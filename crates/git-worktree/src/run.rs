//! 受控的 git 子进程调用。
//!
//! 规则（对应 agents/policies/architecture-rules.md）：
//! - 只用结构化 argv，绝不拼接 shell 命令文本；
//! - 剥离继承来的 GIT_DIR / GIT_WORK_TREE 等环境变量，避免调用方上下文污染；
//! - 只读命令带 `GIT_OPTIONAL_LOCKS=0`，不会为了刷新索引而与 Pi/Agent 抢锁；
//! - 输出有字节上限、进程有超时，超限就终止并把截断标记交给调用方。

use std::ffi::{OsStr, OsString};
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use crate::error::{GitError, GitErrorCode, Result};

/// 只读命令的默认输出上限：4 MiB，足以容纳大型仓库的 status/diff 统计。
pub const DEFAULT_OUTPUT_LIMIT: usize = 4 * 1024 * 1024;
/// 只读命令默认超时。
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(20);
/// 写入命令（新增工作树可能要检出大量文件）默认超时。
pub const WRITE_TIMEOUT: Duration = Duration::from_secs(180);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitOutput {
    pub success: bool,
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    /// 输出超过上限，stdout 被截断。
    pub truncated: bool,
}

impl GitOutput {
    pub fn text(&self) -> &str {
        self.stdout.trim()
    }

    pub fn first_stderr_line(&self) -> &str {
        self.stderr
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty())
            .unwrap_or("")
    }
}

/// 单次调用的策略：只读/写入、输出上限、超时。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitCall {
    pub readonly: bool,
    pub output_limit: usize,
    pub timeout: Duration,
}

impl GitCall {
    pub fn read() -> Self {
        Self {
            readonly: true,
            output_limit: DEFAULT_OUTPUT_LIMIT,
            timeout: DEFAULT_TIMEOUT,
        }
    }

    pub fn write() -> Self {
        Self {
            readonly: false,
            output_limit: DEFAULT_OUTPUT_LIMIT,
            timeout: WRITE_TIMEOUT,
        }
    }

    /// 只读且有明确字节预算（diff 预览用）。
    pub fn bounded(limit: usize) -> Self {
        Self {
            output_limit: limit.max(1024),
            ..Self::read()
        }
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }
}

impl Default for GitCall {
    fn default() -> Self {
        Self::read()
    }
}

/// git 可执行文件与调用策略的持有者。默认使用 PATH 上的 `git`。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitRunner {
    program: OsString,
}

impl Default for GitRunner {
    fn default() -> Self {
        Self {
            program: OsString::from("git"),
        }
    }
}

impl GitRunner {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn program(&self) -> &OsStr {
        &self.program
    }

    fn command(&self, dir: &Path, args: &[&str], readonly: bool) -> Command {
        let mut command = Command::new(&self.program);
        command.current_dir(dir);
        command.arg("--no-pager");
        for key in [
            "GIT_DIR",
            "GIT_WORK_TREE",
            "GIT_INDEX_FILE",
            "GIT_COMMON_DIR",
            "GIT_OBJECT_DIRECTORY",
            "GIT_ALTERNATE_OBJECT_DIRECTORIES",
            "GIT_NAMESPACE",
        ] {
            command.env_remove(key);
        }
        // 本地操作不允许交互式提示；分页器一律关闭，避免子进程等待终端。
        command.env("GIT_TERMINAL_PROMPT", "0");
        command.env("GIT_PAGER", "cat");
        command.env("PAGER", "cat");
        command.env("GIT_OPTIONAL_LOCKS", if readonly { "0" } else { "1" });
        command.args(args);
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command
    }

