/**
 * 扩展页的后端访问（Issue #147）。
 *
 * 单一 owner：**只有这个模块**调用扩展页的 Tauri 命令，组件通过注入的桥接对象访问，
 * 测试可以换成假实现。
 *
 * 为什么只读：Pi 拥有扩展 / 技能 / MCP 配置的所有权（AGENTS.md：不重新实现内核）。
 * SOXU 只把本机真实状态显示出来，因此这里只有 list / detail 两个读入口，
 * 没有任何写 Pi 配置的方法。
 */

import { invoke } from "@tauri-apps/api/core";

import { isTauriRuntime } from "../workspace/bridge.ts";

/** 来源：Pi 自带的扩展，或用户自己安装的（文件 / npm 包）。 */
export type ExtensionSource = "builtin" | "user";

/** 与 src-tauri/src/dto/extension.rs 的 ExtensionItem 一一对应。 */
export interface ExtensionItem {
  /** 后端生成的不透明标识（builtin:mcp / extension:rtk / package:pi-subagents）。 */
  id: string;
  name: string;
  source: ExtensionSource;
  /** Pi 的默认行为是加载；只有 settings 里的排除项才会是 false。 */
  enabled: boolean;
  /** 真实描述（目前只有 npm 包提供）；没有就是 null，界面不补编。 */
  description: string | null;
  /** 本地入口路径；远程声明时为 null。 */
  path: string | null;
}

/** 与 SkillItem 一一对应。 */
export interface SkillItem {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  path: string;
}

/** MCP 连接状态：只读扫描拿不到真实连接结果，因此只有 unknown。 */
export type McpStatus = "unknown";

/** 与 McpServerItem 一一对应。 */
export interface McpServerItem {
  id: string;
  name: string;
  /** stdio / http / sse；mcp.json 没写 type 时由后端按 url 或 command 推断。 */
  transport: string | null;
  description: string | null;
  status: McpStatus;
}

/** 与 ExtensionCatalog 一一对应。 */
export interface ExtensionCatalog {
  /** 实际读取的 Pi 配置目录（界面上告诉用户读的是哪一份配置）。 */
  agentDir: string;
  extensions: ExtensionItem[];
  skills: SkillItem[];
  mcpServers: McpServerItem[];
}

/** 与 ExtensionDetail 一一对应：技能按需展开时才取。 */
export interface ExtensionDetail {
  id: string;
  name: string;
  path: string;
  fileCount: number;
  /** 达到后端统计上限时为 true，界面显示「≥ N」。 */
  fileCountTruncated: boolean;
  description: string | null;
}

export interface ExtensionsBridge {
  list(): Promise<ExtensionCatalog>;
  detail(id: string): Promise<ExtensionDetail>;
}

export function createTauriExtensions(): ExtensionsBridge {
  return {
    list: () => invoke<ExtensionCatalog>("list_extensions"),
    detail: (id) => invoke<ExtensionDetail>("read_extension_detail", { id }),
  };
}

/**
 * 浏览器预览下的桥接：两个方法都显式失败。
 * 不用假数据冒充成功——扩展页会据此显示失败原因，而不是一份看起来正常的清单。
 */
export function unavailableExtensions(reason: string): ExtensionsBridge {
  const fail = () => Promise.reject(new Error(reason));
  return { list: fail, detail: fail };
}

/** 默认桥接：桌面端走真实命令，浏览器预览走显式失败。 */
export function defaultExtensions(): ExtensionsBridge {
  return isTauriRuntime()
    ? createTauriExtensions()
    : unavailableExtensions("浏览器预览读不到本机 Pi 配置，扩展清单只在桌面端可用");
}
