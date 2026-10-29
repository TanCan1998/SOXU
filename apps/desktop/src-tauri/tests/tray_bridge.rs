//! 系统托盘的纯逻辑回归：菜单/点击归一化、关闭回退、窗口 label 与配置一致。
//!
//! 这些用例不启动 Tauri 运行时，因此不需要显示器；真实的托盘图标、点击恢复与
//! 退出进程属于实机验收，见 Issue #90 的验证记录。

use soxu_desktop_lib::tray::{
    self, CloseAction, MAIN_WINDOW_LABEL, MENU_ID_QUIT, MENU_ID_SHOW, TRAY_ID, TrayAction,
};
use tauri::Rect;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconEvent, TrayIconId};

fn click(button: MouseButton, button_state: MouseButtonState) -> TrayIconEvent {
    TrayIconEvent::Click {
        id: TrayIconId::new(TRAY_ID),
        position: tauri::PhysicalPosition::new(0.0, 0.0),
        rect: Rect::default(),
        button,
        button_state,
    }
}

#[test]
fn tray_menu_ids_map_to_show_and_quit() {
    assert_eq!(tray::action_for_menu_id(MENU_ID_SHOW), TrayAction::Show);
    assert_eq!(tray::action_for_menu_id(MENU_ID_QUIT), TrayAction::Quit);
    // 未知 id 不能触发退出，否则新增菜单项会误杀进程。
    assert_eq!(
        tray::action_for_menu_id("soxu-tray-unknown"),
        TrayAction::Ignore
    );
    assert_eq!(tray::action_for_menu_id(""), TrayAction::Ignore);
}

#[test]
fn left_click_up_restores_window_exactly_once() {
    // 按下与抬起都响应会让一次点击触发两次；只认抬起。
    assert_eq!(
        tray::action_for_tray_event(&click(MouseButton::Left, MouseButtonState::Up)),
        TrayAction::Show
    );
    assert_eq!(
        tray::action_for_tray_event(&click(MouseButton::Left, MouseButtonState::Down)),
        TrayAction::Ignore
    );
}

#[test]
fn right_and_middle_click_leave_the_menu_alone() {
    assert_eq!(
        tray::action_for_tray_event(&click(MouseButton::Right, MouseButtonState::Up)),
        TrayAction::Ignore
    );
    assert_eq!(
        tray::action_for_tray_event(&click(MouseButton::Middle, MouseButtonState::Up)),
        TrayAction::Ignore
    );
}

#[test]
fn windows_double_click_also_restores_window() {
    let event = TrayIconEvent::DoubleClick {
        id: TrayIconId::new(TRAY_ID),
        position: tauri::PhysicalPosition::new(0.0, 0.0),
        rect: Rect::default(),
        button: MouseButton::Left,
    };
    assert_eq!(tray::action_for_tray_event(&event), TrayAction::Show);
}

#[test]
fn hover_events_never_move_the_window() {
    let event = TrayIconEvent::Enter {
        id: TrayIconId::new(TRAY_ID),
        position: tauri::PhysicalPosition::new(0.0, 0.0),
        rect: Rect::default(),
    };
    assert_eq!(tray::action_for_tray_event(&event), TrayAction::Ignore);
}

#[test]
fn close_hides_only_when_the_tray_exists() {
    assert_eq!(tray::close_action(true), CloseAction::HideToTray);
    // 托盘创建失败时隐藏会让窗口无法恢复，必须回落到默认关闭。
    assert_eq!(tray::close_action(false), CloseAction::Default);
}

#[test]
fn tray_id_is_stable_so_repeated_creation_is_detected() {
    // 固定 id 是「不产生多个托盘图标」的前提：create_tray 用它判断是否已创建。
    assert_eq!(TRAY_ID, "soxu-main-tray");
    assert_ne!(MENU_ID_SHOW, MENU_ID_QUIT);
}

/// 托盘恢复窗口依赖 `main` 这个 label；配置里新增/改名窗口时必须同步发现。
#[test]
fn main_window_label_matches_tauri_config() {
    let raw = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tauri.conf.json"))
        .expect("读取 tauri.conf.json");
    let config: serde_json::Value = serde_json::from_str(&raw).expect("解析 tauri.conf.json");
    let windows = config["app"]["windows"]
        .as_array()
        .expect("tauri.conf.json 应声明窗口列表");
    assert_eq!(windows.len(), 1, "托盘只恢复唯一主窗口");
    // 未显式声明 label 时 Tauri 使用默认值 "main"。
    let label = windows[0]["label"].as_str().unwrap_or("main");
    assert_eq!(label, MAIN_WINDOW_LABEL);
}
