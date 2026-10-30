//! 工作树集成：Git 事实与会话目录引用的唯一装配点。
//!
//! 分层：commands（IPC）→ worktree（本文件，身份映射 + 安全闸门）→ soxu-git-worktree（Git）
//! 与 soxu-session-index（ProjectId / WorktreeId / SessionId 引用）。
//!
//! 三条规则：
//! 1. 枚举只增引用：发现新工作树就登记，失效只标记 `missing`，从不删除目录或会话文件。
//! 2. 破坏性操作串行化：`state.worktree_guard` + 工作树删除期间持会话目录锁，
//!    与 `claim_writable` 互斥，避免「确认后又有 Agent 挂上来」。
//! 3. 危险操作只返回稳定错误码：拒绝时磁盘与 git 元数据保持原样。

use std::path::{Path, PathBuf};

use soxu_git_worktree::{
    CreateRequest, DiffOptions, GitRepo, RemovalBlocker, RemovePlan, WorktreeEntry, WorktreeStatus,
    normalize_path, removal_error,
};
use soxu_session_index::{ProjectCatalog, ProjectId, WorktreeId};

use crate::dto::{
    CreateWorktreeInput, WorktreeDiffFile, WorktreeDiffView, WorktreeRemovalView, WorktreeSummary,
    WorktreeWorkspace,
};
use crate::git::git_blocking;
use crate::state::AppState;

/// 单个工作树的 Git 事实（在阻塞线程里一次性取回）。
struct WorktreeFacts {
    entry: WorktreeEntry,
    status: Option<WorktreeStatus>,
    plan: RemovePlan,
}

async fn project_root(state: &AppState, project: &ProjectId) -> Result<PathBuf, String> {
    let catalog = state.catalog.lock().await;
    let record = catalog
        .project(project)
        .ok_or_else(|| format!("E_PROJECT_UNKNOWN: 项目未注册：{project}"))?;
    Ok(PathBuf::from(&record.root))
}

async fn open_repo(state: &AppState, project: &ProjectId) -> Result<(GitRepo, PathBuf), String> {
    let root = project_root(state, project).await?;
    let for_open = root.clone();
    let repo = git_blocking(move || GitRepo::open(for_open)).await?;
    Ok((repo, root))
}

/// 枚举 + 登记 + 汇总。只读 Git 状态；对目录只新增引用与失效标记。
pub async fn list(state: &AppState, project_id: &str) -> Result<WorktreeWorkspace, String> {
    let project = ProjectId::new(project_id);
    let (repo, root) = open_repo(state, &project).await?;
    let listed = {
        let repo = repo.clone();
        git_blocking(move || repo.worktrees()).await?
    };

    // 1. Git 发现的新工作树登记进会话目录；失效只标记 missing。
    {
        let mut catalog = state.catalog.lock().await;
        for entry in &listed {
            let path = PathBuf::from(&entry.path);
            let id = WorktreeId::derive(&project, &path);
            let registered = catalog
                .project(&project)
                .and_then(|record| record.worktree(&id))
                .is_some();
            let usable = path.is_dir() && !entry.bare;
            if !registered
                && usable
                && let Err(error) = catalog.add_worktree(&project, &path, entry.branch.as_deref())
            {
                // 登记失败不隐藏工作树本身：视图仍会展示，只是没有会话关联。
                eprintln!("SOXU: 工作树登记失败（{error}）");
            }
            if (registered || usable)
                && let Err(error) = catalog.update_worktree(
                    &project,
                    &id,
                    entry.branch.as_deref(),
                    entry.prunable.is_some() || !usable,
                )
            {
                eprintln!("SOXU: 工作树状态回填失败（{error}）");
            }
        }
        let _ = catalog.save_if_dirty();
    }

    // 2. 取回 Git 事实：状态 + 删除计划（只读）。
    let entries: Vec<WorktreeEntry> = listed.to_vec();
    let facts = {
        let repo = repo.clone();
        git_blocking(move || {
            Ok(entries
                .into_iter()
                .map(|entry| facts_for(&repo, entry))
                .collect::<Vec<_>>())
        })
        .await?
    };
    let prune = {
        let repo = repo.clone();
        git_blocking(move || repo.plan_prune()).await?
    };

    // 3. 叠加会话关联与活跃运行时信息。
    let worktrees = {
        let catalog = state.catalog.lock().await;
        facts
            .iter()
            .map(|facts| {
                let id = WorktreeId::derive(&project, Path::new(&facts.entry.path));
                summarize(&catalog, &project, &id, facts)
            })
            .collect()
    };

    Ok(WorktreeWorkspace {
        project_id: project.to_string(),
        root: root.to_string_lossy().to_string(),
        worktrees,
        stale: prune.stale,
        prune_token: prune.token,
    })
}

