/**
 * 运行时事件 → 通知事件 的分类规则（V4-S2b，Issue #117）。
 *
 * 纯函数，零副作用：输入一条 `RuntimeEvent`，输出「该提醒什么」或 null。
 * 弹窗、声音、历史都由 store 负责，这里只做判定，因此规则可以被单测钉死。
 *
 * 数据来源只有现有的会话事件流（`retain_session_events` 的推送），
 * 不新增后端 command，也不碰系统通知 API。
 *
 * 三类事件的判定依据：
 * - 会话完成：`settled`。Pi 的 `agent_end` 不能代替它（一轮可能有多段回答）。
 *   用户主动停止（`cancelling` 期间到达的 `settled`）不算「成功结束」，不提醒。
 * - 会话出错：`state=error`（后端将来若新增该状态）或**异常退出**
 *   （非 `requested_abort` 且退出码非 0）。用户主动停止不算错误。
 * - 等待输入：扩展 UI 交互请求。后端当前把 `extension_ui_request` 记录当作
 *   未处理并降级成 warning，因此这里同时识别 stream 事件与那条 warning；
 *   等后端补齐扩展 UI（Issue #112 之后的切片）时不需要再改这里。
 */

import type { RuntimeEvent, SessionId, TabStatus } from "../workspace/types.ts";
import type { NotificationEventKind } from "./settings.ts";

export type NotificationSeverity = "success" | "error" | "info";

export interface NotificationEvent {
  kind: NotificationEventKind;
  severity: NotificationSeverity;
  title: string;
  body: string;
  sessionId: SessionId;
  /** 可选操作按钮的文案；null 表示这条通知没有可跳转的目标。 */
  actionLabel: string | null;
  /**
   * 非空时，同 key 且尚未消失的通知会被合并。
   *
   * 一次交互请求在协议层会产生多条记录（未处理记录 + 协议警告），
   * 不合并就会连弹两条「等待你的输入」。
   */
  dedupeKey: string | null;
}

/** 扩展 UI 交互请求的记录类型 / 事件名。 */
const EXTENSION_UI_EVENT_NAMES: readonly string[] = [
  "extension_ui_request",
  "extension_ui_select",
  "extension_ui_confirm",
  "extension_ui_input",
  "extension_ui_editor",
];

/** 交互方式：select / confirm / input / editor 才是「等用户操作」。 */
const EXTENSION_UI_METHODS: readonly string[] = ["select", "confirm", "input", "editor"];

/**
 * 后端降级后的警告文本：`extension ui request is not implemented` 与
 * `未处理的记录类型：extension_ui_request`。大小写与下划线/空格都放过。
 */
const EXTENSION_UI_WARNING = /extension[_ ]ui[_ ]request/i;

const ACTION_LABEL = "查看会话";

function sessionTitle(title: string | null | undefined): string {
  const trimmed = (title ?? "").trim();
  return trimmed.length > 0 ? trimmed : "会话";
}

/**
 * 从 stream 事件里认出交互方式。
 *
 * 只在**白名单命中**时返回：事件名属于扩展 UI 请求，或 data 里某个字段的值
 * 正好是 select/confirm/input/editor。无法识别一律返回 null——宁可少提醒，
 * 也不能把普通消息增量误判成「等待输入」。
 */
function interactionMethod(event: Extract<RuntimeEvent, { type: "stream" }>): string | null {
  if (EXTENSION_UI_EVENT_NAMES.includes(event.event)) return event.event;
  const data = event.data;
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  for (const key of ["method", "interaction", "type", "kind"]) {
    const value = record[key];
    if (typeof value === "string" && EXTENSION_UI_METHODS.includes(value)) return value;
  }
  return null;
}

function errorEvent(sessionId: SessionId, title: string, detail: string): NotificationEvent {
  return {
    kind: "sessionError",
    severity: "error",
    title: "会话出错",
    body: detail.length > 0 ? `「${title}」${detail}` : `「${title}」运行出错，请查看诊断信息`,
    sessionId,
    actionLabel: ACTION_LABEL,
    dedupeKey: null,
  };
}

/**
 * 分类一条运行时事件。
 *
 * `title` 取 Tab 标题（用户在侧栏看到的名字），通知里必须能认出是哪个会话。
 * 事件已被调用方按 generation 过滤过；这里不再判断迟到，只判断语义。
 */
export interface ClassifyOptions {
  title?: string | null;
  /** 事件处理前的 Tab 状态；`cancelling` 表示用户刚按了停止。 */
  previousStatus?: TabStatus;
}

export function classifyRuntimeEvent(
  event: RuntimeEvent,
  options: ClassifyOptions = {},
): NotificationEvent | null {
  const title = sessionTitle(options.title);

  switch (event.type) {
    case "settled":
      // 取消后 Pi 仍可能发 agent_settled：这一轮不是「成功结束」，不能弹「会话完成」。
      if (options.previousStatus === "cancelling") return null;
      return {
        kind: "sessionCompleted",
        severity: "success",
        title: "会话完成",
        body: `「${title}」已完成这一轮回答`,
        sessionId: event.sessionId,
        actionLabel: ACTION_LABEL,
        dedupeKey: null,
      };
    case "state":
      // 现有状态机没有 error 态；后端将来加上时这里直接生效，不需要改前端。
      if (event.state !== "error") return null;
      return errorEvent(event.sessionId, title, "运行时进入错误状态");
    case "exit": {
      const code = event.code ?? 0;
      // 主动停止（requested_abort）与正常退出（code 0）不是错误，不该打扰用户。
      if (event.reason === "requested_abort" || code === 0) return null;
      return errorEvent(event.sessionId, title, `运行时异常退出（${event.reason}）`);
    }
    case "stream": {
      const method = interactionMethod(event);
      if (!method) return null;
      return {
        kind: "awaitingInput",
        severity: "info",
        title: "等待你的输入",
        body: `「${title}」正在等待你选择或确认`,
        sessionId: event.sessionId,
        actionLabel: ACTION_LABEL,
        // 同一次交互请求可能连发多条记录：合并成一条提醒。
        dedupeKey: `awaitingInput:${event.sessionId}`,
      };
    }
    case "warning": {
      if (!EXTENSION_UI_WARNING.test(event.detail)) return null;
      return {
        kind: "awaitingInput",
        severity: "info",
        title: "等待你的输入",
        body: `「${title}」正在等待你选择或确认`,
        sessionId: event.sessionId,
        actionLabel: ACTION_LABEL,
        dedupeKey: `awaitingInput:${event.sessionId}`,
      };
    }
    default:
      return null;
  }
}
