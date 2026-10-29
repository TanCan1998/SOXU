/**
 * 搜索抽屉的纯逻辑（Issue #118 · TASK-026）。
 *
 * 抽屉组件只负责渲染；「该显示哪个状态 / 结果怎么排 / 点击后落到哪条消息」
 * 全部放在这里，Node 测试不需要 DOM 就能验证——这也是本项目既有的分工
 * （见 mapping.ts、search.ts、sendMode.ts）。
 *
 * 三条边界：
 * 1. 状态判定只看 SearchState 与当前输入，不猜后端行为；
 * 2. 命中排序只在**已返回的这一批**里做（后端不支持倒序分页，见文件末尾的已知限制）；
 * 3. 定位只按 ordinal，因为历史消息的 id 就是 "<sessionId>:h:<ordinal>"。
 */

import { splitSnippet, type SnippetParts } from "../workspace/search.ts";
import type {
  ChatMessage,
  EntryRole,
  SearchState,
  SessionSearchHit,
} from "../workspace/types.ts";

/**
 * 抽屉的可见状态。
 *
 * searching 同时覆盖两种「还没有当前查询的结果」的情况：防抖窗口内还没发请求、
 * 请求已经发出但还没回来。区分它们对用户没有意义，但**都不能**继续显示上一次
 * 查询的命中——那会让用户以为旧结果就是新关键词的结果。
 */
export type SearchPanelStatus = "empty" | "searching" | "no-results" | "results" | "error";

/** 命中高亮的持续时间（毫秒）：够看清跳到了哪一条，又不会一直亮着干扰阅读。 */
export const HIT_HIGHLIGHT_MS = 2400;

/**
 * 点击命中时最多再翻几页历史来定位。
 *
 * 命中可能在尚未加载的窗口里（搜索搜的是整份会话，Tab 只保留有界窗口）。
 * 有界翻页是必须的：一个早就被窗口释放的命中不该让界面无限加载 5 万条历史。
 */
export const MAX_JUMP_PAGES = 3;

/** 面板状态判定：优先级从「输入为空」到「有命中」。 */
export function searchPanelStatus(state: SearchState, query: string): SearchPanelStatus {
  const trimmed = query.trim();
  if (!trimmed) return "empty";
  // 输入已经变了但结果还没回来：在途/待触发，不能把旧结果冒充成新查询的结果。
  if (state.loading || state.query !== trimmed) return "searching";
  if (state.error) return "error";
  return state.hits.length > 0 ? "results" : "no-results";
}

/**
 * 命中按消息时间倒序（ordinal 是 JSONL 的追加序号，越大越新）。
 *
 * 后端按 ordinal 升序返回（见 docs/development/session-search.md 第 3 节），
 * 面板要求倒序，所以这里复制一份再排——不原地改 tab.search.hits，
 * 否则同一份状态被两个消费者以不同顺序读到。
 */
export function sortHitsNewestFirst(hits: readonly SessionSearchHit[]): SessionSearchHit[] {
  return [...hits].sort((left, right) => right.ordinal - left.ordinal);
}

/** 命中对应的历史消息 id；与 mapping.ts 的 messageFromEntry 同源。 */
export function hitMessageId(sessionId: string, ordinal: number): string {
  return sessionId + ":h:" + String(ordinal);
}

/**
 * 在已加载的消息窗口里定位命中。
 *
 * 只按 ordinal 匹配：实时消息的 ordinal 是 null，永远不该被一条历史命中选中。
 * 找不到返回 -1，调用方据此翻页或提示「还没加载到这一条」。
 */
export function findMessageIndex(messages: readonly ChatMessage[], ordinal: number): number {
  return messages.findIndex(
    (message) => message.ordinal !== null && message.ordinal === ordinal,
  );
}

/** 命中条目的角色标签：与消息列表的标签口径保持一致，避免同一件事两种叫法。 */
export function hitRoleLabel(role: EntryRole | null): string {
  switch (role) {
    case "user":
      return "你";
    case "assistant":
      return "Agent";
    case "tool_result":
      return "工具输出";
    case "system":
      return "系统";
    case "custom":
      return "自定义";
    default:
      return "事件";
  }
}

/**
 * 千分位计数。
 *
 * 不用 toLocaleString：Node 测试进程与 WebView 的默认 locale 不一定相同，
 * 同一份代码在两处会给出不同的分隔符，测试要么假绿要么假红。
 */
export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const rounded = Math.trunc(value);
  const negative = rounded < 0;
  const digits = String(Math.abs(rounded));
  let grouped = "";
  for (let index = 0; index < digits.length; index += 1) {
    const fromEnd = digits.length - index;
    grouped += digits[index];
    if (fromEnd > 1 && fromEnd % 3 === 1) grouped += ",";
  }
  return negative ? "-" + grouped : grouped;
}

