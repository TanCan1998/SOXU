/**
 * 会话页设置（Issue #116 · V4-S2）。
 *
 * 五项都是「新消息怎么显示、怎么发送」的偏好，与外观无关，所以单独成键
 * `soxu.session`：清掉外观偏好不应该顺手把发送方式也清掉。
 * 结构与 theme/appearance.ts 一致——读存储、校验、写存储都是可注入的纯逻辑，
 * Node 里能直接断言，不需要浏览器或 Tauri 宿主。
 */

import type { ThinkingLevel } from "../workspace/types.ts";
import {
  defaultStorage,
  readStoredRecord,
  writeStoredRecord,
  type KeyValueStorage,
} from "./storage.ts";

/** 会话页保存的全部偏好。 */
export interface SessionSettings {
  /** 新消息到达时自动贴底；关掉后滚动位置完全由用户控制。 */
  sendAfterScroll: boolean;
  /** Enter 直接发送；关掉后 Enter 换行，⌘/Ctrl+Enter 才发送。 */
  enterToSend: boolean;
  /** 工具输出块默认展开（关闭则保持长输出折叠，即改动前的行为）。 */
  showToolCalls: boolean;
  /** 在每条消息下方显示时间戳。 */
  showTimestamps: boolean;
  /** 新会话的初始思考强度。 */
  thinkingLevel: ThinkingLevel;
}

export const SESSION_SETTINGS_STORAGE_KEY = "soxu.session";

/**
 * 默认值 = 改动前的现状：自动贴底、Enter 发送、工具输出折叠、不显示时间戳、中等思考强度。
 *
 * showToolCalls 默认 false 是刻意的：改动前超过 TOOL_FOLD_CHARS 的工具输出块一律折叠，
 * 默认 true 会让老用户升级后突然看到一屏展开的 JSON。开关打开后才改成默认展开。
 */
export const DEFAULT_SESSION_SETTINGS: Readonly<SessionSettings> = Object.freeze({
  sendAfterScroll: true,
  enterToSend: true,
  showToolCalls: false,
  showTimestamps: false,
  thinkingLevel: "medium",
});

export interface ThinkingLevelOption {
  value: ThinkingLevel;
  label: string;
  description: string;
}

/** 默认思考强度三选一；顺序即界面顺序。 */
export const THINKING_LEVEL_OPTIONS: readonly ThinkingLevelOption[] = Object.freeze([
  { value: "low", label: "low", description: "最快，适合简单改动" },
  { value: "medium", label: "medium", description: "默认档，速度与质量平衡" },
  { value: "high", label: "high", description: "最慢，适合复杂推理" },
]);

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return value === "low" || value === "medium" || value === "high";
}

/**
 * 逐字段归一：开关只认真正的 boolean（"true"/1 这类脏值退回默认），
 * 思考强度只认三档之一。
 */
export function normalizeSessionSettings(record: Record<string, unknown>): SessionSettings {
  const flag = (key: keyof SessionSettings): boolean => {
    const value = record[key];
    return typeof value === "boolean" ? value : (DEFAULT_SESSION_SETTINGS[key] as boolean);
  };
  return {
    sendAfterScroll: flag("sendAfterScroll"),
    enterToSend: flag("enterToSend"),
    showToolCalls: flag("showToolCalls"),
    showTimestamps: flag("showTimestamps"),
    thinkingLevel: isThinkingLevel(record.thinkingLevel)
      ? record.thinkingLevel
      : DEFAULT_SESSION_SETTINGS.thinkingLevel,
  };
}

/** 读持久化的会话偏好；任何异常都退回默认值。 */
export function readSessionSettings(
  storage: KeyValueStorage | null | undefined = defaultStorage(),
): SessionSettings {
  const record = readStoredRecord(SESSION_SETTINGS_STORAGE_KEY, storage);
  return record ? normalizeSessionSettings(record) : { ...DEFAULT_SESSION_SETTINGS };
}

/** 持久化会话偏好；只写入已知字段，脏字段不会通过这里回写。 */
export function persistSessionSettings(
  settings: SessionSettings,
  storage: KeyValueStorage | null | undefined = defaultStorage(),
): boolean {
  const normalized = normalizeSessionSettings(
    settings as unknown as Record<string, unknown>,
  );
  return writeStoredRecord(
    SESSION_SETTINGS_STORAGE_KEY,
    { ...normalized },
    storage,
  );
}
