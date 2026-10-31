#!/usr/bin/env node
//! 发送模式协议调查（Issue #146 · TASK-036）：用真实 `pi --mode rpc` 测投递语义。
//!
//! 这是**真实付费**探测（会调用若干次模型），因此不接入 pnpm check：
//! 必须显式执行 `pnpm probe:send-modes`。证据写入
//! docs/development/evidence/issue-146-send-modes/。
//!
//! 覆盖的问题：
//! 1. 忙碌时再发 prompt（不带 streamingBehavior）到底是什么结果；
//! 2. `prompt` 带 streamingBehavior=steer/followUp 与独立 `steer`/`follow_up` 命令的差别；
//! 3. 空闲时带 streamingBehavior 是否被接受（决定 SOXU 是否总要带这个字段）；
//! 4. 排队消息在 agent_settled 之前还是之后投递；
//! 5. abort 之后排队消息是否还会执行；clear_queue 是否能撤掉；
//! 6. 两个独立运行时并行是否互不干扰（parallel = 新会话）。
//!
//! 关键：SOXU 线上走的是 **prompt + streamingBehavior**，不是独立的 steer/follow_up 命令。
//! 因此 followUp 必须按 SOXU 的真实线格式单独测一遍（followUpPromptWhileBusy），
//! 不能只拿 `follow_up` 命令的结果去推断 `prompt+followUp` 的行为。
//!
//! 不覆盖（必须诚实标注）：Tauri/WebView 层、真实项目的工具调用、并发上限与内存。

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { commandPlan } from "./lib/command-plan.mjs";
import { redactHome } from "./lib/redact.mjs";
import { RpcSession, waitFor } from "./lib/pi-rpc-smoke.mjs";

/** 阶段名：--only 用它挑选要跑的部分，报告里也按这些名字记录 skipped。 */
const PHASE_NAMES = [
  "handshake",
  "busyPromptWithoutBehavior",
  "steerWhileBusy",
  "followUpWhileBusy",
  "followUpPromptWhileBusy",
  "idleWithStreamingBehavior",
  "abortWithQueuedFollowUp",
  "clearQueue",
  "parallelTwoRuntimes",
];

const USAGE = [
  "用法: node scripts/probe-send-modes.mjs [选项]",
  "",
  "  --pi <path>         pi 可执行文件（默认 pi）",
  "  --json              输出机器可读报告",
  "  --out <path>        额外把 JSON 报告写入文件",
  "  --merge             与 --out 配合：保留文件里本次没跑的阶段（局部重测不覆盖旧证据）",
  "  --settle-ms <n>     等 agent_settled 的上限，默认 240000",
  "  --request-ms <n>    等单条 response 的上限，默认 30000",
  "  --only <names>      只跑指定阶段（逗号分隔），默认全跑",
  "  --keep              保留临时会话目录（诊断用）",
  "  --help              显示本说明",
  "",
  "阶段名: " + PHASE_NAMES.join(", "),
  "",
  "退出码: 0 探测完成（结论不依赖成败，看 phases 的 measured 字段）；2 环境/用法错误。",
].join("\n");

function parseArgs(argv) {
  const options = {
    pi: "pi",
    json: false,
    out: null,
    merge: false,
    keep: false,
    settleMs: 240_000,
    requestMs: 30_000,
    only: null,
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
    if (arg === "--") continue;
    else if (arg === "--pi") options.pi = next();
    else if (arg === "--json") options.json = true;
    else if (arg === "--out") options.out = next();
    else if (arg === "--merge") options.merge = true;
    else if (arg === "--only") options.only = next();
    else if (arg === "--keep") options.keep = true;
    else if (arg === "--settle-ms") options.settleMs = Number(next());
    else if (arg === "--request-ms") options.requestMs = Number(next());
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error("未知参数: " + arg);
  }
  return options;
}

