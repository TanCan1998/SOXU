//! SOXU 桌面端入口：把 Tauri 窗口接到 Rust Supervisor 与会话目录。
//!
//! 分层：commands（IPC 边界）→ workspace / session_runtime（业务）→
//! driver / watch / entry_text（运行时与索引适配）→ agent-runtime / session-index。

mod commands;
mod driver;
mod entry_text;
mod events;
mod watch;
// 适配层对集成测试开放：测试直接调用真实 catalog/runtime 封装，而不是复制实现。
pub mod dto;
pub mod session_runtime;
pub mod state;
pub mod workspace;
pub mod worktree;

use tauri::Manager;

use crate::state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let state_dir = app
                .path()
                .app_data_dir()
                .map_err(|error| format!("无法解析应用数据目录：{error}"))?;
            let state = AppState::new(state_dir)
                .map_err(|error| format!("初始化工作区状态失败：{error}"))?;
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::runtime_info,
            commands::list_projects,
            commands::register_project,
            commands::refresh_project,
            commands::list_worktrees,
            commands::plan_worktree_removal,
            commands::create_worktree,
            commands::worktree_diff,
            commands::remove_worktree,
            commands::prune_worktrees,
            commands::open_session_history,
            commands::read_session_texts,
            commands::start_session,
            commands::send_prompt,
            commands::cancel_session,
            commands::stop_session,
            commands::runtime_status,
            commands::retain_session_events,
            commands::release_session_events,
        ])
        .build(tauri::generate_context!())
        .expect("Failed to build SOXU")
        .run(|app, event| {
            // 退出前显式回收受管 Pi 进程；supervisor 的 kill_on_drop 只是最后防线。
            if let tauri::RunEvent::Exit = event
                && let Some(state) = app.try_state::<AppState>()
            {
                tauri::async_runtime::block_on(session_runtime::shutdown_all(&state));
            }
        });
}
