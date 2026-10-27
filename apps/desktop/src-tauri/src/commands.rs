//! Tauri 命令层：只做参数映射与错误转字符串，业务在 workspace / session_runtime。
//!
//! 前端调用名与 `apps/desktop/src/workspace/bridge.ts` 中的 invoke 一一对应；
//! 多词参数由 Tauri 自动从 camelCase 映射到 snake_case。

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::dto::{
    EntryRefInput, EntryText, HistoryPage, ProjectSummary, RuntimeStarted, RuntimeStatus,
};
use crate::session_runtime;
use crate::state::AppState;
use crate::workspace;

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

#[tauri::command]
pub async fn start_session(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    temporary: Option<bool>,
) -> Result<RuntimeStarted, String> {
    session_runtime::start(&app, state.inner(), &session_id, temporary.unwrap_or(false)).await
}

#[tauri::command]
pub async fn send_prompt(
    state: State<'_, AppState>,
    session_id: String,
    text: String,
) -> Result<(), String> {
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
