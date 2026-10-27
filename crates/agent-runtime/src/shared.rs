//! Supervisor 与读取/写入任务之间的共享状态。
//!
//! 单一 owner 约定：管道由 supervisor 拉起的任务持有，共享状态只放
//! 「需要跨任务观察」的部分（state、pending、事件出口、退出通知）。

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex as StdMutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde_json::Value;
use soxu_pi_protocol::{PiCommand, RpcResponse, encode_command};
use tokio::sync::{mpsc, oneshot, watch};

use crate::error::{SupervisorError, SupervisorResult};
use crate::identity::RuntimeIdentity;
use crate::state::{RuntimeState, StateCell};

/// 诊断文本的单条上限（字符），与 redact 的 stderr 上限同量级。
const MAX_DIAGNOSTIC_CHARS: usize = 512;

/// 互斥锁的取用方式：中毒后仍继续使用，避免一次 panic 让运行时永久失效。
pub(crate) fn lock<T>(mutex: &StdMutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(crate) fn millis(duration: Duration) -> u64 {
    duration.as_millis() as u64
}

/// 请求终止子进程的原因；由 monitor 决定是 kill 还是等待自然退出。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TerminateReason {
    /// 上层调用 stop。
    Requested,
    /// stdout 已关闭（进程通常在退出，但可能挂住）。
    StreamClosed,
    /// 分帧失步，必须立即终止。
    Desync,
}

/// 运行时结束方式。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitReason {
    /// 进程自行退出。
    ChildExited,
    /// 由 supervisor 请求并强制终止。
    RequestedAbort,
    /// 协议失步后强制终止。
    Desync,
    /// 进程在清理预算内没有被回收（需要平台级进程树治理）。
    KillTimeout,
}

impl ExitReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ChildExited => "child_exited",
            Self::RequestedAbort => "requested_abort",
            Self::Desync => "desync",
            Self::KillTimeout => "kill_timeout",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExitInfo {
    pub code: Option<i32>,
    pub reason: ExitReason,
}

/// 交给上层的运行时事件。所有事件都属于「一个 runtime + 一个 generation」。
#[derive(Debug, Clone, PartialEq)]
pub enum SupervisorEvent {
    /// 状态机迁移后的通知。
    StateChanged { state: RuntimeState },
    /// 普通 agent 事件（流式输出、工具事件等）。
    AgentEvent { kind: String, data: Option<Value> },
    /// agent_settled：这一轮彻底安定。
    Settled,
    /// 子进程 stderr（已截断与脱敏，仅作诊断）。
    Stderr { line: String },
    /// 协议层异常（坏 JSON、失步等），不影响已解析的记录。
    ProtocolWarning { detail: String },
    /// response 的 id 不在 pending 里（迟到或未知 id）。
    UnmatchedResponse { request_id: String },
    /// 未知记录类型，原样上报，交由上层决定是否支持。
    UnhandledRecord { kind: String },
    /// 进程退出；此后不应再有该 generation 的事件。
    Exit { info: ExitInfo },
}

/// 面向 UI/诊断的只读快照；不包含完整 stdout 历史。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeDiagnostics {
    pub identity: RuntimeIdentity,
    /// 进程树根 PID；从没拿到子进程时为 `None`。资源监控按它采样。
    pub pid: Option<u32>,
    pub state: RuntimeState,
    pub pending_requests: usize,
    pub dropped_events: u64,
    pub stderr_tail: Vec<String>,
    pub last_protocol_warning: Option<String>,
    pub exit: Option<ExitInfo>,
}

#[derive(Debug, Default)]
pub(crate) struct Diagnostics {
    pub(crate) stderr_tail: VecDeque<String>,
    pub(crate) dropped_events: u64,
    pub(crate) last_protocol_warning: Option<String>,
    pub(crate) exit: Option<ExitInfo>,
}

