//! Tauri 侧的应用状态：一个 Supervisor、一个会话目录、一张运行时注册表。
//!
//! 单一 owner 约定：
//! - `catalog`：索引缓存目录的唯一写者，用 `tokio::sync::Mutex` 串行化。
//! - `retry`：重试预算在磁盘上的唯一读写入点（见 `retry_store`）。
//! - `runs`：每个 sessionId 至多一个驱动任务；命令通道是该任务的唯一入口。
//! - `pending_starts`：启动还没完成时（含重试退避窗口）的取消句柄，
//!   让「停止」在中止启动这件事上也有唯一的落点。
//! - `statuses` / `titles` / `gate` / `fanout`：有界内存表，不含会话正文。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use soxu_agent_runtime::retry::RetryCancel;
use soxu_agent_runtime::{PiSupervisor, SupervisorConfig};
use soxu_session_index::{CatalogConfig, ProjectCatalog};
use tokio::sync::mpsc;

use crate::driver::{RunCommand, RunStatus};
use crate::retry_store::RetryStore;
use crate::watch::{EventFanout, GenerationGate};

/// 单个会话的驱动句柄：事件由驱动任务消费，命令经此通道串行入队。
pub struct RunHandle {
    pub runtime_id: String,
    pub generation: u64,
    pub control: mpsc::Sender<RunCommand>,
}

pub struct AppState {
    pub supervisor: PiSupervisor,
    /// 每会话重试预算的持久化：进程重启后不重置已用次数。
    pub retry: RetryStore,
    pub catalog: tokio::sync::Mutex<ProjectCatalog>,
    pub runs: tokio::sync::Mutex<HashMap<String, RunHandle>>,
    pub statuses: Arc<Mutex<HashMap<String, RunStatus>>>,
    pub gate: Arc<GenerationGate>,
    pub fanout: Arc<EventFanout>,
    /// 会话标题缓存：标题从首条用户消息派生，命中后不再重复扫描。
    pub titles: Mutex<HashMap<String, String>>,
    /// 启动/停止的串行闸门：同一会话不会被两个并发 start 拉起两次。
    pub start_guard: tokio::sync::Mutex<()>,
    /// 工作树写操作（创建/删除/prune）的串行闸门：破坏性操作不并发执行。
    pub worktree_guard: tokio::sync::Mutex<()>,
    /// 正在启动（含重试退避）的会话取消句柄；启动结束即移除，不留常驻条目。
    pub pending_starts: Mutex<HashMap<String, RetryCancel>>,
}

impl AppState {
    /// `state_dir` 由 Tauri 的应用数据目录提供；目录不存在时创建，但不触碰 Pi 的会话文件。
    pub fn new(state_dir: PathBuf) -> Result<Self, String> {
        Self::open(state_dir, CatalogConfig::with_default_sessions_root())
    }

    /// 测试与自定义布局用：显式给出会话根目录，不依赖 `SOXU_PI_SESSIONS_DIR` 全局变量。
    pub fn open(state_dir: PathBuf, config: CatalogConfig) -> Result<Self, String> {
        std::fs::create_dir_all(&state_dir)
            .map_err(|error| format!("无法创建状态目录 {}：{error}", state_dir.display()))?;
        let catalog = ProjectCatalog::open_with(&state_dir, config)
            .map_err(|error| format!("无法打开会话目录：{error}"))?;
        // 打开目录时已经清掉上一进程遗留的运行时挂载：留一行诊断，避免「幽灵运行时」静默消失。
        let recovered = catalog.recovered_stale_runtimes();
        if recovered > 0 {
            eprintln!("SOXU: 清理了 {recovered} 个上次异常退出遗留的运行时挂载");
        }
        let retry = RetryStore::new(&state_dir);
        Ok(Self {
            supervisor: PiSupervisor::new(SupervisorConfig::default()),
            retry,
            catalog: tokio::sync::Mutex::new(catalog),
            runs: tokio::sync::Mutex::new(HashMap::new()),
            statuses: Arc::new(Mutex::new(HashMap::new())),
            gate: Arc::new(GenerationGate::new()),
            fanout: Arc::new(EventFanout::new()),
            titles: Mutex::new(HashMap::new()),
            start_guard: tokio::sync::Mutex::new(()),
            worktree_guard: tokio::sync::Mutex::new(()),
            pending_starts: Mutex::new(HashMap::new()),
        })
    }

