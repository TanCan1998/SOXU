/**
 * 上下文环、统计浮窗与底部统计行的纯逻辑（Issue #119 / TASK-027）。
 *
 * 这一层不依赖 Vue 也不依赖 DOM：阈值、几何、格式化与「什么时候刷新」都在这里，
 * 组件只负责把结果画出来。这样 Node 里可以确定地验证「圆环随占用率变色」与
 * 「无数据时显示占位而不是 0」两条验收，而不需要浏览器渲染器。
 *
 * 三条不可让步的规则：
 * 1. **null 就是占位**。没有观测到的指标显示「—」，绝不 `?? 0` 把它变成 0；
 * 2. **圆环只按真实比例画**。窗口未知时圆环不填色（tone = unknown），不猜一个百分比；
 * 3. **刷新只由事件驱动**。`shouldRefreshStats` 是唯一判据，任何 `setInterval` 都属于违规。
 */

import { useLocale } from "../locales/index.ts";
import type { RuntimeEvent, SessionStats, SessionTab } from "../workspace/types.ts";

/** 圆环直径（px）。规格来自 Issue #119：14px SVG。 */
export const RING_SIZE = 14;
/** 圆环线宽（px）。规格来自 Issue #119：stroke 2.8。 */
export const RING_STROKE = 2.8;
/** 占用率低于该值用强调色。 */
export const RING_WARN_PCT = 60;
/** 占用率高于该值用危险色；60–85（含）为警告色。 */
export const RING_DANGER_PCT = 85;
/** 无数据占位符：全角破折号，和「0」在视觉上完全不同。 */
export const PLACEHOLDER = "—";

export type RingTone = "accent" | "warn" | "danger" | "unknown";

/**
 * 占用率 → 颜色档位。
 *
 * 阈值口径照 Issue #119：<60% 强调色 / 60–85% 警告 / >85% 危险。
 * `null` 与非法值返回 `unknown`（空心圆环），不是 0%。
 */
export function ringTone(percent: number | null | undefined): RingTone {
  if (percent === null || percent === undefined || !Number.isFinite(percent)) return "unknown";
  if (percent < RING_WARN_PCT) return "accent";
  if (percent <= RING_DANGER_PCT) return "warn";
  return "danger";
}

export interface RingGeometry {
  radius: number;
  circumference: number;
  /** 未画出的弧长：占用率越高，留白越少。 */
  dashOffset: number;
}

/** 圆环几何：半径扣掉半个线宽，保证描边不会溢出 14px 视口。 */
export function ringGeometry(
  percent: number | null | undefined,
  size: number = RING_SIZE,
  stroke: number = RING_STROKE,
): RingGeometry {
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const ratio = percent === null || percent === undefined || !Number.isFinite(percent)
    ? 0
    : Math.min(Math.max(percent, 0), 100) / 100;
  return { radius, circumference, dashOffset: circumference * (1 - ratio) };
}

/** 视图模型：后端快照 + 前端才知道的「已载入条数」。 */
export interface SessionStatsView {
  context: { used: number | null; total: number | null; percent: number | null };
  turn: SessionStats["turn"];
  process: SessionStats["process"];
  session: StatsSessionView;
  updatedAtMs: number | null;
  /** 是否拿到过任何真实观测：false 时浮窗整体显示「暂无数据」。 */
  hasData: boolean;
}

export interface StatsSessionView {
  /** 内存窗口里实际载入的条目数（前端自己的 Tab 状态，后端不猜）。 */
  loaded: number | null;
  /** 会话条目总数：优先用后端索引，回退到 Tab 的历史总数。 */
  total: number | null;
  worktree: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  retry: SessionStats["session"]["retry"];
}

const EMPTY_VIEW: SessionStatsView = {
  context: { used: null, total: null, percent: null },
  turn: {
    turns: null,
    inFlight: false,
    firstTokenMs: null,
    durationMs: null,
    streamTokensPerSec: null,
    avgTokensPerSec: null,
    cacheHitPct: null,
  },
  process: { rssMb: null, cpuPct: null, childCount: null, degraded: [] },
  session: {
    loaded: null,
    total: null,
    worktree: null,
    inputTokens: null,
    outputTokens: null,
    retry: null,
  },
  updatedAtMs: null,
  hasData: false,
};

/**
 * 把后端快照与 Tab 状态合成视图。
 *
 * `tab` 只用来取「已载入条数」：后端不知道前端内存窗口里保留了多少条，
 * 让后端猜会直接违反「浮窗数值与事件流一致」。
 */
