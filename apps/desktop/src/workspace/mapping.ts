/**
 * 历史条目 / 运行时事件 → UI 消息的纯映射函数。
 *
 * 与 `sessionWorkspace.ts` 分开是为了让映射规则可以单独测试，
 * 也避免工作区控制器变成几百行的巨型模块。
 */

import {
  MAX_DIAGNOSTICS,
  type ChatMessage,
  type ChatRole,
  type EntryRole,
  type HistoryEntry,
  type HistoryPage,
  type SessionId,
  type SessionTab,
} from "./types.ts";

/** Pi 原始角色 → UI 角色；bashExecution / toolResult 统一按工具行渲染。 */
export function mapRole(role: EntryRole | string | null): ChatRole {
  switch (role) {
    case "user":
      return "user";
    case "assistant":
      return "assistant";
    case "system":
      return "system";
    case "tool_result":
    case "bashExecution":
    case "toolResult":
      return "tool";
    default:
      return "other";
  }
}

export function messageFromEntry(sessionId: SessionId, entry: HistoryEntry): ChatMessage {
  return {
    id: `${sessionId}:h:${entry.ordinal}`,
    ordinal: entry.ordinal,
    role: mapRole(entry.role),
    text: entry.preview ?? "",
    // 分页只给 240 字符预览：完整正文由 fetchTexts 补齐，这里先标记为未完成。
    partial: entry.kind === "message" || entry.oversized || entry.corrupt,
    streaming: false,
    source: "history",
    createdAt: entry.timestamp,
  };
}

/** 从 Pi 流式事件里取出可追加的文本；无法识别的结构返回 null，绝不猜测。 */
export function deltaText(data: unknown): string | null {
  if (typeof data === "string") return data.length > 0 ? data : null;
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  for (const key of ["delta", "text", "content"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  const message = record["message"];
  if (message && typeof message === "object") {
    const content = (message as Record<string, unknown>)["content"];
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const parts = content
        .filter((block): block is Record<string, unknown> => !!block && typeof block === "object")
        .filter((block) => block["type"] === "text" && typeof block["text"] === "string")
        .map((block) => block["text"] as string);
      if (parts.length > 0) return parts.join("");
    }
  }
  return null;
}

export function describeError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "未知错误";
}

/** 历史消息按 ordinal 有序插入；实时消息始终排在历史之后。 */
export function insertHistoryMessage(tab: SessionTab, message: ChatMessage): void {
  const ordinal = message.ordinal ?? 0;
  let index = tab.messages.length;
  for (let cursor = 0; cursor < tab.messages.length; cursor += 1) {
    const candidate = tab.messages[cursor];
    if (candidate?.source === "history" && (candidate.ordinal ?? 0) > ordinal) {
      index = cursor;
      break;
    }
  }
  tab.messages.splice(index, 0, message);
}

/** 合并一页历史：按 id 去重，重复页或重叠页都不会产生重复消息。 */
export function mergeHistory(tab: SessionTab, page: HistoryPage): void {
  const known = new Set(tab.messages.map((message) => message.id));
  for (const entry of page.entries) {
    const message = messageFromEntry(tab.sessionId, entry);
    if (known.has(message.id)) continue;
    known.add(message.id);
    insertHistoryMessage(tab, message);
  }
  tab.history = {
    loaded: tab.messages.filter((message) => message.source === "history").length,
    total: page.total,
    next: page.next,
    loading: false,
  };
  dropLocalEchoes(tab);
}

/**
 * Pi 会把用户消息写进 JSONL；重新加载历史后本地乐观回显会重复。
 * 只在「角色相同且历史文本是实时文本前缀」时移除，避免误删相似内容。
 */
export function dropLocalEchoes(tab: SessionTab): void {
  const history = tab.messages.filter((message) => message.source === "history");
  if (history.length === 0) return;
  tab.messages = tab.messages.filter((message) => {
    if (message.source !== "live" || message.role !== "user") return true;
    return !history.some(
      (candidate) =>
        candidate.role === message.role &&
        (candidate.text === message.text ||
          (candidate.text.length > 0 &&
            message.text.startsWith(candidate.text.replace(/…$/, "")))),
    );
  });
}

export function finalizeStreaming(tab: SessionTab): void {
  for (const message of tab.messages) {
    if (message.streaming) message.streaming = false;
  }
}

/** 诊断环形缓冲：只保留最近 `MAX_DIAGNOSTICS` 行，不含会话正文。 */
export function pushDiagnostic(tab: SessionTab, line: string): string[] {
  const next = [...tab.diagnostics, line];
  return next.slice(Math.max(0, next.length - MAX_DIAGNOSTICS));
}
