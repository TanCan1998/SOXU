import test from "node:test";
import assert from "node:assert/strict";

import { WorkspaceSession } from "../src/workspace/sessionWorkspace.ts";
import { FakeBridge } from "./support/fakeBridge.ts";

async function openTwoTabs(): Promise<{ bridge: FakeBridge; session: WorkspaceSession }> {
  const bridge = new FakeBridge();
  const session = new WorkspaceSession(bridge);
  await session.openSession({ sessionId: "ses_a", projectId: "prj_1", title: "会话 A" });
  await session.openSession({ sessionId: "ses_b", projectId: "prj_1", title: "会话 B" });
  await session.startRuntime("ses_a");
  await session.startRuntime("ses_b");
  return { bridge, session };
}

test("两个 Tab 的并发流式事件不会串线", async () => {
  const { bridge, session } = await openTwoTabs();
  assert.equal(session.workspace.tabs.length, 2);

  // 交错到达：A、B、A、B —— 每个 Tab 只累积自己的内容。
  bridge.deliver({ sessionId: "ses_a", runtimeId: "ses_a#1", generation: 1, type: "stream", event: "message_update", data: { delta: "A1" } });
  bridge.deliver({ sessionId: "ses_b", runtimeId: "ses_b#1", generation: 1, type: "stream", event: "message_update", data: { delta: "B1" } });
  bridge.deliver({ sessionId: "ses_a", runtimeId: "ses_a#1", generation: 1, type: "stream", event: "message_update", data: { delta: "A2" } });
  bridge.deliver({ sessionId: "ses_b", runtimeId: "ses_b#1", generation: 1, type: "stream", event: "message_update", data: { delta: "B2" } });

  const tabA = session.tab("ses_a");
  const tabB = session.tab("ses_b");
  assert.equal(tabA?.messages.map((message) => message.text).join(""), "A1A2");
  assert.equal(tabB?.messages.map((message) => message.text).join(""), "B1B2");
  assert.equal(tabA?.status, "ready", "流式追加本身不改变 Tab 状态");
});

test("串到别名的 runtimeId 与过期 generation 都会被丢弃", async () => {
  const { bridge, session } = await openTwoTabs();
  const tabA = session.tab("ses_a");
  const tabB = session.tab("ses_b");

  // 用 B 的 runtimeId 发到 A：身份不符。
  bridge.deliver({ sessionId: "ses_a", runtimeId: "ses_b#1", generation: 1, type: "stream", event: "message_update", data: { delta: "串线" } });
  // generation 0（上一代）迟到事件。
  bridge.deliver({ sessionId: "ses_a", runtimeId: "ses_a#1", generation: 0, type: "stream", event: "message_update", data: { delta: "迟到" } });
  assert.equal(tabA?.messages.length, 0);
  assert.equal(tabB?.messages.length, 0);

  // 未启动运行时的事件同样无效。
  const fresh = new FakeBridge();
  const other = new WorkspaceSession(fresh);
  await other.openSession({ sessionId: "ses_c", projectId: "prj_1", title: "C" });
  fresh.deliver({ sessionId: "ses_c", runtimeId: "ses_c#1", generation: 1, type: "settled" });
  assert.equal(other.tab("ses_c")?.status, "ready");
  assert.equal(other.tab("ses_c")?.runtime.runtimeId, null);
});

test("settled 结束流式标记并把状态切回 ready", async () => {
  const { bridge, session } = await openTwoTabs();
  await session.sendPrompt("ses_a", "帮我看看");
  assert.equal(session.tab("ses_a")?.status, "running");

  bridge.deliver({ sessionId: "ses_a", runtimeId: "ses_a#1", generation: 1, type: "stream", event: "message_update", data: { delta: "好的" } });
  const streaming = session.tab("ses_a")?.messages.at(-1);
  assert.equal(streaming?.streaming, true);

  bridge.deliver({ sessionId: "ses_a", runtimeId: "ses_a#1", generation: 1, type: "settled" });
  const tab = session.tab("ses_a");
  assert.equal(tab?.status, "ready");
  assert.equal(tab?.runtime.state, "idle");
  assert.equal(tab?.messages.at(-1)?.streaming, false);
});

test("运行时异常退出进入错误状态，可重新启动", async () => {
  const { bridge, session } = await openTwoTabs();
  bridge.deliver({ sessionId: "ses_a", runtimeId: "ses_a#1", generation: 1, type: "exit", code: 2, reason: "child_exited" });

  const tab = session.tab("ses_a");
  assert.equal(tab?.status, "error");
  assert.equal(tab?.runtime.runtimeId, null, "退出后不再接受该运行时的事件");
  assert.match(tab?.error ?? "", /child_exited/);

  await session.startRuntime("ses_a");
  assert.equal(tab?.status, "ready");
  assert.equal(tab?.runtime.runtimeId, "ses_a#1");
});

test("请求停止导致的退出不算错误", async () => {
  const { bridge, session } = await openTwoTabs();
  bridge.deliver({ sessionId: "ses_b", runtimeId: "ses_b#1", generation: 1, type: "exit", code: null, reason: "requested_abort" });
  const tab = session.tab("ses_b");
  assert.equal(tab?.status, "idle");
  assert.equal(tab?.error, null);
  assert.equal(tab?.runtime.exitReason, "requested_abort");
});
