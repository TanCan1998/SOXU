/**
 * 通知历史（V4-S2b，Issue #117）。
 *
 * 历史只在**本次运行**内存在：纯内存数组，重启清空，不写 localStorage，
 * 也不落盘。原因有两条：
 * 1. 通知正文里可能带会话标题甚至片段，长期留在磁盘上没有必要；
 * 2. 「重启清空」是产品明确要求，持久化反而会让用户以为能翻旧账。
 *
 * 列表有硬上限（`MAX_NOTIFICATION_HISTORY`）：一次长时间运行里
 * 通知条数没有天然边界，不设上限就是一条缓慢的内存泄漏。
 */

import type { NotificationSeverity } from "./events.ts";
import type { NotificationEventKind } from "./settings.ts";

/** 历史保留条数上限：超出后丢弃最旧的（列表按时间倒序，尾部即最旧）。 */
export const MAX_NOTIFICATION_HISTORY = 200;

export interface NotificationRecord {
  id: string;
  kind: NotificationEventKind;
  severity: NotificationSeverity;
  title: string;
  body: string;
  sessionId: string;
  /** 毫秒时间戳；展示用 `formatNotificationClock`。 */
  atMs: number;
  actionLabel: string | null;
}

/** 插入到列表最前面（时间倒序），并按上限裁剪。返回新数组，不改入参。 */
export function appendNotification(
  list: readonly NotificationRecord[],
  record: NotificationRecord,
  max: number = MAX_NOTIFICATION_HISTORY,
): NotificationRecord[] {
  if (max <= 0) return [];
  return [record, ...list].slice(0, max);
}

/**
 * `HH:MM:SS` 本地时间。
 *
 * 不用 `toLocaleTimeString`：各平台/语言环境的输出不一致，抽屉里一列时间
 * 需要对齐；这里自己补零，测试也能用固定时间戳断言。
 */
export function formatNotificationClock(atMs: number): string {
  const date = new Date(atMs);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
