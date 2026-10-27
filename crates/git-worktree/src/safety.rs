//! 破坏性操作的安全闸门：删除工作树、清理失效管理记录。
//!
//! 三条不可让步的规则（对应 TASK-005 验收标准）：
//! 1. **自动清理不存在**：删除必须由调用方显式发起，并带上与当前状态绑定的确认令牌；
//! 2. **脏/冲突/加锁/活跃的工作树永不删除**：有任一 blocker 就拒绝，绝不传 --force；
//! 3. **失败可恢复**：拒绝只返回稳定错误码，磁盘与 git 元数据保持原样；
//!    状态在确认之后发生变化时返回 E_GIT_CONFIRMATION_STALE，要求重新规划。
//!
//! 本 crate **不执行** reset、checkout -f、clean、回滚或自动 prune：
//! prune 也需要独立确认，且只清理 git 自己标记为 prunable 的管理记录。

use std::fmt;
use std::path::{Path, PathBuf};

use crate::error::{GitError, GitErrorCode, Result};
use crate::repo::{GitRepo, normalize_path};
use crate::worktree::WorktreeEntry;

/// 阻止破坏性操作的原因。上层（会话层）可以追加 ActiveRuntime。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[non_exhaustive]
pub enum RemovalBlocker {
    /// 主工作树：产品永不删除项目的根工作树。
    Primary,
    /// 工作树目录已不存在（异常退出/手工删除），应走 prune 流程。
    PathMissing,
    /// 有未提交改动。
    Dirty,
    /// 存在未解决的合并冲突。
    Conflicted,
    /// index.lock 存在，说明有进程或崩溃残留持有索引锁。
    IndexLocked,
    /// 有进行中的多步 Git 操作（merge / rebase / cherry-pick 等）。
    OperationInProgress,
    /// git worktree lock 锁定（通常表示有 Agent 正在使用）。
    GitLocked,
    /// git 已标记 prunable。
    Prunable,
    /// 该工作树下仍有活跃运行时（由会话层判定并追加）。
    ActiveRuntime,
    /// 路径不在本仓库的工作树清单里。
    Unmanaged,
}

impl RemovalBlocker {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Primary => "primary",
            Self::PathMissing => "path_missing",
            Self::Dirty => "dirty",
            Self::Conflicted => "conflicted",
            Self::IndexLocked => "index_locked",
            Self::OperationInProgress => "operation_in_progress",
            Self::GitLocked => "git_locked",
            Self::Prunable => "prunable",
            Self::ActiveRuntime => "active_runtime",
            Self::Unmanaged => "unmanaged",
        }
    }

    /// 面向用户的简短说明。
    pub const fn describe(self) -> &'static str {
        match self {
            Self::Primary => "主工作树不允许删除",
            Self::PathMissing => "工作树目录不存在，请改用清理失效记录",
            Self::Dirty => "存在未提交改动，请先提交或自行处理",
            Self::Conflicted => "存在未解决的合并冲突",
            Self::IndexLocked => "索引被锁定（index.lock）",
            Self::OperationInProgress => "有进行中的 Git 操作（merge / rebase 等）",
            Self::GitLocked => "工作树被 git lock 锁定",
            Self::Prunable => "git 已标记该工作树失效",
            Self::ActiveRuntime => "该工作树下仍有活跃 Agent 会话",
            Self::Unmanaged => "该路径不是本仓库登记的工作树",
        }
    }
}

impl fmt::Display for RemovalBlocker {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// 删除计划：既是执行凭据（token），也是拒绝理由的载体。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemovePlan {
    pub worktree: String,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub dirty: bool,
    pub conflicts: Vec<String>,
    pub index_locked: bool,
    pub git_locked: Option<String>,
    pub operation: Option<String>,
    pub blockers: Vec<RemovalBlocker>,
    /// 与工作树当前状态绑定的确认令牌；状态一变就失效。
    pub token: String,
}

