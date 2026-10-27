//! Pi RPC Supervisor：进程隔离、request 关联、超时/取消/异常退出、generation 隔离。
//!
//! 所有权约定：
//! - Child 由 monitor 任务独占持有，负责 kill 与 wait，其它路径只能请求终止。
//! - stdin/stdout/stderr 各由一个任务持有，任务结束即释放。
//! - RuntimeShared 是唯一需要跨任务观察的状态，锁内不做 await。

use std::collections::{HashMap, VecDeque};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use soxu_pi_protocol::PiCommand;
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;
use tokio::time::timeout;

use crate::config::{PiProgram, SupervisorConfig};
use crate::connection::{run_reader, run_stderr, run_writer};
use crate::error::{SupervisorError, SupervisorResult};
use crate::handle::{RuntimeHandle, wait_for_exit};
use crate::identity::RuntimeIdentity;
use crate::process::RuntimeProcess;
use crate::shared::{
    ExitInfo, ExitReason, RuntimeShared, TerminateReason, lock, request_response_with,
};
use crate::state::RuntimeState;

/// 最近退出记录上限：保证 stop/cancel 具幂等性，同时不让 map 无限增长。
const RECENT_EXIT_CAPACITY: usize = 64;
/// 退出时等待 stdout 读取任务收尾的上限（让最后一条 settled 事件先送达）。
const READER_JOIN_GRACE: Duration = Duration::from_millis(700);

struct SessionChannel {
    active_generation: u64,
    tx: watch::Sender<u64>,
}

struct RuntimeRecord {
    shared: Arc<RuntimeShared>,
    terminate_tx: watch::Sender<Option<TerminateReason>>,
    reader: JoinHandle<()>,
    writer: JoinHandle<()>,
    stderr: JoinHandle<()>,
}

/// Supervisor 的共享内核；PiSupervisor 与 RuntimeHandle 都持有同一份。
pub(crate) struct SupervisorShared {
    pub(crate) config: SupervisorConfig,
    sessions: StdMutex<HashMap<String, SessionChannel>>,
    runtimes: StdMutex<HashMap<String, RuntimeRecord>>,
    recent_exits: StdMutex<VecDeque<(String, ExitInfo)>>,
    runtime_seq: AtomicU64,
}

impl SupervisorShared {
    /// 提升并返回该 session 的新 generation，同时拿到观察通道。
    fn begin_generation(&self, session_id: &str) -> (u64, watch::Receiver<u64>) {
        let mut sessions = lock(&self.sessions);
        if !sessions.contains_key(session_id) {
            let (tx, _rx) = watch::channel(0u64);
            sessions.insert(
                session_id.to_owned(),
                SessionChannel {
                    active_generation: 0,
                    tx,
                },
            );
        }
        let channel = sessions
            .get_mut(session_id)
            .expect("session entry inserted above");
        channel.active_generation += 1;
        let generation = channel.active_generation;
        // send_replace 而不是 send：首个 generation 时还没有接收者，
        // send 会返回错误且不写入值，新 handle 会读到 0 并误判自己已被取代。
        channel.tx.send_replace(generation);
        (generation, channel.tx.subscribe())
    }

    fn take_record(&self, runtime_id: &str) -> Option<RuntimeRecord> {
        lock(&self.runtimes).remove(runtime_id)
    }

    fn remember_exit(&self, runtime_id: String, info: ExitInfo) {
        let mut exits = lock(&self.recent_exits);
        if exits.len() >= RECENT_EXIT_CAPACITY {
            exits.pop_front();
        }
        exits.push_back((runtime_id, info));
    }

    fn recent_exit(&self, runtime_id: &str) -> Option<ExitInfo> {
        lock(&self.recent_exits)
            .iter()
            .rev()
            .find(|(id, _)| id == runtime_id)
            .map(|(_, info)| info.clone())
    }

    fn runtimes_for_session(&self, session_id: &str) -> Vec<String> {
        lock(&self.runtimes)
            .values()
            .filter(|record| record.shared.identity.session_id == session_id)
            .map(|record| record.shared.identity.runtime_id.clone())
            .collect()
    }
}

