//! 稳定错误码：字符串只追加不修改，前端与日志都按它判定。

use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PtyErrorCode {
    /// 目标 ptyId 不在注册表里（已关闭或从未创建）。
    UnknownSession,
    /// 同时打开的终端数达到上限。
    SessionLimitReached,
    /// 行列数非法（0 或超过上限）。
    InvalidSize,
    /// shell 不在白名单内，或不是裸程序名。
    InvalidShell,
    /// 创建 PTY 或拉起子进程失败。
    SpawnFailed,
    /// 写入子进程失败。
    WriteFailed,
    /// 调整窗口大小失败。
    ResizeFailed,
    /// 会话已关闭，后续操作一律拒绝。
    Closed,
}

impl PtyErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::UnknownSession => "E_PTY_UNKNOWN_SESSION",
            Self::SessionLimitReached => "E_PTY_SESSION_LIMIT",
            Self::InvalidSize => "E_PTY_INVALID_SIZE",
            Self::InvalidShell => "E_PTY_INVALID_SHELL",
            Self::SpawnFailed => "E_PTY_SPAWN_FAILED",
            Self::WriteFailed => "E_PTY_WRITE_FAILED",
            Self::ResizeFailed => "E_PTY_RESIZE_FAILED",
            Self::Closed => "E_PTY_CLOSED",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PtyError {
    code: PtyErrorCode,
    message: String,
}

impl PtyError {
    pub fn new(code: PtyErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn code(&self) -> PtyErrorCode {
        self.code
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Display for PtyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code.as_str(), self.message)
    }
}

impl std::error::Error for PtyError {}

pub type Result<T> = std::result::Result<T, PtyError>;