    /// 执行命令并返回有界输出；超时、找不到 git 都转成稳定错误码。
    pub fn capture(&self, dir: &Path, args: &[&str], call: &GitCall) -> Result<GitOutput> {
        if !dir.is_dir() {
            return Err(GitError::new(
                GitErrorCode::WorktreePathMissing,
                format!("Git 工作目录不存在：{}", dir.display()),
            ));
        }
        let mut command = self.command(dir, args, call.readonly);
        let mut child = command.spawn().map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                GitError::new(
                    GitErrorCode::GitUnavailable,
                    format!("找不到 git 可执行文件：{}", self.program.to_string_lossy()),
                )
            } else {
                GitError::io(
                    GitErrorCode::IoFailure,
                    format!("无法启动 git（{}）", dir.display()),
                    &error,
                )
            }
        })?;
        let Some(stdout) = child.stdout.take() else {
            return Err(GitError::new(GitErrorCode::IoFailure, "git stdout 不可读"));
        };
        let Some(stderr) = child.stderr.take() else {
            return Err(GitError::new(GitErrorCode::IoFailure, "git stderr 不可读"));
        };
        let stdout_reader = read_bounded(stdout, call.output_limit);
        let stderr_reader = read_bounded(stderr, call.output_limit);

        let deadline = Instant::now() + call.timeout;
        let mut timed_out = false;
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break Some(status),
                Ok(None) => {
                    if Instant::now() >= deadline {
                        timed_out = true;
                        let _ = child.kill();
                        break child.wait().ok();
                    }
                    thread::sleep(Duration::from_millis(10));
                }
                Err(error) => {
                    let _ = child.kill();
                    return Err(GitError::io(
                        GitErrorCode::IoFailure,
                        "等待 git 退出失败",
                        &error,
                    ));
                }
            }
        };
        let (stdout_bytes, stdout_overflow) = join_reader(stdout_reader);
        let (stderr_bytes, _) = join_reader(stderr_reader);

        if timed_out {
            return Err(GitError::new(
                GitErrorCode::CommandTimeout,
                format!("git {} 超时（{:?}）", args.join(" "), call.timeout),
            ));
        }
        let status = status
            .ok_or_else(|| GitError::new(GitErrorCode::IoFailure, "git 进程没有返回退出状态"))?;
        Ok(GitOutput {
            success: status.success(),
            code: status.code(),
            stdout: String::from_utf8_lossy(&stdout_bytes).into_owned(),
            stderr: String::from_utf8_lossy(&stderr_bytes).into_owned(),
            truncated: stdout_overflow,
        })
    }

    /// 要求命令成功；失败时带上 git 的第一行 stderr，便于判定具体原因。
    pub fn capture_ok(&self, dir: &Path, args: &[&str], call: &GitCall) -> Result<GitOutput> {
        let output = self.capture(dir, args, call)?;
        if output.success {
            return Ok(output);
        }
        let detail = if output.first_stderr_line().is_empty() {
            format!("退出码 {:?}", output.code)
        } else {
            output.first_stderr_line().to_owned()
        };
        Err(GitError::new(
            GitErrorCode::CommandFailed,
            format!("git {} 执行失败", args.join(" ")),
        )
        .with_detail(detail))
    }

    pub fn read_ok(&self, dir: &Path, args: &[&str]) -> Result<GitOutput> {
        self.capture_ok(dir, args, &GitCall::read())
    }

    pub fn write_ok(&self, dir: &Path, args: &[&str]) -> Result<GitOutput> {
        self.capture_ok(dir, args, &GitCall::write())
    }
}

fn join_reader(handle: thread::JoinHandle<(Vec<u8>, bool)>) -> (Vec<u8>, bool) {
    handle.join().unwrap_or_else(|_| (Vec::new(), false))
}

/// 读满上限后继续读但丢弃，避免子进程被写满的管道阻塞。
fn read_bounded<R: Read + Send + 'static>(
    mut reader: R,
    limit: usize,
) -> thread::JoinHandle<(Vec<u8>, bool)> {
    thread::spawn(move || {
        let mut buffer = Vec::new();
        let mut chunk = [0u8; 8192];
        let mut overflow = false;
        loop {
            match reader.read(&mut chunk) {
                Ok(0) => break,
                Ok(read) => {
                    let remaining = limit.saturating_sub(buffer.len());
                    if read > remaining {
                        overflow = true;
                    }
                    buffer.extend_from_slice(&chunk[..read.min(remaining)]);
                }
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
        (buffer, overflow)
    })
}
