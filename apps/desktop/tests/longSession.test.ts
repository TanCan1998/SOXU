/**
 * Issue #36 · 长会话回归（P-04）：50,000 条事件的离线夹具。
 *
 * 四个不变量：
 * 1. 首屏只读一页，不把整份 JSONL 拉进内存；
 * 2. 虚拟列表的渲染行数只取决于视口高度，与消息总数无关；
 * 3. Tab 缓存有硬上限（条数 + 字符），持续「加载更多」不会无限增长；
 * 4. 实时追加（多轮对话）同样受窗口约束，不会绕过上限无限增长。
 *
 * 注意：这是离线夹具结果，不是 Windows/macOS/Linux 实机验收。
 */

import test from "node:test";
import assert from "node:assert/strict";
// vue-virtual 直接 re-export virtual-core，用同一个实例避免再声明一份依赖。
import { Virtualizer } from "@tanstack/vue-virtual";

import { WorkspaceSession } from "../src/workspace/sessionWorkspace.ts";
import { capText, enforceMessageWindow, mergeHistory } from "../src/workspace/mapping.ts";
import {
  MESSAGE_OVERSCAN_ROWS,
  MESSAGE_ROW_ESTIMATE_PX,
  estimatedRenderedRows,
} from "../src/components/messageVirtualizer.ts";
import {
  HISTORY_PAGE_SIZE,
  MAX_MESSAGE_CHARS,
  MAX_TAB_HISTORY_CHARS,
  MAX_TAB_HISTORY_MESSAGES,
  MAX_TAB_LIVE_MESSAGES,
  createWorkspaceState,
  type SessionTab,
} from "../src/workspace/types.ts";
import {
  LONG_SESSION_EVENTS,
  LONG_SESSION_ID,
  LongSessionBridge,
  LongSessionFixture,
} from "./support/longSession.ts";

async function openLongSession(options = {}): Promise<{
  bridge: LongSessionBridge;
  session: WorkspaceSession;
}> {
  const bridge = new LongSessionBridge(options);
  const session = new WorkspaceSession(bridge);
  await session.openSession({
    sessionId: LONG_SESSION_ID,
    projectId: "prj_long",
    title: "5 万事件长会话",
  });
  return { bridge, session };
}

/** 用组件同一份参数构造虚拟列表，只替换滚动容器的观测函数（node 里没有 DOM）。 */
function createVirtualizer(count: number, viewportHeight: number): Virtualizer<never, never> {
  return new Virtualizer<never, never>({
    count,
    getScrollElement: () => null,
    estimateSize: () => MESSAGE_ROW_ESTIMATE_PX,
    overscan: MESSAGE_OVERSCAN_ROWS,
    initialRect: { width: 780, height: viewportHeight },
    initialOffset: 0,
    observeElementRect: () => () => undefined,
    observeElementOffset: () => () => undefined,
  });
}

test("首屏只加载一页：50,000 条事件不会一次性读进内存", async () => {
  const { bridge, session } = await openLongSession();
  const tab = session.tab(LONG_SESSION_ID);

  assert.equal(bridge.fixture.events, LONG_SESSION_EVENTS);
  assert.deepEqual(bridge.pageRequests, [{ offset: 0, limit: HISTORY_PAGE_SIZE }]);
  assert.equal(tab?.history.total, LONG_SESSION_EVENTS);
  assert.equal(tab?.history.next, HISTORY_PAGE_SIZE);
  assert.equal(tab?.messages.length, HISTORY_PAGE_SIZE);
  assert.equal(tab?.history.loaded, HISTORY_PAGE_SIZE);
  assert.equal(tab?.history.evicted, 0);
  assert.equal(tab?.status, "ready");

  // 正文补齐同样有界：一次最多一页，且每条不超过单条上限。
  assert.equal(bridge.count("fetchTexts"), 1);
  const refs = bridge.callsOf("fetchTexts")[0]?.args[1] as Array<{ ordinal: number }>;
  assert.ok(refs.length <= HISTORY_PAGE_SIZE);
  assert.equal(bridge.servedEntries, HISTORY_PAGE_SIZE, "只索引了一页条目");
  assert.ok(
    tab !== undefined && tab.messages.every((message) => message.text.length <= MAX_MESSAGE_CHARS),
  );

  const fixtureChars = new LongSessionFixture().totalTextChars();
  assert.ok(
    bridge.servedTextChars * 100 < fixtureChars,
    `首屏正文 ${bridge.servedTextChars} 字符应远小于整份会话 ${fixtureChars} 字符`,
  );
});

