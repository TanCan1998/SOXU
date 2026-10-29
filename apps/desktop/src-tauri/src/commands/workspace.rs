//! 项目与工作区命令：应用信息、项目枚举、登记与刷新。

use serde::Serialize;
use tauri::State;

use crate::dto::ProjectSummary;
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