/// 计划删除（只读）：返回带令牌与 blocker 的视图，供 UI 展示确认内容。
pub async fn plan_removal(
    state: &AppState,
    project_id: &str,
    worktree_id: &str,
) -> Result<WorktreeSummary, String> {
    let workspace = list(state, project_id).await?;
    workspace
        .worktrees
        .into_iter()
        .find(|view| view.id == worktree_id)
        .ok_or_else(|| format!("E_GIT_WORKTREE_UNKNOWN: 工作树未登记：{worktree_id}"))
}

/// 创建（附加）工作树。路径边界、分支可用性与索引锁全部先检查。
pub async fn create(
    state: &AppState,
    project_id: &str,
    input: CreateWorktreeInput,
) -> Result<WorktreeSummary, String> {
    let project = ProjectId::new(project_id);
    let (repo, root) = open_repo(state, &project).await?;
    let branch = input.branch.trim().to_owned();
    if branch.is_empty() {
        return Err("E_GIT_BRANCH_INVALID: 分支名不能为空".to_owned());
    }
    let allowed_root = root
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "E_GIT_PATH_OUTSIDE_ROOT: 项目根目录没有父目录".to_owned())?;
    let destination = match input
        .path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(path) => PathBuf::from(path),
        None => default_worktree_path(&root, &branch)?,
    };
    let mut request = if input.new_branch {
        CreateRequest::new_branch(destination.clone(), branch.clone())
    } else {
        CreateRequest::existing(destination.clone(), branch.clone())
    }
    .inside(&allowed_root);
    if let Some(base) = input
        .base
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        request = request.with_base(base);
    }

    let guard = state.worktree_guard.lock().await;
    let created = {
        let repo = repo.clone();
        git_blocking(move || repo.create_worktree(&request)).await?
    };
    let path = PathBuf::from(&created.path);
    let id = WorktreeId::derive(&project, &path);
    {
        let mut catalog = state.catalog.lock().await;
        let registered = catalog.add_worktree(&project, &path, created.branch.as_deref());
        if let Ok(record) = &registered {
            // git 返回的是规范化路径，而 Pi 按用户请求的路径写会话目录：把原文补记为别名。
            catalog.remember_worktree_alias(&project, &record.id, &destination);
        }
        if let Err(error) = &registered {
            eprintln!("SOXU: 新工作树登记失败（{error}）");
        }
        // 用登记记录里的 id：它由规范化路径派生，短名/符号链接下才和会话目录一致。
        let id = registered.map(|record| record.id).unwrap_or(id);
        if let Err(error) = catalog.update_worktree(&project, &id, created.branch.as_deref(), false)
        {
            eprintln!("SOXU: 新工作树状态回填失败（{error}）");
        }
        let _ = catalog.save_if_dirty();
    }
    drop(guard);

    // 重新枚举一次：让返回值与列表使用同一份事实，避免两套汇总逻辑。
    let workspace = list(state, project_id).await?;
    workspace
        .worktrees
        .into_iter()
        .find(|view| normalize_path(Path::new(&view.path)) == normalize_path(&path))
        .ok_or_else(|| {
            format!(
                "E_GIT_WORKTREE_UNKNOWN: 创建工作树后未能枚举到它：{}",
                path.display()
            )
        })
}

