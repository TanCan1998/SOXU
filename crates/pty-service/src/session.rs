//! 单个 PTY 会话：拉起 shell、转发输入、转发输出、关闭时回收子进程。
//!
//! 线程模型（每个会话两个线程，都是本模块的私有 owner）：reader 线程反复读
//! master，把分片送进 mpsc；pump 线程按 16ms 窗口合并分片后交给 sink，因此前端
//! 不会收到逐字节的事件。
//!
//! 关闭顺序是硬性要求（见 PtySession::close）：
//!
//! 1. kill() 子进程——这是「不留孤儿」的唯一权威动作；
//! 2. 释放 master / writer——Windows 下 ClosePseudoConsole 会关闭 ConPTY 输出管道的
//!    写端，读线程因此拿到 EOF；Unix 下 slave 关闭后 master 读返回 EIO
//!    （portable-pty 归一成 0 字节读）；
//! 3. 有界等待子进程退出与线程结束，超时如实上报，不假装已回收。

use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use portable_pty::{Child, CommandBuilder, MasterPty, PtyPair, PtySize, native_pty_system};

use crate::error::{PtyError, PtyErrorCode, Result};
use crate::output::{FLUSH_INTERVAL, MAX_PENDING_BYTES, OutputThrottle, PtyOutput};
use crate::shell::ShellSpec;

/// 单次读取的字节上限：与常见管道缓冲同量级，避免大输出时反复分配。
const READ_CHUNK: usize = 8 * 1024;
/// 关闭时等待子进程退出的上限。超时如实上报 exited: false，不把界面卡更久。
const CLOSE_WAIT: Duration = Duration::from_secs(3);
/// 关闭时等待读/合并线程退出的上限。
const THREAD_JOIN: Duration = Duration::from_secs(1);
/// 行列数上限：防止前端传来荒唐的尺寸让 ConPTY 分配巨大的屏幕缓冲。
pub const MAX_DIMENSION: u16 = 500;

/// 终端里不应出现的环境变量：这些是 Runner 注入给 Agent 的凭据，
/// 用户自己的终端不该继承（安全边界：终端不是提权通道）。
const SCRUBBED_ENV: [&str; 5] = [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "ATOMGIT_TOKEN",
    "GITHUB_PAT",
    "NPM_TOKEN",
];

/// 创建请求。id 由服务层分配，这里只描述「怎么起」。
#[derive(Debug, Clone)]
pub struct PtySpec {
    pub id: String,
    pub cols: u16,
    pub rows: u16,
    pub cwd: Option<PathBuf>,
    pub shell: ShellSpec,
}

/// 输出回调。由桌面适配层提供（emit Tauri 事件），本 crate 不认识 Tauri。
pub type OutputSink = Arc<dyn Fn(PtyOutput) + Send + Sync>;

/// 关闭结果。existed 为 false 表示这个 id 本来就不在注册表里（关闭是幂等的）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PtyCloseOutcome {
    pub id: String,
    pub existed: bool,
    pub exited: bool,
    pub exit_code: Option<i32>,
    pub threads_finished: bool,
}

impl PtyCloseOutcome {
    /// 幂等关闭时返回的结果：什么都没做，也没有进程需要回收。
    pub fn absent(id: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            existed: false,
            exited: true,
            exit_code: None,
            threads_finished: true,
        }
    }
}

pub struct PtySession {
    id: String,
    shell: String,
    cols: u16,
    rows: u16,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    /// resize 只需要 &self，但关闭时必须能把句柄丢掉（见模块文档第 2 步）。
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    reader: Mutex<Option<JoinHandle<()>>>,
    pump: Mutex<Option<JoinHandle<()>>>,
    closed: AtomicBool,
    outcome: Mutex<Option<PtyCloseOutcome>>,
}

