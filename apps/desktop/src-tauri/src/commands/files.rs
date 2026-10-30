//! 文件抽屉命令：目录树懒加载、只读预览、新建/重命名/删除与文件内搜索。
//!
//! 本层只做参数映射与错误转字符串；路径守卫与文件系统操作在 `crate::files`。

use tauri::State;

use crate::dto::{DirListing, FileContent, FileMutation, FileSearchResult};
use crate::files;
use crate::state::AppState;

#[tauri::command]
pub async fn list_dir(
    state: State<'_, AppState>,
    project_id: String,
    path: String,
) -> Result<DirListing, String> {
    files::list_dir(state.inner(), &project_id, &path).await
}

#[tauri::command]
pub async fn read_file(
    state: State<'_, AppState>,
    project_id: String,
    path: String,
) -> Result<FileContent, String> {
    files::read_file(state.inner(), &project_id, &path).await
}

#[tauri::command]
pub async fn write_file(
    state: State<'_, AppState>,
    project_id: String,
    path: String,
    content: String,
) -> Result<FileMutation, String> {
    files::write_file(state.inner(), &project_id, &path, &content).await
}

#[tauri::command]
pub async fn create_file(
    state: State<'_, AppState>,
    project_id: String,
    path: String,
    content: Option<String>,
) -> Result<FileMutation, String> {
    files::create_file(state.inner(), &project_id, &path, content.as_deref()).await
}

#[tauri::command]
pub async fn rename_path(
    state: State<'_, AppState>,
    project_id: String,
    from: String,
    to: String,
) -> Result<FileMutation, String> {
    files::rename_path(state.inner(), &project_id, &from, &to).await
}

/// `confirm_name` 必须等于目标名称：二次确认由后端校验，不是前端自觉。
#[tauri::command]
pub async fn delete_path(
    state: State<'_, AppState>,
    project_id: String,
    path: String,
    recursive: bool,
    confirm_name: String,
) -> Result<FileMutation, String> {
    files::delete_path(state.inner(), &project_id, &path, recursive, &confirm_name).await
}

#[tauri::command]
pub async fn search_files(
    state: State<'_, AppState>,
    project_id: String,
    query: String,
    limit: Option<usize>,
) -> Result<FileSearchResult, String> {
    files::search_files(state.inner(), &project_id, &query, limit).await
}
