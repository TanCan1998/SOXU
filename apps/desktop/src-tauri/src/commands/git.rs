//! Git 抽屉命令（Issue #121 · TASK-029）：更改列表、单文件 diff、历史、分支、
//! 暂存、提交、推送与拉取。
//!
//! 只做参数映射与错误转字符串，Git 事实与安全闸门都在 soxu-git-worktree 与 crate::git。
//! worktreeId 省略表示项目主工作树（项目根目录）。

use tauri::State;

use crate::dto::{
    GitBranchesView, GitCommitView, GitFileDiffView, GitLogView, GitRemoteView, GitStatusView,
};
use crate::git;
use crate::state::AppState;

#[tauri::command]
pub async fn git_status(
    state: State<'_, AppState>,
    project_id: String,
    worktree_id: Option<String>,
) -> Result<GitStatusView, String> {
    git::status(state.inner(), &project_id, worktree_id.as_deref()).await
}

#[tauri::command]
pub async fn git_diff(
    state: State<'_, AppState>,
    project_id: String,
    worktree_id: Option<String>,
    path: String,
    staged: bool,
) -> Result<GitFileDiffView, String> {
    git::diff(
        state.inner(),
        &project_id,
        worktree_id.as_deref(),
        path,
        staged,
    )
    .await
}

#[tauri::command]
pub async fn git_log(
    state: State<'_, AppState>,
    project_id: String,
    worktree_id: Option<String>,
    limit: Option<usize>,
) -> Result<GitLogView, String> {
    git::log(state.inner(), &project_id, worktree_id.as_deref(), limit).await
}

#[tauri::command]
pub async fn git_branches(
    state: State<'_, AppState>,
    project_id: String,
    worktree_id: Option<String>,
) -> Result<GitBranchesView, String> {
    git::branches(state.inner(), &project_id, worktree_id.as_deref()).await
}

/// 暂存改动；paths 为空表示全部。返回刷新后的更改列表。
#[tauri::command]
pub async fn git_stage(
    state: State<'_, AppState>,
    project_id: String,
    worktree_id: Option<String>,
    paths: Vec<String>,
) -> Result<GitStatusView, String> {
    git::stage(state.inner(), &project_id, worktree_id.as_deref(), paths).await
}

/// 提交已暂存内容；空说明会被后端拒绝（E_GIT_COMMIT_MESSAGE_INVALID）。
#[tauri::command]
pub async fn git_commit(
    state: State<'_, AppState>,
    project_id: String,
    worktree_id: Option<String>,
    message: String,
) -> Result<GitCommitView, String> {
    git::commit(state.inner(), &project_id, worktree_id.as_deref(), message).await
}

/// 推送当前分支：失败时返回带 git stderr 的错误，不做强制覆盖。
#[tauri::command]
pub async fn git_push(
    state: State<'_, AppState>,
    project_id: String,
    worktree_id: Option<String>,
) -> Result<GitRemoteView, String> {
    git::push(state.inner(), &project_id, worktree_id.as_deref()).await
}

/// 拉取（只快进）：失败时不产生合并提交。
#[tauri::command]
pub async fn git_pull(
    state: State<'_, AppState>,
    project_id: String,
    worktree_id: Option<String>,
) -> Result<GitRemoteView, String> {
    git::pull(state.inner(), &project_id, worktree_id.as_deref()).await
}
