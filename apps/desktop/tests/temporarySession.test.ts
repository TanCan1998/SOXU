import test from "node:test";
import assert from "node:assert/strict";

import { WorkspaceSession } from "../src/workspace/sessionWorkspace.ts";
import type { HistoryEntry, HistoryPage, ProjectSummary } from "../src/workspace/types.ts";
import { FakeBridge } from "./support/fakeBridge.ts";

function project(): ProjectSummary {
  return { id: "prj_1", name: "项目", root: "F:/work/project", worktreeCount: 1, sessions: [] };
}

function entry(ordinal: number, role: HistoryEntry["role"], preview: string): HistoryEntry {
  return {
    ordinal,
    offset: ordinal * 100,
    length: 90,
    kind: "message",
    role,
    preview,
    timestamp: "2026-01-01T00:00:00Z",
    oversized: false,
    corrupt: false,
  };
}

function page(sessionId: string, entries: HistoryEntry[]): HistoryPage {
  return { sessionId, entries, offset: 0, total: entries.length, next: null, bytesRead: 512, clipped: false };
}

function ready(): { bridge: FakeBridge; session: WorkspaceSession } {
  const bridge = new FakeBridge();
  bridge.projects = [project()];
  return { bridge, session: new WorkspaceSession(bridge) };
}

test("临时会话不请求历史分页，也不进入侧栏历史", async () => {
  const { bridge, session } = ready();
  await session.openTemporary("prj_1");

  const temporaryId = session.workspace.activeSessionId;
  assert.match(String(temporaryId), /^ses_tmp_/, "身份由后端分配");
  assert.equal(bridge.count("openTemporarySession"), 1);
  const tab = session.tab(String(temporaryId));
  assert.equal(tab?.mode, "temporary");
  assert.equal(tab?.status, "ready", "临时会话不应因为「会话未登记」进入错误态");
  assert.equal(bridge.count("fetchHistory"), 0, "临时会话没有持久化历史可加载");
  assert.equal(tab?.messages.length, 0);
});

test("转正成功：切到持久化身份、刷新侧栏、加载真实历史", async () => {
  const { bridge, session } = ready();
  await session.loadProjects();
  await session.openTemporary("prj_1");
  const temporaryId = String(session.workspace.activeSessionId);
  bridge.queuePage(page("ses_promoted_1", [entry(0, "user", "临时会话里的第一句话")]));

  await session.promoteSession(temporaryId);

  const promotedId = "ses_promoted_1";
  assert.equal(bridge.count("promoteSession"), 1);
  assert.equal(session.tab(temporaryId), undefined, "旧临时身份不再有 Tab");
  const tab = session.tab(promotedId);
  assert.equal(tab?.mode, "persistent");
  assert.equal(tab?.promoting, false);
  assert.equal(tab?.error, null);
  assert.equal(session.workspace.activeSessionId, promotedId, "选中项跟随新身份");
  assert.equal(
    session.workspace.projects[0]?.sessions.some((item) => item.id === promotedId),
    true,
    "侧栏必须包含转正后的会话（后端返回的项目摘要）",
  );
  assert.equal(bridge.count("fetchHistory"), 1, "转正后按普通会话加载历史");
  assert.equal(tab?.messages[0]?.text, "临时会话里的第一句话");
  assert.deepEqual(bridge.callsOf("releaseSession")[0]?.args[0], temporaryId, "释放旧订阅");
  assert.deepEqual(bridge.callsOf("retainSession").at(-1)?.args[0], promotedId, "订阅新身份");
});

test("转正失败：保留临时会话与内容，显示原因，不伪造成功", async () => {
  const { bridge, session } = ready();
  await session.loadProjects();
  await session.openTemporary("prj_1");
  const temporaryId = String(session.workspace.activeSessionId);
  const tab = session.tab(temporaryId);
  assert.ok(tab);
  tab.messages.push({
    id: "live:1:1",
    ordinal: null,
    role: "user",
    text: "还没保存的内容",
    partial: false,
    streaming: false,
    source: "live",
    createdAt: null,
  });
  bridge.promoteError = "E_TEMPORARY_SESSION_UNPROMOTABLE: 临时会话还没有绑定 Pi 会话文件";

  await session.promoteSession(temporaryId);

  assert.equal(tab.mode, "temporary", "失败必须保持临时会话");
  assert.equal(tab.promoting, false, "失败也要解除进行中状态");
  assert.equal(tab.sessionId, temporaryId, "身份不变");
  assert.equal(tab.messages[0]?.text, "还没保存的内容", "内容保留");
  assert.match(String(tab.error), /转存失败.*E_TEMPORARY_SESSION_UNPROMOTABLE/);
  assert.equal(session.workspace.projects[0]?.sessions.length, 0, "失败不得写入侧栏历史");
  assert.equal(bridge.count("fetchHistory"), 0);
});

test("运行中的临时会话不允许转存", async () => {
  const { bridge, session } = ready();
  await session.openTemporary("prj_1");
  const temporaryId = String(session.workspace.activeSessionId);
  const tab = session.tab(temporaryId);
  assert.ok(tab);
  await session.sendPrompt(temporaryId, "你好");
  assert.equal(tab.status, "running");

  await session.promoteSession(temporaryId);

  assert.equal(bridge.count("promoteSession"), 0, "运行中不发转存请求");
  assert.equal(tab.mode, "temporary");
});

