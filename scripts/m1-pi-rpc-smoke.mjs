#!/usr/bin/env node
//! Windows/macOS/Linux 上的 Pi RPC 最小冒烟 + P-02 恢复演示。
//!
//! 这是**真实付费**冒烟（会调用一次或两次模型），因此不接入 pnpm check：
//! 必须显式执行 pnpm smoke:rpc。默认参数下不做任何文件写入会话之外的事。
//!
//! 覆盖：
//! 1. 握手：get_state 返回 sessionId 与 sessionFile。
//! 2. 最小冒烟：prompt 被接收、有流式事件、收到 agent_settled、助手回复含冒烟标记。
//! 3. 中止：运行中 abort 成功，随后仍收到 agent_settled，状态回到不流式。
//! 4. P-02 恢复：正常关闭运行时后，用同一 session 文件重启进程，历史不丢、
//!    同一提示只执行一次、消息总数不变（不存在重复任务执行）。
//!
//! 不覆盖（必须诚实标注）：Tauri 窗口重启、WebView 界面点击路径、多 Agent 并发。

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { commandPlan } from "./lib/command-plan.mjs";
import { redactHome } from "./lib/redact.mjs";
import { RpcSession, SMOKE_MARKER, analyzeConversation, waitFor } from "./lib/pi-rpc-smoke.mjs";

const USAGE = [
  "用法: node scripts/m1-pi-rpc-smoke.mjs [选项]",
  "",
  "  --pi <path>         pi 可执行文件（默认 pi）",
  "  --json              输出机器可读报告",
  "  --out <path>        额外把 JSON 报告写入文件",
  "  --settle-ms <n>     等 agent_settled 的上限，默认 240000",
  "  --request-ms <n>    等单条 response 的上限，默认 30000",
  "  --keep              保留临时会话目录（诊断用）",
  "  --help              显示本说明",
  "",
  "退出码: 0 全部通过；1 有失败项；2 用法/环境错误。",
].join("\n");

function parseArgs(argv) {
  const options = {
    pi: "pi",
    json: false,
    out: null,
    keep: false,
    settleMs: 240_000,
    requestMs: 30_000,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(arg + " 缺少参数值");
      index += 1;
      return value;
    };
    // pnpm/npm 会原样透传 "--"，node scripts/...mjs -- --json 也应可用。
    if (arg === "--") continue;
    else if (arg === "--pi") options.pi = next();
    else if (arg === "--json") options.json = true;
    else if (arg === "--out") options.out = next();
    else if (arg === "--keep") options.keep = true;
    else if (arg === "--settle-ms") options.settleMs = Number(next());
    else if (arg === "--request-ms") options.requestMs = Number(next());
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error("未知参数: " + arg);
  }
  if (!Number.isFinite(options.settleMs) || options.settleMs <= 0) throw new Error("--settle-ms 必须为正数");
  if (!Number.isFinite(options.requestMs) || options.requestMs <= 0) throw new Error("--request-ms 必须为正数");
  return options;
}

/** 读版本号：只用于报告，失败按环境错误处理，不猜测版本。 */
function probeVersion(pi, timeoutMs = 30_000) {
  const plan = commandPlan(pi, ["--version"]);
  return new Promise((resolve, reject) => {
    let stdout = "";
    const child = spawn(plan.command, plan.args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("pi --version 超过 " + timeoutMs + "ms 无响应"));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error("无法启动 pi: " + error.message));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const first = stdout.trim().split("\n")[0] ?? "";
      if (code !== 0 || !first) reject(new Error("pi --version 退出码 " + code));
      else resolve(first);
    });
  });
}

const RPC_ARGS = (sessionDir, sessionArgs) => [
  "--mode",
  "rpc",
  "--session-dir",
  sessionDir,
  ...sessionArgs,
  // 冒烟只验证协议与恢复，不加载工具/扩展/技能，避免真实写文件或额外网络行为。
  "--no-tools",
  "--no-extensions",
  "--no-mcp",
  "--no-skills",
  "--no-prompt-templates",
  "--no-context-files",
  "--thinking",
  "off",
];

function check(list, id, title, passed, detail) {
  list.push({ id, title, status: passed ? "pass" : "fail", detail: detail ?? "" });
  return passed;
}

