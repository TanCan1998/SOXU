/**
 * Issue #36 · 50,000 条事件长会话的内存采样（可重复、离线、零外网）。
 *
 * 做什么：
 * 1. 用确定性夹具驱动真实的 `WorkspaceSession`（与桌面端同一份分页/窗口逻辑）；
 * 2. 在基线、首屏、翻 24 页、关闭 Tab 四个检查点采样 `process.memoryUsage()`；
 * 3. 额外跑 300 轮实时对话，验证实时追加路径同样受窗口约束（不是只对历史成立）；
 * 4. 再跑一个「不做窗口释放」的对照组，量化有界缓存的差别；
 * 5. 输出含平台、Node 版本、参数与原始采样值的 JSON，便于别人用同样命令复现。
 *
 * 不是什么：
 * - 不是 Tauri WebView 的进程 RSS，也不是 Windows/macOS/Linux 的实机验收；
 * - 不代表真实 Pi 会话的分布（夹具刻意放大了长工具输出的比例）。
 *
 * 用法（在 apps/desktop 下）：
 *   node --expose-gc tests/perf/longSessionMemory.mjs
 *   node --expose-gc tests/perf/longSessionMemory.mjs --out <path.json>
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { cpus, platform, release, totalmem, arch } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { WorkspaceSession } from "../../src/workspace/sessionWorkspace.ts";
import {
  MAX_MESSAGE_CHARS,
  MAX_TAB_HISTORY_CHARS,
  MAX_TAB_HISTORY_MESSAGES,
  MAX_TAB_LIVE_MESSAGES,
} from "../../src/workspace/types.ts";
import {
  LONG_SESSION_EVENTS,
  LONG_SESSION_ID,
  LongSessionBridge,
} from "../support/longSession.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGES = 24;
/** 实时追加路径的检查点：300 轮问答 = 600 条实时消息。 */
const LIVE_ROUNDS = 300;

function sample(label, extra = {}) {
  if (typeof globalThis.gc === "function") globalThis.gc();
  const usage = process.memoryUsage();
  return {
    label,
    rssBytes: usage.rss,
    heapTotalBytes: usage.heapTotal,
    heapUsedBytes: usage.heapUsed,
    externalBytes: usage.external,
    ...extra,
  };
}

function toMiB(bytes) {
  return Math.round((bytes / 1024 / 1024) * 10) / 10;
}

function retained(messages) {
  return {
    messages: messages.length,
    chars: messages.reduce((sum, message) => sum + message.text.length, 0),
    maxMessageChars: messages.reduce((max, message) => Math.max(max, message.text.length), 0),
  };
}

async function measureBounded() {
  const bridge = new LongSessionBridge();
  const session = new WorkspaceSession(bridge);
  const samples = [sample("baseline")];

  await session.openSession({
    sessionId: LONG_SESSION_ID,
    projectId: "prj_long",
    title: "5 万事件长会话",
  });
  let tab = session.tab(LONG_SESSION_ID);
  samples.push(
    sample("first-screen", {
      retained: retained(tab.messages),
      servedEntries: bridge.servedEntries,
      servedTextChars: bridge.servedTextChars,
      history: { ...tab.history },
    }),
  );

  for (let index = 0; index < PAGES; index += 1) await session.loadMore(LONG_SESSION_ID);
  samples.push(
    sample("after-load-more", {
      retained: retained(tab.messages),
      servedEntries: bridge.servedEntries,
      servedTextChars: bridge.servedTextChars,
      history: { ...tab.history },
      pagesLoaded: PAGES + 1,
    }),
  );

  await session.closeTab(LONG_SESSION_ID);
  // 必须丢掉引用，否则采样时 Tab 内容仍然可达，看不出「关闭后释放」。
  tab = null;
  samples.push(sample("after-close-tab", { tabs: session.workspace.tabs.length }));
  await session.dispose();
  return { samples, bridge };
}

/**
 * 实时追加路径：300 轮问答（每轮一条用户消息 + 一条助手回复）。
 *
 * 这是「实时消息也必须有界」的直接证据：窗口生效时保留 `MAX_TAB_LIVE_MESSAGES` 条，
 * 未生效时会保留全部 600 条。用独立会话跑，避免污染历史分页那组数字。
 */
async function measureLiveWindow() {
  const bridge = new LongSessionBridge({ events: 40 });
  const session = new WorkspaceSession(bridge);
  await session.openSession({
    sessionId: LONG_SESSION_ID,
    projectId: "prj_long",
    title: "实时追加窗口",
  });

  for (let round = 0; round < LIVE_ROUNDS; round += 1) {
    await session.sendPrompt(LONG_SESSION_ID, `第 ${round} 轮：继续`);
    bridge.deliver({
      sessionId: LONG_SESSION_ID,
      runtimeId: `${LONG_SESSION_ID}#1`,
      generation: 1,
      type: "stream",
      event: "message_update",
      data: { delta: `第 ${round} 轮回复` },
    });
    bridge.deliver({
      sessionId: LONG_SESSION_ID,
      runtimeId: `${LONG_SESSION_ID}#1`,
      generation: 1,
      type: "settled",
      data: {},
    });
  }

  let tab = session.tab(LONG_SESSION_ID);
  const result = sample("live-300-rounds", {
    retained: retained(tab.messages),
    liveMessages: tab.messages.filter((message) => message.source === "live").length,
    history: { ...tab.history },
    rounds: LIVE_ROUNDS,
    appendedLiveMessages: LIVE_ROUNDS * 2,
  });
  await session.dispose();
  tab = null;
  return result;
}