/** 子进程只继承运行所需的环境：去掉当前会话的 PI_* 身份与模型覆盖，避免污染探测。 */
function childEnv() {
  const env = { ...process.env };
  for (const key of ["PI_SESSION_FILE", "PI_SESSION_ID", "PI_MODEL", "PI_PROVIDER", "PI_REASONING_LEVEL"]) {
    delete env[key];
  }
  return env;
}

const RPC_ARGS = (sessionDir, extra) => [
  "--mode",
  "rpc",
  "--session-dir",
  sessionDir,
  ...extra,
  // 探测只关心投递语义，不加载工具/扩展/技能，避免真实写文件或额外网络行为。
  "--no-tools",
  "--no-extensions",
  "--no-mcp",
  "--no-skills",
  "--no-prompt-templates",
  "--no-context-files",
  "--thinking",
  "off",
];

/** 长任务：给排队窗口留出足够时间，不需要模型「慢」，只需要它还在流式。 */
const LONG_TASK = "请从 1 数到 400，每行一个数字，不要使用任何工具，不要省略。";

let seq = 0;
const nextId = (prefix) => prefix + "-" + ++seq;

function summarize(record) {
  if (!record) return null;
  return {
    id: record.id ?? null,
    type: record.type ?? null,
    command: record.command ?? null,
    success: record.success ?? null,
    error: record.error ?? null,
    disposition: record.data?.disposition ?? null,
  };
}

/** 只保留证据需要的字段，避免把整段流式输出写进报告。 */
function queueFrames(session, fromIndex) {
  return session.records
    .slice(fromIndex)
    .filter((record) => record.type === "queue_update")
    .map((record) => ({
      type: "queue_update",
      steering: Array.isArray(record.steering) ? record.steering.length : null,
      followUp: Array.isArray(record.followUp) ? record.followUp.length : null,
    }))
    .slice(-6);
}

function settledFrame(record) {
  if (!record) return null;
  return { type: "agent_settled", aborted: record.aborted ?? null };
}

/**
 * 某段文本作为**用户消息帧**出现的下标（从 from 开始），找不到返回 -1。
 *
 * 为什么不用「JSON 里包含这段文本」：queue_update 帧同样带正文，用它算下标会把
 * 「入队」误当成「投递」。这里只认 `message_start` 且 `role === "user"`，
 * 于是下标本身就说明消息真的进入了会话历史。
 */
function userMessageIndex(session, mark, from = 0) {
  for (let index = Math.max(0, from); index < session.records.length; index += 1) {
    const record = session.records[index];
    if (record.type !== "message_start") continue;
    if (record.message?.role !== "user") continue;
    if (!JSON.stringify(record).includes(mark)) continue;
    return index;
  }
  return -1;
}

/** 区间内的 agent_settled 下标列表（用来证明「投递发生在轮次结束之后」）。 */
function settledIndices(session, from = 0) {
  const list = [];
  for (let index = Math.max(0, from); index < session.records.length; index += 1) {
    if (session.records[index].type === "agent_settled") list.push(index);
  }
  return list;
}

/**
 * 标记文本在事件流里出现过的位置：只记下标、类型与角色，不复制正文。
 *
 * 为什么不只查 get_messages：投递**时刻**只能从事件流顺序看出来。
 * 这里不预设投递一定伴随 message_start——观测到什么就记什么。
 */
function deliveryTrace(session, mark, limit = 6) {
  const trace = [];
  for (let index = 0; index < session.records.length; index += 1) {
    const record = session.records[index];
    if (!JSON.stringify(record).includes(mark)) continue;
    trace.push({
      index,
      type: record.type ?? null,
      role: record.message?.role ?? null,
    });
    if (trace.length >= limit) break;
  }
  return trace;
}

