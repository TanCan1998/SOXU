/**
 * 把 tauri-plugin-dialog 接到 projectDirectory 的纯逻辑上。
 *
 * 单独成文件，让单元测试只导入不依赖 Tauri 运行时的纯逻辑模块。
 */

import { open } from "@tauri-apps/plugin-dialog";

import { pickProjectDirectory, type DirectoryPickOutcome } from "./projectDirectory.ts";

/** 打开系统目录选择器；取消返回 cancelled，绝不抛给调用方。 */
export function pickProjectDirectoryFromSystem(): Promise<DirectoryPickOutcome> {
  return pickProjectDirectory((options) => open(options));
}
