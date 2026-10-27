import test from "node:test";
import assert from "node:assert/strict";

import { WorkspaceSession } from "../src/workspace/sessionWorkspace.ts";
import { FakeBridge, deferred } from "./support/fakeBridge.ts";

async function runningSession(): Promise<{ bridge: FakeBridge; session: WorkspaceSession }> {
  const bridge = new FakeBridge();
  const session = new WorkspaceSession(bridge);
  await session.openSession({ sessionId: "ses_a", projectId: "prj_1", title: "会话 A" });
  await session.startRuntime("ses_a");
  await session.sendPrompt("ses_a", "开始吧");
  return { bridge, session };
}

test("取消是幂等的：重复点击只发送一次 abort", async () => {
  const { bridge, session } = await runningSession();
  assert.equal(session.tab("ses_a")?.status, "running");

  await session.cancel("ses_a");
  await session.cancel("ses_a");
  const cancelling = session.tab("ses_a");
  assert.equal(cancelling?.status, "cancelling");
  assert.equal(bridge.count("cancelRuntime"), 1);

  // 非 running 状态（已取消/空闲）不会再次发送命令。
  await session.cancel("ses_a");
  assert.equal(bridge.count("cancelRuntime"), 1);

  bridge.deliver({ sessionId: "ses_a", runtimeId: "ses_a#1", generation: 1, type: "settled" });
  assert.equal(session.tab("ses_a")?.status, "ready");
});

test("取消失败时回到 running 并显示原因", async () => {
  const { bridge, session } = await runningSession();
  bridge.cancelError = "cancel_timeout";
  await session.cancel("ses_a");

  const tab = session.tab("ses_a");
  assert.equal(tab?.status, "running");
  assert.match(tab?.error ?? "", /cancel_timeout/);
  assert.equal(bridge.count("cancelRuntime"), 1);
});

test("dispose 摘掉监听器并释放每个会话订阅，之后不再投递事件", async () => {
  const bridge = new FakeBridge();
  const session = new WorkspaceSession(bridge);
  await session.openSession({ sessionId: "ses_a", projectId: "prj_1", title: "A" });
  await session.openSession({ sessionId: "ses_b", projectId: "prj_1", title: "B" });
  await session.startRuntime("ses_a");

  assert.equal(session.subscriptionCount, 1);
  assert.equal(bridge.listeners.size, 1);
  assert.deepEqual(
    bridge.callsOf("retainSession").map((call) => call.args[0]),
    ["ses_a", "ses_b"],
  );

  await session.dispose();

  assert.equal(bridge.unlistenCount, 1, "监听器必须被真正注销");
  assert.equal(bridge.listeners.size, 0);
  assert.equal(session.subscriptionCount, 0);
  assert.equal(session.workspace.tabs.length, 0);
  assert.deepEqual(
    bridge.callsOf("releaseSession").map((call) => call.args[0]),
    ["ses_a", "ses_b"],
  );

  // 卸载之后即便还有事件冒出来，也不得写状态或抛错。
  bridge.deliver({ sessionId: "ses_a", runtimeId: "ses_a#1", generation: 1, type: "settled" });
  assert.equal(session.workspace.tabs.length, 0);
  session.handleEvent({ sessionId: "ses_a", runtimeId: "ses_a#1", generation: 1, type: "settled" });
  assert.equal(session.isDisposed, true);
});

test("dispose 之后迟到的历史响应不再写状态", async () => {
  const bridge = new FakeBridge();
  bridge.queuePage({
    sessionId: "ses_a",
    entries: [{ ordinal: 0, offset: 0, length: 10, kind: "message", role: "user", preview: "在途", timestamp: null, oversized: false, corrupt: false }],
    offset: 0,
    total: 1,
    next: null,
    bytesRead: 10,
    clipped: false,
  });
  const gate = deferred();
  bridge.historyGate = gate.promise;
  const session = new WorkspaceSession(bridge);

  const opening = session.openSession({ sessionId: "ses_a", projectId: "prj_1", title: "A" });
  await Promise.resolve();
  const tabWhileLoading = session.tab("ses_a");
  await session.dispose();
  gate.resolve();
  await opening;

  assert.equal(tabWhileLoading?.messages.length, 0, "卸载后不得把在途结果写进 Tab");
  assert.equal(session.workspace.tabs.length, 0);
});

test("关闭 Tab 只释放订阅，不停止仍在运行的 Agent", async () => {
  const { bridge, session } = await runningSession();
  await session.closeTab("ses_a");

  assert.equal(bridge.count("stopRuntime"), 0, "Pane 销毁不等于停止任务");
  assert.equal(bridge.count("releaseSession"), 1);
  assert.equal(session.workspace.activeSessionId, null);

  // 重新打开：订阅重新挂载，运行时状态可从后端对齐。
  await session.openSession({ sessionId: "ses_a", projectId: "prj_1", title: "会话 A" });
  assert.equal(bridge.count("retainSession"), 2);
  await session.stopRuntime("ses_a");
  assert.equal(bridge.count("stopRuntime"), 1);
});
