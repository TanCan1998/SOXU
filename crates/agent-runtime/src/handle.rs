//! 单个受管运行时的句柄：事件读取、命令发送、settled 等待与 generation 判活。
//!
//! 句柄不属于资源 owner：drop 它不会停止 agent，停止必须显式走 supervisor 的 stop 路径。

use std::collections::VecDeque;
use std::sync::Arc;
use std::time::{Duration, Instant};

use soxu_pi_protocol::{PiCommand, RpcResponse, StreamingBehavior};
use tokio::sync::{mpsc, watch};
use tokio::time::timeout;

use crate::error::{SupervisorError, SupervisorResult};
use crate::identity::RuntimeIdentity;
use crate::shared::{
    ExitInfo, ExitReason, RuntimeDiagnostics, RuntimeShared, SupervisorEvent, lock, millis,
    request_response,
};
use crate::state::RuntimeState;
use crate::supervisor::SupervisorShared;

/// 一次受管运行时的句柄。drop 句柄不会停止 agent（Pane 销毁不等于停止任务）。
pub struct RuntimeHandle {
    supervisor: Arc<SupervisorShared>,
    runtime: Arc<RuntimeShared>,
    identity: RuntimeIdentity,
    events: mpsc::Receiver<SupervisorEvent>,
    exit_rx: watch::Receiver<Option<ExitInfo>>,
    generation_rx: watch::Receiver<u64>,
    backlog: VecDeque<SupervisorEvent>,
    backlog_capacity: usize,
    ended: bool,
    stale: bool,
}

/// 手动实现 Debug：句柄里有接收端与锁，derive 既不可行也不该暴露内部状态。
impl std::fmt::Debug for RuntimeHandle {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RuntimeHandle")
            .field("identity", &self.identity)
            .field("state", &self.state())
            .field("ended", &self.ended)
            .field("stale", &self.stale)
            .finish()
    }
}

enum Wake {
    Event(Option<SupervisorEvent>),
    Generation(bool),
}

