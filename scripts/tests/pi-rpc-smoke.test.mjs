//! Pi RPC 冒烟逻辑的离线测试（Issue #41）。
//!
//! 分两类：
//! 1. 纯函数：NDJSON 分帧、记录解析、消息分析、有界等待、跨平台启动计划。
//! 2. RpcSession 生命周期：用脚本内假运行时（fixtures/fake-pi-rpc.mjs）验证
//!    握手、事件/回执分流、坏记录隔离、超时与「关 stdin 自行退出」的清理路径。
//!
//! 全部离线：不联网、不调用模型、不写用户会话目录。

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
  RpcSession,
  SMOKE_MARKER,
  analyzeConversation,
  createRecordSplitter,
  messageText,
  parseRecord,
  waitFor,
} from "../lib/pi-rpc-smoke.mjs";
import { commandPlan, quoteForCmd } from "../lib/command-plan.mjs";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-pi-rpc.mjs", import.meta.url));

function startFake(env = {}) {
  return new RpcSession({
    command: process.execPath,
    args: [FIXTURE],
    cwd: process.cwd(),
    env: { ...process.env, ...env },
  }).start();
}

test("分帧只按 LF 切分，保留 CRLF 与 U+2028 内容", () => {
  const splitter = createRecordSplitter();
  const line = JSON.stringify({ text: "a\u2028b\u2029c" }) + "\r\n";
  const first = splitter.push(Buffer.from(line.slice(0, 10), "utf8"));
  assert.deepEqual(first, []);
  const rest = splitter.push(Buffer.from(line.slice(10), "utf8"));
  assert.equal(rest.length, 1);
  assert.equal(rest[0].endsWith("\r"), false);
  assert.deepEqual(JSON.parse(rest[0]), { text: "a\u2028b\u2029c" });
});

test("进程退出时 flush 出不带换行的最后一条记录", () => {
  const splitter = createRecordSplitter();
  assert.deepEqual(splitter.push(Buffer.from("{\"a\":1}", "utf8")), []);
  assert.deepEqual(splitter.flush(), ["{\"a\":1}"]);
  assert.deepEqual(splitter.flush(), []);
});

test("非对象与坏 JSON 被拒绝，而不是当成事件", () => {
  assert.equal(parseRecord("[1,2]").error.includes("JSON object"), true);
  assert.equal(parseRecord("null").error.includes("JSON object"), true);
  assert.ok(parseRecord("{oops").error.startsWith("invalid JSON"));
  assert.deepEqual(parseRecord("{\"type\":\"agent_settled\"}").value, { type: "agent_settled" });
});

test("消息文本同时支持字符串与内容块数组", () => {
  assert.equal(messageText({ content: "hi" }), "hi");
  assert.equal(messageText({ content: [{ type: "text", text: "a" }, { type: "toolCall" }, { type: "text", text: "b" }] }), "ab");
  assert.equal(messageText({ content: null }), "");
  assert.equal(messageText({}), "");
});

test("重复执行会同时体现在标记次数与重复提示上", () => {
  const once = analyzeConversation([
    { role: "user", content: "ping " + SMOKE_MARKER },
    { role: "assistant", content: [{ type: "text", text: SMOKE_MARKER }] },
  ]);
  assert.equal(once.markerReplies, 1);
  assert.deepEqual(once.duplicatePrompts, []);
  assert.equal(once.userMessages, 1);

  const twice = analyzeConversation([
    { role: "user", content: "ping " + SMOKE_MARKER },
    { role: "assistant", content: SMOKE_MARKER },
    { role: "user", content: "ping " + SMOKE_MARKER },
    { role: "assistant", content: SMOKE_MARKER },
  ]);
  assert.equal(twice.markerReplies, 2);
  assert.equal(twice.duplicatePrompts.length, 1);
});

test("有界等待：命中即返回，超时抛可读错误", async () => {
  let ready = false;
  setTimeout(() => { ready = true; }, 20);
  assert.equal(await waitFor(() => ready, { timeoutMs: 2000, label: "ready" }), true);
  await assert.rejects(
    () => waitFor(() => false, { timeoutMs: 30, label: "never" }),
    /timed out after 30ms waiting for never/,
  );
});

test("Windows 上 npm 包装走 cmd.exe，.exe 与其它平台直接执行", () => {
  assert.deepEqual(commandPlan("pi", ["--version"], "win32"), {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", "pi --version"],
  });
  assert.deepEqual(commandPlan("C:\\tools\\pi.exe", ["--version"], "win32"), {
    command: "C:\\tools\\pi.exe",
    args: ["--version"],
  });
  assert.deepEqual(commandPlan("pi", ["--mode", "rpc"], "linux"), {
    command: "pi",
    args: ["--mode", "rpc"],
  });
  assert.equal(quoteForCmd("a b"), '"a b"');
  assert.equal(quoteForCmd("plain"), "plain");
});

test("真实协议形状：事件在顶层，回执带 id", async () => {
  const session = startFake();
  try {
    const state = await session.request({ id: "s1", type: "get_state" }, { timeoutMs: 5000 });
    assert.equal(state.type, "response");
    assert.equal(state.success, true);
    assert.equal(state.data.sessionId, "fake-session-1");

    const settled = session.waitEvent("agent_settled", { timeoutMs: 5000 });
    const prompt = await session.request({ id: "p1", type: "prompt", message: "ping" }, { timeoutMs: 5000 });
    assert.equal(prompt.data.disposition, "started");
    assert.equal((await settled).aborted, false);

    const messages = await session.request({ id: "m1", type: "get_messages" }, { timeoutMs: 5000 });
    assert.equal(analyzeConversation(messages.data.messages, SMOKE_MARKER).markerReplies, 1);
    assert.equal(session.counts["event:agent_settled"], 1);
    assert.equal(session.counts["response"], 3);
    assert.deepEqual(session.parseErrors, []);
  } finally {
    await session.close({ graceMs: 5000 });
  }
});

test("坏记录只计入诊断，不会让后续回执失步", async () => {
  const session = startFake();
  try {
    await session.request({ id: "s1", type: "get_state" }, { timeoutMs: 5000 });
    const settled = session.waitEvent("agent_settled", { timeoutMs: 5000 });
    await session.request({ id: "p1", type: "prompt", message: "GARBAGE" }, { timeoutMs: 5000 });
    await settled;
    assert.equal(session.parseErrors.length, 1);
    const messages = await session.request({ id: "m1", type: "get_messages" }, { timeoutMs: 5000 });
    assert.equal(messages.success, true);
  } finally {
    await session.close({ graceMs: 5000 });
  }
});

test("关闭 stdin 后自行退出，不触发强制结束；关闭后拒绝再发命令", async () => {
  const session = startFake();
  await session.request({ id: "s1", type: "get_state" }, { timeoutMs: 5000 });
  const closing = await session.close({ graceMs: 5000 });
  assert.equal(closing.forced, false);
  assert.equal(closing.code, 0);
  assert.throws(() => session.send({ id: "x", type: "get_state" }), /already exited/);
});

test("等不到的事件按超时失败，不会挂死", async () => {
  const session = startFake();
  try {
    await assert.rejects(
      () => session.waitEvent("agent_settled", { timeoutMs: 40 }),
      /timed out after 40ms waiting for event agent_settled/,
    );
  } finally {
    await session.close({ graceMs: 5000 });
  }
});
