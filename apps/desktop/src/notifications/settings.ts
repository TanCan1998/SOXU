/**
 * 通知设置模型（V4-S2b，Issue #117）。
 *
 * 三类事件（会话完成 / 会话出错 / 等待输入）各有独立开关与音效；
 * 全局设置管展示时长、仅失焦提醒、声音总开关与音量。
 *
 * 与 `settings/busyDelivery.ts` 同一套纪律：
 * 1. 读写与校验都是可注入的纯逻辑，Node 里直接断言，不需要浏览器或 Tauri 宿主；
 * 2. 存储里的脏值逐字段回退到默认值，一个坏字段不能把整份设置清空；
 * 3. 读取失败、写入失败（隐私模式 / 配额满）都不抛错，只是回到默认值。
 *
 * 存储键单独成键：清掉主题或投递方式偏好不应该顺手把通知设置也清掉。
 */

import type { KeyValueStorage } from "../settings/busyDelivery.ts";

/** 三类可独立开关的通知事件。命名与 `docs/development/notification-system.md` 一致。 */
export type NotificationEventKind = "sessionCompleted" | "sessionError" | "awaitingInput";

/**
 * 展示时长。
 *
 * `"persistent"` 表示常驻（不自动关闭，只能手动关）；其余是毫秒数。
 * 只列这四个值：设置页的选项与持久化校验共用同一份联合类型，避免出现
 * 「界面能选但读回来被判非法」的第五种值。
 */
export type ToastDuration = 5000 | 10000 | 30000 | "persistent";

/** 内置音效 id（Web Audio 合成，见 `sounds.ts`）。 */
export type SoundId = "chime" | "pop" | "bell" | "drop" | "alert" | "soft";

export interface NotificationEventSettings {
  /** 是否提醒（关闭后不弹 toast、不记历史、不发声）。 */
  enabled: boolean;
  /** 该事件使用哪个音效。 */
  sound: SoundId;
}

export interface NotificationSettings {
  duration: ToastDuration;
  /** 仅失焦时提醒：窗口有焦点时 toast 照常显示，但不发声。 */
  onlyWhenUnfocused: boolean;
  soundEnabled: boolean;
  /** 0～1；0 等于静音（但仍保留开关状态）。 */
  volume: number;
  events: Record<NotificationEventKind, NotificationEventSettings>;
}

export const NOTIFICATIONS_STORAGE_KEY = "soxu.notifications";

/** 事件分类的元数据：默认开关取自 Issue #117 的事件表，界面顺序即这里的顺序。 */
export interface NotificationEventMeta {
  kind: NotificationEventKind;
  label: string;
  description: string;
  defaultEnabled: boolean;
  defaultSound: SoundId;
}

export const NOTIFICATION_EVENT_META: readonly NotificationEventMeta[] = Object.freeze([
  {
    kind: "sessionCompleted",
    label: "会话完成",
    description: "Agent 成功结束一轮回答",
    defaultEnabled: true,
    defaultSound: "chime",
  },
  {
    kind: "sessionError",
    label: "会话出错",
    description: "运行时状态变为 error 或异常退出",
    defaultEnabled: true,
    defaultSound: "alert",
  },
  {
    kind: "awaitingInput",
    label: "等待输入",
    description: "Agent 发起选择 / 确认 / 输入 / 编辑器交互",
    defaultEnabled: false,
    defaultSound: "pop",
  },
]);

/** 展示时长选项（设置页直接渲染这张表，不在组件里另写一份文案）。 */
export const DURATION_OPTIONS: readonly { value: ToastDuration; label: string }[] = Object.freeze([
  { value: 5000, label: "5 秒" },
  { value: 10000, label: "10 秒" },
  { value: 30000, label: "30 秒" },
  { value: "persistent", label: "常驻" },
]);

/** 预设音效清单（6 个，全部由 Web Audio 合成，不占仓库体积）。 */
export const SOUND_PRESETS: readonly { id: SoundId; label: string }[] = Object.freeze([
  { id: "chime", label: "清脆" },
  { id: "pop", label: "短促" },
  { id: "bell", label: "铃音" },
  { id: "drop", label: "下行" },
  { id: "alert", label: "警示" },
  { id: "soft", label: "柔和" },
]);

/** 默认 10 秒：短于 5 秒读不完正文，长于 30 秒会一直挡在右下角。 */
export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  duration: 10000,
  // 通知的意义就是「你不在看的时候提醒你」：默认窗口有焦点时不发声，只弹 toast。
  onlyWhenUnfocused: true,
  soundEnabled: true,
  volume: 0.6,
  events: {
    sessionCompleted: { enabled: true, sound: "chime" },
    sessionError: { enabled: true, sound: "alert" },
    awaitingInput: { enabled: false, sound: "pop" },
  },
};

/**
 * 错误类通知不跟随全局时长。
 *
 * 理由：出错信息通常比「已完成」更长、更需要读；用户把全局时长调成 5 秒
 * 不代表希望错误也只停留 5 秒。调用方可以显式指定，否则用这个默认值。
 */
