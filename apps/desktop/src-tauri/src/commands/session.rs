//! 会话运行时命令：启动、发送、取消、停止，以及状态查询与事件订阅计数。

use tauri::{AppHandle, State};

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
/// `mode` 与 `thinking` 是 V4-S1 新增的可选参数（Issue #111）：
/// 命令层接收并校验取值（非法值由 serde 直接报错），但**不改变行为**——
/// 注入当前回合 / 排队到下一轮 / 并行会话的运行时语义属于后续切片。
/// 旧前端不传这两个字段时按 `None` 处理，行为与改动前完全一致。
#[tauri::command]
pub async fn send_prompt(
    state: State<'_, AppState>,
    session_id: String,
    text: String,
    mode: Option<PromptMode>,
    thinking: Option<ThinkingLevel>,
) -> Result<(), String> {
    // 显式消费两个参数：既让「参数已接通但未生效」这件事留在代码里，
    // 也避免编译器对未使用参数告警。
    let _ = (mode, thinking);
    session_runtime::prompt(state.inner(), &session_id, &text).await
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
