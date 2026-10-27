//! 单个会话运行时的驱动任务。
//!
//! 谁拥有什么：
//! - `RuntimeHandle` 由本任务独占（`recv` 需要 `&mut`），任务结束时停止并回收子进程。
//! - 上层只持有 `mpsc::Sender<RunCommand>`，命令通过通道串行进入，避免并发写同一 stdin。
//! - 事件通过 `DriverContext::sink` 交给 Tauri emit；`GenerationGate` 决定是否丢弃。
//!
//! `RuntimePort` 让测试用脚本化假运行时覆盖「多会话并发事件 / 取消 / 停止」，
//! 真实实现见 `HandlePort`。

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use soxu_agent_runtime::{RuntimeHandle, SupervisorEvent};
use tokio::sync::{mpsc, oneshot};

use crate::dto::RuntimeExit;
use crate::events::{RuntimeEvent, RuntimeEventKind, map_event};
use crate::watch::{EventFanout, GenerationGate};

type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// 上层发给驱动任务的命令；每个命令都有独立的应答通道，失败不会静默挂起。
pub enum RunCommand {
    Prompt {
        text: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    Cancel {
        reply: oneshot::Sender<Result<(), String>>,
    },
    Shutdown {
        reply: oneshot::Sender<()>,
    },
}

/// 驱动任务需要的最小运行时能力；`RuntimeHandle` 与测试替身都实现它。
pub trait RuntimePort: Send {
    fn recv(&mut self) -> BoxFuture<'_, Result<Option<SupervisorEvent>, String>>;
    fn prompt(&mut self, text: String) -> BoxFuture<'_, Result<(), String>>;
    fn cancel(&mut self) -> BoxFuture<'_, Result<(), String>>;
    fn stop(&mut self) -> BoxFuture<'_, ()>;
    fn runtime_id(&self) -> &str;
}

/// 真实实现：独占 `RuntimeHandle`。句柄随驱动任务一起被回收，
/// 驱动结束（停止或进程退出）即释放管道与子进程。
pub struct HandlePort {
    handle: RuntimeHandle,
    runtime_id: String,
}

impl HandlePort {
    pub fn new(handle: RuntimeHandle) -> Self {
        let runtime_id = handle.identity().runtime_id.clone();
        Self { handle, runtime_id }
    }
}

impl RuntimePort for HandlePort {
    fn recv(&mut self) -> BoxFuture<'_, Result<Option<SupervisorEvent>, String>> {
        Box::pin(async move {
            self.handle
                .recv()
                .await
                .map_err(|error| error.code().to_owned())
        })
    }

    fn prompt(&mut self, text: String) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            self.handle
                .prompt(text)
                .await
                .map(|response| {
                    if let Some(reason) = response.failure_message() {
                        Err(reason)
                    } else {
                        Ok(())
                    }
                })
                .unwrap_or_else(|error| Err(error.to_string()))
        })
    }

    fn cancel(&mut self) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            self.handle
                .cancel()
                .await
                .map(|response| {
                    if let Some(reason) = response.failure_message() {
                        Err(reason)
                    } else {
                        Ok(())
                    }
                })
                .unwrap_or_else(|error| Err(error.to_string()))
        })
    }

    fn stop(&mut self) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            let _ = self.handle.stop().await;
        })
    }

    fn runtime_id(&self) -> &str {
        &self.runtime_id
    }
}

/// 运行时状态注册表：与事件订阅解耦，订阅释放后仍可用来重新对齐 UI。
#[derive(Debug, Clone)]
pub struct RunStatus {
    pub runtime_id: String,
    pub generation: u64,
    pub state: String,
    pub exit: Option<RuntimeExit>,
}

#[derive(Clone)]
pub struct DriverContext {
    pub gate: Arc<GenerationGate>,
    pub fanout: Arc<EventFanout>,
    pub statuses: Arc<Mutex<HashMap<String, RunStatus>>>,
    pub sink: Arc<dyn Fn(RuntimeEvent) + Send + Sync>,
}

impl DriverContext {
    fn update_status<F>(&self, session_id: &str, mutate: F)
    where
        F: FnOnce(&mut RunStatus),
    {
        let mut statuses = self
            .statuses
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(status) = statuses.get_mut(session_id) {
            mutate(status);
        }
    }

