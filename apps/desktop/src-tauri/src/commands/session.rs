//! 会话运行时命令：启动、发送、取消、停止，以及状态查询与事件订阅计数。

use tauri::{AppHandle, State};

use soxu_agent_runtime::StreamingBehavior;

use crate::dto::{PromptMode, RuntimeStarted, RuntimeStatus, ThinkingLevel};
use crate::session_runtime;
use crate::state::AppState;

#[tauri::command]
pub async fn start_session(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    temporary: Option<bool>,
) -> Result<RuntimeStarted, String> {
    session_runtime::start(&app, state.inner(), &session_id, temporary.unwrap_or(false)).await
}

/// 发送一条消息。
///
/// `mode` 的运行时语义自 Issue #146 起真的生效（协议事实见
/// docs/development/send-modes.md）：
/// - `steer` → prompt + streamingBehavior=steer，插进当前回合；
/// - `followUp` → prompt + streamingBehavior=followUp，本轮结束后再处理；
/// - `parallel` → 不带排队方式：并行发送由前端另开临时会话，这里只作为兜底，
///   避免任何取值被静默丢弃；
/// - 省略（None）→ 空闲投递，线格式与旧客户端完全一致。
///
/// `thinking` 仍然只做参数管道：思考强度要等 set_thinking_level 接入。
#[tauri::command]
pub async fn send_prompt(
    state: State<'_, AppState>,
    session_id: String,
    text: String,
    mode: Option<PromptMode>,
    thinking: Option<ThinkingLevel>,
) -> Result<(), String> {
    let _ = thinking;
    let behavior = match mode {
        Some(PromptMode::Steer) => Some(StreamingBehavior::Steer),
        Some(PromptMode::FollowUp) => Some(StreamingBehavior::FollowUp),
        Some(PromptMode::Parallel) | None => None,
    };
    session_runtime::prompt(state.inner(), &session_id, &text, behavior).await
}

/// 清空 Pi 侧的排队消息（steering + follow-up）。
///
/// 「停止」在 abort 之前调用它：Pi 的 abort 会继续执行仍留在队列里的消息，
/// 用户按了停止却看到排队的消息又跑起来是明确的错误行为。
#[tauri::command]
pub async fn clear_queued_prompts(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    session_runtime::clear_queue(state.inner(), &session_id).await
}

#[tauri::command]
pub async fn cancel_session(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    session_runtime::cancel(state.inner(), &session_id).await
}

#[tauri::command]
pub async fn stop_session(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    session_runtime::stop(state.inner(), &session_id).await
}

#[tauri::command]
pub async fn runtime_status(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Option<RuntimeStatus>, String> {
    Ok(session_runtime::status(state.inner(), &session_id).await)
}

/// 视图挂载：开始为这个会话积累订阅计数（计数 > 0 时才 emit）。
#[tauri::command]
pub async fn retain_session_events(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<usize, String> {
    Ok(session_runtime::retain_events(state.inner(), &session_id).await)
}

/// 视图卸载/关闭 Tab：释放订阅，计数归零后后端不再 emit。
#[tauri::command]
pub async fn release_session_events(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<usize, String> {
    Ok(session_runtime::release_events(state.inner(), &session_id).await)
}