test("关闭临时会话 Tab 会结束它（幂等，不影响 Pi 文件）", async () => {
  const { bridge, session } = ready();
  await session.openTemporary("prj_1");
  const temporaryId = String(session.workspace.activeSessionId);

  await session.closeTab(temporaryId);

  assert.equal(session.tab(temporaryId), undefined);
  assert.deepEqual(bridge.discarded, [temporaryId]);
  assert.equal(bridge.count("releaseSession"), 1, "订阅同样要释放");
});

test("结束临时会话失败不影响关闭 Tab", async () => {
  const { bridge, session } = ready();
  await session.openTemporary("prj_1");
  const temporaryId = String(session.workspace.activeSessionId);
  bridge.discardError = "后端不可用";

  await session.closeTab(temporaryId);

  assert.equal(session.tab(temporaryId), undefined);
  assert.equal(bridge.count("releaseSession"), 1);
});

test("卸载时释放订阅并清掉临时会话登记", async () => {
  const { bridge, session } = ready();
  await session.openTemporary("prj_1");
  const temporaryId = String(session.workspace.activeSessionId);

  await session.dispose();

  assert.equal(bridge.unlistenCount, 1, "监听器必须摘掉");
  assert.deepEqual(bridge.discarded, [temporaryId]);
  assert.equal(bridge.count("releaseSession"), 1);
});

test("后端不可用时临时会话仍可打开，但不假装已持久化", async () => {
  const bridge = new FakeBridge();
  bridge.temporaryError = "未连接 Rust 运行时";
  const session = new WorkspaceSession(bridge);

  await session.openTemporary("prj_1");

  const temporaryId = String(session.workspace.activeSessionId);
  assert.match(temporaryId, /^ses_tmp_/);
  assert.equal(session.tab(temporaryId)?.mode, "temporary");
  assert.match(String(session.workspace.projectsError), /临时会话分配失败/);
});

test("idle 但 runtimeId 仍在的临时会话不允许转存（只按 status 拦截是不够的）", async () => {
  const { bridge, session } = ready();
  await session.loadProjects();
  await session.openTemporary("prj_1");
  const temporaryId = String(session.workspace.activeSessionId);
  const tab = session.tab(temporaryId);
  assert.ok(tab);
  // 启动运行时但不发送消息：status 回到 ready，runtimeId 仍然非空。
  await session.startRuntime(temporaryId);
  assert.equal(tab.status, "ready");
  assert.ok(tab.runtime.runtimeId, "运行时身份仍然存在");

  await session.promoteSession(temporaryId);

  assert.equal(bridge.count("promoteSession"), 0, "有活运行时不发转存请求");
  assert.equal(tab.mode, "temporary", "失败必须保持临时会话");
  assert.equal(tab.sessionId, temporaryId);
  assert.match(String(tab.error), /先停止 Pi 运行时/);
});

test("停止运行时后可以转存，并清掉旧的 runtimeId", async () => {
  const { bridge, session } = ready();
  await session.loadProjects();
  await session.openTemporary("prj_1");
  const temporaryId = String(session.workspace.activeSessionId);
  const tab = session.tab(temporaryId);
  assert.ok(tab);
  await session.startRuntime(temporaryId);
  await session.stopRuntime(temporaryId);
  assert.equal(tab.runtime.runtimeId, null);
  bridge.queuePage(page("ses_promoted_1", []));

  await session.promoteSession(temporaryId);

  assert.equal(bridge.count("promoteSession"), 1);
  assert.equal(tab.mode, "persistent");
  assert.equal(tab.runtime.runtimeId, null, "转正后不得残留已无 owner 的运行时身份");
});

test("关闭临时会话 Tab 先停止运行时再清登记", async () => {
  const { bridge, session } = ready();
  await session.openTemporary("prj_1");
  const temporaryId = String(session.workspace.activeSessionId);
  await session.startRuntime(temporaryId);

  await session.closeTab(temporaryId);

  assert.equal(session.tab(temporaryId), undefined);
  assert.deepEqual(bridge.callsOf("stopRuntime")[0]?.args[0], temporaryId, "先停运行时");
  assert.deepEqual(bridge.discarded, [temporaryId], "再清内存登记");
  const stopIndex = bridge.calls.findIndex((call) => call.method === "stopRuntime");
  const discardIndex = bridge.calls.findIndex((call) => call.method === "discardTemporarySession");
  assert.ok(stopIndex >= 0 && discardIndex > stopIndex, "停止必须在清登记之前完成");
});

test("卸载时先停临时会话的运行时再清登记", async () => {
  const { bridge, session } = ready();
  await session.openTemporary("prj_1");
  const temporaryId = String(session.workspace.activeSessionId);
  await session.startRuntime(temporaryId);

  await session.dispose();

  const stopIndex = bridge.calls.findIndex((call) => call.method === "stopRuntime");
  const discardIndex = bridge.calls.findIndex((call) => call.method === "discardTemporarySession");
  assert.ok(stopIndex >= 0, "卸载时必须停掉临时会话的运行时");
  assert.ok(discardIndex > stopIndex, "停止必须在清登记之前完成");
  assert.deepEqual(bridge.discarded, [temporaryId]);
  assert.equal(bridge.unlistenCount, 1);
});
