/**
 * 系统页开关的后端通道（Issue #145）。
 *
 * 两件事：
 * 1. **关闭窗口的行为**：前端偏好存在 localStorage，但「关闭按钮到底是隐藏还是退出」
 *    由 Rust 的窗口事件决定。最小方案是一条命令 set_close_behavior：
 *    偏好变化时把布尔值推给 Rust 侧受管的 tray::ClosePreference，
 *    Rust 在处理 CloseRequested 时读它——不新增事件通道、不新增常驻监听。
 * 2. **打开数据目录**：open_data_directory 由 Rust 交给系统文件管理器，
 *    路径只取 app_data_dir()，前端不能传任意路径（避免变成「打开任意目录」的通用能力）。
 *
 * 两条通道都在这里包一层可注入的 bridge：Node 测试用假 bridge 断言
 * 「成功 / 失败 / 浏览器预览」三种结果，不需要 Tauri 宿主。
 */

import { invoke } from "@tauri-apps/api/core";

/** 命令名与 Rust 侧一一对应（commands/workspace.rs）。 */
export const SET_CLOSE_BEHAVIOR_COMMAND = "set_close_behavior";
export const OPEN_DATA_DIRECTORY_COMMAND = "open_data_directory";

export interface SystemBridge {
  /** 把「关闭时最小化到托盘」推给 Rust；失败时抛错。 */
  setMinimizeToTray(enabled: boolean): Promise<void>;
  /** 用系统文件管理器打开应用数据目录，返回真实路径。 */
  openDataDirectory(): Promise<string>;
}

export type OpenDirectoryResult =
  | { ok: true; path: string }
  | { ok: false; error: string };

/** 默认实现：走 Tauri IPC。浏览器预览下调用会抛错，由调用方降级。 */
export function defaultSystemBridge(): SystemBridge {
  return {
    async setMinimizeToTray(enabled: boolean): Promise<void> {
      await invoke(SET_CLOSE_BEHAVIOR_COMMAND, { minimizeToTray: enabled });
    },
    async openDataDirectory(): Promise<string> {
      return invoke<string>(OPEN_DATA_DIRECTORY_COMMAND);
    },
  };
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 同步关闭行为。
 *
 * 返回是否成功而不是抛错：设置页的开关不能因为后端暂时不可用就回滚，
 * 偏好已经落盘，下次启动/下次切换会再推一次。失败只留一行诊断。
 */
export async function pushCloseBehavior(
  bridge: SystemBridge,
  minimizeToTray: boolean,
): Promise<boolean> {
  try {
    await bridge.setMinimizeToTray(minimizeToTray);
    return true;
  } catch (error) {
    console.warn("[system] 同步关闭行为失败：" + reasonOf(error));
    return false;
  }
}

/**
 * 打开数据目录。
 *
 * 失败时把原因带回去给界面显示，而不是静默无反应——用户点了一个按钮，
 * 必须知道它有没有生效。
 */
export async function openDataDirectoryInFileManager(
  bridge: SystemBridge,
): Promise<OpenDirectoryResult> {
  try {
    const path = await bridge.openDataDirectory();
    return { ok: true, path };
  } catch (error) {
    return { ok: false, error: reasonOf(error) };
  }
}
