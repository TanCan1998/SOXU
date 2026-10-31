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

use soxu_agent_runtime::{RuntimeHandle, StreamingBehavior, SupervisorEvent};
use tokio::sync::{mpsc, oneshot};

use crate::dto::RuntimeExit;
use crate::events::{RuntimeEvent, RuntimeEventKind, map_event};
use crate::state::lock;
use crate::stats::StatsStore;
use crate::watch::{EventFanout, GenerationGate};

type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// 上层发给驱动任务的命令；每个命令都有独立的应答通道，失败不会静默挂起。
pub enum RunCommand {
    /// behavior 为 None 表示 agent 空闲时的普通投递；忙碌时必须带上排队方式，
    /// 否则 Pi 会拒绝这条 prompt（见 docs/development/send-modes.md）。
    Prompt {
        text: String,
        behavior: Option<StreamingBehavior>,
        reply: oneshot::Sender<Result<(), String>>,
    },
    Cancel {
        reply: oneshot::Sender<Result<(), String>>,
    },
    /// 清空 Pi 侧的排队消息；「停止」在 abort 之前先发这一条。
    ClearQueue {
        reply: oneshot::Sender<Result<(), String>>,
    },
    Shutdown {
        reply: oneshot::Sender<()>,
    },
}

/// 驱动任务需要的最小运行时能力；`RuntimeHandle` 与测试替身都实现它。
pub trait RuntimePort: Send {
    fn recv(&mut self) -> BoxFuture<'_, Result<Option<SupervisorEvent>, String>>;
    fn prompt(
        &mut self,
        text: String,
        behavior: Option<StreamingBehavior>,
    ) -> BoxFuture<'_, Result<(), String>>;
    fn cancel(&mut self) -> BoxFuture<'_, Result<(), String>>;
    fn clear_queue(&mut self) -> BoxFuture<'_, Result<(), String>>;
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

    fn prompt(
        &mut self,
        text: String,
        behavior: Option<StreamingBehavior>,
    ) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            self.handle
                .prompt_with(text, behavior)
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

    fn clear_queue(&mut self) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            self.handle
                .clear_queue()
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
    /// 会话统计的唯一写者就是本驱动任务：与事件分发同一条路径，不额外起线程。
    pub stats: Arc<Mutex<StatsStore>>,
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
            Step::Command(Some(RunCommand::Prompt {
                text,
                behavior,
                reply,
            })) => {
                let result = port.prompt(text, behavior).await;
                if result.is_ok() {
                    context.update_status(&session_id, |status| {
                        status.state = "running".to_owned();
                    });
                    // 只有 Pi 真的接受了 prompt 才开始计时：被拒绝的命令不算一轮，
                    // 否则首 token 延迟会凭空多出一次失败的等待。
                    lock(&context.stats).note_prompt(&session_id, std::time::Instant::now());
                }
                let _ = reply.send(result);
            }
            Step::Command(Some(RunCommand::Cancel { reply })) => {
                let result = port.cancel().await;
                let _ = reply.send(result);
            }
            Step::Command(Some(RunCommand::ClearQueue { reply })) => {
                let result = port.clear_queue().await;
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
    // 统计累加与事件分发走同一条已过闸门的路径：迟到事件既不上屏，也不进统计。
    lock(&context.stats).observe(session_id, &kind, std::time::Instant::now());
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

        fn prompt(
            &mut self,
            text: String,
            behavior: Option<StreamingBehavior>,
        ) -> BoxFuture<'_, Result<(), String>> {
            Box::pin(async move {
                let suffix = match behavior {
                    Some(StreamingBehavior::Steer) => ":steer",
                    Some(StreamingBehavior::FollowUp) => ":followUp",
                    None => "",
                };
                self.calls
                    .lock()
                    .unwrap()
                    .push(format!("prompt:{text}{suffix}"));
                Ok(())
            })
        }