/**
 * 对照组 A：把所有页的**预览**都留在内存里（等价于「一次加载整个索引」）。
 * 这是「UI 不一次加载整个 JSONL」要避免的状态，用来量化窗口的价值。
 */
function measurePreviewControl() {
  const fixture = new LongSessionBridge().fixture;
  const messages = [];
  for (let offset = 0; offset < fixture.events; offset += 40) {
    for (const entry of fixture.page(offset, 40).entries) {
      messages.push({ id: entry.ordinal, text: entry.preview });
    }
  }
  const result = sample("control-all-previews", { retained: retained(messages) });
  if (messages.length !== fixture.events) throw new Error("control run 条目数不符");
  return result;
}

/** 对照组 B：全部 50,000 条都补齐完整正文（约 1 亿字符），默认不跑，需 --full-control。 */
function measureFullControl() {
  const fixture = new LongSessionBridge().fixture;
  const messages = [];
  for (let offset = 0; offset < fixture.events; offset += 40) {
    for (const entry of fixture.page(offset, 40).entries) {
      messages.push({ id: entry.ordinal, text: fixture.text(entry.ordinal) });
    }
  }
  const result = sample("control-full-text", { retained: retained(messages) });
  if (messages.length !== fixture.events) throw new Error("control run 条目数不符");
  return result;
}

function parseOut(argv) {
  const index = argv.indexOf("--out");
  if (index === -1) return null;
  const value = argv[index + 1];
  if (!value) throw new Error("--out 需要一个文件路径");
  return resolve(process.cwd(), value);
}

const bounded = await measureBounded();
const liveWindow = await measureLiveWindow();
const previewControl = measurePreviewControl();
const fullControl = process.argv.includes("--full-control") ? measureFullControl() : null;

const report = {
  issue: 36,
  task: "P-04 长会话：50,000 条事件的首屏、DOM 与缓存边界",
  generatedAt: new Date().toISOString(),
  method: "node --expose-gc tests/perf/longSessionMemory.mjs",
  note: "V8 进程堆采样（Node），不是 Tauri WebView 进程 RSS，也不是实机验收",
  platform: {
    os: platform(),
    release: release(),
    arch: arch(),
    cpus: cpus().length,
    cpuModel: cpus()[0]?.model ?? "unknown",
    totalMemMiB: Math.round(totalmem() / 1024 / 1024),
    node: process.version,
    gcAvailable: typeof globalThis.gc === "function",
  },
  fixture: {
    events: LONG_SESSION_EVENTS,
    pageSize: 40,
    pagesLoaded: PAGES + 1,
    longOutputEvery: 10,
    longOutputChars: 20_000,
  },
  limits: {
    maxTabHistoryMessages: MAX_TAB_HISTORY_MESSAGES,
    maxTabHistoryChars: MAX_TAB_HISTORY_CHARS,
    maxTabLiveMessages: MAX_TAB_LIVE_MESSAGES,
    maxMessageChars: MAX_MESSAGE_CHARS,
  },
  samples: bounded.samples.map((item) => ({
    ...item,
    rssMiB: toMiB(item.rssBytes),
    heapUsedMiB: toMiB(item.heapUsedBytes),
  })),
  liveWindow: {
    ...liveWindow,
    rssMiB: toMiB(liveWindow.rssBytes),
    heapUsedMiB: toMiB(liveWindow.heapUsedBytes),
  },
  controls: [previewControl, ...(fullControl ? [fullControl] : [])].map((item) => ({
    ...item,
    rssMiB: toMiB(item.rssBytes),
    heapUsedMiB: toMiB(item.heapUsedBytes),
  })),
  backend: {
    servedEntries: bounded.bridge.servedEntries,
    servedTextChars: bounded.bridge.servedTextChars,
    servedBytes: bounded.bridge.servedBytes,
    requests: bounded.bridge.pageRequests.length,
  },
};

const out = parseOut(process.argv.slice(2));
if (out) {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`已写入 ${out}`);
}

console.log(`# 平台 ${report.platform.os} ${report.platform.release} / Node ${report.platform.node}`);
for (const item of report.samples) {
  const retainedInfo = item.retained
    ? ` 保留 ${item.retained.messages} 条 / ${item.retained.chars} 字符`
    : "";
  console.log(
    `${item.label.padEnd(18)} heapUsed ${String(item.heapUsedMiB).padStart(7)} MiB  rss ${String(item.rssMiB).padStart(7)} MiB${retainedInfo}`,
  );
}
for (const item of report.controls) {
  console.log(
    `${item.label.padEnd(18)} heapUsed ${String(item.heapUsedMiB).padStart(7)} MiB  rss ${String(item.rssMiB).padStart(7)} MiB 保留 ${item.retained.messages} 条 / ${item.retained.chars} 字符`,
  );
}
console.log(
  `${report.liveWindow.label.padEnd(18)} heapUsed ${String(report.liveWindow.heapUsedMiB).padStart(7)} MiB  rss ${String(report.liveWindow.rssMiB).padStart(7)} MiB 保留 ${report.liveWindow.retained.messages} 条（实时 ${report.liveWindow.liveMessages} 条，已释放 ${report.liveWindow.history.evictedLive} 条）`,
);
console.log(
  `后端读取：${report.backend.requests} 次分页 / ${report.backend.servedEntries} 条 / ${report.backend.servedTextChars} 字符`,
);