/// 单个 Pi 运行时的共享状态。
pub(crate) struct RuntimeShared {
    pub(crate) identity: RuntimeIdentity,
    /// 子进程 PID，只由 supervisor 在 spawn 成功后写入，之后不再变化。
    pub(crate) pid: Option<u32>,
    pub(crate) state: StateCell,
    pub(crate) pending: StdMutex<HashMap<String, oneshot::Sender<RpcResponse>>>,
    pub(crate) frame_tx: StdMutex<Option<mpsc::Sender<String>>>,
    pub(crate) events_tx: mpsc::Sender<SupervisorEvent>,
    pub(crate) exit_tx: watch::Sender<Option<ExitInfo>>,
    pub(crate) terminate_tx: watch::Sender<Option<TerminateReason>>,
    pub(crate) request_seq: AtomicU64,
    pub(crate) diagnostics: StdMutex<Diagnostics>,
}

impl RuntimeShared {
    pub(crate) fn new(
        identity: RuntimeIdentity,
        pid: Option<u32>,
        frame_tx: mpsc::Sender<String>,
        events_tx: mpsc::Sender<SupervisorEvent>,
        exit_tx: watch::Sender<Option<ExitInfo>>,
        terminate_tx: watch::Sender<Option<TerminateReason>>,
    ) -> Self {
        Self {
            state: StateCell::new(),
            identity,
            pid,
            pending: StdMutex::new(HashMap::new()),
            frame_tx: StdMutex::new(Some(frame_tx)),
            events_tx,
            exit_tx,
            terminate_tx,
            request_seq: AtomicU64::new(0),
            diagnostics: StdMutex::new(Diagnostics::default()),
        }
    }

    pub(crate) fn next_request_id(&self, label: &str) -> String {
        let seq = self.request_seq.fetch_add(1, Ordering::SeqCst) + 1;
        format!("{}:{}:{}", self.identity.runtime_id, label, seq)
    }

    /// 状态迁移 + 通知；非法迁移返回 false 且不改写状态。
    pub(crate) fn transition(&self, next: RuntimeState) -> bool {
        match self.state.try_transition(next) {
            Ok(previous) => {
                if previous != next {
                    self.emit_bounded(SupervisorEvent::StateChanged { state: next });
                }
                true
            }
            Err(_) => false,
        }
    }

    /// 关键事件（agent_settled / agent 事件）：先尝试非阻塞，满了再等。
    pub(crate) async fn emit_control(&self, event: SupervisorEvent) {
        if let Err(mpsc::error::TrySendError::Full(event)) = self.events_tx.try_send(event) {
            let _ = self.events_tx.send(event).await;
        }
    }

    /// 高频/诊断事件：永不阻塞读取任务，丢弃时计数。
    pub(crate) fn emit_bounded(&self, event: SupervisorEvent) {
        if let Err(error) = self.events_tx.try_send(event)
            && matches!(error, mpsc::error::TrySendError::Full(_))
        {
            lock(&self.diagnostics).dropped_events += 1;
        }
    }

    /// 协议层异常只保留有界文本，避免子进程错误信息把诊断区撑大。
    pub(crate) fn record_protocol_warning(&self, detail: String) {
        let detail = crate::redact::truncate_chars(&detail, MAX_DIAGNOSTIC_CHARS);
        lock(&self.diagnostics).last_protocol_warning = Some(detail.clone());
        self.emit_bounded(SupervisorEvent::ProtocolWarning { detail });
    }

    pub(crate) fn push_stderr(&self, line: String, ring: usize) {
        {
            let mut diagnostics = lock(&self.diagnostics);
            if ring == 0 {
                return;
            }
            if diagnostics.stderr_tail.len() >= ring {
                diagnostics.stderr_tail.pop_front();
            }
            diagnostics.stderr_tail.push_back(line.clone());
        }
        self.emit_bounded(SupervisorEvent::Stderr { line });
    }

    /// 取走 pending 中对应 id 的等待者；返回 false 表示无从匹配。
    pub(crate) fn claim_response(&self, response: RpcResponse) -> Result<(), RpcResponse> {
        let sender = lock(&self.pending).remove(&response.id);
        match sender {
            Some(sender) => {
                let _ = sender.send(response);
                Ok(())
            }
            None => Err(response),
        }
    }

