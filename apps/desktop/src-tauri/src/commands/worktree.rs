//! 工作树命令：枚举、创建、差异预览、删除与失效记录清理。

use tauri::State;

use crate::dto::{
    CreateWorktreeInput, WorktreeDiffView, WorktreeRemovalView, WorktreeSummary, WorktreeWorkspace,
};
use crate::state::AppState;
use crate::worktree;

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
