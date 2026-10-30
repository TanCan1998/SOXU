//! 统计命令：composer 上下文环、统计浮窗与底部统计行共用同一个入口。
//!
//! 只做参数映射：累加与采样都在 crate::stats 里，命令层不碰事件流也不起定时器。

use tauri::State;

use crate::dto::SessionStats;
use crate::state::AppState;
use crate::stats;

/// 读取一个会话的统计快照。
///
/// 前端只在**事件驱动**的时机调用它（启动、状态变化、settled、退出、打开浮窗），
/// 不轮询：多一个轮询就等于给低内存目标加一份常驻成本。
#[tauri::command]
pub async fn session_stats(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<SessionStats, String> {
    stats::collect(state.inner(), &session_id).await
}
