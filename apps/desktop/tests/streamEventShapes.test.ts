/**
 * 回归测试：Pi 1.4.0 的**扁平**会话事件帧不能把用户消息渲染成助手回复。
 *
 * 背景（Issue #146 实机走查）：真实帧是 `{"type":"message_start","message":{...}}`，
 * `message_end` 会同时带 user 与 assistant 的消息，`turn_end` 又重复一次助手正文。
 * 修好「扁平事件解码」之后，如果实时窗口不做角色过滤，用户自己那条消息就会被
 * 再渲染成一条「助手回复」——这类重复在界面上很难被发现，所以用测试钉住。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { nextTick } from "vue";

import { WorkspaceSession } from "../src/workspace/sessionWorkspace.ts";
import { createWorkspaceState, type SessionTab } from "../src/workspace/types.ts";
import { FakeBridge } from "./support/fakeBridge.ts";

async function openTab(): Promise<{ bridge: FakeBridge; tab: () => SessionTab }> {
  const state = createWorkspaceState();
  const bridge = new FakeBridge();
  const session = new WorkspaceSession(bridge, state);
  await session.openSession({ sessionId: "ses_a", projectId: "prj_1", title: "A" });
  await session.startRuntime("ses_a");
  await nextTick();
  return { bridge, tab: () => state.tabs[0] as SessionTab };
}

const frame = (event: string, data: unknown) => ({
  sessionId: "ses_a",
  runtimeId: "ses_a#1",
  generation: 1,
  type: "stream" as const,
  event,
  data,
});

const textOf = (tab: SessionTab) =>
  tab.messages.filter((message) => message.role === "assistant").map((message) => message.text);

test("用户消息的扁平帧不会产生助手回复", async () => {
  const { bridge, tab } = await openTab();
  const userMessage = { role: "user", content: [{ type: "text", text: "请从 1 数到 3" }] };

  bridge.deliver(frame("message_start", { message: userMessage }));
  bridge.deliver(frame("message_end", { message: userMessage }));
  await nextTick();

  assert.deepEqual(textOf(tab()), [], "用户消息不能变成助手回复");
  assert.equal(
    tab().messages.filter((message) => message.role === "user").length,
    0,
    "实时窗口只回显本地发送的用户消息；服务端回放的用户消息不能重复",
  );
});

test("助手 message_end 只渲染一条消息，turn_end 不会重复一次", async () => {
  const { bridge, tab } = await openTab();
  const assistant = {
    role: "assistant",
    content: [
      { type: "text", text: "你好，" },
      { type: "text", text: "我是 Pi。" },
    ],
  };

  bridge.deliver(frame("message_start", { message: { role: "assistant", content: [] } }));
  bridge.deliver(frame("message_end", { message: assistant }));
  await nextTick();
  assert.deepEqual(textOf(tab()), ["你好，我是 Pi。"], "message_end 提供权威正文");

  // turn_end 带同一份助手正文：不能再来一条。
  bridge.deliver(frame("turn_end", { message: assistant, toolResults: [] }));
  await nextTick();
  assert.deepEqual(textOf(tab()), ["你好，我是 Pi。"]);

  // 收尾：本轮安定后这条消息不再处于「流式中」。
  bridge.deliver({ sessionId: "ses_a", runtimeId: "ses_a#1", generation: 1, type: "settled" });
  await nextTick();
  assert.equal(tab().messages.at(-1)?.streaming, false, "settled 之后不再显示流式状态");
});

test("message_update 的增量仍然追加在同一个助手消息里", async () => {
  const { bridge, tab } = await openTab();

  bridge.deliver(frame("message_update", { delta: "第一段" }));
  bridge.deliver(frame("message_update", { delta: "，第二段" }));
  await nextTick();

  assert.deepEqual(textOf(tab()), ["第一段，第二段"], "增量必须合并到同一条实时消息");
});