    /// 进程退出/断流：让所有等待中的请求立刻失败，不泄漏 oneshot。
    pub(crate) fn fail_pending(&self) {
        lock(&self.pending).clear();
    }

    /// 关闭 stdin（drop 写入通道），子进程会收到 EOF。
    pub(crate) fn close_stdin(&self) {
        let _ = lock(&self.frame_tx).take();
    }

    pub(crate) fn request_terminate(&self, reason: TerminateReason) {
        let _ = self.terminate_tx.send_if_modified(|slot| {
            if slot.is_none() {
                *slot = Some(reason);
                true
            } else {
                false
            }
        });
    }

    pub(crate) fn record_exit(&self, info: ExitInfo) {
        lock(&self.diagnostics).exit = Some(info);
    }

    pub(crate) fn snapshot(&self) -> RuntimeDiagnostics {
        let diagnostics = lock(&self.diagnostics);
        RuntimeDiagnostics {
            identity: self.identity.clone(),
            pid: self.pid,
            state: self.state.get(),
            pending_requests: lock(&self.pending).len(),
            dropped_events: diagnostics.dropped_events,
            stderr_tail: diagnostics.stderr_tail.iter().cloned().collect(),
            last_protocol_warning: diagnostics.last_protocol_warning.clone(),
            exit: diagnostics.exit.clone(),
        }
    }
}

/// pending 条目的 RAII 守卫：超时/取消/任务被 drop 时都会移除，避免泄漏。
struct PendingGuard<'a> {
    pending: &'a StdMutex<HashMap<String, oneshot::Sender<RpcResponse>>>,
    request_id: String,
    armed: bool,
}

impl Drop for PendingGuard<'_> {
    fn drop(&mut self) {
        if self.armed {
            lock(self.pending).remove(&self.request_id);
        }
    }
}

/// 发一条命令并等待对应 response（按 id 关联，与其他请求并行安全）。
pub(crate) async fn request_response(
    runtime: &RuntimeShared,
    command: PiCommand,
    wait: Duration,
) -> SupervisorResult<RpcResponse> {
    request_response_with(runtime, command, wait, false).await
}

/// `allow_stopping` 只给停止路径用：取消命令必须在 Stopping 状态下仍能发出。
pub(crate) async fn request_response_with(
    runtime: &RuntimeShared,
    command: PiCommand,
    wait: Duration,
    allow_stopping: bool,
) -> SupervisorResult<RpcResponse> {
    let state = runtime.state.get();
    if state.is_terminal() || (state == RuntimeState::Stopping && !allow_stopping) {
        return Err(SupervisorError::RuntimeNotRunning {
            runtime_id: runtime.identity.runtime_id.clone(),
            state,
        });
    }

    let request_id = command.id().to_owned();
    let frame = encode_command(&command)?;
    let (sender, receiver) = oneshot::channel();
    {
        let mut pending = lock(&runtime.pending);
        // 先查再插：直接 insert 会顶掉原等待者，让在途请求凭空消失。
        if pending.contains_key(&request_id) {
            return Err(SupervisorError::DuplicateRequestId { request_id });
        }
        pending.insert(request_id.clone(), sender);
    }
    let mut guard = PendingGuard {
        pending: &runtime.pending,
        request_id: request_id.clone(),
        armed: true,
    };

    let stdin_closed = || SupervisorError::StdinClosed {
        runtime_id: runtime.identity.runtime_id.clone(),
        state: runtime.state.get(),
    };

    let writer = lock(&runtime.frame_tx).clone().ok_or_else(stdin_closed)?;
    writer.send(frame).await.map_err(|_| stdin_closed())?;

    match tokio::time::timeout(wait, receiver).await {
        Ok(Ok(response)) => {
            guard.armed = false;
            Ok(response)
        }
        Ok(Err(_)) => {
            guard.armed = false;
            Err(SupervisorError::RequestChannelClosed { request_id })
        }
        Err(_) => Err(SupervisorError::ResponseTimeout {
            request_id,
            timeout_ms: millis(wait),
        }),
    }
}
