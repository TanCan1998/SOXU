/**
 * 发送三选的可用条件与文案。
 *
 * 三种方式的设计条件（来自 docs/design/UIUX/V4/interaction-decisions.md 第一节）：
 * - 加入当前（steer）：仅 agent 忙碌时可用，空闲时置灰；
 * - 排到下轮（followUp）：总是可用；
 * - 并行发送（parallel）：草稿非空 **且** 纯文本（带图置灰）**且** 有 projectId。
 *
 * 但「可用」的前提是运行时真的能按这三种方式投递，而 Pi 侧的投递语义还没接上。
 * 因此 `SEND_MODES_READY` 为 false 时三项一律置灰，原因统一写「即将支持」：
 * 少一个能点的入口，好过一个点了没反应的假按钮。
 * 条件判定本身保留在 `sendModeAvailability` 里（测试用 ready 选项驱动），
 * 协议结论落地后把开关打开即可复用，不需要重写规则。
 */

import type { SendMode } from "../workspace/types.ts";

export interface SendModeAvailability {
  enabled: boolean;
  /** 置灰原因；可用时为 null。菜单把它显示在描述位置，用户不用猜为什么点不动。 */
  reason: string | null;
}

export interface SendModeContext {
  /** agent 是否正在跑一轮（status 为 running/cancelling）。 */
  busy: boolean;
  draft: string;
  /** 附件数量；首版没有附件能力，调用方传 0，但条件按决策文档先写死。 */
  attachments?: number;
  /** 是否有已登记的 projectId：并行发送要落到一个项目下的临时会话。 */
  hasProject?: boolean;
}

export interface SendModeAvailabilityOptions {
  /**
   * 覆盖「投递语义已接入」开关。默认取 `SEND_MODES_READY`；
   * 测试用它验证开关打开后的条件判定，不必等协议真的落地。
   */
  ready?: boolean;
}

/**
 * 三种投递方式的运行时语义是否已接入 Pi 协议。
 *
 * 协议调查结论落地前保持 false：菜单三项可见但不可点，这是刻意的降级。
 */
export const SEND_MODES_READY = false;

/** 未接入时统一显示的原因：只说事实，不假装能点。 */
export const SEND_MODES_PENDING_REASON = "即将支持";

export const SEND_MODE_ORDER: readonly SendMode[] = Object.freeze([
  "steer",
  "followUp",
  "parallel",
] as const);

export const SEND_MODE_TEXT: Readonly<
  Record<SendMode, { label: string; description: string }>
> = Object.freeze({
  steer: { label: "加入当前", description: "追加到本轮对话" },
  followUp: { label: "排到下轮", description: "本轮结束后自动发送" },
  parallel: { label: "并行发送", description: "独立会话后台处理，不打断当前输出" },
});

export function sendModeLabel(mode: SendMode): string {
  return SEND_MODE_TEXT[mode].label;
}

/** 判定三种投递方式此刻是否可选；顺序与 SEND_MODE_ORDER 一致。 */
export function sendModeAvailability(
  context: SendModeContext,
  options: SendModeAvailabilityOptions = {},
): Record<SendMode, SendModeAvailability> {
  if (!(options.ready ?? SEND_MODES_READY)) {
    // 每一项各自一个对象：调用方可能只改其中一项，共享引用会互相污染。
    return {
      steer: { enabled: false, reason: SEND_MODES_PENDING_REASON },
      followUp: { enabled: false, reason: SEND_MODES_PENDING_REASON },
      parallel: { enabled: false, reason: SEND_MODES_PENDING_REASON },
    };
  }

  const draft = context.draft.trim();
  const attachments = context.attachments ?? 0;
  const hasProject = context.hasProject ?? true;

  const parallelReason = !draft
    ? "先输入内容再并行发送"
    : attachments > 0
      ? "带附件的消息不能并行发送"
      : !hasProject
        ? "并行发送需要一个已登记的项目"
        : null;

  return {
    steer: context.busy
      ? { enabled: true, reason: null }
      : { enabled: false, reason: "Agent 空闲时消息直接发出，无需加入当前回合" },
    followUp: { enabled: true, reason: null },
    parallel: { enabled: parallelReason === null, reason: parallelReason },
  };
}

/** 草稿是否纯文本：首版没有附件通道，只按「有没有附件」判定。 */
export function isPlainTextDraft(context: SendModeContext): boolean {
  return (context.attachments ?? 0) === 0;
}