impl PtySession {
    /// 创建 PTY 并拉起 shell。返回后两个转发线程已经在跑。
    pub fn spawn(spec: PtySpec, sink: OutputSink) -> Result<Self> {
        let size = PtySize {
            cols: spec.cols,
            rows: spec.rows,
            pixel_width: 0,
            pixel_height: 0,
        };
        let pair = native_pty_system()
            .openpty(size)
            .map_err(|error| spawn_error(format!("无法创建 PTY：{error}")))?;

        let mut command = CommandBuilder::new(spec.shell.program());
        for argument in spec.shell.args() {
            command.arg(argument);
        }
        if let Some(cwd) = &spec.cwd {
            command.cwd(cwd);
        }
        for key in SCRUBBED_ENV {
            command.env_remove(key);
        }

        let PtyPair { slave, master } = pair;
        let child = slave
            .spawn_command(command)
            .map_err(|error| spawn_error(format!("无法启动 shell：{error}")))?;
        // slave 必须在 spawn 之后立刻丢掉：只要本进程还持有 slave 端，
        // 子进程退出后 master 就读不到 EOF，读线程会一直挂着。
        drop(slave);

        let reader = master
            .try_clone_reader()
            .map_err(|error| spawn_error(format!("无法读取 PTY：{error}")))?;
        let writer = master
            .take_writer()
            .map_err(|error| spawn_error(format!("无法写入 PTY：{error}")))?;

        let id = spec.id;
        let closed = Arc::new(AtomicBool::new(false));
        let (sender, receiver) = std::sync::mpsc::channel::<Vec<u8>>();
        let reader_handle = spawn_thread(format!("soxu-pty-read-{id}"), move || {
            read_loop(reader, sender);
        })?;
        let pump_handle = spawn_thread(format!("soxu-pty-pump-{id}"), {
            let id = id.clone();
            let closed = Arc::clone(&closed);
            move || pump_loop(&id, receiver, sink, closed)
        })?;

        Ok(Self {
            id,
            shell: spec.shell.program().to_owned(),
            cols: spec.cols,
            rows: spec.rows,
            child: Mutex::new(child),
            master: Mutex::new(Some(master)),
            writer: Mutex::new(Some(writer)),
            reader: Mutex::new(Some(reader_handle)),
            pump: Mutex::new(Some(pump_handle)),
            closed: AtomicBool::new(false),
            outcome: Mutex::new(None),
        })
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn shell(&self) -> &str {
        &self.shell
    }

    pub fn size(&self) -> (u16, u16) {
        (self.cols, self.rows)
    }

    pub fn process_id(&self) -> Option<u32> {
        lock(&self.child).process_id()
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    /// 把用户输入写进 shell。数据原样转发，不做任何转义或行编辑。
    pub fn write(&self, data: &str) -> Result<()> {
        if self.is_closed() {
            return Err(PtyError::new(PtyErrorCode::Closed, "终端已关闭"));
        }
        let mut guard = lock(&self.writer);
        let writer = guard
            .as_mut()
            .ok_or_else(|| PtyError::new(PtyErrorCode::Closed, "终端已关闭"))?;
        writer
            .write_all(data.as_bytes())
            .and_then(|()| writer.flush())
            .map_err(|error| {
                PtyError::new(PtyErrorCode::WriteFailed, format!("写入终端失败：{error}"))
            })
    }

    /// 通知内核（以及 shell）新的可视区域大小。
    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        if self.is_closed() {
            return Err(PtyError::new(PtyErrorCode::Closed, "终端已关闭"));
        }
        validate_size(cols, rows)?;
        let guard = lock(&self.master);
        let master = guard
            .as_ref()
            .ok_or_else(|| PtyError::new(PtyErrorCode::Closed, "终端已关闭"))?;
        master
            .resize(PtySize {
                cols,
                rows,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| {
                PtyError::new(
                    PtyErrorCode::ResizeFailed,
                    format!("调整终端大小失败：{error}"),
                )
            })
    }

    /// 关闭会话：杀子进程 → 释放 PTY → 有界等待退出。重复调用返回第一次的结果。
    pub fn close(&self) -> PtyCloseOutcome {
        if self.closed.swap(true, Ordering::SeqCst) {
            return lock(&self.outcome)
                .clone()
                .unwrap_or_else(|| PtyCloseOutcome::absent(self.id.clone()));
        }
        let exit_code = {
            let mut child = lock(&self.child);
            // 先杀再放 PTY：反过来的话 Windows 下 ClosePseudoConsole 会先断掉输出，
            // 子进程可能仍在跑，那就真的留下孤儿了。
            let _ = child.kill();
            drop(lock(&self.writer).take());
            drop(lock(&self.master).take());
            wait_bounded(&mut **child, CLOSE_WAIT)
        };
        let reader_done = join_bounded(lock(&self.reader).take(), THREAD_JOIN);
        let pump_done = join_bounded(lock(&self.pump).take(), THREAD_JOIN);
        let outcome = PtyCloseOutcome {
            id: self.id.clone(),
            existed: true,
            exited: exit_code.is_some(),
            exit_code,
            threads_finished: reader_done && pump_done,
        };
        *lock(&self.outcome) = Some(outcome.clone());
        outcome
    }
}

/// 兜底：会话被丢弃时也必须回收子进程。命令层会显式 close，这里是最后一道防线。
impl Drop for PtySession {
    fn drop(&mut self) {
        if !self.closed.load(Ordering::SeqCst) {
            let _ = self.close();
        }
    }
}

pub fn validate_size(cols: u16, rows: u16) -> Result<()> {
    if cols == 0 || rows == 0 || cols > MAX_DIMENSION || rows > MAX_DIMENSION {
        return Err(PtyError::new(
            PtyErrorCode::InvalidSize,
            format!("终端尺寸非法：{cols}x{rows}（允许 1..={MAX_DIMENSION}）"),
        ));
    }
    Ok(())
}

fn read_loop(mut reader: Box<dyn Read + Send>, sender: std::sync::mpsc::Sender<Vec<u8>>) {
    let mut buffer = vec![0u8; READ_CHUNK];
    loop {
        match reader.read(&mut buffer) {
            // 0 字节 = EOF（Unix 的 EIO 已被 portable-pty 归一成 0）。
            Ok(0) => break,
            Ok(read) => {
                if sender.send(buffer[..read].to_vec()).is_err() {
                    break;
                }
            }
            // 读取失败（PTY 已销毁）等价于流结束：退出线程，不留悬挂句柄。
            Err(_) => break,
        }
    }
    // sender 随线程结束被丢弃：合并线程在 Disconnected 分支做最后一次 flush 后退出。
}

fn pump_loop(pty_id: &str, receiver: Receiver<Vec<u8>>, sink: OutputSink, closed: Arc<AtomicBool>) {
    let mut throttle = OutputThrottle::new(pty_id, MAX_PENDING_BYTES);
    let mut last_flush = Instant::now();
    loop {
        match receiver.recv_timeout(FLUSH_INTERVAL) {
            Ok(chunk) => {
                if let Some(output) = throttle.push(&chunk) {
                    emit(&sink, &closed, output);
                    last_flush = Instant::now();
                } else if last_flush.elapsed() >= FLUSH_INTERVAL
                    && let Some(output) = throttle.flush()
                {
                    emit(&sink, &closed, output);
                    last_flush = Instant::now();
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                if let Some(output) = throttle.flush() {
                    emit(&sink, &closed, output);
                    last_flush = Instant::now();
                }
            }
            Err(RecvTimeoutError::Disconnected) => {
                // 流结束：把剩下的字节（含不完整的 UTF-8 尾巴）一次性交出去。
                if let Some(output) = throttle.finish() {
                    emit(&sink, &closed, output);
                }
                break;
            }
        }
    }
}

/// 关闭之后到达的输出直接丢弃：界面已经不再有这块终端了。
fn emit(sink: &OutputSink, closed: &AtomicBool, output: PtyOutput) {
    if !closed.load(Ordering::SeqCst) {
        sink(output);
    }
}

fn spawn_thread(name: String, body: impl FnOnce() + Send + 'static) -> Result<JoinHandle<()>> {
    thread::Builder::new()
        .name(name)
        .spawn(body)
        .map_err(|error| spawn_error(format!("无法创建 PTY 转发线程：{error}")))
}

fn wait_bounded(child: &mut (dyn Child + Send + Sync), budget: Duration) -> Option<i32> {
    let deadline = Instant::now() + budget;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status.exit_code() as i32),
            // 尚未退出（kill 之后通常很快）就继续等，直到预算用完。
            Ok(None) => {}
            Err(_) => return None,
        }
        if Instant::now() >= deadline {
            return None;
        }
        thread::sleep(Duration::from_millis(5));
    }
}

