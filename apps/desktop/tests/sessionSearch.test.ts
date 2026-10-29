/**
 * Issue #109 · 会话内搜索的前端契约。
 *
 * 五个不变量：
 * 1. 搜索请求打的是整份会话（一次 IPC 调用，不带分页 offset 的语义混淆）；
 * 2. 输入防抖：200 ms 内的连续输入只发 1 次请求，只保留最后一次查询；
 * 3. 迟到响应不覆盖新结果（请求序号守卫）；
 * 4. 空查询 / 超长查询不发请求，行为明确；
 * 5. dispose 清理定时器，不在销毁后写状态。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { WorkspaceSession } from "../src/workspace/sessionWorkspace.ts";
import { charLength, splitSnippet } from "../src/workspace/search.ts";
import {
  SEARCH_DEBOUNCE_MS,
  SEARCH_HIT_LIMIT,
  SEARCH_QUERY_MAX_CHARS,
} from "../src/workspace/types.ts";
import { FakeBridge, emptySearchResult } from "./support/fakeBridge.ts";

const SESSION = "ses_search";

async function openSession(bridge = new FakeBridge()): Promise<{
  bridge: FakeBridge;
  session: WorkspaceSession;
}> {
  const session = new WorkspaceSession(bridge);
  await session.openSession({ sessionId: SESSION, projectId: "prj_1", title: "搜索会话" });
  return { bridge, session };
}

function hit(ordinal: number, snippet: string, matchStart: number, matchEnd: number) {
  return {
    ordinal,
    kind: "message" as const,
    role: "user" as const,
    snippet,
    matchStart,
    matchEnd,
    totalMatches: 1,
    truncated: false,
  };
}

test("搜索调用一次 IPC 并写入 Tab 状态", async () => {
  const { bridge, session } = await openSession();
  bridge.searchResults.set(
    "扩散",
    emptySearchResult(SESSION, {
      hits: [hit(7, "第 7 条讨论扩散模型的采样步数", 6, 8)],
      totalHits: 206,
      scannedEntries: 1_236,
      truncated: true,
      tookMs: 4,
    }),
  );

  const result = await session.search(SESSION, "扩散");
  assert.ok(result);
  const calls = bridge.callsOf("searchSession");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.args, [
    SESSION,
    "扩散",
    { limit: SEARCH_HIT_LIMIT, afterOrdinal: null },
  ]);

  const tab = session.tab(SESSION);
  assert.equal(tab?.search.query, "扩散");
  assert.equal(tab?.search.loading, false);
  assert.equal(tab?.search.totalHits, 206, "命中总数来自后端，不是本地已加载条数");
  assert.equal(tab?.search.scannedEntries, 1_236);
  assert.equal(tab?.search.truncated, true);
  assert.equal(tab?.search.hits.length, 1);
});

test("输入防抖：快速输入只发 1 次请求，只保留最后一次查询", async () => {
  const { bridge, session } = await openSession();
  bridge.searchResults.set("扩散模型", emptySearchResult(SESSION, { totalHits: 3 }));

  session.scheduleSearch(SESSION, "扩");
  session.scheduleSearch(SESSION, "扩散");
  session.scheduleSearch(SESSION, "扩散模型");
  assert.equal(bridge.count("searchSession"), 0, "防抖窗口内不应发请求");

  await new Promise((resolve) => setTimeout(resolve, SEARCH_DEBOUNCE_MS + 80));
  const calls = bridge.callsOf("searchSession");
  assert.equal(calls.length, 1, "连续输入只能产生 1 次请求");
  assert.equal(calls[0]?.args[1], "扩散模型");
  assert.equal(session.tab(SESSION)?.search.totalHits, 3);
});

test("dispose 清理待触发的防抖，不在销毁后再发请求", async () => {
  const { bridge, session } = await openSession();
  session.scheduleSearch(SESSION, "扩散");
  await session.dispose();
  await new Promise((resolve) => setTimeout(resolve, SEARCH_DEBOUNCE_MS + 80));
  assert.equal(bridge.count("searchSession"), 0);
});

test("关闭 Tab 取消待触发的搜索", async () => {
  const { bridge, session } = await openSession();
  session.scheduleSearch(SESSION, "扩散");
  await session.closeTab(SESSION);
  await new Promise((resolve) => setTimeout(resolve, SEARCH_DEBOUNCE_MS + 80));
  assert.equal(bridge.count("searchSession"), 0);
});

test("迟到响应不覆盖新结果", async () => {
  const { bridge, session } = await openSession();
  bridge.searchResults.set("旧查询", emptySearchResult(SESSION, { totalHits: 1 }));
  bridge.searchResults.set("新查询", emptySearchResult(SESSION, { totalHits: 2 }));

  // 第一请求被 gate 卡住，第二请求先返回。
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  bridge.searchGate = gate;
  const stale = session.search(SESSION, "旧查询");
  bridge.searchGate = null;
  await session.search(SESSION, "新查询");
  release();
  assert.equal(await stale, null, "迟到响应必须被丢弃");

  const tab = session.tab(SESSION);
  assert.equal(tab?.search.query, "新查询");
  assert.equal(tab?.search.totalHits, 2);
});

test("空查询不发请求并清空结果", async () => {
  const { bridge, session } = await openSession();
  bridge.searchResults.set("扩散", emptySearchResult(SESSION, { totalHits: 5 }));
  await session.search(SESSION, "扩散");
  assert.equal(session.tab(SESSION)?.search.totalHits, 5);

  const cleared = await session.search(SESSION, "   ");
  assert.equal(cleared, null);
  assert.equal(bridge.count("searchSession"), 1, "空查询不应产生第二次请求");
  assert.equal(session.tab(SESSION)?.search.hits.length, 0);
  assert.equal(session.tab(SESSION)?.search.totalHits, 0);
  assert.equal(session.tab(SESSION)?.search.error, null);
});

test("超长查询（> " + SEARCH_QUERY_MAX_CHARS + " 字符）在本地拦下并给出原因", async () => {
  const { bridge, session } = await openSession();
  const tooLong = "长".repeat(SEARCH_QUERY_MAX_CHARS + 1);
  const result = await session.search(SESSION, tooLong);
  assert.equal(result, null);
  assert.equal(bridge.count("searchSession"), 0, "注定失败的请求不该发出去");
  const error = session.tab(SESSION)?.search.error ?? "";
  assert.ok(error.includes(String(SEARCH_QUERY_MAX_CHARS)), error);

  // 恰好等于上限的查询必须放行。
  await session.search(SESSION, "长".repeat(SEARCH_QUERY_MAX_CHARS));
  assert.equal(bridge.count("searchSession"), 1);
});

test("后端失败时显示原因并清空命中", async () => {
  const { bridge, session } = await openSession();
  bridge.searchError = "E_SESSION_FILE_MISSING: 会话文件不存在";
  await session.search(SESSION, "扩散");
  const tab = session.tab(SESSION);
  assert.equal(tab?.search.loading, false);
  assert.ok((tab?.search.error ?? "").includes("E_SESSION_FILE_MISSING"));
  assert.equal(tab?.search.hits.length, 0);
});

test("预算淘汰（degraded）写进诊断，不静默少结果", async () => {
  const { bridge, session } = await openSession();
  bridge.searchResults.set(
    "扩散",
    emptySearchResult(SESSION, { degraded: true, totalHits: 1 }),
  );
  await session.search(SESSION, "扩散");
  const tab = session.tab(SESSION);
  assert.equal(tab?.search.degraded, true);
  assert.ok(
    tab?.diagnostics.some((line) => line.includes("预算")),
    "degraded 必须留痕",
  );
});

test("片段高亮按后端给的字符偏移切片", () => {
  assert.deepEqual(splitSnippet("讨论扩散模型", 2, 4), {
    before: "讨论",
    match: "扩散",
    after: "模型",
  });

  // emoji 是代理对：按码点切片才不会把它劈成两半。
  const parts = splitSnippet("🙂扩散🙂", 1, 3);
  assert.equal(parts.before, "🙂");
  assert.equal(parts.match, "扩散");
  assert.equal(parts.after, "🙂");
  assert.equal(charLength("🙂扩散"), 3);
});

test("越界偏移夹到边界而不是抛错", () => {
  const negative = splitSnippet("扩散", -5, 1);
  assert.deepEqual(negative, { before: "", match: "扩", after: "散" });
  const overflow = splitSnippet("扩散", 5, 9);
  assert.deepEqual(overflow, { before: "扩散", match: "", after: "" });
  const inverted = splitSnippet("扩散", 2, 1);
  assert.deepEqual(inverted, { before: "扩散", match: "", after: "" });
});
