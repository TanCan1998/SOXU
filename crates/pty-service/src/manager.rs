//! PTY 注册表：ptyId → 会话，以及数量上限与关闭语义。
//!
//! 单一 owner：每个 PtySession 的读写端、子进程与两个转发线程都由它自己持有并释放；
//! 注册表只负责「按 id 找到它」，不复制任何句柄。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use crate::error::{PtyError, PtyErrorCode, Result};
use crate::session::{OutputSink, PtyCloseOutcome, PtySession, PtySpec, validate_size};
use crate::shell::ShellSpec;

/// 同时打开的终端上限。终端是重资源（一个 shell 进程 + 两个线程 + ConPTY），
/// 不设上限就等于把「打开终端」变成一个 DoS 入口。
pub const DEFAULT_MAX_SESSIONS: usize = 8;

/// 默认尺寸：与常见终端一致，前端拿到容器尺寸后立刻会 resize 覆盖它。
const DEFAULT_COLS: u16 = 80;
const DEFAULT_ROWS: u16 = 24;

/// 会话描述：创建后回给前端，用于日志与诊断。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PtySessionInfo {
    pub id: String,
    pub pid: Option<u32>,
    pub cols: u16,
    pub rows: u16,
    pub shell: String,
}

/// 创建请求（命令层映射后的形态）。
#[derive(Debug, Clone, Default)]
pub struct PtyRequest {
    pub cols: Option<u16>,
    pub rows: Option<u16>,
    pub cwd: Option<PathBuf>,
    pub shell: Option<String>,
}

pub struct PtyService {
    sink: OutputSink,
    sessions: Mutex<HashMap<String, Arc<PtySession>>>,
    max_sessions: usize,
    next_id: AtomicU64,
}

impl PtyService {
    pub fn new(sink: OutputSink) -> Self {
        Self::with_limit(sink, DEFAULT_MAX_SESSIONS)
    }

    pub fn with_limit(sink: OutputSink, max_sessions: usize) -> Self {
        Self {
            sink,
            sessions: Mutex::new(HashMap::new()),
            max_sessions: max_sessions.max(1),
            next_id: AtomicU64::new(1),
        }
    }

    pub fn max_sessions(&self) -> usize {
        self.max_sessions
    }

    /// 打开一个终端。返回的 id 由服务层分配，前端不得自行指定。
    pub fn create(&self, request: PtyRequest) -> Result<PtySessionInfo> {
        let cols = request.cols.unwrap_or(DEFAULT_COLS);
        let rows = request.rows.unwrap_or(DEFAULT_ROWS);
        validate_size(cols, rows)?;
        let shell = ShellSpec::resolve(request.shell.as_deref())?;
        self.create_with(PtySpec {
            id: self.allocate_id(),
            cols,
            rows,
            cwd: request.cwd,
            shell,
        })
    }

    /// 低层入口：显式给出 shell 与参数。shell 仍走白名单（见 ShellSpec::new）。
    pub fn create_with(&self, spec: PtySpec) -> Result<PtySessionInfo> {
        validate_size(spec.cols, spec.rows)?;
        {
            let mut sessions = lock(&self.sessions);
            // 顺手清理已经自行退出（shell 里敲了 exit）的会话，上限只统计活着的。
            sessions.retain(|_, session| !session.is_closed());
            if sessions.len() >= self.max_sessions {
                return Err(PtyError::new(
                    PtyErrorCode::SessionLimitReached,
                    format!(
                        "同时打开的终端已达上限（{}）；请先关闭一个终端",
                        self.max_sessions
                    ),
                ));
            }
        }
        let id = spec.id.clone();
        let session = PtySession::spawn(spec, Arc::clone(&self.sink))?;
        let info = PtySessionInfo {
            id: id.clone(),
            pid: session.process_id(),
            cols: session.size().0,
            rows: session.size().1,
            shell: session.shell().to_owned(),
        };
        lock(&self.sessions).insert(id, Arc::new(session));
        Ok(info)
    }