impl RemovePlan {
    pub fn removable(&self) -> bool {
        self.blockers.is_empty()
    }

    /// 追加 blocker（上层用于注入 ActiveRuntime 等跨层信息）。
    /// 只会收紧权限，不会放宽：token 仍然只由 git 状态决定。
    pub fn with_blocker(mut self, blocker: RemovalBlocker) -> Self {
        if !self.blockers.contains(&blocker) {
            self.blockers.push(blocker);
        }
        self
    }

    /// 第一条拒绝原因，供 UI 展示。
    pub fn first_blocker(&self) -> Option<RemovalBlocker> {
        self.blockers.first().copied()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemovalOutcome {
    pub worktree: String,
    pub branch: Option<String>,
}

/// 失效管理记录的清理计划（git worktree prune）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrunePlan {
    pub stale: Vec<String>,
    pub token: String,
}

impl GitRepo {
    /// 规划删除：只读，不触碰磁盘。removable() 为假时必须拒绝执行。
    pub fn plan_remove(&self, worktree: &Path) -> Result<RemovePlan> {
        let entry = self.worktree(worktree)?;
        Ok(self.plan_from_entry(&entry))
    }

    /// 用已枚举的 entry 规划，避免上层重复调用 git worktree list。
    pub fn plan_from_entry(&self, entry: &WorktreeEntry) -> RemovePlan {
        let path = PathBuf::from(&entry.path);
        let mut blockers: Vec<RemovalBlocker> = Vec::new();
        fn push(blocker: RemovalBlocker, list: &mut Vec<RemovalBlocker>) {
            if !list.contains(&blocker) {
                list.push(blocker);
            }
        }
        if entry.primary {
            push(RemovalBlocker::Primary, &mut blockers);
        }
        if entry.prunable.is_some() {
            push(RemovalBlocker::Prunable, &mut blockers);
        }
        if entry.locked.is_some() {
            push(RemovalBlocker::GitLocked, &mut blockers);
        }
        let mut index_locked = false;
        let status = if path.is_dir() {
            match self.inspect_status(&path) {
                Ok(value) => Some(value),
                Err(error) => {
                    // 读不到状态通常是索引被锁：状态未知时按被锁处理，不放宽权限。
                    if error.code() == GitErrorCode::IndexLocked {
                        index_locked = true;
                        push(RemovalBlocker::IndexLocked, &mut blockers);
                    }
                    None
                }
            }
        } else {
            push(RemovalBlocker::PathMissing, &mut blockers);
            None
        };
        let dirty = status.as_ref().is_some_and(|value| value.dirty());
        let conflicts: Vec<String> = status
            .as_ref()
            .map(|value| {
                value
                    .conflicts
                    .iter()
                    .map(|conflict| conflict.path.clone())
                    .collect()
            })
            .unwrap_or_default();
        if status
            .as_ref()
            .is_some_and(|value| value.index_lock.is_some())
        {
            index_locked = true;
        }
        let operation = status.as_ref().and_then(|value| value.operation.clone());
        if dirty {
            push(RemovalBlocker::Dirty, &mut blockers);
        }
        if !conflicts.is_empty() {
            push(RemovalBlocker::Conflicted, &mut blockers);
        }
        if index_locked {
            push(RemovalBlocker::IndexLocked, &mut blockers);
        }
        if operation.is_some() {
            push(RemovalBlocker::OperationInProgress, &mut blockers);
        }
        blockers.sort();
        let token = state_token(
            entry,
            dirty,
            conflicts.len(),
            index_locked,
            operation.is_some(),
        );
        RemovePlan {
            worktree: normalize_path(&path),
            branch: entry.branch.clone(),
            head: entry.head.clone(),
            dirty,
            conflicts,
            index_locked,
            git_locked: entry.locked.clone(),
            operation,
            blockers,
            token,
        }
    }