        fn cancel(&mut self) -> BoxFuture<'_, Result<(), String>> {
            Box::pin(async move {
                self.calls.lock().unwrap().push("cancel".to_owned());
                Ok(())
            })
        }

        fn clear_queue(&mut self) -> BoxFuture<'_, Result<(), String>> {
            Box::pin(async move {
                self.calls.lock().unwrap().push("clear_queue".to_owned());
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
            stats: Arc::new(Mutex::new(StatsStore::new())),
            sink: Arc::new(move |event| emitted.lock().unwrap().push(event)),
        }
    }

    /// 在既有上下文上换一份共享统计表：用例据此断言「统计与事件流同源」。
    fn with_stats(mut context: DriverContext, stats: Arc<Mutex<StatsStore>>) -> DriverContext {
        context.stats = stats;
        context
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
                behavior: None,
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
    /// Issue #146：忙碌时投递必须把 streamingBehavior 传到协议层，
    /// 且「停止」要按 clear_queue → abort 的顺序走（Pi 的 abort 会继续执行排队消息）。
    #[tokio::test]
    async fn busy_prompt_carries_behavior_and_cancel_clears_the_queue_first() {
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

        for (text, behavior) in [
            ("插进当前", StreamingBehavior::Steer),
            ("排到下轮", StreamingBehavior::FollowUp),
        ] {
            let (reply_tx, reply_rx) = oneshot::channel();
            control_tx
                .send(RunCommand::Prompt {
                    text: text.to_owned(),
                    behavior: Some(behavior),
                    reply: reply_tx,
                })
                .await
                .unwrap();
            assert!(reply_rx.await.unwrap().is_ok());
        }

        // 空闲投递（behavior=None）不带排队方式。
        let (reply_tx, reply_rx) = oneshot::channel();
        control_tx
            .send(RunCommand::Prompt {
                text: "普通发送".to_owned(),
                behavior: None,
                reply: reply_tx,
            })
            .await
            .unwrap();
        assert!(reply_rx.await.unwrap().is_ok());

        let (reply_tx, reply_rx) = oneshot::channel();
        control_tx
            .send(RunCommand::ClearQueue { reply: reply_tx })
            .await
            .unwrap();
        assert!(reply_rx.await.unwrap().is_ok());

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
            [
                "prompt:插进当前:steer",
                "prompt:排到下轮:followUp",
                "prompt:普通发送",
                "clear_queue",
                "cancel",
                "stop",
            ],
            "排队方式必须逐条透传，清队列必须发生在 abort 之前"
        );
    }

    /// Issue #119 验收「浮窗数值与事件流一致」：统计只由驱动消费的同一批事件累加，
    /// 因此轮次 / 首 token / 上下文占用与上屏的事件完全对应。
    #[tokio::test]
    async fn statistics_are_accumulated_from_the_same_event_stream() {
        let (tx, rx) = mpsc::channel(8);
        let port = ScriptedPort {
            events: rx,
            calls: Arc::new(Mutex::new(Vec::new())),
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
        let stats = Arc::new(Mutex::new(StatsStore::new()));
        let (control_tx, control_rx) = mpsc::channel(4);
        let driver = tokio::spawn(drive(
            Box::new(port),
            "ses_a".to_owned(),
            1,
            control_rx,
            with_stats(
                context(
                    Arc::clone(&fanout),
                    Arc::clone(&gate),
                    Arc::clone(&statuses),
                    Arc::clone(&emitted),
                ),
                Arc::clone(&stats),
            ),
        ));

        // Pi 接受了 prompt：开始计时一轮。
        let (reply_tx, reply_rx) = oneshot::channel();
        control_tx
            .send(RunCommand::Prompt {
                text: "统计一下".to_owned(),
                behavior: None,
                reply: reply_tx,
            })
            .await
            .unwrap();
        assert!(reply_rx.await.unwrap().is_ok());

        tx.send(SupervisorEvent::AgentEvent {
            kind: "message_update".to_owned(),
            data: Some(serde_json::json!({
                "delta": "好的",
                "message": { "usage": { "input": 1_000, "output": 200, "cacheRead": 1_000 } }
            })),
        })
        .await
        .unwrap();
        tx.send(SupervisorEvent::Settled).await.unwrap();
        drop(tx);
        driver.await.unwrap();
        drop(control_tx);

        let snapshot = stats
            .lock()
            .unwrap()
            .snapshot("ses_a", std::time::Instant::now())
            .expect("观测过事件就必须有统计");
        assert_eq!(snapshot.turns, Some(1), "settled 才算一轮");
        assert!(
            snapshot.first_token_ms.is_some(),
            "第一个带文本的流式事件就是首 token"
        );
        assert_eq!(snapshot.context_used, Some(2_000), "input + cacheRead");
        assert_eq!(snapshot.cache_hit_pct, Some(50.0));
        // 上屏的事件数量不受统计影响：统计是旁路，不是第二个消费者。
        assert_eq!(emitted.lock().unwrap().len(), 2);
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
