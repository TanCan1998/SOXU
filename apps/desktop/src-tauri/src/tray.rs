//! 系统托盘：关闭主窗口只隐藏到托盘，托盘负责恢复窗口或真正退出进程。
//!
//! 托盘完全由 Rust 侧创建，不向 WebView 暴露任何新能力（`capabilities/default.json`
//! 不需要改动）。窗口隐藏后进程与 Supervisor 继续存活，因此隐藏不会中断运行中的会话；
//! 真正结束进程只有「托盘 → 退出」一条路径，`RunEvent::Exit` 仍会回收受管 Pi 进程。
//!
//! 隐藏后必须留下可感知的痕迹（Issue #101）：窗口消失本身就是「点 × 有反应」的
//! 全部证据，所以隐藏成功会把托盘 tooltip 换成「已最小化到托盘 · 单击图标显示窗口」，
//! 恢复可见时再改回来。这里不加通知插件，避免为一句提示引入常驻依赖与权限。

use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Runtime, Window, WindowEvent};

/// 主窗口 label：与 `tauri.conf.json` 里唯一窗口的默认 label 一致，由集成测试守护。
pub const MAIN_WINDOW_LABEL: &str = "main";

/// 托盘图标 id：固定 id 让「是否已创建」可判定，避免出现第二个托盘图标。
pub const TRAY_ID: &str = "soxu-main-tray";

/// 菜单项 id 与展示文案解耦：改文案不会打断事件分发。
pub const MENU_ID_SHOW: &str = "soxu-tray-show";
/// 菜单项 id：「退出」。
pub const MENU_ID_QUIT: &str = "soxu-tray-quit";

const MENU_TEXT_SHOW: &str = "显示窗口";
const MENU_TEXT_QUIT: &str = "退出";
/// 窗口可见时的托盘提示：只是品牌名，不占用信息带宽。
const TRAY_TOOLTIP: &str = "SOXU · 索序";
/// 窗口隐藏到托盘后的托盘提示（Issue #101）。
///
/// 隐藏后界面上没有任何东西能证明「进程还活着」，用户点 × 时看到的只是窗口消失，
/// 于是反馈成「关闭按钮没有反应」。tooltip 是唯一不引入新插件、也不新增常驻资源的
/// 反馈通道，所以文案必须同时说明「已隐藏」和「怎么回来」。
const TRAY_TOOLTIP_HIDDEN: &str = "SOXU 已最小化到托盘 · 单击图标显示窗口";

/// 托盘交互归一化后的动作，纯数据便于在无显示器环境测试平台差异。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayAction {
    /// 显示并聚焦主窗口。
    Show,
    /// 结束进程。
    Quit,
    /// 不处理：右键菜单、鼠标移入/移出等交给系统或菜单自身。
    Ignore,
}

/// 收到窗口关闭请求时的处理方式。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseAction {
    /// 隐藏到托盘，进程保留。
    HideToTray,
    /// 按系统默认行为关闭窗口。
    Default,
}

/// 托盘不可用时隐藏窗口会让应用再也无法恢复，因此必须回落到默认关闭行为
/// （例如 Linux 缺少 `libayatana-appindicator` 运行时导致托盘创建失败）。
pub fn close_action(tray_present: bool) -> CloseAction {
    if tray_present {
        CloseAction::HideToTray
    } else {
        CloseAction::Default
    }
}

/// 托盘 tooltip 随窗口可见性变化（Issue #101）。
///
/// 纯函数：隐藏/恢复两条路径共用同一份文案映射，避免一处写「已最小化」、
/// 另一处忘了改回来，导致窗口已经显示却还写着「已最小化到托盘」。
pub fn tray_tooltip(window_hidden: bool) -> &'static str {
    if window_hidden {
        TRAY_TOOLTIP_HIDDEN
    } else {
        TRAY_TOOLTIP
    }
}

/// 菜单 id → 动作；未知 id（例如未来新增的菜单项）不处理，避免误退出。
pub fn action_for_menu_id(id: &str) -> TrayAction {
    match id {
        MENU_ID_SHOW => TrayAction::Show,
        MENU_ID_QUIT => TrayAction::Quit,
        _ => TrayAction::Ignore,
    }
}

/// 托盘事件 → 动作。
///
/// 只响应「左键抬起」与 Windows 双击：按下和抬起都响应会让一次点击触发两次，
/// 右键留给菜单，移入/移出只用于悬停反馈。
pub fn action_for_tray_event(event: &TrayIconEvent) -> TrayAction {
    match event {
        TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
        } => TrayAction::Show,
        TrayIconEvent::DoubleClick {
            button: MouseButton::Left,
            ..
        } => TrayAction::Show,
        _ => TrayAction::Ignore,
    }
}