test("虚拟列表：渲染行数只随视口高度变化，与 50,000 条总量无关", () => {
  const tall = createVirtualizer(LONG_SESSION_EVENTS, 1080);
  const short = createVirtualizer(LONG_SESSION_EVENTS, 800);
  const tiny = createVirtualizer(12, 1080);

  const tallRows = tall.getVirtualItems().length;
  const shortRows = short.getVirtualItems().length;
  const tinyRows = tiny.getVirtualItems().length;

  assert.ok(tallRows > 0 && tallRows <= estimatedRenderedRows(1080), `1080px 渲染 ${tallRows} 行`);
  assert.ok(shortRows > 0 && shortRows <= estimatedRenderedRows(800), `800px 渲染 ${shortRows} 行`);
  assert.equal(tinyRows, 12, "消息总数小于视口容量时不会多渲染");
  assert.ok(tallRows <= 26, "1080px 视口下 DOM 行数应保持在个位数量级的 overscan 内");
  assert.equal(tall.getTotalSize(), LONG_SESSION_EVENTS * MESSAGE_ROW_ESTIMATE_PX);
});

test("持续加载更多：历史缓存被窗口截住，且如实记录释放了多少条", async () => {
  const { bridge, session } = await openLongSession();
  const pages = Math.ceil(MAX_TAB_HISTORY_MESSAGES / HISTORY_PAGE_SIZE) + 6;
  for (let index = 0; index < pages; index += 1) {
    await session.loadMore(LONG_SESSION_ID);
  }
  const tab = session.tab(LONG_SESSION_ID);
  assert.ok(tab);
  const historyMessages = tab.messages.filter((message) => message.source === "history");
  const historyChars = historyMessages.reduce((sum, message) => sum + message.text.length, 0);

  assert.ok(
    historyMessages.length <= MAX_TAB_HISTORY_MESSAGES,
    `历史条数 ${historyMessages.length} 应 <= ${MAX_TAB_HISTORY_MESSAGES}`,
  );
  assert.ok(
    historyChars <= MAX_TAB_HISTORY_CHARS,
    `历史字符 ${historyChars} 应 <= ${MAX_TAB_HISTORY_CHARS}`,
  );
  assert.equal(tab.history.loaded, historyMessages.length);
  assert.ok(tab.history.evicted > 0, "超出窗口后必须记录释放条数");

  // 加载过的页数与「仍在内存 + 已释放」对得上：窗口滑动，不是数据丢失。
  const loadedPages = pages + 1;
  assert.equal(
    tab.history.loaded + tab.history.evicted,
    loadedPages * HISTORY_PAGE_SIZE,
    "窗口内 + 已释放 = 累计加载",
  );
  // 保留的是最新的那一窗（最旧的条目已经被释放）。
  const ordinals = historyMessages.map((message) => message.ordinal ?? -1);
  assert.ok(Math.min(...ordinals) > 0, "最旧的条目已被释放");
  assert.ok(Math.max(...ordinals) >= loadedPages * HISTORY_PAGE_SIZE - HISTORY_PAGE_SIZE);
  // 后端读取量随翻页线性增长，但从未读取整份 5 万条。
  assert.ok(bridge.servedEntries < LONG_SESSION_EVENTS);
});

test("字符预算：少量超长工具输出也会触发释放，内存边界与消息长度无关", () => {
  const state = createWorkspaceState();
  const tab: SessionTab = {
    sessionId: "ses_chars",
    projectId: "prj_long",
    worktreeId: null,
    title: "字符预算",
    mode: "persistent",
    status: "ready",
    error: null,
    messages: [],
    history: { loaded: 0, total: 10, next: null, loading: false, evicted: 0, evictedLive: 0 },
    runtime: { runtimeId: null, generation: 0, state: "idle", exitReason: null, retry: null },
    draft: "",
    diagnostics: [],
    promoting: false,
  };
  const fixture = new LongSessionFixture({ events: 10, longOutputEvery: 1 });
  mergeHistory(tab, fixture.page(0, 10));
  for (const message of tab.messages) message.text = fixture.text(message.ordinal ?? 0);

  const report = enforceMessageWindow(tab, {
    maxHistory: 1000,
    maxLive: 10,
    maxChars: 100_000,
  });
  assert.ok(report.historyChars <= 100_000);
  assert.ok(report.droppedHistory > 0);
  assert.equal(tab.history.evicted, report.droppedHistory);
  assert.equal(state.tabs.length, 0, "夹具不写入工作区状态");
});