/**
 * 结果计数文案（搜索框下方那一行）。
 *
 * truncated 时必须说清「只拿到最早的 N 条」：后端按时间正序分页，
 * 命中超过 limit 时返回的是**最早**的一批，用户看到的并不是「最新命中」。
 * 隐瞒这一点会让人以为搜漏了。
 */
export function resultCountText(state: SearchState, query: string): string {
  const status = searchPanelStatus(state, query);
  if (status === "empty") return "";
  if (status === "searching") return "搜索中…";
  if (status === "error") return "搜索失败";
  const total = formatCount(state.totalHits);
  const shown = state.truncated
    ? "（已返回最早的 " + formatCount(state.hits.length) + " 条）"
    : "";
  return total + " 条匹配" + shown + " · 扫描 " + formatCount(state.scannedEntries) + " 条";
}

/** 一次跳转尝试的结果。 */
export interface JumpResolution {
  /** 定位成功时的消息 id；null 表示没定位到。 */
  messageId: string | null;
  /** 为定位额外加载了几页历史（有界，见 MAX_JUMP_PAGES）。 */
  pagesLoaded: number;
  /** 需要告诉用户的说明；null 表示没有。 */
  notice: string | null;
}

/**
 * 把一条命中解析成「该高亮哪条消息」。
 *
 * 依赖全部由调用方注入（消息窗口、是否还有更多历史、加载更多），因此这段逻辑
 * 可以脱离 Vue 与 Tauri 直接测试——它正是「点击结果定位到对应消息」这条验收点的实现。
 *
 * 三条边界：
 * - 已经加载在窗口里：不加载任何历史，直接返回；
 * - 还没加载：有界翻页（最多 maxPages 页），绝不为了一个旧命中把整份会话读进内存；
 * - 翻页途中用户切了会话：立刻放弃（isActive 为 false），不再写任何状态。
 */
export async function resolveJumpTarget(options: {
  sessionId: string;
  ordinal: number;
  messages: () => readonly ChatMessage[];
  hasMore: () => boolean;
  loadMore: () => Promise<void>;
  isActive?: () => boolean;
  maxPages?: number;
}): Promise<JumpResolution> {
  const maxPages = options.maxPages ?? MAX_JUMP_PAGES;
  let pagesLoaded = 0;
  let index = findMessageIndex(options.messages(), options.ordinal);
  while (index < 0 && pagesLoaded < maxPages && options.hasMore()) {
    await options.loadMore();
    pagesLoaded += 1;
    if (options.isActive && !options.isActive()) {
      return { messageId: null, pagesLoaded, notice: null };
    }
    index = findMessageIndex(options.messages(), options.ordinal);
  }
  if (index >= 0) {
    return { messageId: hitMessageId(options.sessionId, options.ordinal), pagesLoaded, notice: null };
  }
  const prefix = "第 " + String(options.ordinal) + " 条命中";
  return {
    messageId: null,
    pagesLoaded,
    notice: options.hasMore()
      ? prefix + "还没加载进当前窗口；先点「加载更多历史」再点一次。"
      : prefix + "不在可加载的历史里（可能已被压缩，或不在消息窗口中）。",
  };
}

/**
 * 命中被 limit 截断时的补充说明；null 表示没有这一条提示。
 *
 * 已知限制（本切片不改 Rust）：search_session 只支持 afterOrdinal 向前翻页，
 * 没有「取最新一批」的能力，所以命中很多时面板只能显示最早的一批并倒序排列。
 * 彻底解决需要后端支持倒序分页，属后续切片；这里选择如实说明而不是假装完整。
 */
export function truncationNote(state: SearchState): string | null {
  if (!state.truncated) return null;
  return (
    "命中 " +
    formatCount(state.totalHits) +
    " 条，这里只拿到最早的 " +
    formatCount(state.hits.length) +
    " 条；加长关键词可以把范围缩小。"
  );
}

/** 缓存因预算丢弃正文时的说明；null 表示没有这一条提示。 */
export function degradedNote(state: SearchState): string | null {
  if (!state.degraded) return null;
  return "部分旧正文因内存预算被释放，结果可能不完整。";
}

/** 命中片段的切片结果（后端给字符偏移，前端只切片，不重新计算匹配位置）。 */
export function hitSnippet(hit: SessionSearchHit): SnippetParts {
  return splitSnippet(hit.snippet, hit.matchStart, hit.matchEnd);
}