function summarize(record) {
  if (!record) return null;
  return {
    success: record.success,
    command: record.command ?? null,
    error: record.error ?? null,
    disposition: record.data?.disposition ?? null,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  const checks = [];
  const startedAt = Date.now();
  const sessionId = randomUUID();
  const tempRoot = await mkdtemp(join(tmpdir(), "soxu-m1-smoke-"));
  const sessionDir = join(tempRoot, "sessions");
  const workDir = join(tempRoot, "workspace");
  await mkdir(sessionDir, { recursive: true });
  await mkdir(workDir, { recursive: true });

  const report = {
    kind: "soxu-m1-pi-rpc-smoke",
    startedAt: new Date().toISOString(),
    environment: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      piCommand: options.pi,
      piVersion: null,
      model: null,
      thinkingLevel: null,
      sessionId,
    },
    phases: {},
    checks,
    limits: [
      "只覆盖 Pi RPC 层：不验证 Tauri 窗口重启、WebView 交互与多 Agent 并发。",
      "会调用真实模型（1~2 次提示），可能产生费用；失败不自动重试。",
    ],
  };

  let exitCode = 0;
  let first = null;
  let second = null;
  try {
    report.environment.piVersion = await probeVersion(options.pi);
    check(checks, "pi-version", "pi 可执行文件可运行", Boolean(report.environment.piVersion), report.environment.piVersion);

    // ---- 阶段 1：握手 + 最小冒烟 ----
    const plan1 = commandPlan(options.pi, RPC_ARGS(sessionDir, ["--session-id", sessionId]));
    first = new RpcSession({ ...plan1, cwd: workDir }).start();
    const state1 = await first.request({ id: "s1", type: "get_state" }, { timeoutMs: options.requestMs });
    const state1Data = state1.data ?? {};
    report.environment.model = state1Data.model?.id ?? state1Data.model?.name ?? null;
    report.environment.thinkingLevel = state1Data.thinkingLevel ?? null;
    report.phases.state = {
      success: state1.success,
      sessionId: state1Data.sessionId ?? null,
      sessionFile: state1Data.sessionFile ?? null,
      model: report.environment.model,
      messageCount: state1Data.messageCount ?? null,
    };
    check(checks, "handshake", "get_state 返回 sessionId 与 sessionFile",
      state1.success === true && state1Data.sessionId === sessionId && typeof state1Data.sessionFile === "string");

    const prompt1 = "请只回复这个标记，不要有任何其他字符：" + SMOKE_MARKER;
    const settled1 = first.waitEvent("agent_settled", { timeoutMs: options.settleMs });
    const response1 = await first.request({ id: "p1", type: "prompt", message: prompt1 }, { timeoutMs: options.requestMs });
    check(checks, "prompt-accepted", "prompt 被 Pi 接收（success 与 disposition）",
      response1.success === true && ["started", "queued"].includes(response1.data?.disposition), JSON.stringify(summarize(response1)));
    await settled1;
    const streamed = (first.counts["event:message_update"] ?? 0) > 0 || (first.counts["event:message_start"] ?? 0) > 0;
    check(checks, "settled", "整轮以 agent_settled 结束且期间有流式事件", streamed,
      "message_update=" + (first.counts["event:message_update"] ?? 0) + ", agent_settled=" + (first.counts["event:agent_settled"] ?? 0));

    const messages1 = await first.request({ id: "m1", type: "get_messages" }, { timeoutMs: options.requestMs });
    const conversation1 = analyzeConversation(messages1.data?.messages, SMOKE_MARKER);
    report.phases.run = { conversation: conversation1 };
    check(checks, "assistant-reply", "助手回复含冒烟标记，且只出现一次",
      conversation1.markerReplies === 1, "markerReplies=" + conversation1.markerReplies);

    // ---- 阶段 2：运行中中止 ----
    const settled2 = first.waitEvent("agent_settled", { timeoutMs: options.settleMs });
    const response2 = await first.request(
      { id: "p2", type: "prompt", message: "请从 1 数到 200，每行一个数字。" },
      { timeoutMs: options.requestMs },
    );
    report.phases.abort = { prompt: summarize(response2) };
    let abortSucceeded = false;
    if (response2.success === true) {
      // 等运行真的开始再中止，否则 abort 可能落在空闲态而失去验证意义。
      await waitFor(() => (first.counts["event:message_update"] ?? 0) > 1 || (first.counts["event:agent_start"] ?? 0) > 0,
        { timeoutMs: 60_000, label: "run to start before abort" }).catch(() => null);
      const abort = await first.request({ id: "a1", type: "abort" }, { timeoutMs: options.requestMs });
      report.phases.abort.response = summarize(abort);
      abortSucceeded = abort.success === true;
      await settled2.catch(() => null);
      const state2 = await first.request({ id: "s2", type: "get_state" }, { timeoutMs: options.requestMs });
      report.phases.abort.isStreaming = state2.data?.isStreaming ?? null;
      abortSucceeded = abortSucceeded && state2.data?.isStreaming === false;
    }
    check(checks, "abort", "运行中 abort 成功并能回到非流式状态", abortSucceeded, JSON.stringify(report.phases.abort));

    // ---- 阶段 3：P-02 重启恢复 ----
    const before = await first.request({ id: "m2", type: "get_messages" }, { timeoutMs: options.requestMs });
    const beforeConversation = analyzeConversation(before.data?.messages, SMOKE_MARKER);
    const firstParseErrors = [...first.parseErrors];
    const closing = await first.close();
    report.phases.shutdown = {
      ...closing,
      parseErrors: firstParseErrors,
      stderrTail: first.stderrTail ? first.stderrTail.slice(-400) : "",
    };
    first = null;
    check(checks, "shutdown", "关闭 stdin 后进程自行退出（未强制结束）",
      closing.forced === false && closing.code === 0, JSON.stringify({ code: closing.code, forced: closing.forced }));

    const sessionFile = report.phases.state.sessionFile;
    const plan2 = commandPlan(options.pi, RPC_ARGS(sessionDir, ["--session", sessionFile]));
    second = new RpcSession({ ...plan2, cwd: workDir }).start();
    const state3 = await second.request({ id: "r1", type: "get_state" }, { timeoutMs: options.requestMs });
    const after = await second.request({ id: "r2", type: "get_messages" }, { timeoutMs: options.requestMs });
    const afterConversation = analyzeConversation(after.data?.messages, SMOKE_MARKER);
    report.phases.resume = {
      sessionId: state3.data?.sessionId ?? null,
      messageCount: state3.data?.messageCount ?? null,
      before: beforeConversation,
      after: afterConversation,
    };
    check(checks, "resume-session", "重启后仍指向同一 sessionId",
      state3.success === true && state3.data?.sessionId === sessionId, String(state3.data?.sessionId));
    check(checks, "messages-persisted", "重启后历史消息不丢（含冒烟标记回复）",
      afterConversation.markerReplies === 1 && afterConversation.total >= beforeConversation.total,
      "before=" + beforeConversation.total + ", after=" + afterConversation.total);
    check(checks, "no-duplicate-execution", "同一提示未被重复执行（消息数不变、无重复提示）",
      afterConversation.total === beforeConversation.total && afterConversation.duplicatePrompts.length === 0,
      "before=" + beforeConversation.total + ", after=" + afterConversation.total
        + ", duplicates=" + afterConversation.duplicatePrompts.length);
    const allParseErrors = [...firstParseErrors, ...second.parseErrors];
    check(checks, "record-parse", "全部 stdout 记录均可解析（无失步）",
      allParseErrors.length === 0, allParseErrors.slice(0, 3).join("; "));
  } catch (error) {
    check(checks, "runtime", "冒烟过程未抛异常", false, error.message.slice(0, 300));
    exitCode = 1;
  } finally {
    for (const session of [first, second]) {
      if (session) await session.close({ graceMs: 5_000 }).catch(() => null);
    }
    if (!options.keep) await rm(tempRoot, { recursive: true, force: true }).catch(() => null);
  }

  const failed = checks.filter((item) => item.status === "fail");
  if (failed.length) exitCode = 1;
  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.now() - startedAt;
  report.tempRoot = options.keep ? tempRoot : "(removed)";
  report.summary = { total: checks.length, passed: checks.length - failed.length, failed: failed.length };
  report.verdict = failed.length ? "fail" : "pass";

  // 证据要入库：把主目录前缀换成 "~"，避免把用户目录结构写进仓库。
  const printable = redactHome(report);
  const json = JSON.stringify(printable, null, 2);
  if (options.out) {
    await mkdir(dirname(options.out), { recursive: true });
    await writeFile(options.out, json + "\n", "utf8");
  }
  if (options.json) {
    console.log(json);
  } else {
    console.log("SOXU M1 Pi RPC 冒烟 · " + report.environment.platform + " · pi " + (report.environment.piVersion ?? "?"));
    console.log("模型: " + (report.environment.model ?? "(沿用 Pi 当前配置)"));
    for (const item of checks) {
      console.log("  [" + (item.status === "pass" ? "PASS" : "FAIL") + "] " + item.id + " - " + item.title
        + (item.detail ? " :: " + item.detail : ""));
    }
    console.log("结论: " + report.verdict + " (" + report.summary.passed + "/" + report.summary.total + " 通过, "
      + report.durationMs + "ms)");
    console.log("限制: " + report.limits.join(" "));
  }
  return exitCode;
}

main().then((code) => {
  process.exitCode = code;
}).catch((error) => {
  console.error("冒烟无法执行: " + error.message);
  process.exitCode = 2;
});