    fn emit(&self, event: RuntimeEvent) {
        if self.fanout.wants(&event.session_id) {
            (self.sink)(event);
        }
    }
}

enum Step {
    Event(Result<Option<SupervisorEvent>, String>),
    Command(Option<RunCommand>),
}

/// 驱动循环：唯一的运行时 owner，直到进程退出或被显式停止。
pub async fn drive(
    mut port: Box<dyn RuntimePort>,
    session_id: String,
    generation: u64,
    mut control: mpsc::Receiver<RunCommand>,
    context: DriverContext,
) {
    let runtime_id = port.runtime_id().to_owned();
    // 记录子进程是否已经回收，保证 stop 不会被重复调用。
    let mut stopped = false;
    loop {
        // 先取出 select 的结果，再在循环体里使用 `port`：避免两处可变借用重叠。
        let step = tokio::select! {
            event = port.recv() => Step::Event(event),
            command = control.recv() => Step::Command(command),
        };
        match step {
            Step::Event(Ok(Some(event))) => {
                if handle_event(&event, &session_id, &runtime_id, generation, &context) {
                    stopped = true;
                    break;
                }
            }
            // Ok(None)：进程结束或该 generation 已被取代。
            Step::Event(Ok(None)) => break,
            Step::Event(Err(code)) => {
                context.emit(RuntimeEvent::new(
                    session_id.clone(),
                    runtime_id.clone(),
                    generation,
                    RuntimeEventKind::Warning {
                        detail: format!("运行时事件读取结束：{code}"),
                    },
                ));
                break;
            }
            Step::Command(Some(RunCommand::Prompt { text, reply })) => {
                let result = port.prompt(text).await;
                if result.is_ok() {
                    context.update_status(&session_id, |status| {
                        status.state = "running".to_owned();
                    });
                }
                let _ = reply.send(result);
            }
            Step::Command(Some(RunCommand::Cancel { reply })) => {
                let result = port.cancel().await;
                let _ = reply.send(result);
            }
            Step::Command(Some(RunCommand::Shutdown { reply })) => {
                port.stop().await;
                stopped = true;
                context.update_status(&session_id, |status| {
                    status.state = "exited".to_owned();
                });
                let _ = reply.send(());
                break;
            }
            Step::Command(None) => break,
        }
    }

    if !stopped {
        port.stop().await;
    }
}

