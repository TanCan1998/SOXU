//! 项目与工作区命令：应用信息、项目枚举、登记与刷新，以及应用级系统开关
//! （打开数据目录、关闭行为偏好，Issue #145）。

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::dto::ProjectSummary;
use crate::state::AppState;
use crate::tray::ClosePreference;
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

/// 用系统文件管理器打开应用数据目录（Issue #145）。
///
/// 路径只取 Tauri 的 `app_data_dir()`，**不接受前端传入的路径**：这条命令的能力
/// 是「定位应用自己的数据目录」，不是通用的「打开任意目录」。只读语义——除了在目录
/// 不存在时创建它，不写入任何文件。
#[tauri::command]
pub fn open_data_directory(app: AppHandle) -> Result<String, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("E_APP_DATA_DIR: {error}"))?;
    // 首次启动、目录还没建时先创建：否则文件管理器会报「找不到路径」。
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("E_APP_DATA_DIR_CREATE: {error}"))?;
    reveal_in_file_manager(&directory)?;
    Ok(directory.to_string_lossy().into_owned())
}

/// 把目录交给系统文件管理器。
///
/// 不引入 tauri-plugin-opener：这里只需要「打开一个已知目录」，三个平台各一条启动器
/// 就够了，少一个依赖就少一份权限面与升级风险。
/// 子进程不阻塞命令返回（explorer 打开目录后立即返回），但仍 join 一次——
/// 否则在 Unix 上会留下僵尸进程。
fn reveal_in_file_manager(directory: &std::path::Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let program = "explorer";
    #[cfg(target_os = "macos")]
    let program = "open";
    #[cfg(all(unix, not(target_os = "macos")))]
    let program = "xdg-open";

    let mut child = std::process::Command::new(program)
        .arg(directory)
        .spawn()
        .map_err(|error| format!("E_OPEN_DIR: {error}"))?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
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

/// 更新「关闭时最小化到托盘」偏好（Issue #145）。
///
/// 只写受管状态：真正的判定在 `tray::handle_window_event` 里，因此不需要重建窗口，
/// 也不需要重启应用。前端挂载时与每次改动时各推一次。
#[tauri::command]
pub fn set_close_behavior(preference: State<'_, ClosePreference>, minimize_to_tray: bool) {
    preference.set_minimize_to_tray(minimize_to_tray);
}
