//! 子进程管道的三个任务：stdin 写入、stdout 分帧读取、stderr 诊断。
//!
//! 每个任务只持有一条管道，任务结束即释放句柄；上层通过 RuntimeShared 观察结果。

use std::sync::Arc;

use soxu_pi_protocol::{EVENT_AGENT_SETTLED, Inbound, RECORD_EXTENSION_UI_REQUEST, decode_inbound};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStderr, ChildStdin, ChildStdout};
use tokio::sync::mpsc;

use crate::frame::LineFramer;
use crate::redact::sanitize_stderr_line;
use crate::shared::{RuntimeShared, SupervisorEvent, TerminateReason};
use crate::state::RuntimeState;

/// 逐帧写入 stdin；通道关闭即关闭 stdin（让子进程收到 EOF）。
pub(crate) async fn run_writer(mut stdin: ChildStdin, mut frames: mpsc::Receiver<String>) {
    while let Some(frame) = frames.recv().await {
        if stdin.write_all(frame.as_bytes()).await.is_err() {
            break;
        }
        if stdin.flush().await.is_err() {
            break;
        }
    }
    // stdin 在这里被 drop：子进程读到 EOF 后会自行退出。
}

/// 读取 stdout，按 LF 分帧后分发；结束时通知 supervisor 处理进程退出。
pub(crate) async fn run_reader(
    shared: Arc<RuntimeShared>,
    stdout: ChildStdout,
    max_frame_bytes: usize,
) {
    let mut framer = LineFramer::new(max_frame_bytes);
    let mut reader = BufReader::new(stdout);
    let mut buffer = vec![0u8; 8 * 1024];
    let mut desync: Option<String> = None;

    loop {
        match reader.read(&mut buffer).await {
            Ok(0) => break,
            Ok(read) => match framer.push(&buffer[..read]) {
                Ok(lines) => {
                    for line in lines {
                        dispatch(&shared, &line).await;
                    }
                }
                Err(error) => {
                    desync = Some(format!("{error}"));
                    break;
                }
            },
            Err(error) => {
                desync = Some(format!("stdout read failed: {error}"));
                break;
            }
        }
    }

    // 有些 CLI 最后一行不带换行；EOF 时补一次 finish。
    if desync.is_none() {
        match framer.finish() {
            Ok(Some(line)) => dispatch(&shared, &line).await,
            Ok(None) => {}
            Err(error) => desync = Some(format!("{error}")),
        }
    }

    match desync {
        Some(detail) => {
            shared.record_protocol_warning(detail);
            shared.request_terminate(TerminateReason::Desync);
        }
        None => shared.request_terminate(TerminateReason::StreamClosed),
    }
}

/// stderr 仅作诊断：逐行截断、脱敏、有界保留。
pub(crate) async fn run_stderr(shared: Arc<RuntimeShared>, stderr: ChildStderr, ring: usize) {
    let mut lines = BufReader::new(stderr).lines();
    loop {
        match lines.next_line().await {
            Ok(Some(line)) => shared.push_stderr(sanitize_stderr_line(&line), ring),
            Ok(None) => break,
            Err(_) => break,
        }
    }
}

async fn dispatch(shared: &Arc<RuntimeShared>, line: &str) {
    match decode_inbound(line) {
        Err(error) => shared.record_protocol_warning(format!("{error}")),
        Ok(Inbound::Response(response)) => {
            if let Err(unmatched) = shared.claim_response(response) {
                shared.emit_bounded(SupervisorEvent::UnmatchedResponse {
                    request_id: unmatched.id,
                });
            }
        }
        Ok(Inbound::Event(event)) => {
            if event.event == EVENT_AGENT_SETTLED {
                let state = shared.state.get();
                if state != RuntimeState::Stopping && !state.is_terminal() {
                    shared.transition(RuntimeState::Idle);
                }
                shared.emit_control(SupervisorEvent::Settled).await;
            } else {
                if event.event == "agent_start" {
                    shared.transition(RuntimeState::Running);
                }
                shared
                    .emit_control(SupervisorEvent::AgentEvent {
                        kind: event.event,
                        data: event.data,
                    })
                    .await;
            }
        }
        Ok(Inbound::Other { kind, .. }) => {
            // 扩展审批绝不自动确认：本层没有 UI，只能显式警告并按未处理上报。
            if kind == RECORD_EXTENSION_UI_REQUEST {
                shared.record_protocol_warning(
                    "extension ui request is not implemented; treated as denied".to_owned(),
                );
            }
            shared.emit_bounded(SupervisorEvent::UnhandledRecord { kind });
        }
    }
}
