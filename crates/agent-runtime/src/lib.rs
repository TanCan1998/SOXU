//! SOXU 产品侧 Pi RPC Supervisor（Rust/Tokio）。
//!
//! 与 automation/loop 的 Node 调度器无关：这里只负责「一个 Pi 子进程的生命周期」。
//!
//! 关键约束：
//! - 以持久化 sessionId 建模；runtimeId + generation 只是临时执行身份。
//! - 迟到事件必须按 generation 丢弃，旧会话不得污染新会话。
//! - 管道/子进程/监听器都有单一 owner，退出时释放，不留孤儿进程。
//!
//! 模块分工：`supervisor` 负责进程拉起、状态、停止与回收；`handle` 是上层使用的
//! 单运行时命令/事件接口；`connection` 是三条管道任务；`frame` 是 NDJSON 分帧；
//! `process` 只暴露「runtime + PID + 状态」给资源监控；`retry` 是网络超时的
//! 有界重试预算与「结果不确定」的副作用防护（纯逻辑，不做 IO）。

mod connection;
mod handle;
mod redact;

pub mod config;
pub mod error;
pub mod frame;
pub mod identity;
pub mod process;
pub mod retry;
pub mod shared;
pub mod state;
pub mod supervisor;

pub use config::{PiProgram, SECRET_ENV_VARS, SupervisorConfig};
pub use error::{SupervisorError, SupervisorResult};
pub use frame::{DEFAULT_MAX_FRAME_BYTES, FrameError, LineFramer};
pub use handle::RuntimeHandle;
pub use identity::RuntimeIdentity;
pub use process::RuntimeProcess;
pub use retry::{
    COST_NOTICE, FailureKind, FailureSignal, ReplayDecision, RetryCancel, RetryLedger, RetryPolicy,
    RetrySnapshot, RetryStateError, RetryStatus, SideEffectLedger, classify, classify_error,
    start_with_retry, start_with_retry_cancellable,
};
pub use shared::{ExitInfo, ExitReason, RuntimeDiagnostics, SupervisorEvent};
pub use state::{IllegalTransition, RuntimeState};
pub use supervisor::PiSupervisor;

pub use soxu_pi_protocol::{
    EVENT_AGENT_SETTLED, Inbound, PiCommand, ProtocolError, RpcEvent, RpcResponse,
    StreamingBehavior, decode_inbound, encode_command,
};