    /// 执行删除。必须同时满足：令牌匹配当前状态、计划无 blocker。
    pub fn remove_worktree(&self, plan: &RemovePlan, confirmation: &str) -> Result<RemovalOutcome> {
        let confirmation = confirmation.trim();
        if confirmation.is_empty() {
            return Err(GitError::new(
                GitErrorCode::ConfirmationRequired,
                "删除工作树需要显式确认令牌",
            ));
        }
        if confirmation != plan.token {
            return Err(GitError::new(
                GitErrorCode::ConfirmationStale,
                format!("确认令牌与当前计划不匹配：{}", plan.worktree),
            )
            .with_detail("请重新检查状态并获取新的令牌"));
        }
        let current = self.plan_remove(Path::new(&plan.worktree))?;
        if current.token != plan.token {
            return Err(GitError::new(
                GitErrorCode::ConfirmationStale,
                format!("工作树状态已变化，请重新检查后再确认：{}", plan.worktree),
            )
            .with_detail(format!("预期 {} 实际 {}", plan.token, current.token)));
        }
        if !current.blockers.is_empty() {
            return Err(removal_error(current.blockers[0]));
        }
        if !plan.blockers.is_empty() {
            return Err(removal_error(plan.blockers[0]));
        }
        // 绝不加 --force：没有 blocker 时 git 自己也会拒绝脏工作树。
        let path_text = plan.worktree.clone();
        self.runner().capture_ok(
            self.root(),
            &["worktree", "remove", "--", path_text.as_str()],
            &crate::run::GitCall::write(),
        )?;
        let still_listed = self.worktrees()?.iter().any(|entry| {
            normalize_path(Path::new(&entry.path)) == normalize_path(Path::new(&plan.worktree))
        });
        if still_listed {
            return Err(GitError::new(
                GitErrorCode::CommandFailed,
                format!("git worktree remove 后仍能枚举到工作树：{}", plan.worktree),
            ));
        }
        Ok(RemovalOutcome {
            worktree: plan.worktree.clone(),
            branch: plan.branch.clone(),
        })
    }

    /// 规划失效记录清理：只列出 git 标记 prunable 的条目。
    pub fn plan_prune(&self) -> Result<PrunePlan> {
        let stale: Vec<String> = self
            .worktrees()?
            .into_iter()
            .filter(|entry| entry.prunable.is_some())
            .map(|entry| entry.path)
            .collect();
        let token = hex16(fnv1a64_parts(&["prune", &stale.join("|")]));
        Ok(PrunePlan { stale, token })
    }