/** 从消息历史里找某段文本是否真的作为用户消息投递过。 */
function userTexts(messages) {
  const list = Array.isArray(messages) ? messages : [];
  return list
    .filter((message) => message?.role === "user")
    .map((message) => {
      const content = message.content;
      if (typeof content === "string") return content;
      if (!Array.isArray(content)) return "";
      return content
        .filter((block) => block?.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("");
    });
}

function hasText(messages, needle) {
  return userTexts(messages).some((text) => text.includes(needle));
}

async function getState(session, options) {
  return session.request({ id: nextId("state"), type: "get_state" }, { timeoutMs: options.requestMs });
}

async function getMessages(session, options) {
  const response = await session.request({ id: nextId("messages"), type: "get_messages" }, { timeoutMs: options.requestMs });
  return response.data?.messages ?? [];
}

/**
 * 开一轮长任务并确认它真的在流式。
 * 模型太快时（已经结束）返回 false，由调用方决定是否重试，绝不无限重试。
 */
async function startBusyRun(session, options) {
  const settled = session.waitEvent("agent_settled", { timeoutMs: options.settleMs });
  const before = session.counts["event:agent_start"] ?? 0;
  const response = await session.request(
    { id: nextId("long"), type: "prompt", message: LONG_TASK },
    { timeoutMs: options.requestMs },
  );
  if (response.success !== true) return { settled, busy: false, response };
  await waitFor(() => (session.counts["event:agent_start"] ?? 0) > before, {
    timeoutMs: 60_000,
    label: "agent_start of the long run",
  }).catch(() => null);
  const state = await getState(session, options);
  return { settled, busy: state.data?.isStreaming === true, response, state };
}

async function drain(session, settled) {
  // 探测不追求「跑完」：能中止就中止，省时间也省费用。
  if (!session.exit) {
    await session.request({ id: nextId("abort"), type: "abort" }, { timeoutMs: 30_000 }).catch(() => null);
  }
  await settled.catch(() => null);
  // 中止后仍可能有尾随事件：给一小段静默窗口，避免污染下一阶段。
  await new Promise((resolve) => setTimeout(resolve, 150));
}

/**
 * 忙碌时排一条 followUp，并记录它是不是在**第一轮 agent_settled 之后**才被投递。
 *
 * wire 决定入口：\`prompt+streamingBehavior=followUp\`（SOXU 的真实线格式）
 * 或独立 \`follow_up\` 命令。文档说两者等价，但 SOXU 只走前者，因此两条路径分开测：
 * 证据必须来自实际使用的那一条，不能拿另一条的结果推断。
 */
async function measureFollowUp(session, options, { viaPrompt }) {
  // 阶段起点：所有「之后再发生」的判定都从这条下标往后数，
  // 否则上一阶段残留的 agent_settled 会把顺序证据算错（这是上一版报告的缺陷）。
  const runStartIndex = session.records.length;
  const run = await startBusyRun(session, options);
  const mark = (viaPrompt ? "PROMPT-FOLLOW-" : "CMD-FOLLOW-") + Date.now().toString(36);
  const frames = {
    wire: viaPrompt ? "prompt+streamingBehavior=followUp" : "follow_up",
    isStreaming: run.state?.data?.isStreaming ?? null,
  };
  if (!run.busy) {
    frames.note = "长任务在发命令前就结束了，未能观测到忙碌窗口";
    await drain(session, run.settled);
    return frames;
  }
  const markIndex = session.records.length;
  const command = viaPrompt
    ? {
        id: nextId("followup-prompt"),
        type: "prompt",
        message: "排到下轮（prompt 路径）：" + mark,
        streamingBehavior: "followUp",
      }
    : { id: nextId("followup"), type: "follow_up", message: "排到下轮（命令路径）：" + mark };
  const response = await session
    .request(command, { timeoutMs: options.requestMs })
    .catch((error) => ({ success: null, error: error.message }));
  frames.response = summarize(response);
  frames.queueFrames = queueFrames(session, markIndex);
  const queuedState = await getState(session, options);
  frames.isStreamingAfterQueue = queuedState.data?.isStreaming ?? null;
  frames.pendingMessageCount = queuedState.data?.pendingMessageCount ?? null;

  // 第一轮让它自己跑完（不 abort）：abort 会改变排队消息的投递语义，那是 P5 的问题。
  const firstSettled = await run.settled.catch(() => null);

  // 排队的消息在这一轮之后自己起一轮：再等一次 agent_settled 就是它的收尾信号。
  const secondSettled = await session
    .waitEvent("agent_settled", { timeoutMs: options.settleMs })
    .catch(() => null);

  const messages = await getMessages(session, options);
  // 投递下标与 settled 下标都从 runStartIndex 往后数，两者同处一条时间线。
  const deliveredAt = userMessageIndex(session, mark, runStartIndex);
  const settledAt = settledIndices(session, runStartIndex);
  const settledBeforeDelivery = deliveredAt < 0 ? 0 : settledAt.filter((index) => index < deliveredAt).length;

  frames.settled = {
    first: settledFrame(firstSettled),
    second: settledFrame(secondSettled),
    indices: settledAt,
    beforeDelivery: settledBeforeDelivery,
  };
  frames.delivery = {
    delivered: hasText(messages, mark),
    // 直接证据：这条用户消息的 message_start 出现在至少一次 agent_settled **之后**
    // （followUp = 下一轮，而不是插进当前回合）。
    deliveredAsUserMessageFrame: deliveredAt >= 0,
    deliveredAfterSettled: settledBeforeDelivery >= 1,
    userMessageIndex: deliveredAt,
    firstSettledIndex: settledAt[0] ?? -1,
  };
  frames.trace = deliveryTrace(session, mark);
  frames.settledCount = session.counts["event:agent_settled"] ?? null;
  return frames;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  const tempRoot = await mkdtemp(join(tmpdir(), "soxu-probe-modes-"));
  const sessionDir = join(tempRoot, "sessions");
  const workDir = join(tempRoot, "workspace");
  await mkdir(sessionDir, { recursive: true });
  await mkdir(workDir, { recursive: true });

  const startedAt = Date.now();
  const report = {
    kind: "soxu-send-modes-probe",
    startedAt: new Date().toISOString(),
    environment: { platform: process.platform, arch: process.arch, node: process.version, piVersion: null, model: null, thinkingLevel: null },
    phases: {},
    limits: [
      "只覆盖 Pi RPC 层：不验证 Tauri 命令层、WebView 交互与 SOXU 客户端队列。",
      "会调用真实模型（约 8 次提示，含 3 次长输出），可能产生少量费用；失败不自动重试。",
      "延迟/时长与模型和网络相关，这里只记录行为，不把时间当作稳定指标。",
    ],
  };

  // --only：只跑指定阶段（排查时省钱省时）。未指定的阶段在报告里记成 skipped。
  const only = options.only
    ? new Set(
        String(options.only)
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
      )
    : null;
  if (only) {
    const unknown = [...only].filter((name) => !PHASE_NAMES.includes(name));
    if (unknown.length > 0) throw new Error("未知阶段名: " + unknown.join(", "));
  }
  const want = (name) => !only || only.has(name);
  report.requestedPhases = only ? [...only] : [...PHASE_NAMES];

  let session = null;
  try {
    const versionPlan = commandPlan(options.pi, ["--version"]);
    report.environment.piVersion = await new Promise((resolve, reject) => {
      let stdout = "";
      const child = spawn(versionPlan.command, versionPlan.args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
      child.on("error", reject);
      child.on("close", () => resolve((stdout.trim().split("\n")[0] ?? "") || null));
    });

    const plan = commandPlan(options.pi, RPC_ARGS(sessionDir, ["--session-id", "probe-send-modes"]));
    session = new RpcSession({ ...plan, cwd: workDir, env: childEnv() }).start();
    const handshake = await getState(session, options);
    report.environment.model = handshake.data?.model?.id ?? null;
    report.environment.thinkingLevel = handshake.data?.thinkingLevel ?? null;
    report.phases.handshake = want("handshake") ? {
      success: handshake.success === true,
      isStreaming: handshake.data?.isStreaming ?? null,
      steeringMode: handshake.data?.steeringMode ?? null,
      followUpMode: handshake.data?.followUpMode ?? null,
      pendingMessageCount: handshake.data?.pendingMessageCount ?? null,
    } : { skipped: true };

    // ---- P1：忙碌时发 prompt（不带 streamingBehavior） ----
    if (want("busyPromptWithoutBehavior")) {
      const run = await startBusyRun(session, options);
      const frames = { longPrompt: summarize(run.response), isStreaming: run.state?.data?.isStreaming ?? null };
      if (run.busy) {
        const busyPrompt = await session.request(
          { id: nextId("busy"), type: "prompt", message: "忙碌时直接发送" },
          { timeoutMs: options.requestMs },
        ).catch((error) => ({ success: null, error: error.message }));
        frames.busyPrompt = summarize(busyPrompt);
        frames.busyPromptAccepted = busyPrompt.success === true;
      } else {
        frames.note = "长任务在发命令前就结束了，未能观测到忙碌窗口";
      }
      report.phases.busyPromptWithoutBehavior = frames;
      await drain(session, run.settled);
    }

    // ---- P2：prompt 带 streamingBehavior=steer + 独立 steer 命令 ----
    if (want("steerWhileBusy")) {
      const run = await startBusyRun(session, options);
      const frames = { isStreaming: run.state?.data?.isStreaming ?? null };
      const mark = "STEER-" + Date.now().toString(36);
      if (run.busy) {
        const markIndex = session.records.length;
        const viaPrompt = await session.request(
          { id: nextId("steer-prompt"), type: "prompt", message: "排队消息 A：" + mark + "-A", streamingBehavior: "steer" },
          { timeoutMs: options.requestMs },
        ).catch((error) => ({ success: null, error: error.message }));
        const viaCommand = await session.request(
          { id: nextId("steer-cmd"), type: "steer", message: "排队消息 B：" + mark + "-B" },
          { timeoutMs: options.requestMs },
        ).catch((error) => ({ success: null, error: error.message }));
        frames.promptWithSteer = summarize(viaPrompt);
        frames.steerCommand = summarize(viaCommand);
        frames.queueFrames = queueFrames(session, markIndex);
        const state = await getState(session, options);
        frames.pendingMessageCount = state.data?.pendingMessageCount ?? null;
        await run.settled.catch(() => null);
        const messages = await getMessages(session, options);
        frames.deliveredA = hasText(messages, mark + "-A");
        frames.deliveredB = hasText(messages, mark + "-B");
      } else {
        frames.note = "未捕捉到忙碌窗口";
      }
      report.phases.steerWhileBusy = frames;
      await drain(session, Promise.resolve());
    }

    // ---- P3a：独立 follow_up 命令（对照路径） ----
    if (want("followUpWhileBusy")) {
      const frames = await measureFollowUp(session, options, { viaPrompt: false });
      report.phases.followUpWhileBusy = frames;
      await drain(session, Promise.resolve());
    }

    // ---- P3b：prompt + streamingBehavior=followUp（SOXU 的真实线格式） ----
    if (want("followUpPromptWhileBusy")) {
      const frames = await measureFollowUp(session, options, { viaPrompt: true });
      report.phases.followUpPromptWhileBusy = frames;
      await drain(session, Promise.resolve());
    }

    // ---- P4：空闲时带 streamingBehavior 是否被接受 ----
    if (want("idleWithStreamingBehavior")) {
      const mark = "IDLE-" + Date.now().toString(36);
      const response = await session.request(
        { id: nextId("idle-behavior"), type: "prompt", message: "空闲时带 steer 行为：" + mark, streamingBehavior: "steer" },
        { timeoutMs: options.requestMs },
      ).catch((error) => ({ success: null, error: error.message }));
      const settled = await session.waitEvent("agent_settled", { timeoutMs: options.settleMs }).catch(() => null);
      report.phases.idleWithStreamingBehavior = {
        response: summarize(response),
        settled: settledFrame(settled),
        delivered: hasText(await getMessages(session, options), mark),
      };
      await drain(session, Promise.resolve());
    }

    // ---- P5：abort 之后排队消息是否还会执行 ----
    if (want("abortWithQueuedFollowUp")) {
      const run = await startBusyRun(session, options);
      const frames = { isStreaming: run.state?.data?.isStreaming ?? null };
      const mark = "ABORTQ-" + Date.now().toString(36);
      if (run.busy) {
        const queued = await session.request(
          { id: nextId("abort-queue"), type: "follow_up", message: "中止后是否还会执行：" + mark },
          { timeoutMs: options.requestMs },
        ).catch((error) => ({ success: null, error: error.message }));
        frames.queued = summarize(queued);
        const abort = await session.request({ id: nextId("abort"), type: "abort" }, { timeoutMs: options.requestMs })
          .catch((error) => ({ success: null, error: error.message }));
        frames.abort = summarize(abort);
        const settledRecord = await run.settled.catch(() => null);
        frames.settled = settledFrame(settledRecord);
        const state = await getState(session, options);
        frames.isStreamingAfterAbort = state.data?.isStreaming ?? null;
        frames.pendingMessageCount = state.data?.pendingMessageCount ?? null;
        frames.delivered = hasText(await getMessages(session, options), mark);
      } else {
        frames.note = "未捕捉到忙碌窗口";
      }
      report.phases.abortWithQueuedFollowUp = frames;
      await drain(session, Promise.resolve());
    }

    // ---- P6：clear_queue 能撤掉排队消息 ----
    if (want("clearQueue")) {
      const run = await startBusyRun(session, options);
      const frames = { isStreaming: run.state?.data?.isStreaming ?? null };
      const mark = "CLEAR-" + Date.now().toString(36);
      if (run.busy) {
        await session.request(
          { id: nextId("clear-steer"), type: "steer", message: "待清空 steer：" + mark + "-S" },
          { timeoutMs: options.requestMs },
        ).catch(() => null);
        await session.request(
          { id: nextId("clear-follow"), type: "follow_up", message: "待清空 followUp：" + mark + "-F" },
          { timeoutMs: options.requestMs },
        ).catch(() => null);
        const cleared = await session.request({ id: nextId("clear"), type: "clear_queue" }, { timeoutMs: options.requestMs })
          .catch((error) => ({ success: null, error: error.message }));
        frames.clearQueue = {
          ...summarize(cleared),
          steering: Array.isArray(cleared.data?.steering) ? cleared.data.steering.length : null,
          followUp: Array.isArray(cleared.data?.followUp) ? cleared.data.followUp.length : null,
        };
        await run.settled.catch(() => null);
        const messages = await getMessages(session, options);
        frames.deliveredS = hasText(messages, mark + "-S");
        frames.deliveredF = hasText(messages, mark + "-F");
      } else {
        frames.note = "未捕捉到忙碌窗口";
      }
      report.phases.clearQueue = frames;
      await drain(session, Promise.resolve());
    }

    const parseErrors = [...session.parseErrors];
    report.phases.sessionHealth = { parseErrors, records: session.records.length };
  } catch (error) {
    report.error = error.message.slice(0, 400);
  } finally {
    if (session) await session.close({ graceMs: 8_000 }).catch(() => null);
  }

  // ---- P7：两个独立运行时并行（parallel = 新会话，不打断当前） ----
  if (want("parallelTwoRuntimes")) try {
    const a = new RpcSession({ ...commandPlan(options.pi, RPC_ARGS(sessionDir, ["--session-id", "probe-parallel-a"])), cwd: workDir, env: childEnv() }).start();
    const b = new RpcSession({ ...commandPlan(options.pi, RPC_ARGS(sessionDir, ["--session-id", "probe-parallel-b"])), cwd: workDir, env: childEnv() }).start();
    const markA = "PARA-A-" + Date.now().toString(36);
    const markB = "PARA-B-" + Date.now().toString(36);
    const settledA = a.waitEvent("agent_settled", { timeoutMs: options.settleMs });
    const settledB = b.waitEvent("agent_settled", { timeoutMs: options.settleMs });
    const [ra, rb] = await Promise.all([
      a.request({ id: nextId("pa"), type: "prompt", message: "只回复：" + markA }, { timeoutMs: options.requestMs }),
      b.request({ id: nextId("pb"), type: "prompt", message: "只回复：" + markB }, { timeoutMs: options.requestMs }),
    ]);
    const [sa, sb] = await Promise.all([settledA.catch(() => null), settledB.catch(() => null)]);
    const messagesA = await getMessages(a, options);
    const messagesB = await getMessages(b, options);
    report.phases.parallelTwoRuntimes = {
      responseA: summarize(ra),
      responseB: summarize(rb),
      settledA: settledFrame(sa),
      settledB: settledFrame(sb),
      // 交叉污染检查：A 的会话里不能出现 B 的标记，反之亦然。
      crossTalk: hasText(messagesA, markB) || hasText(messagesB, markA),
      ownTextPresent: hasText(messagesA, markA) && hasText(messagesB, markB),
    };
    await Promise.all([a.close({ graceMs: 8_000 }), b.close({ graceMs: 8_000 })]).catch(() => null);
  } catch (error) {
    report.phases.parallelTwoRuntimes = { error: error.message.slice(0, 300) };
  }

  // 没跑的阶段要显式记下来：报告里「缺一项」和「这一项被跳过」不能混为一谈。
  report.skippedPhases = PHASE_NAMES.filter((name) => !(name in report.phases));

  if (!options.keep) await rm(tempRoot, { recursive: true, force: true }).catch(() => null);

  // --merge：局部重测（--only）时不丢旧证据。同名的阶段以本次为准，其余保留，
  // 并把上一轮的时间/环境记下来，避免把两次运行混成一次。
  if (options.out && options.merge) {
    const existing = await readFile(options.out, "utf8")
      .then((text) => JSON.parse(text))
      .catch(() => null);
    if (existing && existing.kind === report.kind) {
      report.phases = { ...existing.phases, ...report.phases };
      report.previousRuns = [...(existing.previousRuns ?? []), {
        startedAt: existing.startedAt ?? null,
        finishedAt: existing.finishedAt ?? null,
        requestedPhases: existing.requestedPhases ?? null,
        environment: existing.environment ?? null,
      }];
      report.skippedPhases = PHASE_NAMES.filter((name) => !(name in report.phases));
    }
  }

  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.now() - startedAt;
  report.tempRoot = options.keep ? tempRoot : "(removed)";
  const printable = redactHome(report);
  const json = JSON.stringify(printable, null, 2);
  if (options.out) {
    await mkdir(dirname(options.out), { recursive: true });
    await writeFile(options.out, json + "\n", "utf8");
  }
  if (options.json) {
    console.log(json);
  } else {
    console.log("SOXU 发送模式探测 · " + report.environment.platform + " · pi " + (report.environment.piVersion ?? "?") + " · 模型 " + (report.environment.model ?? "?"));
    for (const [name, phase] of Object.entries(report.phases)) {
      console.log("  " + name + ": " + JSON.stringify(phase));
    }
    console.log("限制: " + report.limits.join(" "));
  }
  return 0;
}

main().then((code) => { process.exitCode = code; }).catch((error) => {
  console.error("探测无法执行: " + error.message);
  process.exitCode = 2;
});
