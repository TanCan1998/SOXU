//! Git 工作树服务的稳定错误码。
//!
//! 错误码是给 UI、日志与验收证据使用的机器可读契约：字符串值一旦发布不可更改，
//! 只能追加。说明文字（context / detail）允许本地化与补充，不属于契约。
//!
//! 本 crate 只做只读检查与**显式确认后才执行**的少量变更（创建、删除、prune）；
//! 每个错误码都标注调用方能否在不修改磁盘数据的前提下重试或回退。

use std::fmt;

/// 稳定的错误码。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[non_exhaustive]
pub enum GitErrorCode {
    RepoMissing,
    RepoNotWorkTree,
    GitUnavailable,
    CommandFailed,
    CommandTimeout,
    WorktreeUnknown,
    WorktreePathMissing,
    WorktreePrimary,
    WorktreeDirty,
    WorktreeLocked,
    WorktreeConflicted,
    WorktreeBusy,
    IndexLocked,
    OperationInProgress,
    BranchInUse,
    BranchInvalid,
    BranchExists,
    PathExists,
    PathNotAbsolute,
    PathInsideRepo,
    PathOutsideRoot,
    ConfirmationRequired,
    ConfirmationStale,
    IoFailure,
}

impl GitErrorCode {
    pub const fn as_str(self) -> &'static str {
        use GitErrorCode::{
            BranchExists, BranchInUse, BranchInvalid, CommandFailed, CommandTimeout,
            ConfirmationRequired, ConfirmationStale, GitUnavailable, IndexLocked, IoFailure,
            OperationInProgress, PathExists, PathInsideRepo, PathNotAbsolute, PathOutsideRoot,
            RepoMissing, RepoNotWorkTree, WorktreeBusy, WorktreeConflicted, WorktreeDirty,
            WorktreeLocked, WorktreePathMissing, WorktreePrimary, WorktreeUnknown,
        };
        match self {
            RepoMissing => "E_GIT_REPO_MISSING",
            RepoNotWorkTree => "E_GIT_NOT_WORKTREE",
            GitUnavailable => "E_GIT_UNAVAILABLE",
            CommandFailed => "E_GIT_COMMAND_FAILED",
            CommandTimeout => "E_GIT_COMMAND_TIMEOUT",
            WorktreeUnknown => "E_GIT_WORKTREE_UNKNOWN",
            WorktreePathMissing => "E_GIT_WORKTREE_PATH_MISSING",
            WorktreePrimary => "E_GIT_WORKTREE_PRIMARY",
            WorktreeDirty => "E_GIT_WORKTREE_DIRTY",
            WorktreeLocked => "E_GIT_WORKTREE_LOCKED",
            WorktreeConflicted => "E_GIT_WORKTREE_CONFLICTED",
            WorktreeBusy => "E_GIT_WORKTREE_BUSY",
            IndexLocked => "E_GIT_INDEX_LOCKED",
            OperationInProgress => "E_GIT_OPERATION_IN_PROGRESS",
            BranchInUse => "E_GIT_BRANCH_IN_USE",
            BranchInvalid => "E_GIT_BRANCH_INVALID",
            BranchExists => "E_GIT_BRANCH_EXISTS",
            PathExists => "E_GIT_PATH_EXISTS",
            PathNotAbsolute => "E_GIT_PATH_NOT_ABSOLUTE",
            PathInsideRepo => "E_GIT_PATH_INSIDE_REPO",
            PathOutsideRoot => "E_GIT_PATH_OUTSIDE_ROOT",
            ConfirmationRequired => "E_GIT_CONFIRMATION_REQUIRED",
            ConfirmationStale => "E_GIT_CONFIRMATION_STALE",
            IoFailure => "E_GIT_IO_FAILURE",
        }
    }

    /// 调用方能否在不修改磁盘数据的前提下重试或回退。
    pub const fn is_recoverable(self) -> bool {
        use GitErrorCode::{
            BranchInUse, ConfirmationRequired, ConfirmationStale, IndexLocked,
            OperationInProgress, WorktreeBusy, WorktreeUnknown,
        };
        matches!(
            self,
            IndexLocked | OperationInProgress | ConfirmationRequired | ConfirmationStale
                | WorktreeBusy | BranchInUse | WorktreeUnknown
        )
    }
}

impl fmt::Display for GitErrorCode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// 结构化错误：稳定错误码 + 人类可读上下文 + 可选底层原因。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitError {
    code: GitErrorCode,
    context: String,
    detail: Option<String>,
}

impl GitError {
    pub fn new(code: GitErrorCode, context: impl Into<String>) -> Self {
        Self {
            code,
            context: context.into(),
            detail: None,
        }
    }

    /// 补充底层原因（git stderr、文件系统错误种类）。空字符串会被忽略。
    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        let detail = detail.into();
        if !detail.trim().is_empty() {
            self.detail = Some(detail);
        }
        self
    }

    /// 包装系统 IO 错误，保留原始 kind 与 message 便于诊断。
    pub fn io(code: GitErrorCode, context: impl Into<String>, error: &std::io::Error) -> Self {
        Self {
            code,
            context: context.into(),
            detail: Some(format!("{}: {error}", error.kind())),
        }
    }

    pub fn code(&self) -> GitErrorCode {
        self.code
    }

    pub fn context(&self) -> &str {
        &self.context
    }

    pub fn detail(&self) -> Option<&str> {
        self.detail.as_deref()
    }

    pub fn recoverable(&self) -> bool {
        self.code.is_recoverable()
    }
}

impl fmt::Display for GitError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.detail {
            Some(detail) => write!(formatter, "{}: {} ({detail})", self.code, self.context),
            None => write!(formatter, "{}: {}", self.code, self.context),
        }
    }
}

impl std::error::Error for GitError {}

pub type Result<T> = std::result::Result<T, GitError>;
