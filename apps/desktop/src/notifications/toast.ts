/**
 * Toast 队列的纯逻辑（V4-S2b，Issue #117）。
 *
 * 这里只做「列表怎么排、哪几条可见、剩余多久」这类可断言的计算；
 * 定时器、声音与 DOM 都在 store 与组件里。抽出来的目的是让
 * 「最多同时 4 条、超出排队」「悬停暂停后的剩余时长」这些验收点
 * 能在 Node 里确定性地测出来，不依赖浏览器。
 */

import type { NotificationEvent, NotificationSeverity } from "./events.ts";
import type { NotificationEventKind } from "./settings.ts";

/** 右下角同时可见的条数上限；超出的留在队列里，关掉一条就顶上一条。 */
export const MAX_VISIBLE_TOASTS = 4;

/**
 * 自动关闭前开始淡出的提前量（毫秒）。
 *
 * 与 `--dur-slow`（260ms）对齐并留一点余量：淡出在消失之前发生，
 * 而不是「啪」地消失，因此这里必须早于真正的移除时刻。
 */
export const TOAST_FADE_LEAD_MS = 320;

export interface ToastItem {
  id: string;
  kind: NotificationEventKind;
  severity: NotificationSeverity;
  title: string;
  body: string;
  sessionId: string;
  /** null 表示常驻：不自动关闭，只能手动关。 */
  durationMs: number | null;
  /** 正在淡出（即将被移除），用于 CSS 提前降透明度。 */
  fading: boolean;
  /** 非空时同 key 的未消失通知会被合并。 */
  dedupeKey: string | null;
  /** 操作按钮文案；null 表示没有可跳转目标。 */
  actionLabel: string | null;
}

export function createToast(
  event: NotificationEvent,
  durationMs: number | null,
  id: string,
): ToastItem {
  return {
    id,
    kind: event.kind,
    severity: event.severity,
    title: event.title,
    body: event.body,
    sessionId: event.sessionId,
    durationMs,
    fading: false,
    dedupeKey: event.dedupeKey,
    actionLabel: event.actionLabel,
  };
}

/** 可见的那一段：列表前端若干条，其余排队等空位。 */
export function visibleToasts(
  list: readonly ToastItem[],
  max: number = MAX_VISIBLE_TOASTS,
): ToastItem[] {
  if (max <= 0) return [];
  return list.slice(0, max);
}

/** 队列里还有多少条在等空位。 */
export function queuedCount(list: readonly ToastItem[], max: number = MAX_VISIBLE_TOASTS): number {
  return Math.max(0, list.length - Math.max(0, max));
}

/** 找一条尚未消失、且 dedupeKey 相同的通知。 */
export function findActiveByDedupeKey(
  list: readonly ToastItem[],
  dedupeKey: string,
): ToastItem | undefined {
  return list.find((item) => item.dedupeKey === dedupeKey);
}

/** 悬停暂停后的剩余时长：过期即为 0，不会出现负数倒计时。 */
export function remainingMs(scheduledMs: number, elapsedMs: number): number {
  if (!Number.isFinite(scheduledMs) || !Number.isFinite(elapsedMs)) return 0;
  return Math.max(0, Math.round(scheduledMs - elapsedMs));
}