/// Diff 预览：只读、有界，未跟踪文件由 status 的 untracked 列表提示。
pub async fn preview_diff(
    state: &AppState,
    project_id: &str,
    worktree_id: &str,
    staged: bool,
) -> Result<WorktreeDiffView, String> {
    let project = ProjectId::new(project_id);
    let id = WorktreeId::new(worktree_id);
    let (repo, _root) = open_repo(state, &project).await?;
    let path = {
        let catalog = state.catalog.lock().await;
        catalog
            .project(&project)
            .and_then(|record| record.worktree(&id))
            .map(|record| PathBuf::from(&record.path))
            .ok_or_else(|| format!("E_WORKTREE_UNKNOWN: 工作树未登记：{worktree_id}"))?
    };
    let options = if staged {
        DiffOptions::staged()
    } else {
        DiffOptions::default()
    };
    let preview = {
        let repo = repo.clone();
        git_blocking(move || repo.preview_diff(&path, &options)).await?
    };
    Ok(WorktreeDiffView {
        worktree_id: id.to_string(),
        staged,
        files: preview
            .files
            .into_iter()
            .map(|file| WorktreeDiffFile {
                status: file.status,
                path: file.path,
                added: file.added,
                removed: file.removed,
                binary: file.binary,
            })
            .collect(),
        total_files: preview.total_files,
        patch: preview.patch,
        truncated: preview.truncated,
        bytes_read: preview.bytes_read,
    })
}

/// 删除附加工作树。必须带令牌；持会话目录锁执行，防止确认后出现新的活跃运行时。
pub async fn remove(
    state: &AppState,
    project_id: &str,
    worktree_id: &str,
    token: &str,
) -> Result<WorktreeRemovalView, String> {
    let project = ProjectId::new(project_id);
    let id = WorktreeId::new(worktree_id);
    let token = token.trim().to_owned();
    if token.is_empty() {
        return Err("E_GIT_CONFIRMATION_REQUIRED: 删除工作树需要显式确认令牌".to_owned());
    }
    let (repo, _root) = open_repo(state, &project).await?;

    let _guard = state.worktree_guard.lock().await;
    // 先锁会话目录：与 claim_writable 互斥，确认期间不会出现新的运行时挂载。
    let mut catalog = state.catalog.lock().await;
    let record = catalog
        .project(&project)
        .and_then(|record| record.worktree(&id))
        .cloned()
        .ok_or_else(|| format!("E_WORKTREE_UNKNOWN: 工作树未登记：{worktree_id}"))?;
    let path = PathBuf::from(&record.path);
    let active: Vec<String> = catalog
        .sessions_in_worktree(&id)
        .iter()
        .filter(|session| session.runtime.is_some())
        .map(|session| session.id.to_string())
        .collect();

    let mut plan = {
        let repo = repo.clone();
        let for_plan = path.clone();
        git_blocking(move || repo.plan_remove(&for_plan)).await?
    };
    if !active.is_empty() {
        plan = plan.with_blocker(RemovalBlocker::ActiveRuntime);
    }
    if !plan.removable() {
        let blocker = plan.first_blocker().unwrap_or(RemovalBlocker::Unmanaged);
        return Err(removal_error(blocker).to_string());
    }
    let taken = {
        let repo = repo.clone();
        git_blocking(move || repo.remove_worktree(&plan, &token)).await?
    };
    let _ = catalog.update_worktree(&project, &id, None, true);
    let _ = catalog.save_if_dirty();
    drop(catalog);

    Ok(WorktreeRemovalView {
        project_id: project.to_string(),
        worktree_id: id.to_string(),
        path: taken.worktree,
        branch: taken.branch,
    })
}

/// 清理 git 已标记 prunable 的管理记录（异常退出后的恢复路径）。
pub async fn prune(state: &AppState, project_id: &str, token: &str) -> Result<usize, String> {
    let project = ProjectId::new(project_id);
    let token = token.trim().to_owned();
    if token.is_empty() {
        return Err("E_GIT_CONFIRMATION_REQUIRED: 清理失效工作树记录需要显式确认令牌".to_owned());
    }
    let (repo, _root) = open_repo(state, &project).await?;
    let _guard = state.worktree_guard.lock().await;
    let plan = {
        let repo = repo.clone();
        git_blocking(move || repo.plan_prune()).await?
    };
    let repo_for_prune = repo.clone();
    git_blocking(move || repo_for_prune.prune(&plan, &token)).await
}

