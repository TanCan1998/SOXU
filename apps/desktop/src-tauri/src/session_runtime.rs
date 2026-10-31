//! 运行时控制：启动 / 发送 / 取消 / 停止，以及事件订阅的挂载与释放。
//!
//! 每个 sessionId 至多一个驱动任务。启动流程串行化（`start_guard`），
//! 因此并发点击不会拉起两个 Pi 进程，也不会出现双写同一 JSONL 的运行时。
//!
//! 启动阶段接入了**有界重试**（`soxu_agent_runtime::retry`）：只有握手超时/瞬时
//! 传输故障会自动重试，次数写入 `retry/` 下的持久化预算，进程重启也不会重置。
//! 429/额度、鉴权失败与用户中止不重试，直接报错并把预算钉死等人工恢复。

use std::sync::Arc;
use std::time::{Duration, Instant};

use soxu_agent_runtime::retry::{RetryPolicy, start_with_retry_cancellable};
use soxu_agent_runtime::{PiProgram, StreamingBehavior};
use soxu_session_index::SessionId;
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, oneshot};
use tokio::time::timeout;

use crate::driver::{DriverContext, HandlePort, RunCommand, RunStatus, drive};
use crate::dto::{RuntimeStarted, RuntimeStatus};
use crate::events::{RUNTIME_EVENT_NAME, RuntimeEvent};
use crate::state::{AppState, RunHandle, lock};

/// 单条命令（含 Pi 接收 prompt）的最长等待；超时返回错误而不是挂住界面。
const COMMAND_TIMEOUT: Duration = Duration::from_secs(120);
/// 停止运行的回收预算；超时后仍会走 supervisor 的强制终止路径。
const STOP_TIMEOUT: Duration = Duration::from_secs(15);
/// 启动阶段的有界重试策略：最多 2 次、500ms 起指数退避、单次不超过 8 秒。
/// 保持常量，避免不同入口（手动启动 / 恢复）用不同预算绕过限制。
const RETRY_POLICY: RetryPolicy = RetryPolicy::conservative();

pub async fn start(
    app: &AppHandle,
    state: &AppState,
    session_id: &str,
    temporary: bool,
) -> Result<RuntimeStarted, String> {
    let session_id = session_id.trim();
    if session_id.is_empty() {
        return Err("sessionId 不能为空".to_owned());
    }
    let _serialized = state.start_guard.lock().await;

    // 已在运行（且命令通道仍活着）时直接复用，避免重复拉起进程。
    let running = {
        let runs = state.runs.lock().await;
        runs.get(session_id)
            .filter(|run| !run.control.is_closed())
            .map(|run| (run.runtime_id.clone(), run.generation))
    };
    if let Some((runtime_id, generation)) = running {
        let status = state
            .status_of(session_id)
            .ok_or_else(|| "运行时状态缺失".to_owned())?;
        return Ok(RuntimeStarted {
            session_id: session_id.to_owned(),
            runtime_id,
            generation,
            state: status.state,
            // 复用在跑的运行时：预算以磁盘记录为准，不在这里清零。
            retry: state.retry.load(session_id, RETRY_POLICY).status(),
        });
    }
    state.runs.lock().await.remove(session_id);

    // 预算先读盘再启动：上一次未成功的重试次数不会因为重启而清零。
    let mut ledger = state.retry.load(session_id, RETRY_POLICY);
    // 登记取消句柄再启动：用户在重试退避窗口里点「停止」也能立刻收手，
    // 不必等退避睡满、更不会多拉起一次子进程。
    let cancel = state.begin_pending_start(session_id);
    let started = start_with_retry_cancellable(
        &state.supervisor,
        session_id,
        &PiProgram::pi_rpc(),
        &mut ledger,
        &cancel,
    )
    .await;
    state.finish_pending_start(session_id);
    let handle = started.map_err(|error| {
        // 失败也要落盘：耗尽/取消状态必须在重启后仍然可见（不会绕过预算）。
        state.retry.save(session_id, &ledger);
        error.to_string()
    })?;
    state.retry.save(session_id, &ledger);
    let retry = ledger.status();
    let identity = handle.identity().clone();
    if !state.gate.begin(session_id, identity.generation) {
        let mut handle = handle;
        let _ = handle.stop().await;
        return Err("generation 回退：已存在更新的运行时".to_owned());
    }
    // 新一代运行时开始：丢弃上一代未完成的一轮计时（累计 token 与轮次保留）。
    lock(&state.stats).begin_generation(session_id, identity.generation, Instant::now());

    // 临时会话同样要声明可写归属：否则转正后再启动会对同一 JSONL 双写。
    claim_catalog(state, session_id, &identity.runtime_id, temporary).await;

    let status = RunStatus {
        runtime_id: identity.runtime_id.clone(),
        generation: identity.generation,
        state: "idle".to_owned(),
        exit: None,
    };
    state.set_status(session_id, status.clone());

    let (control_tx, control_rx) = mpsc::channel(16);
    let sink_app = app.clone();
    let context = DriverContext {
        gate: Arc::clone(&state.gate),
        fanout: Arc::clone(&state.fanout),
        statuses: Arc::clone(&state.statuses),
        stats: Arc::clone(&state.stats),
        sink: Arc::new(move |event: RuntimeEvent| {
            let _ = sink_app.emit(RUNTIME_EVENT_NAME, event);
        }),
    };
    let session = session_id.to_owned();
    let generation = identity.generation;
    tauri::async_runtime::spawn(async move {
        drive(
            Box::new(HandlePort::new(handle)),
            session,
            generation,
            control_rx,
            context,
        )
        .await;
    });

    state.runs.lock().await.insert(
        session_id.to_owned(),
        RunHandle {
            runtime_id: identity.runtime_id.clone(),
            generation: identity.generation,
            control: control_tx,
        },
    );

    Ok(RuntimeStarted {
        session_id: session_id.to_owned(),
        runtime_id: identity.runtime_id,
        generation: identity.generation,
        state: status.state,
        retry,
    })
}

