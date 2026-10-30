//! SOXU 桌面端入口：把 Tauri 窗口接到 Rust Supervisor 与会话目录。
//!
//! 分层：commands（IPC 边界，按领域拆分为 `commands/` 子模块）→
//! workspace / session_runtime / git（业务）→ driver / watch / entry_text（运行时与索引适配）→
//! agent-runtime / session-index / git-worktree。

mod commands;
mod driver;
mod entry_text;
mod events;
mod watch;
// 语言包存储（Issue #135）：只读写应用数据目录下的 locales/，不碰 Pi 会话文件。
pub mod locale_store;
// 适配层对集成测试开放：测试直接调用真实 catalog/runtime 封装，而不是复制实现。
pub mod dto;
pub mod git;
pub mod retry_store;
pub mod session_runtime;
pub mod state;
pub mod stats;
pub mod tray;
pub mod workspace;
pub mod worktree;

use tauri::Manager;

use crate::state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 目录选择器插件：前端「添加项目」用 dialog:allow-open 权限调用。
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let state_dir = app
                .path()
                .app_data_dir()
                .map_err(|error| format!("无法解析应用数据目录：{error}"))?;
            // 语言包目录与 AppState 并列受管：它有自己的 owner（locale_store::LocaleStore），
            // 不挂在 AppState 上，避免「会话状态」与「用户导入的语言包」互相牵连。
            app.manage(locale_store::LocaleStore::new(state_dir.join("locales")));
            let state = AppState::new(state_dir)
                .map_err(|error| format!("初始化工作区状态失败：{error}"))?;
            app.manage(state);
            // 托盘创建失败（例如 Linux 缺少 libayatana-appindicator 运行时）不阻断启动：
            // 此时窗口关闭按系统默认行为退出，避免隐藏后无法再恢复。
            if let Err(error) = tray::create_tray(app.handle()) {
                eprintln!("SOXU: 创建系统托盘失败，关闭窗口将直接退出（{error}）");
            }
            Ok(())
        })
        // 托盘菜单与窗口菜单共用同一组全局监听器，因此只在这里注册一次。
        .on_menu_event(|app, event| tray::handle_menu_event(app, &event))
        .on_window_event(tray::handle_window_event)
        // ── 领域块规则（Issue #112 / docs/development/command-blocks.md）──
        // 新增 command 只能追加到自己领域块内（行首注释下方），块内按字母序排列；
        // 不得在其他领域块内插入。`scripts/check-command-blocks.mjs` 会校验落位与顺序。
        .invoke_handler(tauri::generate_handler![
            // ── session ──
            commands::cancel_session,
            commands::release_session_events,
            commands::retain_session_events,
            commands::runtime_status,
            commands::send_prompt,
            commands::start_session,
            commands::stop_session,
            // ── workspace ──
            commands::list_projects,
            commands::refresh_project,
            commands::register_project,
            commands::runtime_info,
            // ── worktree ──
            commands::create_worktree,
            commands::list_worktrees,
            commands::plan_worktree_removal,
            commands::prune_worktrees,
            commands::remove_worktree,
            commands::worktree_diff,
            // ── history ──
            commands::bind_temporary_session_file,
            commands::discard_temporary_session,
            commands::open_session_history,
            commands::open_temporary_session,
            commands::promote_session,
            commands::read_session_texts,
            commands::search_session,
            // ── files（V4：新 command 只加在本行下方）──
            // ── git（V4：新 command 只加在本行下方）──
            commands::git_branches,
            commands::git_commit,
            commands::git_diff,
            commands::git_log,
            commands::git_pull,
            commands::git_push,
            commands::git_stage,
            commands::git_status,
            // ── pty（V4：新 command 只加在本行下方）──
            // ── model（V4：新 command 只加在本行下方）──
            // ── stats（V4：新 command 只加在本行下方）──
            commands::session_stats,
            // ── outline（V4：新 command 只加在本行下方）──
            // ── extension（V4：新 command 只加在本行下方）──
            commands::delete_locale_pack,
            commands::list_locale_packs,
            commands::read_locale_pack,
            commands::read_locale_source,
            commands::save_locale_pack,
            // ── notify（V4：新 command 只加在本行下方）──
            // ── search（V4：新 command 只加在本行下方）──
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

#[cfg(test)]
mod tests {
    //! 命令层拆分后的路径回归（Issue #112）。
    //!
    //! 拆分只搬位置，前端 invoke 名称与 `commands::<name>` 路径必须保持不变；
    //! 这里按领域各取一个代表，让「再导出漏了一块」在编译期就失败。
    //! 真正的 IPC 冒烟需要桌面窗口，属于实机验收。

    use crate::commands;

    #[test]
    fn command_reexports_keep_their_paths() {
        // session / worktree / history：Issue #112 验收里点名的三个命令。
        let _ = commands::start_session;
        let _ = commands::list_worktrees;
        let _ = commands::open_session_history;
        // workspace 与 history 的其余入口同样必须能从 commands 顶层取到。
        let _ = commands::runtime_info;
        let _ = commands::search_session;
        // V4 新领域：stats 块里的第一条命令也必须能从 commands 顶层取到。
        let _ = commands::session_stats;
        // V4 新领域：extension 块里的语言包命令同样必须能从 commands 顶层取到（Issue #135）。
        let _ = commands::list_locale_packs;
    }
}