test("长输出与超长流式增量都被单条上限截断，并标记 truncated", async () => {
  const { bridge, session } = await openLongSession();
  await session.startRuntime(LONG_SESSION_ID);
  await session.sendPrompt(LONG_SESSION_ID, "继续");
  for (let index = 0; index < 40; index += 1) {
    bridge.deliver({
      sessionId: LONG_SESSION_ID,
      runtimeId: `${LONG_SESSION_ID}#1`,
      generation: 1,
      type: "stream",
      event: "message_update",
      data: { delta: "x".repeat(2000) },
    });
  }
  const streaming = session.tab(LONG_SESSION_ID)?.messages.at(-1);
  assert.ok(streaming);
  assert.ok(
    streaming.text.length <= MAX_MESSAGE_CHARS + 1,
    `流式正文 ${streaming.text.length} 应停在单条上限`,
  );
  assert.equal(streaming.truncated, true, "截断必须显式标记，不能静默丢内容");

  const capped = capText("汉".repeat(MAX_MESSAGE_CHARS + 5));
  assert.equal(capped.truncated, true);
  assert.equal(capped.text.length, MAX_MESSAGE_CHARS + 1, "按字符截断，UTF-8/代理对安全");
});

test("实时追加路径同样有界：300 轮对话后实时消息不超过窗口上限", async () => {
  const { bridge, session } = await openLongSession();
  const rounds = 300;

  for (let round = 0; round < rounds; round += 1) {
    await session.sendPrompt(LONG_SESSION_ID, `第 ${round} 轮：继续`);
    const tab = session.tab(LONG_SESSION_ID);
    assert.ok(tab);
    // 用户发问是一次实时追加：返回后立即受窗口约束，不会先涨到 2 条再收敛。
    assert.ok(
      tab.messages.filter((message) => message.source === "live").length <= MAX_TAB_LIVE_MESSAGES,
      `第 ${round} 轮发问后实时消息不应超过 ${MAX_TAB_LIVE_MESSAGES}`,
    );

    bridge.deliver({
      sessionId: LONG_SESSION_ID,
      runtimeId: `${LONG_SESSION_ID}#1`,
      generation: 1,
      type: "stream",
      event: "message_update",
      data: { delta: `第 ${round} 轮回复` },
    });
    // 流式中的最后一条永不被释放，即使它刚好把窗口挤到上限。
    const streaming = session.tab(LONG_SESSION_ID)?.messages.at(-1);
    assert.equal(streaming?.streaming, true, "流式消息必须留在窗口里");
    bridge.deliver({
      sessionId: LONG_SESSION_ID,
      runtimeId: `${LONG_SESSION_ID}#1`,
      generation: 1,
      type: "settled",
      data: {},
    });
    assert.ok(
      (session.tab(LONG_SESSION_ID)?.messages.filter((message) => message.source === "live")
        .length ?? 0) <= MAX_TAB_LIVE_MESSAGES,
    );
  }

  const tab = session.tab(LONG_SESSION_ID);
  assert.ok(tab);
  const live = tab.messages.filter((message) => message.source === "live");
  const total = rounds * 2; // 每轮一条用户消息 + 一条助手回复
  assert.equal(live.length, MAX_TAB_LIVE_MESSAGES, "实时窗口必须停在上限");
  assert.equal(tab.history.evictedLive, total - MAX_TAB_LIVE_MESSAGES, "释放条数必须如实记录");
  assert.equal(tab.history.evicted, 0, "实时释放不计入历史释放");
  assert.equal(
    tab.messages.at(-1)?.text,
    `第 ${rounds - 1} 轮回复`,
    "保留的是最新的一窗，最后一条回复仍在",
  );
  assert.equal(tab.messages.at(-2)?.role, "user", "最新一轮的用户消息仍在窗口里");
  assert.equal(tab.messages.at(-2)?.text, `第 ${rounds - 1} 轮：继续`);
});

test("窗口释放永不丢弃正在流式的最后一条消息", () => {
  const state = createWorkspaceState();
  const tab: SessionTab = {
    sessionId: "ses_live",
    projectId: "prj_long",
    worktreeId: null,
    title: "实时窗口",
    mode: "persistent",
    status: "running",
    error: null,
    messages: [],
    history: { loaded: 0, total: 0, next: null, loading: false, evicted: 0, evictedLive: 0 },
    runtime: { runtimeId: "ses_live#1", generation: 1, state: "running", exitReason: null, retry: null },
    draft: "",
    diagnostics: [],
    promoting: false,
  };
  for (let index = 0; index < 200; index += 1) {
    tab.messages.push({
      id: `live:${index}`,
      ordinal: null,
      role: index % 2 === 0 ? "user" : "assistant",
      text: `第 ${index} 条实时消息`,
      partial: false,
      streaming: index === 199,
      source: "live",
      createdAt: null,
    });
  }
  const report = enforceMessageWindow(tab, { maxHistory: 10, maxLive: 20, maxChars: 1_000_000 });
  assert.ok(report.droppedLive > 0);
  assert.equal(tab.messages.length, 20);
  assert.equal(tab.history.evictedLive, report.droppedLive, "实时释放条数必须落在游标上");
  assert.equal(tab.history.evicted, 0, "实时释放不得计入历史释放");
  assert.equal(tab.messages.at(-1)?.streaming, true, "流式中的最后一条必须保留");
  assert.equal(state.tabs.length, 0);
});
