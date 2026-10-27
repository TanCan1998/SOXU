//! 资源监控的稳定错误码。
//!
//! 错误码是给 UI、日志与验收证据使用的机器可读契约：字符串值一旦发布不可更改。
//! 采样失败**不会**导致任何释放动作，只会降级为诊断信息。

use std::fmt;

/// 稳定错误码，只能追加，不能改名或复用。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[non_exhaustive]
pub enum ErrorCode {
    /// 当前平台没有可用的指标来源（如 macOS 未实现）。
    PlatformUnsupported,
    /// 进程已退出或不存在。
    ProcessUnavailable,
    /// 权限不足（例如读不到 /proc/<pid>/smaps_rollup）。
    PermissionDenied,
    /// 进程树快照不可用。
    SnapshotFailed,
    /// 不支持裁剪工作集。
    TrimUnsupported,
    /// 预算配置自相矛盾。
    InvalidBudget,
    /// 其它 IO 失败。
    IoFailure,
}

impl ErrorCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::PlatformUnsupported => "E_PLATFORM_UNSUPPORTED",
            Self::ProcessUnavailable => "E_PROCESS_UNAVAILABLE",
            Self::PermissionDenied => "E_PERMISSION_DENIED",
            Self::SnapshotFailed => "E_SNAPSHOT_FAILED",
            Self::TrimUnsupported => "E_TRIM_UNSUPPORTED",
            Self::InvalidBudget => "E_INVALID_BUDGET",
            Self::IoFailure => "E_IO_FAILURE",
        }
    }

    /// 调用方能否在下一个采样周期重试而不修改任何状态。
    pub const fn is_recoverable(self) -> bool {
        matches!(
            self,
            Self::ProcessUnavailable | Self::PermissionDenied | Self::SnapshotFailed
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
pub struct MonitorError {
    code: ErrorCode,
    context: String,
    detail: Option<String>,
}

impl MonitorError {
    pub fn new(code: ErrorCode, context: impl Into<String>) -> Self {
        Self {
            code,
            context: context.into(),
            detail: None,
        }
    }

    pub fn with_detail(
        code: ErrorCode,
        context: impl Into<String>,
        detail: impl Into<String>,
    ) -> Self {
        Self {
            code,
            context: context.into(),
            detail: Some(detail.into()),
        }
    }

    /// 保留系统 IO 错误的 kind 与 message，便于诊断；不包含进程环境内容。
    pub fn io(code: ErrorCode, context: impl Into<String>, error: &std::io::Error) -> Self {
        Self::with_detail(code, context, format!("{}: {error}", error.kind()))
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

impl fmt::Display for MonitorError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.detail {
            Some(detail) => write!(formatter, "{}: {} ({detail})", self.code, self.context),
            None => write!(formatter, "{}: {}", self.code, self.context),
        }
    }
}

impl std::error::Error for MonitorError {}

pub type Result<T> = std::result::Result<T, MonitorError>;