    pub fn write(&self, id: &str, data: &str) -> Result<()> {
        self.session(id)?.write(data)
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<()> {
        self.session(id)?.resize(cols, rows)
    }

    /// 关闭终端。幂等：id 不存在时返回 existed = false，不报错。
    pub fn close(&self, id: &str) -> Result<PtyCloseOutcome> {
        let session = lock(&self.sessions).remove(id);
        match session {
            Some(session) => Ok(session.close()),
            None => Ok(PtyCloseOutcome::absent(id)),
        }
    }

    /// 关闭全部终端（退出应用时调用）。返回真正关闭的数量。
    pub fn close_all(&self) -> usize {
        let drained: Vec<Arc<PtySession>> = {
            let mut sessions = lock(&self.sessions);
            sessions.drain().map(|(_, session)| session).collect()
        };
        let count = drained.len();
        for session in drained {
            let _ = session.close();
        }
        count
    }

    pub fn is_open(&self, id: &str) -> bool {
        lock(&self.sessions)
            .get(id)
            .is_some_and(|session| !session.is_closed())
    }

    pub fn open_ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = lock(&self.sessions)
            .iter()
            .filter(|(_, session)| !session.is_closed())
            .map(|(id, _)| id.clone())
            .collect();
        ids.sort();
        ids
    }

    pub fn open_count(&self) -> usize {
        lock(&self.sessions)
            .values()
            .filter(|session| !session.is_closed())
            .count()
    }

    fn session(&self, id: &str) -> Result<Arc<PtySession>> {
        lock(&self.sessions)
            .get(id)
            .filter(|session| !session.is_closed())
            .cloned()
            .ok_or_else(|| {
                PtyError::new(
                    PtyErrorCode::UnknownSession,
                    format!("终端不存在或已关闭：{id}"),
                )
            })
    }

    fn allocate_id(&self) -> String {
        // 单调递增：同一进程内不复用 id，前端因此不会把旧事件写到新终端上。
        let sequence = self.next_id.fetch_add(1, Ordering::SeqCst);
        format!("pty_{sequence}")
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::output::PtyOutput;

    /// 只验证「不启动进程」的路径：真实 PTY 的创建/关闭见 tests/pty_lifecycle.rs。
    fn service(max: usize) -> PtyService {
        let sink: OutputSink = Arc::new(|_output: PtyOutput| {});
        PtyService::with_limit(sink, max)
    }

    #[test]
    fn unknown_ids_are_reported_with_a_stable_code() {
        let service = service(DEFAULT_MAX_SESSIONS);
        let error = service
            .write("pty_nope", "x")
            .expect_err("未知 id 必须报错");
        assert_eq!(error.code(), PtyErrorCode::UnknownSession);
        assert_eq!(error.code().as_str(), "E_PTY_UNKNOWN_SESSION");
        assert!(!service.is_open("pty_nope"));
    }

    #[test]
    fn closing_an_unknown_terminal_is_idempotent() {
        let service = service(DEFAULT_MAX_SESSIONS);
        let outcome = service.close("pty_nope").expect("关闭不存在的终端不算失败");
        assert!(!outcome.existed);
        assert!(outcome.exited);
        assert_eq!(service.close_all(), 0);
    }

    #[test]
    fn invalid_sizes_are_rejected_before_spawning_anything() {
        let service = service(DEFAULT_MAX_SESSIONS);
        for (cols, rows) in [(Some(0), Some(24)), (Some(80), Some(0)), (Some(9999), None)] {
            let error = service
                .create(PtyRequest {
                    cols,
                    rows,
                    ..PtyRequest::default()
                })
                .expect_err("非法尺寸必须被拒绝");
            assert_eq!(error.code(), PtyErrorCode::InvalidSize);
        }
        assert_eq!(service.open_count(), 0, "校验失败不得留下会话");
    }

    #[test]
    fn unsupported_shells_are_rejected_before_spawning_anything() {
        let service = service(DEFAULT_MAX_SESSIONS);
        let error = service
            .create(PtyRequest {
                shell: Some("curl".to_owned()),
                ..PtyRequest::default()
            })
            .expect_err("白名单之外的 shell 必须被拒绝");
        assert_eq!(error.code(), PtyErrorCode::InvalidShell);
        assert_eq!(service.open_count(), 0);
    }

    #[test]
    fn ids_are_unique_and_never_reused() {
        let service = service(DEFAULT_MAX_SESSIONS);
        let first = service.allocate_id();
        let second = service.allocate_id();
        assert_ne!(first, second);
        assert!(first.starts_with("pty_") && second.starts_with("pty_"));
    }

    #[test]
    fn limit_is_at_least_one_and_reported() {
        // 0 会让「打开终端」永远失败：上限必须至少是 1。
        let service = service(0);
        assert_eq!(service.max_sessions(), 1);
        assert_eq!(service.open_count(), 0);
        assert!(service.open_ids().is_empty());
    }
}
