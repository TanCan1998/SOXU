#!/usr/bin/env node
// 测试夹具：模拟 `pi --mode rpc` 的 stdio NDJSON 行为，仅用于自动化测试。
//
// 用法：node fake-pi.mjs <mode> <label>
//   ok        正常响应，prompt 后发出 agent_start / agent_settled
//   fragment  按 3 字节切片写出，并一次写出两条记录（拆包 + 粘包）
//   reverse   先收到的命令后回复，用于验证 request id 关联
//   chatty    prompt 后持续输出 40 条 agent_activity，再 settled
//   slow      收到 abort 前不 settle
//   crash     prompt 到达后立即 exit(7)，不回复
//   noreply   get_state 正常，prompt/abort 永不回复
//   garbage   首条命令前写一行坏 JSON 与一条扩展 UI 请求
//   noisy     启动即写 120 行带密钥形态的 stderr
import process from "node:process";
import readline from "node:readline";

const [mode = "ok", label = "default"] = process.argv.slice(2);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// 让出一轮事件循环：每次 write 都是独立系统调用，足以把一条记录拆到多次读取里。
const tick = () => new Promise((resolve) => setImmediate(resolve));

// 兜底：夹具进程最多活 30 秒，避免测试异常时留下孤儿进程。
const guard = setTimeout(() => process.exit(0), 30_000);
guard.unref();

let chain = Promise.resolve();
let aborted = false;
let counter = 0;
let sentGarbage = false;

// 所有 stdout 写入串行化，fragment 模式下刻意拆成 3 字节小块。
function raw(text) {
  chain = chain.then(async () => {
    if (mode === "fragment") {
      for (let index = 0; index < text.length; index += 2) {
        process.stdout.write(text.slice(index, index + 2));
        await tick();
      }
      return;
    }
    process.stdout.write(text);
  });
  return chain;
}

const record = (value) => raw(`${JSON.stringify(value)}\n`);
const batch = (values) => raw(`${values.map((value) => JSON.stringify(value)).join("\n")}\n`);
const event = (name, data = {}) =>
  record({ type: "event", event: name, data: { sessionId: label, ...data } });
const response = (id, command, data = {}) =>
  record({ type: "response", id, command, success: true, data: { sessionId: label, ...data } });

if (mode === "noisy") {
  for (let index = 0; index < 120; index += 1) {
    process.stderr.write(
      `noise ${index} token ${"ghp_" + "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"} tail\n`,
    );
  }
}

async function handleCommand(line) {
  let command;
  try {
    command = JSON.parse(line);
  } catch {
    return;
  }
  const { type, id } = command;
  if (typeof id !== "string") return;

  if (mode === "garbage" && !sentGarbage) {
    sentGarbage = true;
    // 坏 JSON 只应产生协议警告，后续记录必须照常解析。
    await raw("this-is-not-a-json-record\n");
    await record({ type: "extension_ui_request", id: "ui-1" });
  }

  if (type === "prompt" && mode === "crash") {
    await delay(20);
    process.exit(7);
  }

  let latency = 0;
  if (mode === "reverse") {
    latency = Math.max(10, 320 - counter * 140);
    counter += 1;
  }
  if (latency > 0) await delay(latency);

  if (type === "get_state") {
    await response(id, "get_state");
    return;
  }

  if (type === "prompt") {
    if (mode === "noreply") return;
    await response(id, "prompt", { disposition: "handled" });
    if (mode === "chatty") {
      await event("agent_start");
      for (let tick = 0; tick < 40; tick += 1) {
        if (aborted) return;
        await event("agent_activity", { tick });
        await delay(5);
      }
      await event("agent_settled");
      return;
    }
    if (mode === "slow") {
      await event("agent_start");
      const deadline = Date.now() + 15_000;
      while (!aborted && Date.now() < deadline) await delay(10);
      await event("agent_settled");
      return;
    }
    if (mode === "fragment") {
      // 一次写入两条记录：验证粘包。
      await batch([
        { type: "event", event: "agent_start", data: { sessionId: label } },
        { type: "event", event: "agent_settled", data: { sessionId: label } },
      ]);
      return;
    }
    await event("agent_start");
    await event("agent_settled");
    return;
  }

  if (type === "abort") {
    aborted = true;
    if (mode === "noreply") return;
    await response(id, "abort");
    return;
  }

  await response(id, type);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  void handleCommand(line.trim()).catch(() => {});
});
rl.on("close", () => {
  // 先把已排队的 stdout 写完再退出，避免最后一条记录被截断。
  void chain.then(() => process.exit(0));
});