/// 发送一条消息。
///
/// behavior 为 None 表示 agent 空闲时的普通投递；agent 忙碌时必须给出排队方式，
/// 否则 Pi 会拒绝这条 prompt（实测见 docs/development/send-modes.md）。
pub async fn prompt(
    state: &AppState,
    session_id: &str,
    text: &str,
    behavior: Option<StreamingBehavior>,
) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("消息不能为空".to_owned());
    }
    let control = sender(state, session_id).await?;
    let (reply_tx, reply_rx) = oneshot::channel();
    control
        .send(RunCommand::Prompt {
            text: text.to_owned(),
            behavior,
            reply: reply_tx,
        })
        .await
        .map_err(|_| "运行时已结束，请重新启动会话".to_owned())?;
    await_reply(reply_rx, COMMAND_TIMEOUT, "发送消息").await
}

/// 清空 Pi 侧的排队消息（steering + follow-up）。
///
/// 停止流程会先调用它：Pi 的 abort 会继续执行仍留在队列里的消息，
/// 用户按了停止却看到排队的消息又跑起来是明确的错误行为。
pub async fn clear_queue(state: &AppState, session_id: &str) -> Result<(), String> {
    let control = sender(state, session_id).await?;
    let (reply_tx, reply_rx) = oneshot::channel();
    control
        .send(RunCommand::ClearQueue { reply: reply_tx })
        .await
        .map_err(|_| "运行时已结束，无法清空排队消息".to_owned())?;
    await_reply(reply_rx, COMMAND_TIMEOUT, "清空排队消息").await
}

pub async fn cancel(state: &AppState, session_id: &str) -> Result<(), String> {
    // 启动还没完成（例如正在重试退避）：取消重试窗口，视作已中止。
    if state.cancel_pending_start(session_id) {
        return Ok(());
    }
    let control = sender(state, session_id).await?;
    let (reply_tx, reply_rx) = oneshot::channel();
    control
        .send(RunCommand::Cancel { reply: reply_tx })
        .await
        .map_err(|_| "运行时已结束，无法取消".to_owned())?;
    await_reply(reply_rx, COMMAND_TIMEOUT, "取消当前轮次").await
}

pub async fn stop(state: &AppState, session_id: &str) -> Result<(), String> {
    // 启动中的会话也要能停：先取消重试退避窗口，再与启动流程串行。
    // 串行是必要的——否则「启动刚成功、runs 还没登记」的空档会把停止变成空操作，
    // 留下一个用户以为已经停掉、实际仍在跑的运行时。取消之后启动会立刻收手，
    // 所以这里等 start_guard 是有界的，不会卡住整个退避窗口。
    state.cancel_pending_start(session_id);
    let serialized = state.start_guard.lock().await;
    let run = state.runs.lock().await.remove(session_id);
    // 取出句柄即可释放启动闸门：后续回收只作用于这个 runtimeId，
    // 不应该让「再点一次启动」白等一次停止握手。
    drop(serialized);
    let Some(run) = run else {
        return Ok(()); // 停止是幂等的：没有运行中的 Agent 也算成功。
    };
    let (reply_tx, reply_rx) = oneshot::channel();
    if run
        .control
        .send(RunCommand::Shutdown { reply: reply_tx })
        .await
        .is_ok()
    {
        let _ = timeout(STOP_TIMEOUT, reply_rx).await;
    } else {
        // 驱动任务已经不在：直接让 supervisor 回收该进程。
        let _ = state.supervisor.stop(&run.runtime_id).await;
    }
    release_catalog(state, session_id, &run.runtime_id).await;
    // 水位保留：停止后再到的同一 generation 事件也不会污染下一次启动。
    state.gate.retire(session_id, run.generation);
    Ok(())
}