export function composeStatsView(
  stats: SessionStats | null,
  tab: Pick<SessionTab, "history"> | null,
): SessionStatsView {
  if (!stats) return EMPTY_VIEW;
  const loaded = tab ? tab.history.loaded : null;
  const total = stats.session.entriesTotal ?? (tab ? tab.history.total : null);
  return {
    context: {
      used: stats.context.used,
      total: stats.context.total,
      percent: stats.context.percent,
    },
    turn: stats.turn,
    process: stats.process,
    session: {
      loaded,
      total,
      worktree: stats.session.worktree,
      inputTokens: stats.session.inputTokens,
      outputTokens: stats.session.outputTokens,
      retry: stats.session.retry,
    },
    updatedAtMs: stats.updatedAtMs,
    hasData: hasObservedData(stats),
  };
}

/** 后端是否观测到过东西：全部字段为 null 说明本次进程还没跑过这一轮。 */
export function hasObservedData(stats: SessionStats): boolean {
  return (
    stats.updatedAtMs !== null ||
    stats.turn.turns !== null ||
    stats.context.used !== null ||
    stats.session.inputTokens !== null ||
    stats.session.entriesTotal !== null
  );
}

/** 千分位整数；null → 占位符。 */
export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return PLACEHOLDER;
  return Math.round(value).toLocaleString("en-US");
}

/** 百分比保留一位小数；null → 占位符（不是 0%）。 */
export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return PLACEHOLDER;
  return `${value.toFixed(1)}%`;
}

/** 毫秒：<1s 显示 820 ms，≥1s 显示 1.24 s；null → 占位符。 */
export function formatMs(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return PLACEHOLDER;
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toFixed(2)} s`;
}

/** 吞吐：一位小数 tok/s；null → 占位符。 */
export function formatRate(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return PLACEHOLDER;
  return `${value.toFixed(1)} tok/s`;
}

/** 内存：一位小数 MB；null → 占位符。 */
export function formatMb(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return PLACEHOLDER;
  return `${value.toFixed(1)} MB`;
}

/** 上下文用量的紧凑写法：1200 → 1.2k，用于圆环的读屏标签。 */
export function formatTokenCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return PLACEHOLDER;
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(2)}M`;
}

/**
 * 圆环的读屏标签：把「看到什么」和「读屏听到什么」对齐。
 *
 * 文案走 session.json（Issue #144）：数字部分仍由本模块格式化，
 * 语言只决定句子结构与单位位置，避免把格式化逻辑搬进语言包。
 */
export function ringLabel(view: SessionStatsView): string {
  const { t } = useLocale();
  const percent = view.context.percent;
  if (percent === null) {
    return view.context.used === null
      ? t("session.stats.ring.unknown")
      : t("session.stats.ring.used.only", { used: formatTokenCount(view.context.used) });
  }
  const used = formatTokenCount(view.context.used);
  const total = formatTokenCount(view.context.total);
  return t("session.stats.ring.known", {
    percent: formatPercent(percent),
    used,
    total,
  });
}

export interface StatsItem {
  key: string;
  label: string;
  value: string;
  /** 值不可用的原因（例如「模型未上报用量」），没有就省略。 */
  hint?: string;
}

/**
 * 底部统计行：轮次 / 首 token / 回复耗时 / 流式 / 均速 / 缓存命中 / 输入输出。
 *
 * 每一项都来自事件流，因此与浮窗里的同名项永远一致（同一个快照对象）。
 */
export function statsRowItems(view: SessionStatsView): StatsItem[] {
  const { t } = useLocale();
  const { turn, session } = view;
  return [
    { key: "turns", label: t("session.stats.row.turns"), value: formatCount(turn.turns) },
    {
      key: "firstToken",
      label: t("session.stats.row.first.token"),
      value: formatMs(turn.firstTokenMs),
    },
    { key: "duration", label: t("session.stats.row.duration"), value: formatMs(turn.durationMs) },
    { key: "stream", label: t("session.stats.row.stream"), value: formatRate(turn.streamTokensPerSec) },
    { key: "avg", label: t("session.stats.row.avg"), value: formatRate(turn.avgTokensPerSec) },
    { key: "cache", label: t("session.stats.row.cache"), value: formatPercent(turn.cacheHitPct) },
    {
      key: "tokens",
      label: t("session.stats.row.tokens"),
      value: `${formatTokenCount(session.inputTokens)} / ${formatTokenCount(session.outputTokens)}`,
    },
  ];
}

