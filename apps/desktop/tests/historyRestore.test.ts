import test from "node:test";
import assert from "node:assert/strict";

import { WorkspaceSession } from "../src/workspace/sessionWorkspace.ts";
import { mergeHistory } from "../src/workspace/mapping.ts";
import type { HistoryEntry, HistoryPage } from "../src/workspace/types.ts";
import { FakeBridge, emptyPage } from "./support/fakeBridge.ts";

function entry(ordinal: number, role: HistoryEntry["role"], preview: string): HistoryEntry {
  return {
    ordinal,
    offset: ordinal * 100,
    length: 90,
    kind: "message",
    role,
    preview,
    timestamp: `2026-01-01T00:00:0${ordinal}Z`,
    oversized: false,
    corrupt: false,
  };
}

function page(sessionId: string, offset: number, entries: HistoryEntry[], next: number | null): HistoryPage {
  return {
    sessionId,
    entries,
    offset,
    total: 4,
    next,
    bytesRead: 4096,
    clipped: false,
  };
}

function sessionWithPages(): { bridge: FakeBridge; session: WorkspaceSession } {
  const bridge = new FakeBridge();
  bridge.queuePage(page("ses_a", 0, [entry(0, "user", "第一条…"), entry(1, "assistant", "回复…")], 2));
  bridge.queuePage(page("ses_a", 2, [entry(2, "user", "第二条…"), entry(3, "assistant", "再回复…")], null));
  bridge.texts.set(0, { ordinal: 0, role: "user", text: "第一条完整内容", clipped: false });
  bridge.texts.set(1, { ordinal: 1, role: "assistant", text: "回复完整内容", clipped: false });
  return { bridge, session: new WorkspaceSession(bridge) };
}

test("历史分页按 ordinal 追加、补齐完整正文，且到底后不再请求", async () => {
  const { bridge, session } = sessionWithPages();
  await session.openSession({ sessionId: "ses_a", projectId: "prj_1", title: "会话 A" });

  const tab = session.tab("ses_a");
  assert.equal(tab?.status, "ready");
  assert.deepEqual(
    tab?.messages.map((message) => message.ordinal),
    [0, 1],
    "历史消息按 ordinal 排序",
  );
  assert.equal(tab?.messages[0]?.text, "第一条完整内容", "预览被完整正文替换");
  assert.equal(tab?.messages[0]?.partial, false);
  assert.equal(bridge.count("fetchTexts"), 1);
  assert.deepEqual(bridge.callsOf("fetchTexts")[0]?.args[1], [
    { ordinal: 0, offset: 0, length: 90 },
    { ordinal: 1, offset: 100, length: 90 },
  ]);

  await session.loadMore("ses_a");
  assert.deepEqual(
    session.tab("ses_a")?.messages.map((message) => message.text),
    ["第一条完整内容", "回复完整内容", "第二条…", "再回复…"],
  );
  assert.equal(session.tab("ses_a")?.history.next, null);

  const before = bridge.count("fetchHistory");
  await session.loadMore("ses_a");
  assert.equal(bridge.count("fetchHistory"), before, "到达末尾后不再请求");
});

test("重复页不会产生重复消息，重叠页只补缺", () => {
  const tab = {
    sessionId: "ses_a",
    projectId: "prj_1",
    title: "A",
    mode: "persistent" as const,
    status: "ready" as const,
    error: null,
    messages: [],
    history: { loaded: 0, total: 0, next: null, loading: false, evicted: 0, evictedLive: 0 },
    runtime: { runtimeId: null, generation: 0, state: "idle", exitReason: null },
    draft: "",
    diagnostics: [],
  };
  mergeHistory(tab, page("ses_a", 0, [entry(0, "user", "一"), entry(1, "assistant", "二")], 2));
  mergeHistory(tab, page("ses_a", 0, [entry(0, "user", "一"), entry(1, "assistant", "二")], 2));
  assert.equal(tab.messages.length, 2);

  mergeHistory(tab, page("ses_a", 1, [entry(1, "assistant", "二"), entry(2, "user", "三")], null));
  assert.deepEqual(
    tab.messages.map((message) => message.ordinal),
    [0, 1, 2],
    "重叠页不重复插入",
  );
});

test("关闭 Tab 后重新打开会从会话历史恢复，而不是复用旧内存", async () => {
  const { bridge, session } = sessionWithPages();
  await session.openSession({ sessionId: "ses_a", projectId: "prj_1", title: "会话 A" });
  const firstLoad = bridge.count("fetchHistory");

  await session.closeTab("ses_a");
  assert.equal(session.tab("ses_a"), undefined);
  assert.equal(bridge.count("releaseSession"), 1, "关闭 Tab 释放该会话订阅");

  await session.openSession({ sessionId: "ses_a", projectId: "prj_1", title: "会话 A" });
  assert.ok(bridge.count("fetchHistory") > firstLoad, "重新打开重新读取历史");
  assert.deepEqual(
    session.tab("ses_a")?.messages.map((message) => message.text),
    ["第一条完整内容", "回复完整内容"],
  );
  assert.equal(bridge.listeners.size, 1, "整个工作区只有一个监听器");
});

test("本地乐观回显与 JSONL 历史重复时被合并", async () => {
  const { bridge, session } = sessionWithPages();
  await session.openSession({ sessionId: "ses_a", projectId: "prj_1", title: "会话 A" });
  await session.startRuntime("ses_a");
  await session.sendPrompt("ses_a", "第二条完整内容");

  const live = session.tab("ses_a")?.messages.at(-1);
  assert.equal(live?.source, "live");
  assert.equal(session.tab("ses_a")?.messages.length, 3);

  // Pi 把这条消息写进 JSONL 后，下一页历史包含它。
  bridge.queuePage(page("ses_a", 2, [entry(2, "user", "第二条完整内容"), entry(3, "assistant", "再回复…")], null));
  await session.loadMore("ses_a");

  const messages = session.tab("ses_a")?.messages ?? [];
  assert.equal(messages.length, 4);
  assert.equal(messages.filter((message) => message.text === "第二条完整内容").length, 1);
  assert.ok(messages.every((message) => message.source === "history" || message.role === "assistant"));
});

test("历史读取失败时显示错误，重试成功后恢复", async () => {
  const bridge = new FakeBridge();
  bridge.fetchHistory = async () => {
    throw new Error("E_SESSION_FILE_MISSING");
  };
  const session = new WorkspaceSession(bridge);
  await session.openSession({ sessionId: "ses_a", projectId: "prj_1", title: "会话 A" });

  const tab = session.tab("ses_a");
  assert.equal(tab?.status, "error");
  assert.match(tab?.error ?? "", /E_SESSION_FILE_MISSING/);
  assert.deepEqual(emptyPage("ses_a").entries, tab?.messages);

  // 恢复：文件回来后重新打开同一会话会重新读取。
  bridge.fetchHistory = async (sessionId, offset) => page(sessionId, offset, [entry(0, "user", "恢复")], null);
  await session.closeTab("ses_a");
  await session.openSession({ sessionId: "ses_a", projectId: "prj_1", title: "会话 A" });
  assert.equal(session.tab("ses_a")?.status, "ready");
  assert.equal(session.tab("ses_a")?.messages.length, 1);
});