/// 处理单条事件；返回 true 表示该运行时已经结束。
fn handle_event(
    event: &SupervisorEvent,
    session_id: &str,
    runtime_id: &str,
    generation: u64,
    context: &DriverContext,
) -> bool {
    // 迟到事件：generation 已过期则整条丢弃，状态注册表也不改写。
    if !context.gate.accept(session_id, generation) {
        return false;
    }
    let Some(kind) = map_event(event) else {
        return false;
    };
    match &kind {
        RuntimeEventKind::State { state } => context.update_status(session_id, |status| {
            status.state = state.clone();
        }),
        RuntimeEventKind::Settled => context.update_status(session_id, |status| {
            status.state = "idle".to_owned();
        }),
        RuntimeEventKind::Exit { code, reason } => context.update_status(session_id, |status| {
            status.state = "exited".to_owned();
            status.exit = Some(RuntimeExit {
                code: *code,
                reason: reason.clone(),
            });
        }),
        _ => {}
    }
    let ended = matches!(kind, RuntimeEventKind::Exit { .. });
    context.emit(RuntimeEvent::new(
        session_id.to_owned(),
        runtime_id.to_owned(),
        generation,
        kind,
    ));
    ended
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc;

    /// 脚本化假运行时：按脚本吐出事件，并记录命令调用顺序。
    struct ScriptedPort {
        events: mpsc::Receiver<SupervisorEvent>,
        calls: Arc<Mutex<Vec<String>>>,
        runtime_id: String,
    }

    impl RuntimePort for ScriptedPort {
        fn recv(&mut self) -> BoxFuture<'_, Result<Option<SupervisorEvent>, String>> {
            Box::pin(async move { Ok(self.events.recv().await) })
        }

        fn prompt(&mut self, text: String) -> BoxFuture<'_, Result<(), String>> {
            Box::pin(async move {
                self.calls.lock().unwrap().push(format!("prompt:{text}"));
                Ok(())
            })
        }

        fn cancel(&mut self) -> BoxFuture<'_, Result<(), String>> {
            Box::pin(async move {
                self.calls.lock().unwrap().push("cancel".to_owned());
                Ok(())
            })
        }

        fn stop(&mut self) -> BoxFuture<'_, ()> {
            Box::pin(async move {
                self.calls.lock().unwrap().push("stop".to_owned());
            })
        }

        fn runtime_id(&self) -> &str {
            &self.runtime_id
        }
    }

    fn context(
        fanout: Arc<EventFanout>,
        gate: Arc<GenerationGate>,
        statuses: Arc<Mutex<HashMap<String, RunStatus>>>,
        emitted: Arc<Mutex<Vec<RuntimeEvent>>>,
    ) -> DriverContext {
        DriverContext {
            gate,
            fanout,
            statuses,
            sink: Arc::new(move |event| emitted.lock().unwrap().push(event)),
        }
    }

    fn status(session: &str, generation: u64) -> RunStatus {
        RunStatus {
            runtime_id: format!("{session}#1"),
            generation,
            state: "starting".to_owned(),
            exit: None,
        }
    }

    #[tokio::test]
    async fn events_of_a_superseded_generation_are_never_forwarded() {
        let (tx, rx) = mpsc::channel(8);
        let calls = Arc::new(Mutex::new(Vec::new()));
        let port = ScriptedPort {
            events: rx,
            calls: Arc::clone(&calls),
            runtime_id: "ses_a#1".to_owned(),
        };
        let gate = Arc::new(GenerationGate::new());
        assert!(gate.begin("ses_a", 1));
        let fanout = Arc::new(EventFanout::new());
        fanout.attach("ses_a");
        let statuses = Arc::new(Mutex::new(HashMap::from([(
            "ses_a".to_owned(),
            status("ses_a", 1),
        )])));
        let emitted = Arc::new(Mutex::new(Vec::new()));
        let (control_tx, control_rx) = mpsc::channel(4);

        let driver = tokio::spawn(drive(
            Box::new(port),
            "ses_a".to_owned(),
            1,
            control_rx,
            context(
                Arc::clone(&fanout),
                Arc::clone(&gate),
                Arc::clone(&statuses),
                Arc::clone(&emitted),
            ),
        ));

        // 新一代运行时代替旧代：旧代的事件必须整体丢弃。
        assert!(gate.begin("ses_a", 2));
        tx.send(SupervisorEvent::Settled).await.unwrap();
        drop(tx);
        driver.await.unwrap();
        drop(control_tx);

        assert!(emitted.lock().unwrap().is_empty(), "旧 generation 不得上屏");
        let statuses = statuses.lock().unwrap();
        assert_eq!(statuses["ses_a"].state, "starting", "状态也不得被旧代改写");
    }

    #[tokio::test]
    async fn unsubscribed_sessions_still_track_state_without_emitting() {
        let (tx, rx) = mpsc::channel(8);
        let port = ScriptedPort {
            events: rx,
            calls: Arc::new(Mutex::new(Vec::new())),
            runtime_id: "ses_a#1".to_owned(),
        };
        let gate = Arc::new(GenerationGate::new());
        gate.begin("ses_a", 1);
        let fanout = Arc::new(EventFanout::new());
        let statuses = Arc::new(Mutex::new(HashMap::from([(
            "ses_a".to_owned(),
            status("ses_a", 1),
        )])));
        let emitted = Arc::new(Mutex::new(Vec::new()));
        let (control_tx, control_rx) = mpsc::channel(4);
        let driver = tokio::spawn(drive(
            Box::new(port),
            "ses_a".to_owned(),
            1,
            control_rx,
            context(
                Arc::clone(&fanout),
                Arc::clone(&gate),
                Arc::clone(&statuses),
                Arc::clone(&emitted),
            ),
        ));

        tx.send(SupervisorEvent::Settled).await.unwrap();
        // 视图已卸载（订阅计数 0），后端不 emit。
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(300);
        while tokio::time::Instant::now() < deadline
            && statuses.lock().unwrap()["ses_a"].state != "idle"
        {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        assert_eq!(statuses.lock().unwrap()["ses_a"].state, "idle");
        assert!(emitted.lock().unwrap().is_empty(), "无订阅者时不应 emit");
        drop(control_tx);
        drop(tx);
        driver.await.unwrap();
    }

    #[tokio::test]
    async fn prompt_cancel_and_shutdown_are_serialized_commands() {
        // `_tx` 必须存活：否则 recv 立即返回 None，驱动会当成进程退出。
        let (_tx, rx) = mpsc::channel(8);
        let calls = Arc::new(Mutex::new(Vec::new()));
        let port = ScriptedPort {
            events: rx,
            calls: Arc::clone(&calls),
            runtime_id: "ses_a#1".to_owned(),
        };
        let gate = Arc::new(GenerationGate::new());
        gate.begin("ses_a", 1);
        let fanout = Arc::new(EventFanout::new());
        fanout.attach("ses_a");
        let statuses = Arc::new(Mutex::new(HashMap::from([(
            "ses_a".to_owned(),
            status("ses_a", 1),
        )])));
        let emitted = Arc::new(Mutex::new(Vec::new()));
        let (control_tx, control_rx) = mpsc::channel(4);
        let driver = tokio::spawn(drive(
            Box::new(port),
            "ses_a".to_owned(),
            1,
            control_rx,
            context(
                Arc::clone(&fanout),
                Arc::clone(&gate),
                Arc::clone(&statuses),
                Arc::clone(&emitted),
            ),
        ));

        let (reply_tx, reply_rx) = oneshot::channel();
        control_tx
            .send(RunCommand::Prompt {
                text: "你好".to_owned(),
                reply: reply_tx,
            })
            .await
            .unwrap();
        assert!(reply_rx.await.unwrap().is_ok());
        assert_eq!(statuses.lock().unwrap()["ses_a"].state, "running");

        let (reply_tx, reply_rx) = oneshot::channel();
        control_tx
            .send(RunCommand::Cancel { reply: reply_tx })
            .await
            .unwrap();
        assert!(reply_rx.await.unwrap().is_ok());

        let (reply_tx, reply_rx) = oneshot::channel();
        control_tx
            .send(RunCommand::Shutdown { reply: reply_tx })
            .await
            .unwrap();
        reply_rx.await.unwrap();
        driver.await.unwrap();

        assert_eq!(
            calls.lock().unwrap().as_slice(),
            ["prompt:你好", "cancel", "stop"],
            "命令必须按提交顺序串行执行，且停止只发生一次"
        );
        assert_eq!(statuses.lock().unwrap()["ses_a"].state, "exited");
    }

    #[tokio::test]
    async fn exit_event_ends_the_driver_and_reports_the_process_result() {
        let (tx, rx) = mpsc::channel(8);
        let calls = Arc::new(Mutex::new(Vec::new()));
        let port = ScriptedPort {
            events: rx,
            calls: Arc::clone(&calls),
            runtime_id: "ses_a#1".to_owned(),
        };
        let gate = Arc::new(GenerationGate::new());
        gate.begin("ses_a", 1);
        let fanout = Arc::new(EventFanout::new());
        fanout.attach("ses_a");
        let statuses = Arc::new(Mutex::new(HashMap::from([(
            "ses_a".to_owned(),
            status("ses_a", 1),
        )])));
        let emitted = Arc::new(Mutex::new(Vec::new()));
        let (_control_tx, control_rx) = mpsc::channel(4);
        let driver = tokio::spawn(drive(
            Box::new(port),
            "ses_a".to_owned(),
            1,
            control_rx,
            context(
                Arc::clone(&fanout),
                Arc::clone(&gate),
                Arc::clone(&statuses),
                Arc::clone(&emitted),
            ),
        ));

        tx.send(SupervisorEvent::Exit {
            info: soxu_agent_runtime::ExitInfo {
                code: Some(1),
                reason: soxu_agent_runtime::ExitReason::ChildExited,
            },
        })
        .await
        .unwrap();
        driver.await.unwrap();

        let events = emitted.lock().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(
            events[0].kind,
            RuntimeEventKind::Exit {
                code: Some(1),
                reason: "child_exited".to_owned()
            }
        );
        assert_eq!(statuses.lock().unwrap()["ses_a"].state, "exited");
        assert!(
            calls.lock().unwrap().is_empty(),
            "进程自行退出后不再重复 stop"
        );
    }
}
