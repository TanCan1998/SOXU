/**
 * 应用数据目录（Issue #116 · V4-S2）。
 *
 * 后端用的是 Tauri 的 `app_data_dir()`，它在各平台都按「应用标识符」建目录，
 * 因此设置页显示的路径必须与 tauri.conf.json 的 identifier 一致，而不是原型里的
 * 占位名 %APPDATA%\SOXU（原型当时还没有 identifier）。
 *
 * 这里只做「按平台给出可读路径」这一件纯逻辑：Node 里能断言，不需要 Tauri 宿主。
 * 打开文件夹需要后端命令（#112 命令层拆分后接入），本切片只提供路径与复制。
 */

/** 必须与 apps/desktop/src-tauri/tauri.conf.json 的 identifier 完全一致（测试核对）。 */
export const APP_IDENTIFIER = "dev.soxu.desktop";

/**
 * 给出该平台的数据目录可读路径。
 * platform 取 Tauri `RuntimeInfo.platform`（std::env::consts::OS 的取值）。
 */
export function dataDirectoryHint(platform: string | null | undefined): string {
  switch (platform) {
    case "windows":
      return `%APPDATA%\\${APP_IDENTIFIER}`;
    case "macos":
      return `~/Library/Application Support/${APP_IDENTIFIER}`;
    case "linux":
      return `~/.local/share/${APP_IDENTIFIER}`;
    default:
      // 浏览器预览或未知平台：给一个明确的占位说明，不假装知道路径。
      return `应用数据目录（${APP_IDENTIFIER}）`;
  }
}