    /// 登记一次启动的取消句柄；返回的克隆交给重试循环。
    ///
    /// 同一会话重复启动时旧句柄被覆盖：真正的串行化由 `start_guard` 负责，
    /// 这里只是让「停止」找得到当前这一次启动。
    pub fn begin_pending_start(&self, session_id: &str) -> RetryCancel {
        let cancel = RetryCancel::new();
        lock(&self.pending_starts).insert(session_id.to_owned(), cancel.clone());
        cancel
    }

    /// 启动流程结束（成功、失败、取消都算）后清理登记，避免表无限增长。
    pub fn finish_pending_start(&self, session_id: &str) {
        lock(&self.pending_starts).remove(session_id);
    }

    /// 取消正在进行的启动重试窗口；返回是否命中（没有在启动的会话时返回 false）。
    pub fn cancel_pending_start(&self, session_id: &str) -> bool {
        match lock(&self.pending_starts).get(session_id) {
            Some(cancel) => {
                cancel.cancel();
                true
            }
            None => false,
        }
    }

    /// 是否有启动仍在进行（含等待退避）。只读诊断用。
    pub fn is_start_pending(&self, session_id: &str) -> bool {
        lock(&self.pending_starts).contains_key(session_id)
    }

    pub fn status_of(&self, session_id: &str) -> Option<RunStatus> {
        lock(&self.statuses).get(session_id).cloned()
    }

    pub fn set_status(&self, session_id: &str, status: RunStatus) {
        lock(&self.statuses).insert(session_id.to_owned(), status);
    }
}

pub fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sandbox(name: &str) -> PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or_default();
        let dir = std::env::temp_dir().join(format!("soxu-state-{name}-{stamp}"));
        std::fs::create_dir_all(&dir).expect("创建临时目录");
        dir
    }

    #[test]
    fn pending_start_cancellation_is_registered_and_released() {
        let dir = sandbox("pending-start");
        let sessions = dir.join("sessions");
        std::fs::create_dir_all(&sessions).expect("创建会话根目录");
        let state = AppState::open(
            dir.join("state"),
            CatalogConfig::with_sessions_root(&sessions),
        )
        .expect("应能打开状态");

        // 没有启动中的会话：不能把取消当成命中。
        assert!(!state.cancel_pending_start("ses_a"));
        assert!(!state.is_start_pending("ses_a"));

        let cancel = state.begin_pending_start("ses_a");
        assert!(state.is_start_pending("ses_a"));
        assert!(!cancel.is_cancelled());

        // 「停止」在启动未完成（例如重试退避窗口）时也要能打断。
        assert!(state.cancel_pending_start("ses_a"));
        assert!(cancel.is_cancelled(), "取消句柄必须真的被点亮");
        assert!(cancel.is_cancelled(), "取消是粘滞的，不会自己恢复");

        // 启动结束后登记被移除，表不会随会话数无限增长。
        state.finish_pending_start("ses_a");
        assert!(!state.is_start_pending("ses_a"));
        assert!(!state.cancel_pending_start("ses_a"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pending_start_cancellation_is_per_session() {
        let dir = sandbox("pending-scope");
        let sessions = dir.join("sessions");
        std::fs::create_dir_all(&sessions).expect("创建会话根目录");
        let state = AppState::open(
            dir.join("state"),
            CatalogConfig::with_sessions_root(&sessions),
        )
        .expect("应能打开状态");

        let a = state.begin_pending_start("ses_a");
        let b = state.begin_pending_start("ses_b");
        assert!(state.cancel_pending_start("ses_a"));
        assert!(a.is_cancelled());
        assert!(!b.is_cancelled(), "停止一个会话不能顺带取消另一个");

        state.finish_pending_start("ses_a");
        state.finish_pending_start("ses_b");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
