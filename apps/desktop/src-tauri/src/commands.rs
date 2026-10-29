//! Tauri 命令层：只做参数映射与错误转字符串，业务在 workspace / session_runtime。
//!
//! 前端调用名与 `apps/desktop/src/workspace/bridge.ts` 中的 invoke 一一对应；
//! 多词参数由 Tauri 自动从 camelCase 映射到 snake_case。

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::dto::{
    CreateWorktreeInput, EntryRefInput, EntryText, HistoryPage, ProjectSummary, PromotedSession,
    PromptMode, RuntimeStarted, RuntimeStatus, SessionSearchResult, TemporarySessionView,
    ThinkingLevel, WorktreeDiffView, WorktreeRemovalView, WorktreeSummary, WorktreeWorkspace,
};
use crate::session_runtime;
use crate::state::AppState;
use crate::workspace;
use crate::worktree;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInfo {
    app_name: &'static str,
    app_version: &'static str,
    platform: &'static str,
}

#[tauri::command]
pub fn runtime_info() -> RuntimeInfo {
    RuntimeInfo {
        app_name: "SOXU",
        app_version: env!("CARGO_PKG_VERSION"),
        platform: std::env::consts::OS,
    }
}

#[tauri::command]
pub async fn list_projects(state: State<'_, AppState>) -> Result<Vec<ProjectSummary>, String> {
    workspace::list_projects(state.inner()).await
}

#[tauri::command]
pub async fn register_project(
    state: State<'_, AppState>,
    root: String,
) -> Result<ProjectSummary, String> {
    workspace::register_project(state.inner(), &root).await
}

#[tauri::command]
pub async fn refresh_project(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<ProjectSummary, String> {
    workspace::refresh_project(state.inner(), &project_id).await
}

#[tauri::command]
pub async fn open_session_history(
    state: State<'_, AppState>,
    session_id: String,
    offset: u64,
    limit: usize,
) -> Result<HistoryPage, String> {
    workspace::open_history(state.inner(), &session_id, offset, limit).await
}

#[tauri::command]
pub async fn read_session_texts(
    state: State<'_, AppState>,
    session_id: String,
    entries: Vec<EntryRefInput>,
) -> Result<Vec<EntryText>, String> {
    workspace::read_texts(state.inner(), &session_id, entries).await
}

/// 会话内搜索：走本地文本缓存 + 线性扫描，搜的是整份会话，不是已加载的一页。
///
/// 空查询返回空结果（不是错误）；超过 200 字符返回 E_SEARCH_QUERY_TOO_LONG。
#[tauri::command]
pub async fn search_session(
    state: State<'_, AppState>,
    session_id: String,
    query: String,
    limit: Option<usize>,
    after_ordinal: Option<u64>,
) -> Result<SessionSearchResult, String> {
    workspace::search(state.inner(), &session_id, &query, limit, after_ordinal).await
}

#[tauri::command]
pub async fn list_worktrees(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<WorktreeWorkspace, String> {
    worktree::list(state.inner(), &project_id).await
}

#[tauri::command]
pub async fn plan_worktree_removal(
    state: State<'_, AppState>,
    project_id: String,
    worktree_id: String,
) -> Result<WorktreeSummary, String> {
    worktree::plan_removal(state.inner(), &project_id, &worktree_id).await
}

#[tauri::command]
pub async fn create_worktree(
    state: State<'_, AppState>,
    project_id: String,
    input: CreateWorktreeInput,
) -> Result<WorktreeSummary, String> {
    worktree::create(state.inner(), &project_id, input).await
}

#[tauri::command]
pub async fn worktree_diff(
    state: State<'_, AppState>,
    project_id: String,
    worktree_id: String,
    staged: bool,
) -> Result<WorktreeDiffView, String> {
    worktree::preview_diff(state.inner(), &project_id, &worktree_id, staged).await
}

#[tauri::command]
pub async fn remove_worktree(
    state: State<'_, AppState>,
    project_id: String,
    worktree_id: String,
    token: String,
) -> Result<WorktreeRemovalView, String> {
    worktree::remove(state.inner(), &project_id, &worktree_id, &token).await
}

#[tauri::command]
pub async fn prune_worktrees(
    state: State<'_, AppState>,
    project_id: String,
    token: String,
) -> Result<usize, String> {
    worktree::prune(state.inner(), &project_id, &token).await
}

/// 分配一个临时会话：只存在于 Rust 进程内存，默认不进入持久化历史。
#[tauri::command]
pub async fn open_temporary_session(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<TemporarySessionView, String> {
    workspace::open_temporary(state.inner(), &project_id).await
}

/// 绑定 Pi 会话文件：绑定期间该文件不进入普通历史，转正后才登记。
#[tauri::command]
pub async fn bind_temporary_session_file(
    state: State<'_, AppState>,
    session_id: String,
    file: String,
) -> Result<TemporarySessionView, String> {
    workspace::bind_temporary_file(state.inner(), &session_id, &file).await
}

/// 显式转正：把临时会话变成普通会话；失败保留临时会话并返回原因。
#[tauri::command]
pub async fn promote_session(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<PromotedSession, String> {
    workspace::promote_session(state.inner(), &session_id).await
}

/// 结束临时会话：幂等，不删除 Pi 的会话文件。
#[tauri::command]
pub async fn discard_temporary_session(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<bool, String> {
    workspace::discard_temporary(state.inner(), &session_id).await
}

#[tauri::command]
pub async fn start_session(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    temporary: Option<bool>,
) -> Result<RuntimeStarted, String> {
    session_runtime::start(&app, state.inner(), &session_id, temporary.unwrap_or(false)).await
}

/// 发送一条消息。
///
/// `mode` 与 `thinking` 是 V4-S1 新增的可选参数（Issue #111）：
/// 命令层接收并校验取值（非法值由 serde 直接报错），但**不改变行为**——
/// 注入当前回合 / 排队到下一轮 / 并行会话的运行时语义属于后续切片。
/// 旧前端不传这两个字段时按 `None` 处理，行为与改动前完全一致。
#[tauri::command]
pub async fn send_prompt(
    state: State<'_, AppState>,
    session_id: String,
    text: String,
    mode: Option<PromptMode>,
    thinking: Option<ThinkingLevel>,
) -> Result<(), String> {
    // 显式消费两个参数：既让「参数已接通但未生效」这件事留在代码里，
    // 也避免编译器对未使用参数告警。
    let _ = (mode, thinking);
    session_runtime::prompt(state.inner(), &session_id, &text).await
}

#[tauri::command]
pub async fn cancel_session(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    session_runtime::cancel(state.inner(), &session_id).await
}

#[tauri::command]
pub async fn stop_session(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    session_runtime::stop(state.inner(), &session_id).await
}

#[tauri::command]
pub async fn runtime_status(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Option<RuntimeStatus>, String> {
    Ok(session_runtime::status(state.inner(), &session_id).await)
}

/// 视图挂载：开始为这个会话积累订阅计数（计数 > 0 时才 emit）。
#[tauri::command]
pub async fn retain_session_events(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<usize, String> {
    Ok(session_runtime::retain_events(state.inner(), &session_id).await)
}

/// 视图卸载/关闭 Tab：释放订阅，计数归零后后端不再 emit。
#[tauri::command]
pub async fn release_session_events(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<usize, String> {
    Ok(session_runtime::release_events(state.inner(), &session_id).await)
}
