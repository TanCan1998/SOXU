/**
 * 设置模块共用的存储表面（Issue #116）。
 *
 * 会话页与系统页各有自己的存储键，但「读一个 JSON 对象、失败退回默认值」这段
 * 容错逻辑完全一样，抽出来只写一次；theme/appearance.ts 与 settings/busyDelivery.ts
 * 早于本模块落地、各自带一份等价实现，保持原样不动（它们已有回归测试钉住行为）。
 */

/** 只依赖最小存储表面，测试可注入假对象。 */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * 读一个 JSON 对象。
 * 存储不可用（隐私模式/被策略禁用）、键不存在、内容不是 JSON、内容不是对象
 * 一律返回 null，由调用方退回默认值，绝不抛错。
 */
export function readStoredRecord(
  key: string,
  storage: KeyValueStorage | null | undefined = defaultStorage(),
): Record<string, unknown> | null {
  if (!storage) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return null;
  }
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

/** 写一个 JSON 对象；写入失败（配额、隐私模式）返回 false，调用方不当作错误。 */
export function writeStoredRecord(
  key: string,
  value: Record<string, unknown>,
  storage: KeyValueStorage | null | undefined = defaultStorage(),
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function defaultStorage(): KeyValueStorage | null {
  if (typeof localStorage === "undefined") return null;
  return localStorage;
}
