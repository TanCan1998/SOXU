#!/usr/bin/env node
//! 测试专用假 Pi RPC 运行时。
//!
//! 只实现冒烟测试用到的命令，输出格式与 Pi 1.4.0 一致：事件是顶层的
//! {"type":"agent_settled"}，回执是 {"type":"response","id":...}。
//! 不联网、不读会话文件、不产生费用；stdin 结束即退出，用于验证 close() 的优雅路径。

import { createInterface } from "node:readline";

const sessionId = process.env.FAKE_PI_SESSION_ID ?? "fake-session-1";
const sessionFile = "/fake/sessions/" + sessionId + ".jsonl";
const messages = [];
let streaming = false;

const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const later = (fn) => setTimeout(fn, 5);

function handle(command) {
  switch (command.type) {
    case "get_state":
      send({ type: "response", id: command.id, success: true, command: "get_state", data: { sessionId, sessionFile, messageCount: messages.length, isStreaming: streaming, thinkingLevel: "off", model: { id: "fake/model" } } });
      break;
    case "get_messages":
      send({ type: "response", id: command.id, success: true, command: "get_messages", data: { messages } });
      break;
    case "prompt": {
      if (String(command.message).includes("GARBAGE")) process.stdout.write("not-json\n");
      messages.push({ role: "user", content: command.message });
      send({ type: "response", id: command.id, success: true, command: "prompt", data: { disposition: "started" } });
      streaming = true;
      send({ type: "agent_start" });
      send({ type: "message_start", message: { role: "assistant", content: [] } });
      later(() => send({ type: "message_update" }));
      later(() => {
        messages.push({ role: "assistant", content: [{ type: "text", text: "SOXU-SMOKE-OK" }] });
        send({ type: "message_end" });
        send({ type: "agent_end", messages });
        streaming = false;
        send({ type: "agent_settled", aborted: false });
      });
      break;
    }
    case "abort":
      send({ type: "response", id: command.id, success: true, command: "abort" });
      later(() => {
        streaming = false;
        send({ type: "agent_settled", aborted: true });
      });
      break;
    default:
      send({ type: "response", id: command.id, success: false, command: command.type, error: "unknown command" });
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let command;
  try {
    command = JSON.parse(line);
  } catch {
    send({ type: "response", id: "unknown", success: false, error: "invalid json" });
    return;
  }
  handle(command);
});
rl.on("close", () => process.exit(0));