/// 创建托盘图标与菜单；已存在时直接返回，保证重复调用不会产生第二个图标。
///
/// 菜单事件统一由 `lib.rs` 的 `Builder::on_menu_event` 处理：Tauri 会把托盘菜单事件
/// 分发给同一组全局监听器，这里再注册一次会导致同一动作执行两次。
pub fn create_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    if app.tray_by_id(TRAY_ID).is_some() {
        return Ok(());
    }

    let show = MenuItem::with_id(app, MENU_ID_SHOW, MENU_TEXT_SHOW, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, MENU_ID_QUIT, MENU_TEXT_QUIT, true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    // Linux 下托盘常常必须有菜单才可见，因此三个平台统一挂同一个菜单。
    let menu = Menu::with_items(app, &[&show, &separator, &quit])?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        // 左键留给「恢复窗口」，菜单由右键打开（Linux 不支持该开关，左键即菜单）。
        .show_menu_on_left_click(false)
        .tooltip(tray_tooltip(false))
        .on_tray_icon_event(|tray, event| handle_tray_icon_event(tray, event));

    // 复用应用图标：它由 `tauri.conf.json` 的 `bundle.icon` 在编译期嵌入，
    // 因此不依赖 `pnpm icons:generate` 生成到磁盘的具体路径。
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }

    builder.build(app)?;
    Ok(())
}

/// 处理托盘菜单：显示窗口或真正退出。
pub fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, event: &MenuEvent) {
    match action_for_menu_id(event.id().as_ref()) {
        TrayAction::Show => {
            if let Err(error) = show_main_window(app) {
                eprintln!("SOXU: 托盘恢复窗口失败（{error}）");
            }
        }
        TrayAction::Quit => app.exit(0),
        TrayAction::Ignore => {}
    }
}

/// 处理托盘图标点击：左键恢复并聚焦窗口。
pub fn handle_tray_icon_event<R: Runtime>(tray: &TrayIcon<R>, event: TrayIconEvent) {
    if action_for_tray_event(&event) == TrayAction::Show
        && let Err(error) = show_main_window(tray.app_handle())
    {
        eprintln!("SOXU: 托盘恢复窗口失败（{error}）");
    }
}

/// 处理窗口事件：托盘可用时把关闭请求改成隐藏。
pub fn handle_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    let WindowEvent::CloseRequested { api, .. } = event else {
        return;
    };
    let tray_present = window.app_handle().tray_by_id(TRAY_ID).is_some();
    if close_action(tray_present) == CloseAction::HideToTray {
        // 顺序不能反：先阻止关闭，再隐藏；否则窗口已被销毁，托盘无法恢复。
        api.prevent_close();
        if let Err(error) = window.hide() {
            eprintln!("SOXU: 隐藏窗口到托盘失败（{error}）");
            return;
        }
        // 隐藏成功后才改提示：hide 失败时窗口仍在，提示必须继续描述「窗口可见」。
        sync_tooltip(window.app_handle(), true);
    }
}

/// 把窗口可见性同步到托盘提示；托盘不存在（创建失败）时安静跳过。
///
/// TrayIcon::set_tooltip 内部走 run_on_main_thread，而 tauri-runtime-wry 的
/// send_user_message 在当前线程就是主线程时会就地执行，因此窗口事件回调里直接
/// 调用不会因为等待事件循环而卡死。
fn sync_tooltip<R: Runtime>(app: &AppHandle<R>, window_hidden: bool) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    if let Err(error) = tray.set_tooltip(Some(tray_tooltip(window_hidden))) {
        eprintln!("SOXU: 更新托盘提示失败（{error}）");
    }
}

/// 显示并聚焦主窗口；窗口已被销毁时保持安静，退出由托盘菜单负责。
pub fn show_main_window<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return Ok(());
    };
    // 先还原最小化，再显示并抢焦点；否则从托盘恢复后窗口可能仍是最小化状态。
    if window.is_minimized()? {
        window.unminimize()?;
    }
    window.show()?;
    // 恢复可见后把提示改回品牌名：否则 tooltip 会一直停在「已最小化到托盘」，
    // 用户下次悬停会以为窗口还在托盘里。
    sync_tooltip(app, false);
    window.set_focus()
}
