/**
 * 窗口焦点判定（V4-S2b，Issue #117）。
 *
 * 「仅失焦时提醒」需要知道窗口当前有没有焦点。这里刻意不直接用全局
 * `window`/`document`：组件与 store 拿到的是一层最小表面，Node 测试
 * 可以注入假对象，把「有焦点 / 失焦 / 隐藏到托盘」三种情形都跑一遍。
 *
 * 判定口径是**两个条件同时成立才算有焦点**：
 * - `hasFocus()`（`document.hasFocus()`）：窗口是活动窗口（最小化/被别的窗口盖住会失焦）；
 * - `visibilityState !== "hidden"`：窗口被隐藏到托盘 / 最小化。
 *
 * 只看 `hasFocus()` 不够：部分平台上隐藏窗口仍会报「有焦点」，
 * 于是「托盘时也要响」就会失效。反过来只看 visibility 也不够：
 * 窗口可见但被切到后台时应该算失焦。
 */

export type FocusEventName = "focus" | "blur" | "visibilitychange";

export interface FocusTarget {
  hasFocus(): boolean;
  visibilityState(): string;
  on(type: FocusEventName, handler: () => void): void;
  off(type: FocusEventName, handler: () => void): void;
}

/** 浏览器 / WebView 宿主：window 提供 focus/blur，document 提供 visibilitychange。 */
export function browserFocusTarget(): FocusTarget | null {
  if (typeof window === "undefined" || typeof document === "undefined") return null;
  const view = window;
  const doc = document;
  return {
    // document.hasFocus() 才是「本文档是否活动」的正确来源；window 上没有这个方法。
    hasFocus: () => doc.hasFocus(),
    visibilityState: () => doc.visibilityState,
    on: (type, handler) => {
      if (type === "visibilitychange") doc.addEventListener(type, handler);
      else view.addEventListener(type, handler);
    },
    off: (type, handler) => {
      if (type === "visibilitychange") doc.removeEventListener(type, handler);
      else view.removeEventListener(type, handler);
    },
  };
}

/** 当前是否「用户正在看这个窗口」；没有宿主（测试/SSR）时按有焦点处理，即静默。 */
export function isWindowFocused(target: FocusTarget | null): boolean {
  if (!target) return true;
  try {
    return target.hasFocus() && target.visibilityState() !== "hidden";
  } catch {
    // 读取失败时保守处理：当作有焦点，宁可不出声也不要半夜突然响。
    return true;
  }
}

export interface FocusWatcher {
  readonly focused: boolean;
  /** 移除全部监听器；重复调用安全。 */
  stop(): void;
}

/**
 * 订阅焦点变化。
 *
 * 三个事件都要听：切走窗口只触发 blur，最小化/隐藏可能只触发 visibilitychange，
 * 少听一个就会出现「状态一直停在有焦点，托盘后永远不响」。
 */
export function watchWindowFocus(
  onChange: (focused: boolean) => void,
  target: FocusTarget | null = browserFocusTarget(),
): FocusWatcher {
  let current = isWindowFocused(target);
  let stopped = false;

  const handler = () => {
    if (stopped) return;
    const next = isWindowFocused(target);
    if (next === current) return;
    current = next;
    onChange(next);
  };

  if (target) {
    for (const type of ["focus", "blur", "visibilitychange"] as const) {
      target.on(type, handler);
    }
  }

  return {
    get focused() {
      return current;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      if (!target) return;
      for (const type of ["focus", "blur", "visibilitychange"] as const) {
        target.off(type, handler);
      }
    },
  };
}
