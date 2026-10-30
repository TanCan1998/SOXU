//! 终端命令：创建 / 写入 / 调整尺寸 / 关闭。
//!
//! 命令层只做参数映射与错误转字符串；PTY 生命周期在 `soxu-pty-service`，
//! 工作目录守卫在 `crate::pty`。
//!
//! 全部是 async：关闭要等子进程退出（有界，最长 3 秒），不能阻塞主线程。

use tauri::State;

use soxu_pty_service::PtyService;

use crate::dto::{PtyClosedView, PtySessionView};
use crate::pty;
use crate::state::AppState;

/// 为某个会话打开终端。
///
/// 工作目录**不接受前端传参**：由会话目录推导（见 `pty::session_cwd`），
/// WebView 因此无法指定任意目录去起 shell。
#[tauri::command]
pub async fn create_pty(
    state: State<'_, AppState>,
    service: State<'_, PtyService>,
    session_id: String,
    cols: Option<u16>,
    rows: Option<u16>,
    shell: Option<String>,
) -> Result<PtySessionView, String> {
    pty::create(
        state.inner(),
        service.inner(),
        &session_id,
        cols,
        rows,
        shell,
    )
    .await
}

/// 把用户输入原样写进 shell（不做任何转义或行编辑）。
#[tauri::command]
pub async fn write_pty(
    service: State<'_, PtyService>,
    pty_id: String,
    data: String,
) -> Result<(), String> {
    service
        .write(&pty_id, &data)
        .map_err(|error| error.to_string())
}

/// 尺寸变化时通知内核与 shell（终端里跑全屏程序时靠它排版）。
#[tauri::command]
pub async fn resize_pty(
    service: State<'_, PtyService>,
    pty_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    service
        .resize(&pty_id, cols, rows)
        .map_err(|error| error.to_string())
}

/// 关闭终端并回收子进程。幂等：重复关闭返回 `existed: false`，不报错。
#[tauri::command]
pub async fn close_pty(
    service: State<'_, PtyService>,
    pty_id: String,
) -> Result<PtyClosedView, String> {
    let outcome = service.close(&pty_id).map_err(|error| error.to_string())?;
    if !outcome.exited {
        // 回收超时不是「关闭失败」：会话已经从注册表移除，但进程可能还在，
        // 必须留一条诊断，否则「无残留进程」这条验收会被静默破坏。
        eprintln!(
            "SOXU: 终端 {} 的子进程未在预算内退出，可能存在残留进程",
            outcome.id
        );
    }
    Ok(PtyClosedView {
        pty_id: outcome.id,
        existed: outcome.existed,
        exited: outcome.exited,
        exit_code: outcome.exit_code,
    })
}
