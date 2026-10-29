//! 会话目录与 JSONL 索引的稳定错误码。
//!
//! 错误码是给 UI、日志与验收证据使用的机器可读契约：字符串值一旦发布不可更改。
//! 说明文字（context）允许本地化与补充，不属于契约。

use std::fmt;

/// 稳定的错误码，只能追加，不能改名或复用。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[non_exhaustive]
pub enum ErrorCode {
    ProjectRootMissing,
    ProjectRootNotDirectory,
    ProjectUnknown,
    WorktreeUnknown,
    WorktreePathMissing,
    SessionUnknown,
    SessionFileMissing,
    SessionPathConflict,
    SessionAlreadyOwned,
    SessionRuntimeUnknown,
    StaleRuntimeGeneration,
    PageOutOfRange,
    SessionsRootUnavailable,
    MetadataCorrupt,
    IoFailure,
    TemporarySessionUnknown,
    TemporarySessionLimit,
    TemporarySessionUnpromotable,
    TemporarySessionFileInvalid,
    TemporarySessionFileConflict,
    TemporarySessionRuntimeActive,
    SearchQueryTooLong,
}

impl ErrorCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ProjectRootMissing => "E_PROJECT_ROOT_MISSING",
            Self::ProjectRootNotDirectory => "E_PROJECT_ROOT_NOT_DIRECTORY",
            Self::ProjectUnknown => "E_PROJECT_UNKNOWN",
            Self::WorktreeUnknown => "E_WORKTREE_UNKNOWN",
            Self::WorktreePathMissing => "E_WORKTREE_PATH_MISSING",
            Self::SessionUnknown => "E_SESSION_UNKNOWN",
            Self::SessionFileMissing => "E_SESSION_FILE_MISSING",
            Self::SessionPathConflict => "E_SESSION_PATH_CONFLICT",
            Self::SessionAlreadyOwned => "E_SESSION_ALREADY_OWNED",
            Self::SessionRuntimeUnknown => "E_SESSION_RUNTIME_UNKNOWN",
            Self::StaleRuntimeGeneration => "E_STALE_RUNTIME_GENERATION",
            Self::PageOutOfRange => "E_PAGE_OUT_OF_RANGE",
            Self::SessionsRootUnavailable => "E_SESSIONS_ROOT_UNAVAILABLE",
            Self::MetadataCorrupt => "E_METADATA_CORRUPT",
            Self::IoFailure => "E_IO_FAILURE",
            Self::TemporarySessionUnknown => "E_TEMPORARY_SESSION_UNKNOWN",
            Self::TemporarySessionLimit => "E_TEMPORARY_SESSION_LIMIT",
            Self::TemporarySessionUnpromotable => "E_TEMPORARY_SESSION_UNPROMOTABLE",
            Self::TemporarySessionFileInvalid => "E_TEMPORARY_SESSION_FILE_INVALID",
            Self::TemporarySessionFileConflict => "E_TEMPORARY_SESSION_FILE_CONFLICT",
            Self::TemporarySessionRuntimeActive => "E_TEMPORARY_SESSION_RUNTIME_ACTIVE",
            Self::SearchQueryTooLong => "E_SEARCH_QUERY_TOO_LONG",
        }
    }

    /// 调用方能否在不修改磁盘数据的前提下重试或回退。
    pub const fn is_recoverable(self) -> bool {
        matches!(
            self,
            Self::SessionFileMissing
                | Self::PageOutOfRange
                | Self::StaleRuntimeGeneration
                | Self::MetadataCorrupt
                | Self::SessionsRootUnavailable
                | Self::TemporarySessionLimit
                | Self::TemporarySessionUnpromotable
                | Self::TemporarySessionFileInvalid
                | Self::TemporarySessionRuntimeActive
                | Self::SearchQueryTooLong
        )
    }
}

impl fmt::Display for ErrorCode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// 结构化错误：稳定错误码 + 人类可读上下文 + 可选底层原因。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CatalogError {
    code: ErrorCode,
    context: String,
    detail: Option<String>,
}

impl CatalogError {
    pub fn new(code: ErrorCode, context: impl Into<String>) -> Self {
        Self {
            code,
            context: context.into(),
            detail: None,
        }
    }

    /// 包装系统 IO 错误，保留原始 kind 与 message 便于诊断。
    pub fn io(code: ErrorCode, context: impl Into<String>, error: &std::io::Error) -> Self {
        Self {
            code,
            context: context.into(),
            detail: Some(format!("{}: {error}", error.kind())),
        }
    }

    pub fn code(&self) -> ErrorCode {
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

impl fmt::Display for CatalogError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.detail {
            Some(detail) => write!(formatter, "{}: {} ({detail})", self.code, self.context),
            None => write!(formatter, "{}: {}", self.code, self.context),
        }
    }
}

impl std::error::Error for CatalogError {}

pub type Result<T> = std::result::Result<T, CatalogError>;
