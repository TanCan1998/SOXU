/**
 * 「忙碌时发送」默认投递方式（Issue #111 · V4-S1）。
 *
 * 与 PiDeck 的 `busySendDeliveryAtom` 对齐：两选一，默认「加入当前」。
 * 结构与 theme/appearance.ts 保持一致——读存储、校验、写存储都是可注入的纯逻辑，
 * Node 里能直接断言，不需要浏览器或 Tauri 宿主。
 *
 * 存储键单独成键：清掉主题/字号偏好不应该顺手把投递方式也清掉。
 */

import type { SendMode } from "../workspace/types.ts";

/** 忙碌时的默认投递方式：只有「加入当前」与「排到下轮」两选（并行发送不是默认项）。 */
export type BusySendDelivery = Extract<SendMode, "steer" | "followUp">;

export const BUSY_DELIVERY_STORAGE_KEY = "soxu.busyDelivery";

/** 默认值 = 决策文档的默认（steer / 加入当前）。 */
export const DEFAULT_BUSY_DELIVERY: BusySendDelivery = "steer";

export interface BusyDeliveryOption {
  value: BusySendDelivery;
  label: string;
  description: string;
}

/** 设置面板渲染的选项表；顺序即界面顺序。 */
export const BUSY_DELIVERY_OPTIONS: readonly BusyDeliveryOption[] = Object.freeze([
  { value: "steer", label: "加入当前", description: "插进正在进行的回答" },
  { value: "followUp", label: "排到下轮", description: "本轮结束后自动发送" },
]);

/** 只依赖最小存储表面，测试可注入假对象。 */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function isBusySendDelivery(value: unknown): value is BusySendDelivery {
  return value === "steer" || value === "followUp";
}

/**
 * 读持久化的投递方式。
 * 存储不可用（隐私模式/被策略禁用）、值不认识、读取抛错都退回默认值，绝不抛错。
 */
export function readBusyDelivery(
  storage: KeyValueStorage | null | undefined = defaultStorage(),
): BusySendDelivery {
  if (!storage) return DEFAULT_BUSY_DELIVERY;
  let raw: string | null;
  try {
    raw = storage.getItem(BUSY_DELIVERY_STORAGE_KEY);
  } catch {
    return DEFAULT_BUSY_DELIVERY;
  }
  return isBusySendDelivery(raw) ? raw : DEFAULT_BUSY_DELIVERY;
}

/** 持久化投递方式；写入失败（配额、隐私模式）不算错误，只是下次启动回到默认值。 */
export function persistBusyDelivery(
  value: BusySendDelivery,
  storage: KeyValueStorage | null | undefined = defaultStorage(),
): boolean {
  if (!storage) return false;
  const normalized: BusySendDelivery = isBusySendDelivery(value)
    ? value
    : DEFAULT_BUSY_DELIVERY;
  try {
    storage.setItem(BUSY_DELIVERY_STORAGE_KEY, normalized);
    return true;
  } catch {
    return false;
  }
}

function defaultStorage(): KeyValueStorage | null {
  if (typeof localStorage === "undefined") return null;
  return localStorage;
}
