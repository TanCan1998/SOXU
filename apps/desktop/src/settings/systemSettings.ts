/**
 * 系统页设置（Issue #116 · V4-S2；Issue #145 起真接线）。
 *
 * 三个字段的含义：
 * - notifyOnComplete：通知总闸，已并入通知事件链（stores/notifications.ts）；
 * - minimizeToTray：关闭窗口的行为，经 set_close_behavior 推给 Rust 托盘层；
 * - autoUpdate：**保留字段但不显示**。更新通道落地前设置页没有这个入口（Issue #145），
 *   字段留着是为了不丢用户的旧偏好、将来加回入口时不用做迁移；
 *   读取时仍然逐字段校验，写回也不会清掉它。
 *
 * 单独成键 `soxu.system`，与外观/会话偏好互不影响。
 */

import {
  defaultStorage,
  readStoredRecord,
  writeStoredRecord,
  type KeyValueStorage,
} from "./storage.ts";

export interface SystemSettings {
  /**
   * 有新版时提示下载。
   *
   * 更新通道落地前**没有界面入口**（Issue #145 把整行移除了，而不是留一个禁用的开关）；
   * 这里只保留持久化，避免用户旧偏好被清掉。
   */
  autoUpdate: boolean;
  /** 任务完成/失败时提醒（通知总闸，已接线到通知事件链）。 */
  notifyOnComplete: boolean;
  /** 关闭窗口时最小化到系统托盘，而不是退出进程（已接线到 Rust 窗口事件）。 */
  minimizeToTray: boolean;
}

export const SYSTEM_SETTINGS_STORAGE_KEY = "soxu.system";

/** 默认值：三项都开（与原型和 Issue #90 的托盘行为一致）。 */
export const DEFAULT_SYSTEM_SETTINGS: Readonly<SystemSettings> = Object.freeze({
  autoUpdate: true,
  notifyOnComplete: true,
  minimizeToTray: true,
});

export function normalizeSystemSettings(record: Record<string, unknown>): SystemSettings {
  const flag = (key: keyof SystemSettings): boolean => {
    const value = record[key];
    return typeof value === "boolean" ? value : (DEFAULT_SYSTEM_SETTINGS[key] as boolean);
  };
  return {
    autoUpdate: flag("autoUpdate"),
    notifyOnComplete: flag("notifyOnComplete"),
    minimizeToTray: flag("minimizeToTray"),
  };
}

export function readSystemSettings(
  storage: KeyValueStorage | null | undefined = defaultStorage(),
): SystemSettings {
  const record = readStoredRecord(SYSTEM_SETTINGS_STORAGE_KEY, storage);
  return record ? normalizeSystemSettings(record) : { ...DEFAULT_SYSTEM_SETTINGS };
}

export function persistSystemSettings(
  settings: SystemSettings,
  storage: KeyValueStorage | null | undefined = defaultStorage(),
): boolean {
  const normalized = normalizeSystemSettings(
    settings as unknown as Record<string, unknown>,
  );
  return writeStoredRecord(SYSTEM_SETTINGS_STORAGE_KEY, { ...normalized }, storage);
}
