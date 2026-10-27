//! 运行时控制：启动 / 发送 / 取消 / 停止，以及事件订阅的挂载与释放。
//!
//! 每个 sessionId 至多一个驱动任务。启动流程串行化（`start_guard`），
//! 因此并发点击不会拉起两个 Pi 进程，也不会出现双写同一 JSONL 的运行时。

use std::sync::Arc;
use std::time::Duration;

use soxu_agent_runtime::PiProgram;
use soxu_session_index::SessionId;
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, oneshot};
use tokio::time::timeout;

use crate::driver::{DriverContext, HandlePort, RunCommand, RunStatus, drive};
use crate::dto::{RuntimeStarted, RuntimeStatus};
use crate::events::{RUNTIME_EVENT_NAME, RuntimeEvent};
use crate::state::{AppState, RunHandle};

/// 单条命令（含 Pi 接收 prompt）的最长等待；超时返回错误而不是挂住界面。
const COMMAND_TIMEOUT: Duration = Duration::from_secs(120);
/// 停止运行的回收预算；超时后仍会走 supervisor 的强制终止路径。
const STOP_TIMEOUT: Duration = Duration::from_secs(15);

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
        });
    }
    state.runs.lock().await.remove(session_id);

    let handle = state
        .supervisor
        .start(session_id, &PiProgram::pi_rpc())
        .await
        .map_err(|error| error.to_string())?;
    let identity = handle.identity().clone();
    if !state.gate.begin(session_id, identity.generation) {
        let mut handle = handle;
        let _ = handle.stop().await;
        return Err("generation 回退：已存在更新的运行时".to_owned());
    }

    if !temporary {
        claim_catalog(state, session_id, &identity.runtime_id).await;
    }

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
    })
}

pub async fn prompt(state: &AppState, session_id: &str, text: &str) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("消息不能为空".to_owned());
    }
    let control = sender(state, session_id).await?;
    let (reply_tx, reply_rx) = oneshot::channel();
    control
        .send(RunCommand::Prompt {
            text: text.to_owned(),
            reply: reply_tx,
        })
        .await
        .map_err(|_| "运行时已结束，请重新启动会话".to_owned())?;
    await_reply(reply_rx, COMMAND_TIMEOUT, "发送消息").await
}

pub async fn cancel(state: &AppState, session_id: &str) -> Result<(), String> {
    let control = sender(state, session_id).await?;
    let (reply_tx, reply_rx) = oneshot::channel();
    control
        .send(RunCommand::Cancel { reply: reply_tx })
        .await
        .map_err(|_| "运行时已结束，无法取消".to_owned())?;
    await_reply(reply_rx, COMMAND_TIMEOUT, "取消当前轮次").await
}

pub async fn stop(state: &AppState, session_id: &str) -> Result<(), String> {
    let run = state.runs.lock().await.remove(session_id);
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
async fn claim_catalog(state: &AppState, session_id: &str, runtime_id: &str) {
    let session = SessionId::new(session_id);
    let mut catalog = state.catalog.lock().await;
    if catalog.find_session(&session).is_none() {
        return;
    }
    let _ = catalog.release_stale_runtime(&session);
    if let Err(error) = catalog.claim_writable(&session, runtime_id) {
        // 归属失败不阻断对话：会话文件仍由 Pi 自己拥有，只在诊断里留痕。
        eprintln!("SOXU: 会话 {session_id} 归属未登记（{error}）");
    }
    let _ = catalog.save_if_dirty();
}

async fn release_catalog(state: &AppState, session_id: &str, runtime_id: &str) {
    let session = SessionId::new(session_id);
    let mut catalog = state.catalog.lock().await;
    if catalog.find_session(&session).is_none() {
        return;
    }
    let _ = catalog.release(&session, runtime_id);
    let _ = catalog.save_if_dirty();
}
