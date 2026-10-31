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

import { useLocale } from "../locales/index.ts";
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

/**
 * 未接入时统一显示的原因 key（Issue #144）：文案在 session.json，
 * 这里只保存 key，语言切换后同一个 key 会解析成对应语言的文案。
 */
export const SEND_MODES_PENDING_KEY = "session.mode.pending";

export const SEND_MODE_ORDER: readonly SendMode[] = Object.freeze([
  "steer",
  "followUp",
  "parallel",
] as const);

/** 每种投递方式的文案 key；文案本身在 locales/<tag>/session.json。 */
export interface SendModeTextKeys {
  labelKey: string;
  descriptionKey: string;
}

export const SEND_MODE_TEXT: Readonly<Record<SendMode, SendModeTextKeys>> = Object.freeze({
  steer: { labelKey: "session.mode.steer.label", descriptionKey: "session.mode.steer.description" },
  followUp: {
    labelKey: "session.mode.follow.up.label",
    descriptionKey: "session.mode.follow.up.description",
  },
  parallel: {
    labelKey: "session.mode.parallel.label",
    descriptionKey: "session.mode.parallel.description",
  },
});

/** 取当前语言的投递方式名称；组件在模板里直接调用，语言切换后自动重渲染。 */
export function sendModeLabel(mode: SendMode): string {
  return useLocale().t(SEND_MODE_TEXT[mode].labelKey);
}

/** 取当前语言的投递方式说明。 */
export function sendModeDescription(mode: SendMode): string {
  return useLocale().t(SEND_MODE_TEXT[mode].descriptionKey);
}

/** 未接入时统一显示的原因：只说事实，不假装能点。 */
export function sendModePendingReason(): string {
  return useLocale().t(SEND_MODES_PENDING_KEY);
}

/** 判定三种投递方式此刻是否可选；顺序与 SEND_MODE_ORDER 一致。 */
export function sendModeAvailability(
  context: SendModeContext,
  options: SendModeAvailabilityOptions = {},
): Record<SendMode, SendModeAvailability> {
  const { t } = useLocale();
  if (!(options.ready ?? SEND_MODES_READY)) {
    // 每一项各自一个对象：调用方可能只改其中一项，共享引用会互相污染。
    return {
      steer: { enabled: false, reason: sendModePendingReason() },
      followUp: { enabled: false, reason: sendModePendingReason() },
      parallel: { enabled: false, reason: sendModePendingReason() },
    };
  }

  const draft = context.draft.trim();
  const attachments = context.attachments ?? 0;
  const hasProject = context.hasProject ?? true;

  const parallelReason = !draft
    ? t("session.mode.reason.parallel.empty")
    : attachments > 0
      ? t("session.mode.reason.parallel.attachments")
      : !hasProject
        ? t("session.mode.reason.parallel.no.project")
        : null;

  return {
    steer: context.busy
      ? { enabled: true, reason: null }
      : { enabled: false, reason: t("session.mode.reason.steer.idle") },
    followUp: { enabled: true, reason: null },
    parallel: { enabled: parallelReason === null, reason: parallelReason },
  };
}

/** 草稿是否纯文本：首版没有附件通道，只按「有没有附件」判定。 */
export function isPlainTextDraft(context: SendModeContext): boolean {
  return (context.attachments ?? 0) === 0;
}
