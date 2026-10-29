/**
 * 历史条目 / 运行时事件 → UI 消息的纯映射函数。
 *
 * 与 `sessionWorkspace.ts` 分开是为了让映射规则可以单独测试，
 * 也避免工作区控制器变成几百行的巨型模块。
 */

import {
  MAX_DIAGNOSTICS,
  MAX_MESSAGE_CHARS,
  MAX_TAB_HISTORY_CHARS,
  MAX_TAB_HISTORY_MESSAGES,
  MAX_TAB_LIVE_MESSAGES,
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
    evicted: tab.history.evicted,
    evictedLive: tab.history.evictedLive,
  };
  dropLocalEchoes(tab);
  enforceMessageWindow(tab);
}

/** Tab 内存窗口的三条上限；测试可以传入更小的值来验证释放逻辑。 */
export interface MessageWindowLimits {
  /** 保留的历史消息条数上限。 */
  maxHistory: number;
  /** 保留的实时消息条数上限。 */
  maxLive: number;
  /** 保留的历史正文字符预算。 */
  maxChars: number;
}

export const DEFAULT_WINDOW_LIMITS: MessageWindowLimits = {
  maxHistory: MAX_TAB_HISTORY_MESSAGES,
  maxLive: MAX_TAB_LIVE_MESSAGES,
  maxChars: MAX_TAB_HISTORY_CHARS,
};

export interface WindowReport {
  droppedHistory: number;
  droppedLive: number;
  historyMessages: number;
  historyChars: number;
}

/**
 * 有界窗口：释放最旧的消息，让「加载更多」不会把整份长会话读进内存。
 *
 * 释放顺序固定为「先最旧的历史、再最旧的实时」，且**永不释放**正在流式的最后一条
 * （否则用户会看到当前回复被截掉）。释放只是从内存窗口移出，Pi 的 JSONL 未受影响。
 *
 * 调用点必须覆盖两条增长路径：`mergeHistory`（加载更多）与实时追加（用户发问、
 * 新的流式回复）。只在前者收敛，连续多轮对话仍会无限增长。
 */
export function enforceMessageWindow(
  tab: SessionTab,
  limits: MessageWindowLimits = DEFAULT_WINDOW_LIMITS,
): WindowReport {
  const liveIndexes: number[] = [];
  const historyIndexes: number[] = [];
  tab.messages.forEach((message, index) => {
    if (message.source === "history") historyIndexes.push(index);
    else liveIndexes.push(index);
  });

  const dropped = new Set<number>();
  let liveCount = liveIndexes.length;
  for (const index of liveIndexes) {
    if (liveCount <= limits.maxLive) break;
    const message = tab.messages[index];
    if (!message || message.streaming) continue; // 流式中的最后一条保留
    dropped.add(index);
    liveCount -= 1;
  }

  let historyCount = historyIndexes.length;
  let historyChars = historyIndexes.reduce(
    (sum, index) => sum + (tab.messages[index]?.text.length ?? 0),
    0,
  );
  for (const index of historyIndexes) {
    if (historyCount <= limits.maxHistory && historyChars <= limits.maxChars) break;
    if (historyCount <= 1) break; // 至少保留一条，避免窗口为空后无法继续翻页
    const message = tab.messages[index];
    if (!message) continue;
    dropped.add(index);
    historyCount -= 1;
    historyChars -= message.text.length;
  }

  if (dropped.size === 0) {
    return {
      droppedHistory: 0,
      droppedLive: 0,
      historyMessages: historyCount,
      historyChars,
    };
  }

  const kept: ChatMessage[] = [];
  let droppedHistory = 0;
  let droppedLive = 0;
  tab.messages.forEach((message, index) => {
    if (dropped.has(index)) {
      if (message.source === "history") droppedHistory += 1;
      else droppedLive += 1;
      return;
    }
    kept.push(message);
  });
  tab.messages = kept;
  tab.history = {
    ...tab.history,
    loaded: historyCount,
    evicted: tab.history.evicted + droppedHistory,
    evictedLive: tab.history.evictedLive + droppedLive,
  };
  return { droppedHistory, droppedLive, historyMessages: historyCount, historyChars };
}

/**
 * 按字符（码点）截断正文，UTF-8/代理对安全；与 Rust 的 `truncate` 口径一致。
 *
 * 目的不是隐藏内容，而是保证一条超长工具输出不会撑爆 Vue 状态与 DOM。
 */
export function capText(
  text: string,
  limit: number = MAX_MESSAGE_CHARS,
): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  const points = Array.from(text);
  if (points.length <= limit) return { text, truncated: false };
  return { text: `${points.slice(0, limit).join("")}…`, truncated: true };
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
