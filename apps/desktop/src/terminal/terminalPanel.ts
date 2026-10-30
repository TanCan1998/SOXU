/**
 * 终端抽屉的纯逻辑（Issue #122 · TASK-030）。
 *
 * 组件只负责「挂 xterm、转发事件」；尺寸口径、去重闸门、状态文案与关闭结论
 * 全部放在这里，Node 测试不需要 DOM 就能验证（与 searchPanel.ts / sendMode.ts 同一分工）。
 *
 * 三条边界：
 * 1. 尺寸必须在后端允许的范围内（后端会拒绝 0 与超限值，前端先夹紧，避免把
 *    一次非法请求发出去再处理错误）；
 * 2. 只有**尺寸真的变了**才发 resize：拖拽窗口时 onResize 每帧都触发，
 *    不去重就会变成每帧一次 IPC；
 * 3. 关闭结论如实呈现：`exited: false` 意味着后端等待超时，界面不能写成「已回收」。
 */

/** xterm 的回滚行数：够翻查一段输出，又不会把整份日志留在内存里。 */
export const TERMINAL_SCROLLBACK = 5000;

/** 尺寸下限：小于这个值 xterm 排版会错乱（ConPTY 也拿不到可用的屏幕缓冲）。 */
export const TERMINAL_MIN_COLS = 20;
export const TERMINAL_MIN_ROWS = 4;
/** 尺寸上限：与后端 `MAX_DIMENSION` 同量级，防止一次异常测量把缓冲撑爆。 */
export const TERMINAL_MAX_COLS = 400;
export const TERMINAL_MAX_ROWS = 200;

/** 后端拒绝创建时使用的默认尺寸（容器还没布局好时的兜底）。 */
export const TERMINAL_DEFAULT_COLS = 80;
export const TERMINAL_DEFAULT_ROWS = 24;

export interface TerminalSize {
  cols: number;
  rows: number;
}

/** 抽屉的可见状态。`closed` 与 `error` 都保留在界面上，不静默变成空面板。 */
export type TerminalStatus = "starting" | "ready" | "closed" | "error";

/** 把任意来源的尺寸夹进合法区间；非整数一律取整（xterm 只接受整数）。 */
export function clampSize(cols: number, rows: number): TerminalSize {
  return {
    cols: clampDimension(cols, TERMINAL_MIN_COLS, TERMINAL_MAX_COLS, TERMINAL_DEFAULT_COLS),
    rows: clampDimension(rows, TERMINAL_MIN_ROWS, TERMINAL_MAX_ROWS, TERMINAL_DEFAULT_ROWS),
  };
}

function clampDimension(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  const rounded = Math.round(value);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}

export function sameSize(left: TerminalSize | null, right: TerminalSize | null): boolean {
  if (!left || !right) return left === right;
  return left.cols === right.cols && left.rows === right.rows;
}

/**
 * resize 去重闸门。
 *
 * `request` 返回 true 表示这次调用真的发出去了。调用方（组件）负责把「每帧触发」
 * 合并成一次：闸门只回答「和上次发出去的是不是同一个尺寸」。
 */
export function createResizeGate(send: (size: TerminalSize) => void): {
  request: (size: TerminalSize) => boolean;
  last: () => TerminalSize | null;
  reset: () => void;
} {
  let last: TerminalSize | null = null;
  return {
    request(size: TerminalSize): boolean {
      const clamped = clampSize(size.cols, size.rows);
      if (sameSize(last, clamped)) return false;
      last = clamped;
      send(clamped);
      return true;
    },
    last: () => last,
    reset(): void {
      last = null;
    },
  };
}

/**
 * 初始尺寸：优先用容器测量结果（FitAddon 的 proposeDimensions），
 * 拿不到就退回默认值。容器在抽屉刚打开的那一帧通常还是 0×0，这一步必须兜住。
 */
export function resolveInitialSize(proposal: TerminalSize | null | undefined): TerminalSize {
  if (!proposal) return { cols: TERMINAL_DEFAULT_COLS, rows: TERMINAL_DEFAULT_ROWS };
  return clampSize(proposal.cols, proposal.rows);
}

/**
 * 输出事件是否应当写入终端。
 *
 * 后端按 ptyId 分流且 seq 单调递增；重复或乱序说明事件来自别的终端（或旧一代），
 * 写进去就会串屏。这里只放行 `seq > lastSeq` 的事件。
 */
export function shouldAcceptOutput(lastSeq: number, seq: number): boolean {
  return Number.isFinite(seq) && seq > lastSeq;
}

/** 状态文案：界面上不出现技术术语，只说用户能理解的状态。 */
export function terminalStatusText(status: TerminalStatus): string {
  switch (status) {
    case "starting":
      return "正在打开终端…";
    case "ready":
      return "已连接";
    case "closed":
      return "终端已关闭";
    case "error":
      return "终端不可用";
  }
}

/**
 * 关闭结论：`exited` 为 false 时后端等待子进程退出超时，
 * 必须如实提示「可能有残留进程」，不能写成「已回收」。
 */
export function closeSummary(closed: {
  existed: boolean;
  exited: boolean;
}): string {
  if (!closed.existed) return "终端已关闭";
  return closed.exited ? "终端已关闭，进程已回收" : "终端已关闭，但进程可能仍在运行";
}

/** 快捷键提示（顶栏按钮与抽屉标题共用一份，避免两处文案漂移）。 */
export const TERMINAL_SHORTCUT_LABEL = "Ctrl+`";

/** 创建返回前最多缓存多少个输出事件（超出的按「丢最旧」处理）。 */
export const MAX_PENDING_EVENTS = 64;
/** 创建返回前最多缓存多少字符：并发首屏输出的极端情况也要有界。 */
export const MAX_PENDING_CHARS = 256 * 1024;

/** 缓冲里的一条输出（字段与 `ptyClient.PtyOutputEvent` 一致，这里只依赖结构）。 */
export interface BufferedOutput {
  ptyId: string;
  seq: number;
  data: string;
}

/**
 * 创建返回前的输出缓冲。
 *
 * 为什么需要：订阅必须早于创建（否则 ConPTY 的首屏内容会丢），但 ptyId 要等创建返回
 * 才知道。这段窗口里到达的输出先按序缓冲，拿到 ptyId 后一次性补写。
 *
 * 有界：窗口内的输出量不可控（shell 可能一启动就狂打日志），所以超过上限时丢**最旧**
 * 的一条并计数——宁可少一行旧输出，也不能让内存无界增长。
 */
export function createOutputBuffer(
  limits: { events: number; chars: number } = { events: MAX_PENDING_EVENTS, chars: MAX_PENDING_CHARS },
): {
  push: (event: BufferedOutput) => void;
  take: (ptyId: string) => BufferedOutput[];
  clear: () => void;
  size: () => number;
  dropped: () => number;
} {
  let events: BufferedOutput[] = [];
  let chars = 0;
  let dropped = 0;
  return {
    push(event: BufferedOutput): void {
      events.push(event);
      chars += event.data.length;
      while (
        events.length > Math.max(1, limits.events) ||
        (chars > limits.chars && events.length > 1)
      ) {
        const removed = events.shift();
        if (!removed) break;
        chars -= removed.data.length;
        dropped += 1;
      }
    },
    take(ptyId: string): BufferedOutput[] {
      const matched = events.filter((event) => event.ptyId === ptyId);
      events = [];
      chars = 0;
      return matched;
    },
    clear(): void {
      events = [];
      chars = 0;
    },
    size: () => events.length,
    dropped: () => dropped,
  };
}
