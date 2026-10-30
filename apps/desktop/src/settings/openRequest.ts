/**
 * 「打开设置」请求的落地判定（Issue #123 复审修正）。
 *
 * 背景：设置弹窗可能**已经开着**（Ctrl+, 或上一次命令面板打开的），此时再从命令面板
 * 执行一条「设置 · 系统」，用户期望的是切到那一页，而不是什么都没发生。
 * 旧实现只在 props.open 由 false 变 true 时应用 initialTab，于是「已经打开」时
 * 那次请求被静默丢掉——文案说了跳到系统页，界面却停在原处。
 *
 * 修法：App.vue 每次调用 openSettings 都递增 request（单调计数），弹窗把
 * 「(open, request) 的前后变化」交给本函数判定。纯逻辑、无 DOM，可直接在 Node 里断言。
 */

/** 一次打开请求的落地结果。 */
export type SettingsOpenTransition =
  /** 没有新请求（弹窗关着，或同一个请求重复渲染）：什么都不做。 */
  | "none"
  /** 弹窗从关到开：应用目标页，并把焦点移进弹窗。 */
  | "opened"
  /** 弹窗已经开着又来了新请求：只切页，不抢用户当前的焦点。 */
  | "retargeted";

/** 判定所需的两个事实；request 是单调递增的请求序号。 */
export interface SettingsOpenState {
  open: boolean;
  request: number;
}

/** 把前后两次状态翻译成动作。 */
export function settingsOpenTransition(
  previous: SettingsOpenState,
  next: SettingsOpenState,
): SettingsOpenTransition {
  if (!next.open) return "none";
  if (!previous.open) return "opened";
  if (next.request !== previous.request) return "retargeted";
  return "none";
}
