/**
 * 回归测试：Tab 状态必须通过 Vue 的响应式代理更新。
 *
 * 直接修改创建 Tab 时的原始对象不会触发代理的 setter，界面就不会重绘；
 * 这个用例专门守住「openSession 之后的状态变更必须可被 watch 观察到」。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { nextTick, reactive, watch } from "vue";

import { WorkspaceSession } from "../src/workspace/sessionWorkspace.ts";
import { createWorkspaceState } from "../src/workspace/types.ts";
import { FakeBridge } from "./support/fakeBridge.ts";

test("Tab 状态变更会触发响应式更新", async () => {
  const state = reactive(createWorkspaceState());
  const bridge = new FakeBridge();
  const session = new WorkspaceSession(bridge, state);
  const seen: string[] = [];
  watch(
    () => state.tabs[0]?.status,
    (value) => {
      if (value) seen.push(value);
    },
  );

  await session.openSession({ sessionId: "ses_a", projectId: "prj_1", title: "A" });
  await nextTick();

  assert.equal(state.tabs[0]?.status, "ready");
  assert.deepEqual(
    seen,
    ["idle", "loading", "ready"],
    "Tab 挂载后的每次状态变化都必须触发，否则界面停留在旧状态",
  );

  await session.startRuntime("ses_a");
  bridge.deliver({ sessionId: "ses_a", runtimeId: "ses_a#1", generation: 1, type: "stream", event: "message_update", data: { delta: "流式" } });
  await nextTick();
  assert.equal(state.tabs[0]?.messages.at(-1)?.text, "流式", "流式追加同样要进入响应式视图");

  bridge.deliver({ sessionId: "ses_a", runtimeId: "ses_a#1", generation: 1, type: "exit", code: 0, reason: "child_exited" });
  await nextTick();
  assert.ok(seen.includes("idle"), "退出后的状态切换同样可观察");
});