export interface StatsSection {
  title: string;
  items: StatsItem[];
}

/** 浮窗的四组指标，顺序与契约（context / turn / process / session）一致。 */
export function statsPopoverSections(view: SessionStatsView): StatsSection[] {
  const { t } = useLocale();
  const { context, turn, process: proc, session } = view;
  return [
    {
      title: t("session.stats.section.context"),
      items: [
        {
          key: "context",
          label: t("session.stats.item.used"),
          value:
            context.percent === null
              ? PLACEHOLDER
              : formatPercent(context.percent),
          hint:
            context.percent === null
              ? t("session.stats.item.context.unknown")
              : `${formatTokenCount(context.used)} / ${formatTokenCount(context.total)} token`,
        },
      ],
    },
    {
      title: turn.inFlight
        ? t("session.stats.section.turn")
        : t("session.stats.section.turn.previous"),
      items: [
        { key: "turns", label: t("session.stats.item.turns"), value: formatCount(turn.turns) },
        {
          key: "firstToken",
          label: t("session.stats.item.first.token"),
          value: formatMs(turn.firstTokenMs),
        },
        { key: "duration", label: t("session.stats.item.duration"), value: formatMs(turn.durationMs) },
        {
          key: "stream",
          label: t("session.stats.item.stream.rate"),
          value: formatRate(turn.streamTokensPerSec),
        },
        { key: "avg", label: t("session.stats.item.avg"), value: formatRate(turn.avgTokensPerSec) },
        {
          key: "cache",
          label: t("session.stats.item.cache"),
          value: formatPercent(turn.cacheHitPct),
        },
      ],
    },
    {
      title: t("session.stats.section.process"),
      items: [
        { key: "rss", label: t("session.stats.item.memory"), value: formatMb(proc.rssMb) },
        {
          key: "cpu",
          label: t("session.stats.item.cpu"),
          value: formatPercent(proc.cpuPct),
          hint: proc.cpuPct === null ? t("session.stats.item.cpu.unsupported") : undefined,
        },
        {
          key: "children",
          label: t("session.stats.item.children"),
          value: formatCount(proc.childCount),
        },
      ],
    },
    {
      title: t("session.stats.section.session"),
      items: [
        {
          key: "entries",
          label: t("session.stats.item.entries"),
          value: `${formatCount(session.loaded)} / ${formatCount(session.total)}`,
        },
        {
          key: "input",
          label: t("session.stats.item.input"),
          value: formatTokenCount(session.inputTokens),
        },
        {
          key: "output",
          label: t("session.stats.item.output"),
          value: formatTokenCount(session.outputTokens),
        },
        {
          key: "retry",
          label: t("session.stats.item.retry"),
          value: session.retry ? `${session.retry.attempts} / ${session.retry.maxAttempts}` : PLACEHOLDER,
          hint: session.retry ? undefined : t("session.stats.item.retry.none"),
        },
      ],
    },
  ];
}

/** 进程采样的降级说明：把后端标识翻译成一句人话，未知标识原样保留。 */
export function processDegradedNotes(degraded: string[]): string[] {
  const { t } = useLocale();
  return degraded.map((code) => {
    switch (code) {
      case "runtime_not_running":
        return t("session.stats.degraded.runtime.not.running");
      case "process_sample_failed":
        return t("session.stats.degraded.sample.failed");
      case "process_tree_partial":
        return t("session.stats.degraded.tree.partial");
      case "cpu_unsupported":
        return t("session.stats.degraded.cpu.unsupported");
      default:
        // 未知标识原样保留：它是后端给出的排障线索，不该被翻译成猜测。
        return code;
    }
  });
}

/**
 * 是否需要刷新统计：只认这三种事件，**没有任何定时器**。
 *
 * - `state`：运行时状态变化（启动/运行/空闲）；
 * - `settled`：一轮结束，轮次与耗时刚更新；
 * - `exit`：进程退出，进程指标必须立刻变成「不可用」。
 *
 * 流式事件（`stream`）故意不触发刷新：每条 token 都拉一次统计等于把轮询搬到事件里。
 */
export function shouldRefreshStats(event: RuntimeEvent): boolean {
  return event.type === "state" || event.type === "settled" || event.type === "exit";
}
