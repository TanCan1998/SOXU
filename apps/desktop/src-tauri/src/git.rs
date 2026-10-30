//! Git 抽屉适配层（Issue #121 · TASK-029）。
//!
//! 分层：commands/git.rs（IPC）→ 本文件（身份映射 + 阻塞调用桥）→
//! soxu-git-worktree（Git 事实）。
//!
//! 三条规则：
//! 1. 身份只从会话目录取：projectId / worktreeId 必须已登记，不接受前端传路径；
//! 2. 写操作串行：暂存/提交/推送/拉取共用 state.git_guard，避免并发写索引；
//! 3. 失败只返回稳定错误码 + git 的第一行 stderr，界面原样展示，不伪造成功。

use std::path::{Path, PathBuf};

use soxu_git_worktree::{
    ChangesView, DEFAULT_LOG_ENTRIES, GitError, GitRepo, MAX_FILE_DIFF_BYTES, MAX_LOG_ENTRIES,
};
use soxu_session_index::{ProjectId, WorktreeId};

use crate::dto::{
    GitBranchEntry, GitBranchesView, GitChangeFile, GitCommitView, GitFileDiffView, GitLogEntry,
    GitLogView, GitRemoteView, GitStatusView,
};
use crate::state::AppState;

/// 把 Git 调用移出异步运行时：git 是阻塞子进程，且可能持续上百毫秒。
///
/// worktree.rs 与 git.rs 共用这一份实现，避免两处对「git 任务失败」的措辞分叉。
pub(crate) async fn git_blocking<T, F>(task: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, GitError> + Send + 'static,
    T: Send + 'static,
{
    match tokio::task::spawn_blocking(task).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(error)) => Err(error.to_string()),
        Err(error) => Err(format!("E_GIT_IO_FAILURE: Git 任务未完成（{error}）")),
    }
}

/// 一次操作的目标：项目 + 可选工作树 + 解析后的目录。
struct GitTarget {
    project: ProjectId,
    worktree: Option<WorktreeId>,
    path: PathBuf,
}

impl GitTarget {
    fn worktree_id(&self) -> Option<String> {
        self.worktree.as_ref().map(ToString::to_string)
    }
}

/// 解析目标目录。给了 worktreeId 就用登记的工作树，否则用项目根目录（主工作树）。
async fn target(
    state: &AppState,
    project_id: &str,
    worktree_id: Option<&str>,
) -> Result<GitTarget, String> {
    let project = ProjectId::new(project_id);
    let worktree = worktree_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(WorktreeId::new);
    let path = {
        let catalog = state.catalog.lock().await;
        let record = catalog
            .project(&project)
            .ok_or_else(|| format!("E_PROJECT_UNKNOWN: 项目未注册：{project}"))?;
        match &worktree {
            Some(id) => {
                let worktree_record = record
                    .worktree(id)
                    .ok_or_else(|| format!("E_WORKTREE_UNKNOWN: 工作树未登记：{id}"))?;
                PathBuf::from(&worktree_record.path)
            }
            None => PathBuf::from(&record.root),
        }
    };
    Ok(GitTarget {
        project,
        worktree,
        path,
    })
}

async fn read_changes(path: &Path) -> Result<ChangesView, String> {
    let for_open = path.to_path_buf();
    git_blocking(move || {
        let repo = GitRepo::open(&for_open)?;
        repo.changes(&for_open)
    })
    .await
}

fn status_view(target: &GitTarget, changes: ChangesView) -> GitStatusView {
    GitStatusView {
        project_id: target.project.to_string(),
        worktree_id: target.worktree_id(),
        root: changes.worktree,
        branch: changes.branch,
        upstream: changes.upstream,
        ahead: changes.ahead,
        behind: changes.behind,
        files: changes
            .files
            .into_iter()
            .map(|file| GitChangeFile {
                path: file.path,
                status: file.status,
                staged: file.staged,
                unstaged: file.unstaged,
                untracked: file.untracked,
                conflict: file.conflict,
                added: file.added,
                removed: file.removed,
                binary: file.binary,
            })
            .collect(),
        total_files: changes.total_files,
        truncated: changes.truncated,
        index_locked: changes.index_lock.is_some(),
        operation: changes.operation,
    }
}

/// 更改列表：只读。
pub async fn status(
    state: &AppState,
    project_id: &str,
    worktree_id: Option<&str>,
) -> Result<GitStatusView, String> {
    let target = target(state, project_id, worktree_id).await?;
    let changes = read_changes(&target.path).await?;
    Ok(status_view(&target, changes))
}

/// 单文件 diff：只读、有界。
pub async fn diff(
    state: &AppState,
    project_id: &str,
    worktree_id: Option<&str>,
    path: String,
    staged: bool,
) -> Result<GitFileDiffView, String> {
    let target = target(state, project_id, worktree_id).await?;
    let workdir = target.path;
    git_blocking(move || {
        let repo = GitRepo::open(&workdir)?;
        repo.file_diff(&workdir, &path, staged, MAX_FILE_DIFF_BYTES)
    })
    .await
    .map(|view| GitFileDiffView {
        path: view.path,
        staged: view.staged,
        patch: view.patch,
        truncated: view.truncated,
        bytes_read: view.bytes_read,
        added: view.added,
        removed: view.removed,
        binary: view.binary,
    })
}