    /// 执行清理。只清理 git 已经认定为失效（目录不存在）的管理记录，不触碰任何真实工作树。
    pub fn prune(&self, plan: &PrunePlan, confirmation: &str) -> Result<usize> {
        if confirmation.trim().is_empty() {
            return Err(GitError::new(
                GitErrorCode::ConfirmationRequired,
                "清理失效工作树记录需要显式确认令牌",
            ));
        }
        if confirmation != plan.token {
            return Err(GitError::new(
                GitErrorCode::ConfirmationStale,
                "确认令牌与当前失效工作树清单不匹配",
            ));
        }
        let current = self.plan_prune()?;
        if current.token != plan.token {
            return Err(GitError::new(
                GitErrorCode::ConfirmationStale,
                "失效工作树清单已变化，请重新规划后再确认",
            ));
        }
        if plan.stale.is_empty() {
            return Ok(0);
        }
        self.runner()
            .write_ok(self.root(), &["worktree", "prune"])?;
        Ok(plan.stale.len())
    }
}

/// 把 blocker 翻译成稳定错误码；上层注入的 ActiveRuntime 映射为 E_GIT_WORKTREE_BUSY。
pub fn removal_error(blocker: RemovalBlocker) -> GitError {
    let code = match blocker {
        RemovalBlocker::Primary => GitErrorCode::WorktreePrimary,
        RemovalBlocker::PathMissing => GitErrorCode::WorktreePathMissing,
        RemovalBlocker::Dirty => GitErrorCode::WorktreeDirty,
        RemovalBlocker::Conflicted => GitErrorCode::WorktreeConflicted,
        RemovalBlocker::IndexLocked => GitErrorCode::IndexLocked,
        RemovalBlocker::OperationInProgress => GitErrorCode::OperationInProgress,
        RemovalBlocker::GitLocked => GitErrorCode::WorktreeLocked,
        RemovalBlocker::Prunable => GitErrorCode::WorktreePathMissing,
        RemovalBlocker::ActiveRuntime => GitErrorCode::WorktreeBusy,
        RemovalBlocker::Unmanaged => GitErrorCode::WorktreeUnknown,
    };
    GitError::new(code, blocker.describe()).with_detail(format!("blocker={}", blocker.as_str()))
}

fn state_token(
    entry: &WorktreeEntry,
    dirty: bool,
    conflicts: usize,
    index_locked: bool,
    operation: bool,
) -> String {
    hex16(fnv1a64_parts(&[
        "remove",
        &normalize_path(Path::new(&entry.path)),
        entry.head.as_deref().unwrap_or("-"),
        entry.branch.as_deref().unwrap_or("-"),
        if dirty { "dirty" } else { "clean" },
        &conflicts.to_string(),
        if index_locked { "locked" } else { "unlocked" },
        if operation { "busy" } else { "idle" },
        entry.locked.as_deref().unwrap_or("-"),
    ]))
}

fn fnv1a64_parts(parts: &[&str]) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for part in parts {
        for byte in part.as_bytes() {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x100_0000_01b3);
        }
        hash ^= 0xff;
        hash = hash.wrapping_mul(0x100_0000_01b3);
    }
    hash
}

fn hex16(value: u64) -> String {
    format!("{value:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_stable_and_state_sensitive() {
        let entry = WorktreeEntry {
            path: "F:/work/wt".to_owned(),
            head: Some("abc".to_owned()),
            branch: Some("feature".to_owned()),
            ..WorktreeEntry::default()
        };
        let clean = state_token(&entry, false, 0, false, false);
        assert_eq!(clean, state_token(&entry, false, 0, false, false));
        assert_ne!(clean, state_token(&entry, true, 0, false, false));
        assert_ne!(clean, state_token(&entry, false, 1, false, false));
        assert_eq!(clean.len(), 16);
    }

    #[test]
    fn blockers_render_stable_codes_and_recoverability() {
        assert_eq!(RemovalBlocker::Dirty.as_str(), "dirty");
        assert_eq!(
            removal_error(RemovalBlocker::Dirty).code(),
            GitErrorCode::WorktreeDirty
        );
        assert_eq!(
            removal_error(RemovalBlocker::ActiveRuntime).code(),
            GitErrorCode::WorktreeBusy
        );
        // 活跃运行时与索引锁可恢复；脏工作树必须由用户先处理。
        assert!(removal_error(RemovalBlocker::ActiveRuntime).recoverable());
        assert!(removal_error(RemovalBlocker::IndexLocked).recoverable());
        assert!(!removal_error(RemovalBlocker::Dirty).recoverable());
    }

    #[test]
    fn with_blocker_only_tightens() {
        let plan = RemovePlan {
            worktree: "wkt".to_owned(),
            branch: None,
            head: None,
            dirty: false,
            conflicts: Vec::new(),
            index_locked: false,
            git_locked: None,
            operation: None,
            blockers: Vec::new(),
            token: "0".repeat(16),
        };
        assert!(plan.removable());
        let blocked = plan.with_blocker(RemovalBlocker::ActiveRuntime);
        assert!(!blocked.removable());
        assert_eq!(blocked.first_blocker(), Some(RemovalBlocker::ActiveRuntime));
        let again = blocked.with_blocker(RemovalBlocker::ActiveRuntime);
        assert_eq!(again.blockers.len(), 1);
    }
}
