//! Tauri 侧的应用状态：一个 Supervisor、一个会话目录、一张运行时注册表。
//!
//! 单一 owner 约定：
//! - `catalog`：索引缓存目录的唯一写者，用 `tokio::sync::Mutex` 串行化。
//! - `runs`：每个 sessionId 至多一个驱动任务；命令通道是该任务的唯一入口。
//! - `statuses` / `titles` / `gate` / `fanout`：有界内存表，不含会话正文。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use soxu_agent_runtime::{PiSupervisor, SupervisorConfig};
use soxu_session_index::{CatalogConfig, ProjectCatalog};
use tokio::sync::mpsc;

use crate::driver::{RunCommand, RunStatus};
use crate::watch::{EventFanout, GenerationGate};

/// 单个会话的驱动句柄：事件由驱动任务消费，命令经此通道串行入队。
pub struct RunHandle {
    pub runtime_id: String,
    pub generation: u64,
    pub control: mpsc::Sender<RunCommand>,
}

pub struct AppState {
    pub supervisor: PiSupervisor,
    pub catalog: tokio::sync::Mutex<ProjectCatalog>,
    pub runs: tokio::sync::Mutex<HashMap<String, RunHandle>>,
    pub statuses: Arc<Mutex<HashMap<String, RunStatus>>>,
    pub gate: Arc<GenerationGate>,
    pub fanout: Arc<EventFanout>,
    /// 会话标题缓存：标题从首条用户消息派生，命中后不再重复扫描。
    pub titles: Mutex<HashMap<String, String>>,
    /// 启动/停止的串行闸门：同一会话不会被两个并发 start 拉起两次。
    pub start_guard: tokio::sync::Mutex<()>,
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
        Ok(Self {
            supervisor: PiSupervisor::new(SupervisorConfig::default()),
            catalog: tokio::sync::Mutex::new(catalog),
            runs: tokio::sync::Mutex::new(HashMap::new()),
            statuses: Arc::new(Mutex::new(HashMap::new())),
            gate: Arc::new(GenerationGate::new()),
            fanout: Arc::new(EventFanout::new()),
            titles: Mutex::new(HashMap::new()),
            start_guard: tokio::sync::Mutex::new(()),
        })
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