fn join_bounded(handle: Option<JoinHandle<()>>, budget: Duration) -> bool {
    let Some(handle) = handle else {
        return true;
    };
    let deadline = Instant::now() + budget;
    while !handle.is_finished() {
        if Instant::now() >= deadline {
            // 超时就不再等：线程会在下一次 read 返回后自行结束，句柄随 drop 分离。
            return false;
        }
        thread::sleep(Duration::from_millis(5));
    }
    handle.join().is_ok()
}

fn spawn_error(message: String) -> PtyError {
    PtyError::new(PtyErrorCode::SpawnFailed, message)
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn size_limits_are_enforced() {
        assert!(validate_size(80, 24).is_ok());
        assert!(validate_size(MAX_DIMENSION, MAX_DIMENSION).is_ok());
        for (cols, rows) in [
            (0, 24),
            (80, 0),
            (MAX_DIMENSION + 1, 24),
            (80, MAX_DIMENSION + 1),
        ] {
            let error = validate_size(cols, rows).expect_err("非法尺寸必须被拒绝");
            assert_eq!(error.code(), PtyErrorCode::InvalidSize);
        }
    }

    #[test]
    fn absent_outcome_is_reported_as_already_reclaimed() {
        let outcome = PtyCloseOutcome::absent("pty_missing");
        assert!(!outcome.existed);
        assert!(outcome.exited);
        assert!(outcome.exit_code.is_none());
    }
}
