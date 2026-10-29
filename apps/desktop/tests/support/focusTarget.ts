/**
 * 焦点目标的测试替身（V4-S2b，Issue #117）。
 *
 * `src/notifications/focus.ts` 只依赖一层最小表面（hasFocus / visibilityState /
 * on / off），所以测试不需要 jsdom 或真实窗口：这个假对象可以精确制造
 * 「有焦点 / 失焦 / 隐藏到托盘」三种情形，并记录监听器数量以验证 stop 是否真的解绑。
 */

import type { FocusEventName, FocusTarget } from "../../src/notifications/focus.ts";

export interface TestFocusTarget extends FocusTarget {
  setFocused(value: boolean): void;
  setVisibility(value: string): void;
  /** 派发一个事件（不改变状态，状态由测试自己设）。 */
  emit(type: FocusEventName): void;
  listenerCount(): number;
}

export function createFocusTargetForTests(initial: {
  focused: boolean;
  visibility: string;
}): TestFocusTarget {
  let focused = initial.focused;
  let visibility = initial.visibility;
  const listeners = new Map<FocusEventName, Set<() => void>>();

  return {
    hasFocus: () => focused,
    visibilityState: () => visibility,
    on(type, handler) {
      const bucket = listeners.get(type) ?? new Set<() => void>();
      bucket.add(handler);
      listeners.set(type, bucket);
    },
    off(type, handler) {
      listeners.get(type)?.delete(handler);
    },
    setFocused(value: boolean) {
      focused = value;
    },
    setVisibility(value: string) {
      visibility = value;
    },
    emit(type) {
      for (const handler of [...(listeners.get(type) ?? [])]) handler();
    },
    listenerCount() {
      let total = 0;
      for (const bucket of listeners.values()) total += bucket.size;
      return total;
    },
  };
}