/// Pi RPC Supervisor。一个实例管理本进程内所有受管 Pi Agent。
pub struct PiSupervisor {
    shared: Arc<SupervisorShared>,
}

impl PiSupervisor {
    pub fn new(config: SupervisorConfig) -> Self {
        Self {
            shared: Arc::new(SupervisorShared {
                config,
                sessions: StdMutex::new(HashMap::new()),
                runtimes: StdMutex::new(HashMap::new()),
                recent_exits: StdMutex::new(VecDeque::new()),
                runtime_seq: AtomicU64::new(0),
            }),
        }
    }

    pub fn with_default_config() -> Self {
        Self::new(SupervisorConfig::default())
    }

    pub fn config(&self) -> &SupervisorConfig {
        &self.shared.config
    }

    /// 为一个 session 拉起新的 Pi 进程并完成 get_state 握手。
    ///
    /// 同一 session 的旧运行时会被提升 generation（旧事件立即失效）并在新运行时
    /// 就绪后终止；新运行时启动失败时同样终止旧运行时，避免两个写者共享同一 JSONL。
    pub async fn start(
        &self,
        session_id: &str,
        program: &PiProgram,
    ) -> SupervisorResult<RuntimeHandle> {
        if session_id.trim().is_empty() {
            return Err(SupervisorError::EmptySessionId);
        }

        let (generation, generation_rx) = self.shared.begin_generation(session_id);
        let superseded = self.shared.runtimes_for_session(session_id);
        let seq = self.shared.runtime_seq.fetch_add(1, Ordering::SeqCst) + 1;
        let identity = RuntimeIdentity::new(session_id, format!("{session_id}#{seq}"), generation);

        let mut command = Command::new(program.program());
        command
            .args(program.args())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            // 最后一道防线：即使 supervisor 被 drop，也不留下孤儿进程。
            .kill_on_drop(true);
        if let Some(dir) = program.current_dir() {
            command.current_dir(dir);
        }
        for name in program.env_removed() {
            command.env_remove(name);
        }

        let mut child = command.spawn().map_err(|error| SupervisorError::Spawn {
            program: program.describe(),
            detail: error.to_string(),
        })?;
        // 进程树根 PID：资源监控按它采样（含 Pi 自己再拉起的子进程）。
        let child_pid = child.id();
        let stdin = child
            .stdin
            .take()
            .ok_or(SupervisorError::MissingPipe("stdin"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or(SupervisorError::MissingPipe("stdout"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or(SupervisorError::MissingPipe("stderr"))?;

        let config = self.shared.config.clone();
        let (frame_tx, frame_rx) = mpsc::channel(64);
        let (events_tx, events_rx) = mpsc::channel(config.event_capacity.max(8));
        let (exit_tx, exit_rx) = watch::channel(None);
        let (terminate_tx, terminate_rx) = watch::channel(None);

        let runtime = Arc::new(RuntimeShared::new(
            identity.clone(),
            child_pid,
            frame_tx,
            events_tx,
            exit_tx,
            terminate_tx.clone(),
        ));

        let writer = tokio::spawn(run_writer(stdin, frame_rx));
        let reader = tokio::spawn(run_reader(runtime.clone(), stdout, config.max_frame_bytes));
        let stderr_task = tokio::spawn(run_stderr(runtime.clone(), stderr, config.stderr_ring));
        tokio::spawn(run_monitor(
            self.shared.clone(),
            runtime.clone(),
            child,
            terminate_rx,
        ));

        lock(&self.shared.runtimes).insert(
            identity.runtime_id.clone(),
            RuntimeRecord {
                shared: runtime.clone(),
                terminate_tx,
                reader,
                writer,
                stderr: stderr_task,
            },
        );

        let mut handle = RuntimeHandle::new(
            self.shared.clone(),
            runtime.clone(),
            identity.clone(),
            events_rx,
            exit_rx,
            generation_rx,
            config.backlog_capacity,
        );

        if let Err(error) = handle.handshake().await {
            // 启动失败：回收本次进程，并终止同 session 的旧运行时（保持单一写者）。
            let _ = stop_runtime(&self.shared, &identity.runtime_id).await;
            for runtime_id in superseded {
                let _ = stop_runtime(&self.shared, &runtime_id).await;
            }
            return Err(error);
        }

        // 旧运行时在新运行时就绪后终止；期间其事件已被 generation 过滤。
        for runtime_id in superseded {
            let supervisor = self.shared.clone();
            tokio::spawn(async move {
                let _ = stop_runtime(&supervisor, &runtime_id).await;
            });
        }

        Ok(handle)
    }

    /// 幂等停止：已退出或已回收的 runtime 返回记录下来的 ExitInfo。
    pub async fn stop(&self, runtime_id: &str) -> SupervisorResult<ExitInfo> {
        stop_runtime(&self.shared, runtime_id).await
    }

    /// 停止所有受管运行时；返回每个 runtime 的结果，便于上层汇总诊断。
    pub async fn shutdown(&self) -> Vec<(String, SupervisorResult<ExitInfo>)> {
        let runtime_ids: Vec<String> = lock(&self.shared.runtimes).keys().cloned().collect();
        let mut results = Vec::with_capacity(runtime_ids.len());
        for runtime_id in runtime_ids {
            let outcome = stop_runtime(&self.shared, &runtime_id).await;
            results.push((runtime_id, outcome));
        }
        results
    }

    pub fn runtime_state(&self, runtime_id: &str) -> Option<RuntimeState> {
        match lock(&self.shared.runtimes).get(runtime_id) {
            Some(record) => Some(record.shared.state.get()),
            None => self
                .shared
                .recent_exit(runtime_id)
                .map(|_| RuntimeState::Exited),
        }
    }

    pub fn active_identities(&self) -> Vec<RuntimeIdentity> {
        lock(&self.shared.runtimes)
            .values()
            .map(|record| record.shared.identity.clone())
            .collect()
    }

    /// 受管运行时 + 可采样的进程树根 PID，按登记顺序无关的稳定顺序返回。
    ///
    /// 这是资源监控的唯一集成点：`soxu-resource-monitor` 不需要依赖本 crate，
    /// 由上层把这里的 pid/state 映射成 `Target`。
    pub fn processes(&self) -> Vec<RuntimeProcess> {
        let mut processes: Vec<RuntimeProcess> = lock(&self.shared.runtimes)
            .values()
            .map(|record| RuntimeProcess {
                identity: record.shared.identity.clone(),
                pid: record.shared.pid,
                state: record.shared.state.get(),
            })
            .collect();
        processes.sort_by(|left, right| left.identity.runtime_id.cmp(&right.identity.runtime_id));
        processes
    }

    pub fn is_empty(&self) -> bool {
        lock(&self.shared.runtimes).is_empty()
    }
}

/// 唯一的停止入口：先请求 abort，再关闭 stdin，最后才强杀。
pub(crate) async fn stop_runtime(
    supervisor: &Arc<SupervisorShared>,
    runtime_id: &str,
) -> SupervisorResult<ExitInfo> {
    let (runtime, terminate_tx, mut exit_rx) = {
        let runtimes = lock(&supervisor.runtimes);
        match runtimes.get(runtime_id) {
            Some(record) => (
                record.shared.clone(),
                record.terminate_tx.clone(),
                record.shared.exit_tx.subscribe(),
            ),
            None => {
                return supervisor
                    .recent_exit(runtime_id)
                    .ok_or(SupervisorError::UnknownRuntime {
                        runtime_id: runtime_id.to_owned(),
                    });
            }
        }
    };

    if let Some(info) = exit_rx.borrow().clone() {
        return Ok(info);
    }

    runtime.transition(RuntimeState::Stopping);

    let abort_id = runtime.next_request_id("stop-abort");
    let cancel_wait = supervisor.config.cancel_timeout;
    // 此时状态已是 Stopping，必须走 allow_stopping 分支，否则 abort 根本发不出去。
    let _ = timeout(
        cancel_wait,
        request_response_with(
            &runtime,
            PiCommand::Abort { id: abort_id },
            cancel_wait,
            true,
        ),
    )
    .await;

    // 关闭 stdin：正常退出的主路径，不依赖 kill。
    runtime.close_stdin();
    if let Ok(Ok(info)) = timeout(
        supervisor.config.shutdown_grace,
        wait_for_exit(&mut exit_rx),
    )
    .await
    {
        return Ok(info);
    }

    runtime.request_terminate(TerminateReason::Requested);
    if let Ok(Ok(info)) = timeout(supervisor.config.kill_timeout, wait_for_exit(&mut exit_rx)).await
    {
        return Ok(info);
    }

    let _ = terminate_tx.send(Some(TerminateReason::Requested));
    Err(SupervisorError::ShutdownTimeout {
        runtime_id: runtime_id.to_owned(),
    })
}

/// Child 的唯一所有者：负责等待退出、执行 kill、发布退出事件并回收任务句柄。
async fn run_monitor(
    supervisor: Arc<SupervisorShared>,
    runtime: Arc<RuntimeShared>,
    mut child: Child,
    mut terminate_rx: watch::Receiver<Option<TerminateReason>>,
) {
    let grace = supervisor.config.shutdown_grace;
    let mut pending: Option<TerminateReason> = None;
    let mut senders_gone = false;
    let mut reason = ExitReason::ChildExited;
    let mut status = None;

    loop {
        if let Some(signal) = pending.take() {
            match signal {
                TerminateReason::StreamClosed => match timeout(grace, child.wait()).await {
                    Ok(waited) => status = waited.ok(),
                    Err(_) => {
                        reason = ExitReason::RequestedAbort;
                        let _ = child.start_kill();
                        status = timeout(grace, child.wait())
                            .await
                            .ok()
                            .and_then(|waited| waited.ok());
                        if status.is_none() {
                            reason = ExitReason::KillTimeout;
                        }
                    }
                },
                TerminateReason::Requested | TerminateReason::Desync => {
                    reason = if signal == TerminateReason::Desync {
                        ExitReason::Desync
                    } else {
                        ExitReason::RequestedAbort
                    };
                    let _ = child.start_kill();
                    match timeout(grace, child.wait()).await {
                        Ok(waited) => status = waited.ok(),
                        Err(_) => reason = ExitReason::KillTimeout,
                    }
                }
            }
            break;
        }

        if senders_gone {
            status = child.wait().await.ok();
            break;
        }

        tokio::select! {
            biased;
            waited = child.wait() => {
                status = waited.ok();
                break;
            }
            changed = terminate_rx.changed() => {
                if changed.is_err() {
                    senders_gone = true;
                } else {
                    pending = *terminate_rx.borrow();
                }
            }
        }
    }

    let info = ExitInfo {
        code: status.and_then(|status| status.code()),
        reason,
    };

    // 先让读取任务把管道里剩余的事件送出去，再宣告退出。
    if let Some(record) = supervisor.take_record(&runtime.identity.runtime_id) {
        let RuntimeRecord {
            reader,
            writer,
            stderr,
            ..
        } = record;
        let mut reader = reader;
        if timeout(READER_JOIN_GRACE, &mut reader).await.is_err() {
            reader.abort();
        }
        writer.abort();
        stderr.abort();
    }

    runtime.transition(RuntimeState::Exited);
    runtime.fail_pending();
    runtime.close_stdin();
    runtime.record_exit(info.clone());
    // 退出通知不经过事件通道，避免上层不读事件时 stop 卡住；
    // RuntimeHandle::recv 在通道排空后据此合成 SupervisorEvent::Exit。
    let _ = runtime.exit_tx.send(Some(info.clone()));
    supervisor.remember_exit(runtime.identity.runtime_id.clone(), info);
}
