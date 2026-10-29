/**
 * 50,000 条事件的离线长会话夹具（确定性生成，不含任何真实会话内容）。
 *
 * 目的：在不启动 Pi、不读磁盘的前提下，让「分页 + 窗口 + 虚拟列表」跑在真实组件逻辑上，
 * 用可重复的数字回答 P-04 的三个问题——首屏读了多少、DOM 有多少行、缓存涨到哪为止。
 *
 * 生成规则刻意贴近 Rust 索引的真实行为：
 * - 条目按 ordinal 升序，`offset` 是文件内字节偏移，`length` 是条目字节数；
 * - 预览最多 `PREVIEW_CHARS`（240）字符并以 `…` 结尾，完整正文另行请求；
 * - 每 10 条插入一条 20,000 字符的工具输出，覆盖「长工具输出」这一类；
 * - 全部条目都小于 `INLINE_ENTRY_BYTES`（256 KiB），因此都是可补正文的内联条目。
 */

import type {
  EntryRef,
  EntryText,
  HistoryEntry,
  HistoryPage,
  SessionId,
} from "../../src/workspace/types.ts";
import { FakeBridge } from "./fakeBridge.ts";

export const LONG_SESSION_ID = "ses_long_50k";
/** P-04 要求的规模下限。 */
export const LONG_SESSION_EVENTS = 50_000;
/** 与 `soxu_session_index::PREVIEW_CHARS` 一致。 */
export const PREVIEW_CHARS = 240;
/** 与 `entry_text::MAX_TEXT_CHARS` 一致：单条正文上限。 */
export const LONG_TOOL_OUTPUT_CHARS = 20_000;

export interface LongSessionOptions {
  events?: number;
  /** 每隔多少条插入一条长工具输出；0 表示不插入。 */
  longOutputEvery?: number;
  longOutputChars?: number;
  /** 普通消息的正文长度（字符）。 */
  shortChars?: number;
}

const SHORT_FILLER = "上下文摘要：这一条用于模拟普通对话消息的长度与结构。";
const encoder = new TextEncoder();
const LONG_FILLER = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ\n";

function fill(seed: string, length: number): string {
  let text = seed;
  while (text.length < length) text += LONG_FILLER;
  return text.slice(0, length);
}

export class LongSessionFixture {
  readonly events: number;
  readonly longOutputEvery: number;
  readonly longOutputChars: number;
  readonly shortChars: number;

  constructor(options: LongSessionOptions = {}) {
    this.events = options.events ?? LONG_SESSION_EVENTS;
    this.longOutputEvery = options.longOutputEvery ?? 10;
    this.longOutputChars = options.longOutputChars ?? LONG_TOOL_OUTPUT_CHARS;
    this.shortChars = options.shortChars ?? 120;
  }

  isLong(ordinal: number): boolean {
    return this.longOutputEvery > 0 && ordinal % this.longOutputEvery === this.longOutputEvery - 1;
  }

  role(ordinal: number): HistoryEntry["role"] {
    if (this.isLong(ordinal)) return "tool_result";
    return ordinal % 2 === 0 ? "user" : "assistant";
  }

  /** 一条条目的完整正文（按需生成，不缓存整份会话）。 */
  text(ordinal: number): string {
    if (this.isLong(ordinal)) {
      return fill(`工具输出 #${ordinal}：`, this.longOutputChars);
    }
    return fill(`消息 #${ordinal}：${SHORT_FILLER}`, this.shortChars);
  }

  preview(ordinal: number): string {
    const text = this.text(ordinal);
    if (text.length <= PREVIEW_CHARS) return text;
    return `${text.slice(0, PREVIEW_CHARS)}…`;
  }

  entry(ordinal: number): HistoryEntry {
    const text = this.text(ordinal);
    return {
      ordinal,
      // 字节偏移随 ordinal 单调递增，和真实 JSONL 一样便于定位。
      offset: ordinal * 512,
      length: encoder.encode(text).length,
      kind: "message",
      role: this.role(ordinal),
      preview: this.preview(ordinal),
      timestamp: new Date(Date.UTC(2026, 0, 1) + ordinal * 1000).toISOString(),
      oversized: false,
      corrupt: false,
    };
  }

  page(offset: number, limit: number, sessionId: SessionId = LONG_SESSION_ID): HistoryPage {
    const start = Math.min(offset, this.events);
    const end = Math.min(start + Math.max(0, limit), this.events);
    const entries: HistoryEntry[] = [];
    let bytesRead = 0;
    for (let ordinal = start; ordinal < end; ordinal += 1) {
      const item = this.entry(ordinal);
      bytesRead += item.length;
      entries.push(item);
    }
    return {
      sessionId,
      entries,
      offset,
      total: this.events,
      next: end < this.events ? end : null,
      bytesRead,
      clipped: false,
    };
  }

  texts(refs: EntryRef[], sessionId: SessionId = LONG_SESSION_ID): EntryText[] {
    return refs.map((ref) => ({
      ordinal: ref.ordinal,
      role: this.role(ref.ordinal),
      text: this.text(ref.ordinal),
      clipped: false,
    }));
  }

  /** 整份会话的正文总字符数：用来对照首屏只加载了其中多大比例。 */
  totalTextChars(): number {
    let total = 0;
    for (let ordinal = 0; ordinal < this.events; ordinal += 1) {
      total += this.text(ordinal).length;
    }
    return total;
  }
}

/**
 * 把夹具接到真实 `WorkspaceSession` 上，并记录「实际读了多少」。
 *
 * `servedEntries` / `servedTextChars` 是判断「是否一次加载整个 JSONL」的直接证据：
 * 首屏只应命中一页，而不是 50,000 条。
 */
export class LongSessionBridge extends FakeBridge {
  readonly fixture: LongSessionFixture;
  servedEntries = 0;
  servedTextChars = 0;
  servedBytes = 0;
  readonly pageRequests: Array<{ offset: number; limit: number }> = [];

  constructor(options: LongSessionOptions = {}) {
    super();
    this.fixture = new LongSessionFixture(options);
  }

  async fetchHistory(sessionId: SessionId, offset: number, limit: number): Promise<HistoryPage> {
    this.calls.push({ method: "fetchHistory", args: [sessionId, offset, limit] });
    this.pageRequests.push({ offset, limit });
    const page = this.fixture.page(offset, limit, sessionId);
    this.servedEntries += page.entries.length;
    this.servedBytes += page.bytesRead;
    return page;
  }

  async fetchTexts(sessionId: SessionId, refs: EntryRef[]): Promise<EntryText[]> {
    this.calls.push({ method: "fetchTexts", args: [sessionId, refs] });
    const texts = this.fixture.texts(refs, sessionId);
    for (const item of texts) this.servedTextChars += item.text.length;
    return texts;
  }
}