impl RuntimeHandle {
    /// 仅由 PiSupervisor 在进程拉起并登记后构造。
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        supervisor: Arc<SupervisorShared>,
        runtime: Arc<RuntimeShared>,
        identity: RuntimeIdentity,
        events: mpsc::Receiver<SupervisorEvent>,
        exit_rx: watch::Receiver<Option<ExitInfo>>,
        generation_rx: watch::Receiver<u64>,
        backlog_capacity: usize,
    ) -> Self {
        Self {
            supervisor,
            runtime,
            identity,
            events,
            exit_rx,
            generation_rx,
            backlog: VecDeque::new(),
            backlog_capacity,
            ended: false,
            stale: false,
        }
    }

    pub fn identity(&self) -> &RuntimeIdentity {
        &self.identity
    }

    pub fn state(&self) -> RuntimeState {
        self.runtime.state.get()
    }

    /// 进程树根 PID；资源监控按它采样整棵树。
    pub fn pid(&self) -> Option<u32> {
        self.runtime.pid
    }

    pub fn diagnostics(&self) -> RuntimeDiagnostics {
        self.runtime.snapshot()
    }

    /// 发命令并按 request id 等 response；并发请求互不影响。
    pub async fn request(
        &self,
        command: PiCommand,
        wait: Duration,
    ) -> SupervisorResult<RpcResponse> {
        request_response(&self.runtime, command, wait).await
    }

    pub async fn get_state(&self) -> SupervisorResult<RpcResponse> {
        let id = self.runtime.next_request_id("state");
        let wait = self.supervisor.config.response_timeout;
        self.request(PiCommand::GetState { id }, wait).await
    }

    /// 接受 prompt 后进入 Running，直到 agent_settled。
    ///
    /// 只用于「agent 空闲时开一轮」；忙碌时再发必须走 prompt_with 并带上
    /// streamingBehavior，否则 Pi 会直接拒绝这条命令（见 docs/development/send-modes.md）。
    pub async fn prompt(&self, message: impl Into<String>) -> SupervisorResult<RpcResponse> {
        self.prompt_with(message, None).await
    }

    /// 发一条 prompt；behavior 为 None 表示空闲投递（不带 streamingBehavior）。
    pub async fn prompt_with(
        &self,
        message: impl Into<String>,
        behavior: Option<StreamingBehavior>,
    ) -> SupervisorResult<RpcResponse> {
        let id = self.runtime.next_request_id("prompt");
        let wait = self.supervisor.config.response_timeout;
        let message = message.into();
        let command = match behavior {
            Some(behavior) => PiCommand::prompt_while_busy(id, message, behavior),
            None => PiCommand::prompt(id, message),
        };
        let response = self.request(command, wait).await?;
        if response.success {
            self.runtime.transition(RuntimeState::Running);
        }
        Ok(response)
    }

    /// 清空 Pi 侧的 steering / follow-up 队列。
    ///
    /// 「停止」必须先清队列再 abort：Pi 的 abort 会继续执行仍留在会话里的排队消息
    /// （docs/rpc-commands.md 的 clear_queue 一节），用户按了停止却看到消息又跑起来
    /// 是明确的错误行为。
    pub async fn clear_queue(&self) -> SupervisorResult<RpcResponse> {
        let id = self.runtime.next_request_id("clear_queue");
        let wait = self.supervisor.config.response_timeout;
        self.request(PiCommand::ClearQueue { id }, wait).await
    }

    /// 取消当前轮次；可重复调用（每次都有独立 request id）。
    pub async fn cancel(&self) -> SupervisorResult<RpcResponse> {
        let id = self.runtime.next_request_id("abort");
        let wait = self.supervisor.config.cancel_timeout;
        self.request(PiCommand::Abort { id }, wait).await
    }

    /// 取下一个事件；旧 generation 或已结束时返回 Ok(None)，被取代时返回 Err。
    pub async fn recv(&mut self) -> SupervisorResult<Option<SupervisorEvent>> {
        loop {
            if self.ended || self.stale {
                return Ok(None);
            }
            self.ensure_current()?;

            // 先排空通道里已到达的事件，保证 Exit 一定排在它们之后。
            match self.events.try_recv() {
                Ok(event) => return Ok(Some(event)),
                Err(mpsc::error::TryRecvError::Empty) => {}
                Err(mpsc::error::TryRecvError::Disconnected) => {
                    self.mark_stale();
                    return Ok(None);
                }
            }

            // 通道已空且进程已退出：合成 Exit 事件。
            // 退出通知不占用事件通道容量，读取任务也已收尾，因此这里不会漏掉后续事件。
            if let Some(info) = self.exit_rx.borrow().clone() {
                self.ended = true;
                return Ok(Some(SupervisorEvent::Exit { info }));
            }

            let wake = {
                let events = &mut self.events;
                let generation = &mut self.generation_rx;
                tokio::select! {
                    biased;
                    changed = generation.changed() => Wake::Generation(changed.is_ok()),
                    event = events.recv() => Wake::Event(event),
                }
            };

            match wake {
                Wake::Generation(alive) => {
                    if !alive {
                        self.mark_stale();
                        return Ok(None);
                    }
                    // 值变化说明出现了新 generation，回到循环顶部统一处理。
                }
                Wake::Event(None) => return Ok(None),
                Wake::Event(Some(event)) => {
                    // 迟到事件：等它到达后再判定 generation，避免旧会话污染新会话。
                    self.ensure_current()?;
                    return Ok(Some(event));
                }
            }
        }
    }

    pub async fn recv_timeout(
        &mut self,
        wait: Duration,
    ) -> SupervisorResult<Option<SupervisorEvent>> {
        match timeout(wait, self.recv()).await {
            Ok(result) => result,
            Err(_) => Err(SupervisorError::EventTimeout {
                timeout_ms: millis(wait),
            }),
        }
    }

    /// 等到 agent_settled；期间其它事件进入有界 backlog，不丢流式内容。
    pub async fn wait_settled(&mut self, wait: Duration) -> SupervisorResult<()> {
        let deadline = Instant::now() + wait;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(SupervisorError::EventTimeout {
                    timeout_ms: millis(wait),
                });
            }
            match self.recv_timeout(remaining).await? {
                Some(SupervisorEvent::Settled) => return Ok(()),
                Some(event) => self.push_backlog(event),
                None => {
                    return Err(SupervisorError::RuntimeEnded {
                        runtime_id: self.identity.runtime_id.clone(),
                    });
                }
            }
        }
    }

    pub fn take_backlog(&mut self) -> Vec<SupervisorEvent> {
        self.backlog.drain(..).collect()
    }

    pub async fn wait_exit(&mut self, wait: Duration) -> SupervisorResult<ExitInfo> {
        if let Some(info) = self.exit_rx.borrow().clone() {
            return Ok(info);
        }
        match timeout(wait, wait_for_exit(&mut self.exit_rx)).await {
            Ok(Ok(info)) => Ok(info),
            Ok(Err(_)) => Err(SupervisorError::ExitTimeout {
                runtime_id: self.identity.runtime_id.clone(),
            }),
            Err(_) => Err(SupervisorError::ExitTimeout {
                runtime_id: self.identity.runtime_id.clone(),
            }),
        }
    }

    /// 停止本次运行时（先 abort、再关 stdin、超时才强杀）。
    pub async fn stop(&mut self) -> SupervisorResult<ExitInfo> {
        crate::supervisor::stop_runtime(&self.supervisor, &self.identity.runtime_id).await
    }

    fn ensure_current(&mut self) -> SupervisorResult<()> {
        let active = *self.generation_rx.borrow();
        if active == self.identity.generation {
            return Ok(());
        }
        self.mark_stale();
        Err(SupervisorError::Superseded {
            session_id: self.identity.session_id.clone(),
            generation: self.identity.generation,
            active_generation: active,
        })
    }

    fn mark_stale(&mut self) {
        self.stale = true;
        self.events.close();
        while self.events.try_recv().is_ok() {}
        self.backlog.clear();
    }

    fn push_backlog(&mut self, event: SupervisorEvent) {
        if self.backlog_capacity == 0 {
            return;
        }
        if self.backlog.len() >= self.backlog_capacity {
            self.backlog.pop_front();
            lock(&self.runtime.diagnostics).dropped_events += 1;
        }
        self.backlog.push_back(event);
    }

    pub(crate) async fn handshake(&mut self) -> SupervisorResult<()> {
        let state_wait = self.supervisor.config.handshake_timeout;
        let id = self.runtime.next_request_id("handshake");
        let response = self
            .request(PiCommand::GetState { id }, state_wait)
            .await
            .map_err(|error| match error {
                SupervisorError::ResponseTimeout { .. } => SupervisorError::HandshakeTimeout {
                    runtime_id: self.identity.runtime_id.clone(),
                    timeout_ms: millis(state_wait),
                },
                SupervisorError::RuntimeNotRunning { state, .. } => {
                    SupervisorError::RuntimeNotRunning {
                        runtime_id: self.identity.runtime_id.clone(),
                        state,
                    }
                }
                other => other,
            })?;
        if !response.success {
            return Err(SupervisorError::Protocol(format!(
                "handshake rejected: {}",
                response
                    .failure_message()
                    .unwrap_or_else(|| "unknown reason".to_owned())
            )));
        }
        if !self.runtime.transition(RuntimeState::Idle) {
            return Err(SupervisorError::IllegalTransition(
                crate::state::IllegalTransition {
                    from: self.runtime.state.get(),
                    to: RuntimeState::Idle,
                },
            ));
        }
        Ok(())
    }
}

pub(crate) async fn wait_for_exit(
    receiver: &mut watch::Receiver<Option<ExitInfo>>,
) -> Result<ExitInfo, watch::error::RecvError> {
    let value = receiver.wait_for(|slot| slot.is_some()).await?;
    Ok(value.clone().unwrap_or(ExitInfo {
        code: None,
        reason: ExitReason::ChildExited,
    }))
}