fn facts_for(repo: &GitRepo, entry: WorktreeEntry) -> WorktreeFacts {
    let path = PathBuf::from(&entry.path);
    let status = if path.is_dir() && !entry.bare {
        repo.inspect_status(&path).ok()
    } else {
        None
    };
    let plan = repo.plan_from_entry(&entry);
    WorktreeFacts {
        entry,
        status,
        plan,
    }
}

fn summarize(
    catalog: &ProjectCatalog,
    project: &ProjectId,
    id: &WorktreeId,
    facts: &WorktreeFacts,
) -> WorktreeSummary {
    let sessions = catalog.sessions_in_worktree(id);
    let session_ids: Vec<String> = sessions
        .iter()
        .map(|session| session.id.to_string())
        .collect();
    let active: Vec<String> = sessions
        .iter()
        .filter(|session| session.runtime.is_some())
        .map(|session| session.id.to_string())
        .collect();
    // 跨层信息只能收紧权限：会话层判定活跃后追加 blocker，令牌仍由 Git 状态决定。
    let plan = if active.is_empty() {
        facts.plan.clone()
    } else {
        facts
            .plan
            .clone()
            .with_blocker(RemovalBlocker::ActiveRuntime)
    };
    let status = facts.status.as_ref();
    WorktreeSummary {
        id: id.to_string(),
        project_id: project.to_string(),
        path: facts.entry.path.clone(),
        name: worktree_name(&facts.entry.path),
        branch: facts.entry.branch.clone(),
        head: facts.entry.head.clone(),
        primary: facts.entry.primary,
        missing: facts.entry.prunable.is_some() || !Path::new(&facts.entry.path).is_dir(),
        locked: facts.entry.locked.clone(),
        prunable: facts.entry.prunable.clone(),
        dirty: status.map(WorktreeStatus::dirty).unwrap_or(plan.dirty),
        staged: status.map_or(0, |value| value.staged_count),
        unstaged: status.map_or(0, |value| value.unstaged_count),
        untracked: status.map_or(0, |value| value.untracked_count),
        conflicts: status.map_or(0, |value| value.conflict_count),
        changes_truncated: status.is_some_and(|value| value.truncated),
        index_locked: plan.index_locked,
        operation: status
            .and_then(|value| value.operation.clone())
            .or_else(|| plan.operation.clone()),
        session_ids,
        active_session_ids: active,
        blockers: plan
            .blockers
            .iter()
            .map(|blocker| blocker.as_str().to_owned())
            .collect(),
        removable: plan.removable(),
        token: plan.token,
    }
}

fn worktree_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_owned())
}

/// 默认目标：项目旁边的 <项目名>-worktrees/<分支 slug>，不写进项目目录本身。
fn default_worktree_path(root: &Path, branch: &str) -> Result<PathBuf, String> {
    let parent = root
        .parent()
        .ok_or_else(|| "E_GIT_PATH_OUTSIDE_ROOT: 项目根目录没有父目录".to_owned())?;
    let name = root
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "project".to_owned());
    let base = parent.join(format!("{name}-worktrees"));
    std::fs::create_dir_all(&base).map_err(|error| {
        format!(
            "E_GIT_IO_FAILURE: 无法创建工作树根目录 {}：{error}",
            base.display()
        )
    })?;
    Ok(base.join(slug(branch)))
}

/// 分支名里的路径分隔符等字符换成 '-'，保证目标目录名在各平台都合法。
fn slug(branch: &str) -> String {
    branch
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
                character
            } else {
                '-'
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_keeps_platform_safe_names() {
        assert_eq!(slug("agent/issue-5"), "agent-issue-5");
        assert_eq!(slug("feat.x_y"), "feat.x_y");
        assert_eq!(slug("a b"), "a-b");
    }

    #[test]
    fn worktree_name_falls_back_to_path() {
        assert_eq!(worktree_name("/work/repo"), "repo");
        assert_eq!(worktree_name("/"), "/");
    }
}
