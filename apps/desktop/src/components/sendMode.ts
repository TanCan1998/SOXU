/**
 * 发送三选的可用条件与文案（Issue #111 · V4-S1）。
 *
 * 定义来自 `docs/design/UIUX/V4/interaction-decisions.md` 第一节：
 * - 加入当前（steer）：**仅 agent 忙碌时可用**，空闲时置灰；
 * - 排到下轮（followUp）：总是可用；
 * - 并行发送（parallel）：草稿非空 **且** 纯文本（带图置灰）**且** 有 projectId。
 *
 * 这里是纯函数：菜单组件只负责渲染结果，判定逻辑可被测试直接驱动
 * （忙碌置灰用 mock 状态验证，不需要跑真实运行时）。
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
): Record<SendMode, SendModeAvailability> {
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
