/**
 * 原生窗口主题适配层（Tauri 2）。
 *
 * 窗口装饰（标题栏、边框）由操作系统绘制，CSS token 影响不到它：不显式调用
 * WebviewWindow.setTheme，标题栏就一直跟随系统，深色应用顶着一条浅色标题栏。
 *
 * 权限：调用窗口方法需要在 capabilities/default.json 里放行 core:window:allow-set-theme；
 * core:default 只包含只读的 window 权限（含 theme() 查询），不包含 setTheme。
 *
 * 平台差异：Windows / macOS 支持窗口级主题；Linux（GTK）不支持，调用会返回错误，
 * 由 theme.ts 的 syncWindowTheme 吞掉并记为 failed，不影响应用内主题。
 */

import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

import type { ThemeWindowTarget } from "./theme.ts";

/**
 * 取当前窗口的主题目标；不在 Tauri 宿主里（pnpm dev 直接开浏览器）返回 null。
 * 这里不做缓存：窗口对象本身是轻量句柄，缓存反而会挡住多窗口场景。
 */
export function currentWindowTarget(): ThemeWindowTarget | null {
  if (!isTauri()) return null;
  try {
    const current = getCurrentWindow();
    return { setTheme: (theme) => current.setTheme(theme) };
  } catch {
    // 拿不到窗口（例如 Tauri 还没注入 label）时按"没有原生窗口"处理
    return null;
  }
}
