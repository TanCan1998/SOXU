import test from "node:test";
import assert from "node:assert/strict";

import { WorkspaceSession } from "../src/workspace/sessionWorkspace.ts";
import type { RetryStatus } from "../src/workspace/types.ts";
import { FakeBridge } from "./support/fakeBridge.ts";

function snapshot(overrides: Partial<RetryStatus> = {}): RetryStatus {
  return {
    attempts: 1,
    maxAttempts: 2,
    remaining: 1,
    exhausted: false,
    lastFailure: "timeout",
    nextDelayMs: 500,
    costNotice: "重试会重新发起模型请求，可能产生新的模型费用。",
    ...overrides,
  };
}

async function started(ledger: RetryStatus | null): Promise<{
  bridge: FakeBridge;
  session: WorkspaceSession;
}> {
  const bridge = new FakeBridge();
  bridge.retry = ledger;
  const session = new WorkspaceSession(bridge);
  await session.openSession({ sessionId: "ses_a", projectId: "prj_1", title: "会话 A" });
  await session.startRuntime("ses_a");
  return { bridge, session };
}

test("启动后 Tab 记录后端下发的重试次数与费用提示", async () => {
  const { session } = await started(snapshot());
  const retry = session.tab("ses_a")?.runtime.retry;
  assert.equal(retry?.attempts, 1);
  assert.equal(retry?.maxAttempts, 2);
  assert.equal(retry?.lastFailure, "timeout");
  assert.match(retry?.costNotice ?? "", /费用/);
});

test("预算耗尽时 Tab 反映「已耗尽」，不会伪装成可重试", async () => {
  const { session } = await started(
    snapshot({ attempts: 2, remaining: 0, exhausted: true, nextDelayMs: null }),
  );
  const retry = session.tab("ses_a")?.runtime.retry;
  assert.equal(retry?.exhausted, true);
  assert.equal(retry?.remaining, 0);
  assert.equal(retry?.nextDelayMs, null);
});

test("停止运行时保留重试次数，便于事后查看用掉了几次", async () => {
  const { session } = await started(snapshot());
  await session.stopRuntime("ses_a");
  const tab = session.tab("ses_a");
  assert.equal(tab?.runtime.runtimeId, null);
  assert.equal(tab?.runtime.retry?.attempts, 1, "停止不得把历史重试次数清零");
});

test("后端不返回重试快照时显示为未发生重试，不伪造 0 次", async () => {
  const { session } = await started(null);
  assert.equal(session.tab("ses_a")?.runtime.retry, null);
});

test("运行时退出事件保留重试次数", async () => {
  const { bridge, session } = await started(snapshot({ exhausted: true, attempts: 2, remaining: 0 }));
  bridge.deliver({
    sessionId: "ses_a",
    runtimeId: "ses_a#1",
    generation: 1,
    type: "exit",
    reason: "network_error",
  });
  const tab = session.tab("ses_a");
  assert.equal(tab?.runtime.retry?.attempts, 2);
  assert.equal(tab?.runtime.retry?.exhausted, true);
});
