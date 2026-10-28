//! 结构化错误：上层可以按变体分支，不需要解析字符串。

use crate::state::{IllegalTransition, RuntimeState};

pub type SupervisorResult<T> = Result<T, SupervisorError>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SupervisorError {
    /// sessionId 为空或全是空白。
    EmptySessionId,
    /// 子进程拉起失败（程序不存在、argv 非法等）。
    Spawn { program: String, detail: String },
    /// 子进程缺少标准管道，说明 spawn 配置被破坏。
    MissingPipe(&'static str),
    /// 启动握手在预算内没有完成。
    HandshakeTimeout { runtime_id: String, timeout_ms: u64 },
    /// 命令在预算内没有收到 response。
    ResponseTimeout { request_id: String, timeout_ms: u64 },
    /// 等待事件超时。
    EventTimeout { timeout_ms: u64 },
    /// 同一个 request id 还在等待时被重复使用。
    DuplicateRequestId { request_id: String },
    /// pending 通道在 response 到达前被丢弃（进程退出、断流）。
    RequestChannelClosed { request_id: String },
    /// stdin 已关闭，命令无法写入。
    StdinClosed {
        runtime_id: String,
        state: RuntimeState,
    },
    /// 运行时不可接收新命令。
    RuntimeNotRunning {
        runtime_id: String,
        state: RuntimeState,
    },
    /// 未知 runtime id。
    UnknownRuntime { runtime_id: String },
    /// 旧 generation 的 handle 已被新运行时代替。
    Superseded {
        session_id: String,
        generation: u64,
        active_generation: u64,
    },
    /// 状态机拒绝了迁移。
    IllegalTransition(IllegalTransition),
    /// 线协议编码失败。
    Protocol(String),
    /// 运行时在静默等待中结束（例如 agent 异常退出）。
    RuntimeEnded { runtime_id: String },
    /// 有界重试预算已耗尽：不得自动继续，必须暂停并等人工恢复。
    RetryBudgetExhausted { attempts: u32, last: String },
    /// 用户在重试窗口内中止：立即停止重试，不得再拉起子进程。
    RetryCancelled { attempts: u32 },
    /// 进程在预算内既没有退出也没有被回收。
    ShutdownTimeout { runtime_id: String },
    /// 等待退出通知超时。
    ExitTimeout { runtime_id: String },
}

impl SupervisorError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::EmptySessionId => "empty_session_id",
            Self::Spawn { .. } => "spawn_failed",
            Self::MissingPipe(_) => "missing_pipe",
            Self::HandshakeTimeout { .. } => "handshake_timeout",
            Self::ResponseTimeout { .. } => "response_timeout",
            Self::EventTimeout { .. } => "event_timeout",
            Self::DuplicateRequestId { .. } => "duplicate_request_id",
            Self::RequestChannelClosed { .. } => "request_channel_closed",
            Self::StdinClosed { .. } => "stdin_closed",
            Self::RuntimeNotRunning { .. } => "runtime_not_running",
            Self::UnknownRuntime { .. } => "unknown_runtime",
            Self::Superseded { .. } => "superseded",
            Self::IllegalTransition(_) => "illegal_transition",
            Self::Protocol(_) => "protocol",
            Self::RuntimeEnded { .. } => "runtime_ended",
            Self::RetryBudgetExhausted { .. } => "retry_budget_exhausted",
            Self::RetryCancelled { .. } => "retry_cancelled",
            Self::ShutdownTimeout { .. } => "shutdown_timeout",
            Self::ExitTimeout { .. } => "exit_timeout",
        }
    }
}

impl std::fmt::Display for SupervisorError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::EmptySessionId => write!(formatter, "session id must not be empty"),
            Self::Spawn { program, detail } => {
                write!(formatter, "cannot spawn pi agent ({program}): {detail}")
            }
            Self::MissingPipe(pipe) => write!(formatter, "pi agent {pipe} pipe is unavailable"),
            Self::HandshakeTimeout {
                runtime_id,
                timeout_ms,
            } => write!(
                formatter,
                "runtime {runtime_id} did not complete the rpc handshake in {timeout_ms}ms"
            ),
            Self::ResponseTimeout {
                request_id,
                timeout_ms,
            } => write!(
                formatter,
                "request {request_id} received no response in {timeout_ms}ms"
            ),
            Self::EventTimeout { timeout_ms } => {
                write!(formatter, "no supervisor event arrived in {timeout_ms}ms")
            }
            Self::DuplicateRequestId { request_id } => {
                write!(formatter, "request id {request_id} is already in flight")
            }
            Self::RequestChannelClosed { request_id } => write!(
                formatter,
                "request {request_id} was dropped before a response arrived"
            ),
            Self::StdinClosed { runtime_id, state } => write!(
                formatter,
                "runtime {runtime_id} stdin is closed (state {})",
                state.as_str()
            ),
            Self::RuntimeNotRunning { runtime_id, state } => write!(
                formatter,
                "runtime {runtime_id} cannot accept commands in state {}",
                state.as_str()
            ),
            Self::UnknownRuntime { runtime_id } => {
                write!(formatter, "unknown runtime {runtime_id}")
            }
            Self::Superseded {
                session_id,
                generation,
                active_generation,
            } => write!(
                formatter,
                "generation {generation} of session {session_id} was superseded by {active_generation}"
            ),
            Self::IllegalTransition(transition) => write!(formatter, "{transition}"),
            Self::Protocol(detail) => write!(formatter, "pi rpc protocol error: {detail}"),
            Self::RuntimeEnded { runtime_id } => {
                write!(
                    formatter,
                    "runtime {runtime_id} ended before the awaited event"
                )
            }
            Self::RetryBudgetExhausted { attempts, last } => write!(
                formatter,
                "retry budget exhausted after {attempts} automatic retries (last failure: {last})"
            ),
            Self::RetryCancelled { attempts } => write!(
                formatter,
                "retry cancelled by the user after {attempts} automatic retries"
            ),
            Self::ShutdownTimeout { runtime_id } => {
                write!(formatter, "runtime {runtime_id} did not shut down in time")
            }
            Self::ExitTimeout { runtime_id } => {
                write!(
                    formatter,
                    "runtime {runtime_id} exit was not observed in time"
                )
            }
        }
    }
}

impl std::error::Error for SupervisorError {}

impl From<IllegalTransition> for SupervisorError {
    fn from(value: IllegalTransition) -> Self {
        Self::IllegalTransition(value)
    }
}

impl From<soxu_pi_protocol::ProtocolError> for SupervisorError {
    fn from(value: soxu_pi_protocol::ProtocolError) -> Self {
        Self::Protocol(value.to_string())
    }
}