pub async fn status(state: &AppState, session_id: &str) -> Option<RuntimeStatus> {
    let running = state.runs.lock().await.contains_key(session_id);
    let status = state.status_of(session_id)?;
    Some(RuntimeStatus {
        session_id: session_id.to_owned(),
        runtime_id: status.runtime_id,
        generation: status.generation,
        state: if running {
            status.state
        } else {
            "exited".to_owned()
        },
        exit: status.exit,
        retry: state.retry.status(session_id, RETRY_POLICY),
    })
}

/// 视图开始观察会话（前端订阅后的第一次挂载）。
pub async fn retain_events(state: &AppState, session_id: &str) -> usize {
    state.fanout.attach(session_id)
}

/// 视图卸载或关闭 Tab：计数归零后后端不再 emit，事件通道随之安静。
pub async fn release_events(state: &AppState, session_id: &str) -> usize {
    state.fanout.detach(session_id)
}

pub async fn shutdown_all(state: &AppState) {
    let _guard = state.start_guard.lock().await;
    let runs: Vec<(String, String)> = {
        let runs = state.runs.lock().await;
        runs.iter()
            .map(|(session, run)| (session.clone(), run.runtime_id.clone()))
            .collect()
    };
    for (session, runtime_id) in runs {
        let run = state.runs.lock().await.remove(&session);
        if let Some(run) = run {
            let (reply_tx, reply_rx) = oneshot::channel();
            if run
                .control
                .send(RunCommand::Shutdown { reply: reply_tx })
                .await
                .is_ok()
            {
                let _ = timeout(STOP_TIMEOUT, reply_rx).await;
            }
        }
        release_catalog(state, &session, &runtime_id).await;
    }
    let _ = state.supervisor.shutdown().await;
}

async fn sender(state: &AppState, session_id: &str) -> Result<mpsc::Sender<RunCommand>, String> {
    state
        .runs
        .lock()
        .await
        .get(session_id)
        .map(|run| run.control.clone())
        .ok_or_else(|| "会话没有运行中的 Agent，请先启动".to_owned())
}

async fn await_reply<T>(
    receiver: oneshot::Receiver<Result<T, String>>,
    budget: Duration,
    action: &str,
) -> Result<T, String> {
    match timeout(budget, receiver).await {
        Ok(Ok(Ok(value))) => Ok(value),
        Ok(Ok(Err(reason))) => Err(reason),
        Ok(Err(_)) => Err(format!("{action}失败：运行时应答通道关闭")),
        Err(_) => Err(format!("{action}超时")),
    }
}

/// 会话目录的运行时归属：上一个进程崩溃遗留的链接先清理，再声明本次所有权。
///
/// 临时会话没有持久化记录，归属只登记在内存登记表里（不落盘），但语义相同：
/// 同一会话最多一个可写运行时，转正/结束前必须先释放。
async fn claim_catalog(state: &AppState, session_id: &str, runtime_id: &str, temporary: bool) {
    let session = SessionId::new(session_id);
    let mut catalog = state.catalog.lock().await;
    if temporary {
        // 与持久化会话一致：先清掉上一代（崩溃/自行退出）遗留的归属，再声明本次所有权。
        // 启动已被 start_guard 串行化，此处的遗留归属不可能还有活进程。
        let _ = catalog.release_stale_temporary_runtime(&session);
        if let Err(error) = catalog.claim_temporary_writable(&session, runtime_id) {
            // 归属失败不阻断对话：会话文件仍由 Pi 自己拥有，只在诊断里留痕。
            eprintln!("SOXU: 临时会话 {session_id} 归属未登记（{error}）");
        }
        return;
    }
    if catalog.find_session(&session).is_none() {
        return;
    }
    let _ = catalog.release_stale_runtime(&session);
    if let Err(error) = catalog.claim_writable(&session, runtime_id) {
        eprintln!("SOXU: 会话 {session_id} 归属未登记（{error}）");
    }
    let _ = catalog.save_if_dirty();
}

async fn release_catalog(state: &AppState, session_id: &str, runtime_id: &str) {
    let session = SessionId::new(session_id);
    let mut catalog = state.catalog.lock().await;
    if catalog.is_temporary(&session) {
        let _ = catalog.release_temporary_writable(&session, runtime_id);
        return;
    }
    if catalog.find_session(&session).is_none() {
        return;
    }
    let _ = catalog.release(&session, runtime_id);
    let _ = catalog.save_if_dirty();
}

/// 该会话是否有活运行时：命令通道未关闭，或启动仍在进行（含重试退避窗口）。
///
/// 转正/结束临时会话前必须为 false——否则旧 Pi 会失去 owner（停止变成 no-op 假成功），
/// 转正后再启动就会对同一 JSONL 双写。
pub async fn has_live_runtime(state: &AppState, session_id: &str) -> bool {
    if state.is_start_pending(session_id) {
        return true;
    }
    let runs = state.runs.lock().await;
    runs.get(session_id)
        .is_some_and(|run| !run.control.is_closed())
}
