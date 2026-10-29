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
//   mute      启动即静默，任何命令都不回复（模拟握手超时）
//   tree      额外拉起两个孙进程（行为良好，随管道 EOF 退出），用于进程树清理冒烟
//   tree-stubborn  同上但孙进程不跟随、根进程也不随 stdin 关闭退出，强制走 kill 路径
//
// 可选第 4 个参数 logPath：把「启动 / 收到命令」追加写入该文件，
// 让有界重试的用例可以精确统计实际尝试次数，而不必依赖计时。
// 可选第 5 个参数 leafReleasePath：仅 tree-stubborn 使用，出现该文件时孙进程退出。
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const [mode = "ok", label = "default", logPath, leafReleasePath] = process.argv.slice(2);

// 只有显式给了 logPath 才写文件；正常用例不产生任何磁盘副作用。
const note = (text) => {
  if (logPath) appendFileSync(logPath, text + String.fromCharCode(10));
};
note("start");

// 进程树夹具：模拟真实 Pi 自己拉起的工具子进程。结构化行让冒烟测试按 PID
// 还原「root → leaf」的完整树，而不是靠平台命令行枚举猜测。
if (mode === "tree" || mode === "tree-stubborn") {
  const leafMode = mode === "tree-stubborn" ? "stubborn" : "follow";
  const leafScript = join(dirname(fileURLToPath(import.meta.url)), "fake-pi-leaf.mjs");
  for (let index = 0; index < 2; index += 1) {
    const child = spawn(
      process.execPath,
      [leafScript, String(index), leafMode, logPath ?? "", leafReleasePath ?? ""],
      { stdio: ["pipe", "ignore", "ignore"], windowsHide: true },
    );
    note(JSON.stringify({ event: "leaf-spawn", index, pid: child.pid }));
  }
  note(JSON.stringify({ event: "root-start", mode, pid: process.pid }));
}

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

  note("command " + type);
  // mute：永远不回复，用握手超时模拟网络中断。
  if (mode === "mute") return;

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
  // tree-stubborn 是故意的：根进程拒绝随 stdin 关闭退出，逼迫 supervisor 走
  // shutdown_grace → start_kill 的强制终止路径。孙进程句柄本身会让事件循环继续存活。
  if (mode === "tree-stubborn") return;
  // 先把已排队的 stdout 写完再退出，避免最后一条记录被截断。
  void chain.then(() => process.exit(0));
});
