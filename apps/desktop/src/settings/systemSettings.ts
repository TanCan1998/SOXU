/**
 * 系统页设置（Issue #116 · V4-S2）。
 *
 * 三个开关都只做「UI + 持久化」：真正的更新检查、系统通知、托盘行为分别属于
 * 发布流程与通知切片，本切片不伪造它们已经生效（见设置面板里的说明文案）。
 * 单独成键 `soxu.system`，与外观/会话偏好互不影响。
 */

import {
  defaultStorage,
  readStoredRecord,
  writeStoredRecord,
  type KeyValueStorage,
} from "./storage.ts";

export interface SystemSettings {
  /** 有新版时提示下载。 */
  autoUpdate: boolean;
  /** 任务完成/失败时弹系统通知（通知实现见 Issue #117）。 */
  notifyOnComplete: boolean;
  /** 关闭窗口时最小化到系统托盘，而不是退出进程。 */
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