/// 提交历史：只读、有界。
pub async fn log(
    state: &AppState,
    project_id: &str,
    worktree_id: Option<&str>,
    limit: Option<usize>,
) -> Result<GitLogView, String> {
    let target = target(state, project_id, worktree_id).await?;
    let workdir = target.path.clone();
    let limit = limit.unwrap_or(DEFAULT_LOG_ENTRIES);
    let entries = git_blocking(move || {
        let repo = GitRepo::open(&workdir)?;
        repo.log(&workdir, limit)
    })
    .await?;
    // 取满上限只说明「可能还有更多」，不代表一定有；前端按这个标记提示。
    let truncated = entries.len() >= limit.clamp(1, MAX_LOG_ENTRIES);
    Ok(GitLogView {
        project_id: target.project.to_string(),
        worktree_id: target.worktree_id(),
        entries: entries
            .into_iter()
            .map(|entry| GitLogEntry {
                hash: entry.hash,
                short_hash: entry.short_hash,
                author: entry.author,
                date: entry.date,
                subject: entry.subject,
            })
            .collect(),
        truncated,
    })
}

/// 分支清单：只读、有界。
pub async fn branches(
    state: &AppState,
    project_id: &str,
    worktree_id: Option<&str>,
) -> Result<GitBranchesView, String> {
    let target = target(state, project_id, worktree_id).await?;
    let workdir = target.path.clone();
    let view = git_blocking(move || {
        let repo = GitRepo::open(&workdir)?;
        repo.branches(&workdir)
    })
    .await?;
    Ok(GitBranchesView {
        project_id: target.project.to_string(),
        worktree_id: target.worktree_id(),
        current: view.current,
        branches: view
            .branches
            .into_iter()
            .map(|branch| GitBranchEntry {
                name: branch.name,
                head: branch.head,
                upstream: branch.upstream,
                current: branch.current,
            })
            .collect(),
        truncated: view.truncated,
    })
}

/// 暂存改动：paths 为空表示全部。
pub async fn stage(
    state: &AppState,
    project_id: &str,
    worktree_id: Option<&str>,
    paths: Vec<String>,
) -> Result<GitStatusView, String> {
    let target = target(state, project_id, worktree_id).await?;
    let workdir = target.path.clone();
    let _guard = state.git_guard.lock().await;
    git_blocking(move || {
        let repo = GitRepo::open(&workdir)?;
        repo.stage(&workdir, &paths)
    })
    .await?;
    let changes = read_changes(&target.path).await?;
    Ok(status_view(&target, changes))
}

/// 提交已暂存内容。
pub async fn commit(
    state: &AppState,
    project_id: &str,
    worktree_id: Option<&str>,
    message: String,
) -> Result<GitCommitView, String> {
    let target = target(state, project_id, worktree_id).await?;
    let workdir = target.path.clone();
    let _guard = state.git_guard.lock().await;
    let outcome = git_blocking(move || {
        let repo = GitRepo::open(&workdir)?;
        repo.commit(&workdir, &message)
    })
    .await?;
    let changes = read_changes(&target.path).await?;
    Ok(GitCommitView {
        hash: outcome.hash,
        short_hash: outcome.short_hash,
        subject: outcome.subject,
        status: status_view(&target, changes),
    })
}

/// 推送当前分支。失败时返回带 git stderr 的错误，磁盘与远端都不变。
pub async fn push(
    state: &AppState,
    project_id: &str,
    worktree_id: Option<&str>,
) -> Result<GitRemoteView, String> {
    remote(state, project_id, worktree_id, "push").await
}

/// 拉取（只快进）。失败时不产生合并提交。
pub async fn pull(
    state: &AppState,
    project_id: &str,
    worktree_id: Option<&str>,
) -> Result<GitRemoteView, String> {
    remote(state, project_id, worktree_id, "pull").await
}

async fn remote(
    state: &AppState,
    project_id: &str,
    worktree_id: Option<&str>,
    operation: &'static str,
) -> Result<GitRemoteView, String> {
    let target = target(state, project_id, worktree_id).await?;
    let workdir = target.path.clone();
    let _guard = state.git_guard.lock().await;
    let outcome = git_blocking(move || {
        let repo = GitRepo::open(&workdir)?;
        if operation == "push" {
            repo.push(&workdir)
        } else {
            repo.pull(&workdir)
        }
    })
    .await?;
    let changes = read_changes(&target.path).await?;
    Ok(GitRemoteView {
        operation: operation.to_owned(),
        // 输出已在 Git 事实层按 MAX_REMOTE_OUTPUT_CHARS 裁剪，这里不再二次加工。
        output: outcome.output,
        status: status_view(&target, changes),
    })
}
