//! 集成测试公共夹具：临时目录与 Pi JSONL 行生成器。
//!
//! JSON 一律用 serde_json 构造，避免手工转义带来的脆弱测试。
#![allow(dead_code)]

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{Value, json};

static COUNTER: AtomicU64 = AtomicU64::new(0);

pub struct TempDir {
    path: PathBuf,
}

impl TempDir {
    pub fn new(label: &str) -> Self {
        let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "soxu-session-index-{label}-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("创建临时目录");
        Self {
            path: canonical_root(path),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn child(&self, name: &str) -> PathBuf {
        self.path.join(name)
    }

    pub fn mkdir(&self, name: &str) -> PathBuf {
        let path = self.child(name);
        fs::create_dir_all(&path).expect("创建子目录");
        path
    }
}

/// 统一成 canonical 路径的字符串形式：真实大小写、长文件名、无 Windows verbatim 前缀。
///
/// 临时目录在 macOS 上是 `/var` → `/private/var` 的符号链接、在 Windows runner 上带
/// 8.3 短名（`RUNNER~1`），不规范化就会让「测试给的路径」和「目录里存的 canonical 路径」
/// 永远不相等 —— 这类断言本机过、CI 必挂。
fn canonical_root(path: PathBuf) -> PathBuf {
    let Ok(canonical) = fs::canonicalize(&path) else {
        return path;
    };
    let text = canonical.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(rest) if rest.as_bytes().get(1) == Some(&b':') => PathBuf::from(rest),
        _ => canonical,
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        // 夹具清理失败也忽略，不掩盖测试断言结果。
        let _ = fs::remove_dir_all(&self.path);
    }
}

pub fn header_line(session_id: &str, cwd: &str) -> String {
    json!({
        "type": "session",
        "version": 3,
        "id": session_id,
        "timestamp": "2026-01-01T00:00:00.000Z",
        "cwd": cwd,
    })
    .to_string()
}

pub fn message_value(id: &str, parent: Option<&str>, role: &str, text: &str) -> Value {
    json!({
        "type": "message",
        "id": id,
        "parentId": parent,
        "timestamp": "2026-01-01T00:00:01.000Z",
        "message": {
            "role": role,
            "content": text,
            "timestamp": 1_767_225_601_000_u64,
        },
    })
}

pub fn message_line(id: &str, parent: Option<&str>, role: &str, text: &str) -> String {
    message_value(id, parent, role, text).to_string()
}

pub fn write_text(path: &Path, text: &str) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("创建父目录");
    }
    fs::write(path, text).expect("写入文件");
}

pub fn append_text(path: &Path, text: &str) {
    let mut file = fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(path)
        .expect("打开待追加文件");
    file.write_all(text.as_bytes()).expect("追加内容");
    file.flush().expect("刷新文件");
}

/// 生成 n 条消息（含头部）的完整会话文本。
pub fn session_text(session_id: &str, cwd: &str, messages: usize) -> String {
    let mut text = header_line(session_id, cwd);
    text.push('\n');
    let mut previous: Option<String> = None;
    for index in 0..messages {
        let id = format!("m{index:06}");
        let role = if index % 2 == 0 { "user" } else { "assistant" };
        text.push_str(&message_line(
            &id,
            previous.as_deref(),
            role,
            &format!("message {index}"),
        ));
        text.push('\n');
        previous = Some(id);
    }
    text
}

/// 尝试创建指向目录的链接：Unix 用符号链接，Windows 先试符号链接、再退化为目录联接。
///
/// Windows 上普通用户创建符号链接需要开发者模式或管理员权限（SeCreateSymbolicLinkPrivilege），
/// 目录联接（junction）不需要。两者都不可用时返回 Err，由测试显式记录平台差异，
/// 而不是让"符号链接用例"静默变成绿灯。
pub fn try_dir_link(target: &Path, link: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, link)
            .map_err(|error| format!("创建符号链接失败：{error}"))
    }
    #[cfg(windows)]
    {
        match std::os::windows::fs::symlink_dir(target, link) {
            Ok(()) => Ok(()),
            Err(symlink_error) => {
                // mklink 是 cmd 内置命令，参数逐个传递，不做字符串拼接。
                let output = std::process::Command::new("cmd")
                    .arg("/C")
                    .arg("mklink")
                    .arg("/J")
                    .arg(link)
                    .arg(target)
                    .output()
                    .map_err(|error| {
                        format!("符号链接失败（{symlink_error}），目录联接也无法启动：{error}")
                    })?;
                if !output.status.success() {
                    return Err(format!(
                        "符号链接与目录联接都不可用：{symlink_error} / {}",
                        String::from_utf8_lossy(&output.stderr).trim()
                    ));
                }
                if link.is_dir() {
                    Ok(())
                } else {
                    Err("目录联接创建后不可用".to_owned())
                }
            }
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (target, link);
        Err("当前平台不支持目录链接".to_owned())
    }
}

/// 尝试创建指向文件的符号链接。Windows 上需要额外权限，不可用时返回 Err。
pub fn try_file_link(target: &Path, link: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, link)
            .map_err(|error| format!("创建文件符号链接失败：{error}"))
    }
    #[cfg(windows)]
    {
        std::os::windows::fs::symlink_file(target, link)
            .map_err(|error| format!("Windows 创建文件符号链接需要开发者模式或管理员权限：{error}"))
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (target, link);
        Err("当前平台不支持文件符号链接".to_owned())
    }
}

pub fn session_dir(sessions_root: &Path, worktree: &Path) -> PathBuf {
    sessions_root.join(soxu_session_index::project_sessions_dir_name(worktree))
}
