import type { SessionId } from "./types.ts";

/**
 * 顶栏「后退 / 前进」的会话导航历史（Issue #96）。
 *
 * 语义与浏览器标签页导航一致：后退回到上一个查看过的会话，前进回到之后查看过的会话；
 * 期间打开新会话会丢弃「前进」分支。刻意不做完整浏览器历史栈——只需要
 * 「访问顺序数组 + 游标」，上限 50 条，状态与内存都可预测。
 *
 * 全部是纯函数：返回新状态而不是就地改写，既方便单元测试，也不会在
 * Vue 响应式对象上留下难以追踪的共享引用。
 */
export const SESSION_HISTORY_LIMIT = 50;

export interface SessionHistory {
  /** 按访问顺序排列的会话 id，最新的在末尾。 */
  entries: SessionId[];
  /** 当前停留的下标；-1 表示还没有任何访问记录。 */
  index: number;
}

export type HistoryDirection = "back" | "forward";

/** 某个会话 id 是否仍然可以作为导航目标（Tab 已关闭的不算）。 */
export type SessionAvailability = (sessionId: SessionId) => boolean;

export function createSessionHistory(): SessionHistory {
  return { entries: [], index: -1 };
}

export function currentSession(history: SessionHistory): SessionId | null {
  return history.entries[history.index] ?? null;
}

/**
 * 记录一次访问。
 *
 * 与当前条目相同就直接返回原状态：否则「后退」之后重新渲染触发的那次记录
 * 会把刚刚保留的前进分支截断，前进按钮立刻失效。
 */
export function recordVisit(
  history: SessionHistory,
  sessionId: SessionId,
  limit: number = SESSION_HISTORY_LIMIT,
): SessionHistory {
  if (currentSession(history) === sessionId) return history;
  const entries = [...history.entries.slice(0, history.index + 1), sessionId];
  const overflow = entries.length - limit;
  // 超出上限丢最旧的记录；游标始终指向最后一条。
  const bounded = overflow > 0 ? entries.slice(overflow) : entries;
  return { entries: bounded, index: bounded.length - 1 };
}

/**
 * 沿指定方向找第一个仍可打开的会话，跳过已关闭的 Tab。
 * 返回 null 表示该方向到头了，调用方据此渲染禁用态。
 */
export function findTarget(
  history: SessionHistory,
  direction: HistoryDirection,
  isAvailable: SessionAvailability = () => true,
): { index: number; sessionId: SessionId } | null {
  const step = direction === "back" ? -1 : 1;
  const entries = history.entries;
  for (let index = history.index + step; index >= 0 && index < entries.length; index += step) {
    const sessionId = entries[index];
    if (isAvailable(sessionId)) return { index, sessionId };
  }
  return null;
}

/** 把游标移到指定下标；越界时收敛到合法范围，避免导航后状态错位。 */
export function moveTo(history: SessionHistory, index: number): SessionHistory {
  if (history.entries.length === 0) return history;
  const clamped = Math.min(Math.max(index, 0), history.entries.length - 1);
  return clamped === history.index ? history : { ...history, index: clamped };
}