export const ERROR_TOAST_DURATION_MS = 10000;

export function isNotificationEventKind(value: unknown): value is NotificationEventKind {
  return value === "sessionCompleted" || value === "sessionError" || value === "awaitingInput";
}

export function isToastDuration(value: unknown): value is ToastDuration {
  return value === 5000 || value === 10000 || value === 30000 || value === "persistent";
}

export function isSoundId(value: unknown): value is SoundId {
  return SOUND_PRESETS.some((preset) => preset.id === value);
}

/** 音量只保留 0～1 的两位小数：滑块与持久化共用同一个口径。 */
export function clampVolume(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_NOTIFICATION_SETTINGS.volume;
  return Math.round(Math.min(1, Math.max(0, value)) * 100) / 100;
}

function normalizeEvent(
  raw: unknown,
  fallback: NotificationEventSettings,
): NotificationEventSettings {
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const enabled = typeof record["enabled"] === "boolean" ? record["enabled"] : fallback.enabled;
  const sound = isSoundId(record["sound"]) ? record["sound"] : fallback.sound;
  return { enabled, sound };
}

/**
 * 逐字段校验：认识的值原样保留，不认识的退回默认。
 *
 * 不做「整份 JSON 解析失败就全丢」：用户把时长改坏了不应该连带丢掉声音开关。
 */
export function normalizeNotificationSettings(raw: unknown): NotificationSettings {
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const events =
    record["events"] && typeof record["events"] === "object"
      ? (record["events"] as Record<string, unknown>)
      : {};
  const fallback = DEFAULT_NOTIFICATION_SETTINGS;
  return {
    duration: isToastDuration(record["duration"]) ? record["duration"] : fallback.duration,
    onlyWhenUnfocused:
      typeof record["onlyWhenUnfocused"] === "boolean"
        ? record["onlyWhenUnfocused"]
        : fallback.onlyWhenUnfocused,
    soundEnabled:
      typeof record["soundEnabled"] === "boolean" ? record["soundEnabled"] : fallback.soundEnabled,
    volume:
      typeof record["volume"] === "number" ? clampVolume(record["volume"]) : fallback.volume,
    events: {
      sessionCompleted: normalizeEvent(events["sessionCompleted"], fallback.events.sessionCompleted),
      sessionError: normalizeEvent(events["sessionError"], fallback.events.sessionError),
      awaitingInput: normalizeEvent(events["awaitingInput"], fallback.events.awaitingInput),
    },
  };
}

/** 读持久化的通知设置；存储不可用、JSON 坏掉、字段不认识都退回默认值，绝不抛错。 */
export function readNotificationSettings(
  storage: KeyValueStorage | null | undefined = defaultStorage(),
): NotificationSettings {
  if (!storage) return normalizeNotificationSettings(null);
  let raw: string | null;
  try {
    raw = storage.getItem(NOTIFICATIONS_STORAGE_KEY);
  } catch {
    return normalizeNotificationSettings(null);
  }
  if (!raw) return normalizeNotificationSettings(null);
  try {
    return normalizeNotificationSettings(JSON.parse(raw) as unknown);
  } catch {
    return normalizeNotificationSettings(null);
  }
}

/** 持久化通知设置；写入失败（配额、隐私模式）只返回 false，下次启动回到默认值。 */
export function persistNotificationSettings(
  settings: NotificationSettings,
  storage: KeyValueStorage | null | undefined = defaultStorage(),
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(NOTIFICATIONS_STORAGE_KEY, JSON.stringify(normalizeNotificationSettings(settings)));
    return true;
  } catch {
    return false;
  }
}

/**
 * 解析一条通知最终展示多久。
 *
 * - 错误类（`sessionError`）：不跟随全局时长，用调用方给的值，否则用
 *   `ERROR_TOAST_DURATION_MS`；
 * - 其余事件：**全局设置覆盖调用方时长**（这是 Issue #117 的明确要求）；
 *   全局选「常驻」时返回 `null`，表示不自动关闭。
 */
export function resolveToastDuration(
  kind: NotificationEventKind,
  settings: NotificationSettings,
  requestedMs: number | null = null,
): number | null {
  if (kind === "sessionError") {
    return requestedMs !== null && requestedMs > 0 ? requestedMs : ERROR_TOAST_DURATION_MS;
  }
  if (settings.duration === "persistent") return null;
  return settings.duration;
}

/**
 * 是否该出声。
 *
 * toast 是否显示由事件开关单独决定：这个函数只管声音，所以「仅失焦时提醒」
 * 在窗口有焦点时返回 false，但界面上的 toast 照常出现。
 */
export function shouldPlaySound(
  kind: NotificationEventKind,
  settings: NotificationSettings,
  windowFocused: boolean,
): boolean {
  if (!settings.soundEnabled) return false;
  if (settings.volume <= 0) return false;
  if (!settings.events[kind].enabled) return false;
  if (settings.onlyWhenUnfocused && windowFocused) return false;
  return true;
}

function defaultStorage(): KeyValueStorage | null {
  if (typeof localStorage === "undefined") return null;
  return localStorage;
}
