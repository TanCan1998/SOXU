/**
 * Issue #119 · TASK-027：上下文环、统计浮窗与底部统计行的契约。
 *
 * 能在 Node 里确定验证的部分：
 * 1. 圆环颜色随占用率变化（<60 强调 / 60–85 警告 / >85 危险，边界值逐个钉住）；
 * 2. 圆环几何（14px、stroke 2.8，占用率越高留白越少）；
 * 3. 无数据时显示占位而不是 0（格式化、统计行、浮窗三层都验）；
 * 4. 浮窗数值与事件流一致：统计行与浮窗读同一个视图对象，刷新只由事件驱动；
 * 5. 刷新路径：事件边界触发、请求序号丢弃迟到响应、进行中只排队一次补拉；
 * 6. 组件接线：环挂在 composer 右侧、统计行在其下方、没有任何定时器。
 *
 * 真实渲染与像素结果由 tests/harness 与证据文档负责，见
 * docs/development/session-stats.md。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PLACEHOLDER,
  RING_DANGER_PCT,
  RING_SIZE,
  RING_STROKE,
  RING_WARN_PCT,
  composeStatsView,
  formatCount,
  formatMb,
  formatMs,
  formatPercent,
  formatRate,
  formatTokenCount,
  processDegradedNotes,
  ringGeometry,
  ringLabel,
  ringTone,
  shouldRefreshStats,
  statsPopoverSections,
  statsRowItems,
} from "../src/components/sessionStats.ts";
import { WorkspaceSession } from "../src/workspace/sessionWorkspace.ts";
import { createStatsState, type SessionStats } from "../src/workspace/types.ts";
import { FakeBridge, deferred, emptyStats } from "./support/fakeBridge.ts";

const SRC_ROOT = fileURLToPath(new URL("../src", import.meta.url));
const SESSION = "ses_a";

async function readSource(relative: string): Promise<string> {
  return readFile(join(SRC_ROOT, relative), "utf8");
}

/** 一份「跑完了一轮」的统计快照：数值取自事件流的可复算结果。 */
function sampledStats(overrides: Partial<SessionStats> = {}): SessionStats {
  return {
    ...emptyStats(SESSION),
    runtimeId: `${SESSION}#1`,
    generation: 1,
    context: { used: 120_000, total: 200_000, percent: 60 },
    turn: {
      turns: 3,
      inFlight: false,
      firstTokenMs: 420,
      durationMs: 2_400,
      streamTokensPerSec: 12.5,
      avgTokensPerSec: 9.5,
      cacheHitPct: 80,
    },
    process: { rssMb: 128.5, cpuPct: null, childCount: 1, degraded: ["cpu_unsupported"] },
    session: {
      entriesTotal: 1_203,
      worktree: "F:/work/soxu",
      inputTokens: 9_000,
      outputTokens: 1_200,
      retry: null,
    },
    updatedAtMs: 1_700_000_000_000,
    ...overrides,
  };
}

/** 让 void 出去的异步刷新跑完（事件驱动的刷新不返回 Promise）。 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("圆环规格：14px、stroke 2.8", () => {
  assert.equal(RING_SIZE, 14);
  assert.equal(RING_STROKE, 2.8);
  const geometry = ringGeometry(0);
  assert.equal(geometry.radius, (14 - 2.8) / 2, "半径要扣掉半个线宽，描边不能溢出");
  assert.ok(Math.abs(geometry.circumference - 2 * Math.PI * 5.6) < 1e-9);
});

test("圆环颜色随占用率变化：<60 accent / 60–85 warn / >85 danger", () => {
  assert.equal(ringTone(0), "accent");
  assert.equal(ringTone(59.9), "accent");
  assert.equal(ringTone(RING_WARN_PCT), "warn", "60% 是警告档的起点（含）");
  assert.equal(ringTone(72), "warn");
  assert.equal(ringTone(RING_DANGER_PCT), "warn", "85% 仍属警告档");
  assert.equal(ringTone(85.1), "danger");
  assert.equal(ringTone(100), "danger");
  // 没有窗口信息时不猜比例：空心圆环，而不是 0% 的强调色圆环。
  assert.equal(ringTone(null), "unknown");
  assert.equal(ringTone(Number.NaN), "unknown");
});

test("圆环弧长按占用率填充，并钳制在 0–100", () => {
  const empty = ringGeometry(0);
  assert.equal(empty.dashOffset, empty.circumference, "0% 时整圈留白");
  assert.equal(ringGeometry(100).dashOffset, 0, "100% 时不留白");
  const half = ringGeometry(50);
  assert.ok(Math.abs(half.dashOffset - half.circumference / 2) < 1e-9);
  assert.equal(ringGeometry(140).dashOffset, 0, "超出 100% 不能画成负留白");
  assert.equal(ringGeometry(-10).dashOffset, ringGeometry(0).dashOffset);
  assert.equal(ringGeometry(null).dashOffset, ringGeometry(0).dashOffset);
});

test("无数据时显示占位而不是 0", () => {
  assert.equal(PLACEHOLDER, "—");
  assert.equal(formatPercent(null), PLACEHOLDER);
  assert.equal(formatMs(null), PLACEHOLDER);
  assert.equal(formatRate(null), PLACEHOLDER);
  assert.equal(formatMb(null), PLACEHOLDER);
  assert.equal(formatCount(null), PLACEHOLDER);
  assert.equal(formatTokenCount(null), PLACEHOLDER);
  // 真实的 0 仍然显示 0：占位只用于「没观测到」。
  assert.equal(formatPercent(0), "0.0%");
  assert.equal(formatCount(0), "0");
  assert.equal(formatMs(0), "0 ms");
});

test("空快照的统计行与浮窗全部是占位，没有一个 0", () => {
  const view = composeStatsView(null, null);
  assert.equal(view.hasData, false);
  const row = statsRowItems(view);
  assert.deepEqual(
    row.map((item) => item.key),
    ["turns", "firstToken", "duration", "stream", "avg", "cache", "tokens"],
    "底部统计行的七项顺序固定",
  );
  for (const item of row) {
    assert.ok(
      item.value.includes(PLACEHOLDER),
      `${item.label} 无数据时必须显示占位，实际是 ${item.value}`,
    );
  }
  const values = statsPopoverSections(view)
    .flatMap((section) => section.items)
    .map((item) => item.value);
  assert.ok(values.every((value) => value.includes(PLACEHOLDER)));
  assert.ok(!values.includes("0"), "没有任何一项被写成 0");
});

test("浮窗与统计行读同一份快照：同名项数值一致", () => {
  const stats = sampledStats();
  const view = composeStatsView(stats, {
    history: { loaded: 240, total: 1_203, next: null, loading: false, evicted: 12, evictedLive: 3 },
  });
  const row = new Map(statsRowItems(view).map((item) => [item.key, item.value]));
  const popover = new Map(
    statsPopoverSections(view).flatMap((section) => section.items.map((item) => [item.key, item.value])),
  );
  for (const key of ["turns", "firstToken", "duration", "cache"]) {
    assert.equal(row.get(key), popover.get(key), `${key} 在统计行与浮窗里必须相同`);
  }
  assert.equal(row.get("firstToken"), "420 ms");
  assert.equal(row.get("duration"), "2.40 s");
  assert.equal(row.get("cache"), "80.0%");
  assert.equal(row.get("stream"), "12.5 tok/s");
  assert.equal(row.get("tokens"), "9.0k / 1.2k");
});

test("载入数来自 Tab 窗口，条目总数优先用后端索引", () => {
  const withIndex = composeStatsView(sampledStats(), {
    history: { loaded: 240, total: 999, next: null, loading: false, evicted: 0, evictedLive: 0 },
  });
  assert.equal(withIndex.session.loaded, 240, "已载入条数是前端自己的内存窗口");
  assert.equal(withIndex.session.total, 1_203, "总数以后端索引为准");
  assert.equal(
    statsPopoverSections(withIndex)[3].items[0].value,
    "240 / 1,203",
  );

  const withoutIndex = composeStatsView(
    sampledStats({ session: { ...sampledStats().session, entriesTotal: null } }),
    { history: { loaded: 40, total: 88, next: 40, loading: false, evicted: 0, evictedLive: 0 } },
  );
  assert.equal(withoutIndex.session.total, 88, "索引缺失时回退到历史总数");
});

test("上下文比例需要 used 与 total 同时存在", () => {
  const partial = composeStatsView(
    sampledStats({ context: { used: 120_000, total: null, percent: null } }),
    null,
  );
  assert.equal(partial.context.percent, null);
  assert.equal(ringTone(partial.context.percent), "unknown");
  assert.match(ringLabel(partial), /窗口未知/);
  assert.equal(formatPercent(partial.context.percent), PLACEHOLDER);

  const full = composeStatsView(sampledStats(), null);
  assert.equal(ringLabel(full), "上下文占用 60.0%（120.0k / 200.0k token）");
});

test("进程降级说明翻译成人话，未知标识原样保留", () => {
  assert.deepEqual(processDegradedNotes(["cpu_unsupported"]), ["当前平台不提供 CPU 占用"]);
  assert.deepEqual(processDegradedNotes(["runtime_not_running"]), [
    "Pi 运行时未启动，无法采样进程",
  ]);
  assert.deepEqual(processDegradedNotes(["whatever"]), ["whatever"]);
});

test("刷新只由 state / settled / exit 触发，流式增量不触发", () => {
  const base = { sessionId: SESSION, runtimeId: `${SESSION}#1`, generation: 1 };
  assert.equal(shouldRefreshStats({ ...base, type: "state", state: "running" }), true);
  assert.equal(shouldRefreshStats({ ...base, type: "settled" }), true);
  assert.equal(shouldRefreshStats({ ...base, type: "exit", code: 0, reason: "requested_abort" }), true);
  assert.equal(
    shouldRefreshStats({ ...base, type: "stream", event: "message_update", data: { delta: "x" } }),
    false,
    "每条 token 都拉一次统计等于把轮询搬进事件里",
  );
  assert.equal(shouldRefreshStats({ ...base, type: "stderr", line: "x" }), false);
});

test("组件与工作区里没有任何统计轮询定时器", async () => {
  for (const relative of [
    "components/sessionStats.ts",
    "components/SessionStatsRing.vue",
    "components/SessionStatsRow.vue",
    "workspace/sessionWorkspace.ts",
  ]) {
    const source = await readSource(relative);
    assert.ok(!source.includes("setInterval("), `${relative} 不允许统计轮询`);
    assert.ok(
      !/setTimeout\([^)]*refreshStats/u.test(source),
      `${relative} 不允许把刷新包进定时器`,
    );
  }
});

test("统计环挂在 composer 右侧，统计行在其下方", async () => {
  const composer = await readSource("components/ChatComposer.vue");
  const ringIndex = composer.indexOf("<SessionStatsRing");
  const rowIndex = composer.indexOf("<SessionStatsRow");
  const buttonsIndex = composer.indexOf("class=\"buttons\"");
  assert.ok(ringIndex > 0 && rowIndex > 0, "两个组件都必须被挂载");
  assert.ok(ringIndex > buttonsIndex, "圆环在 composer 的操作区（右侧）内");
  assert.ok(rowIndex > composer.indexOf("class=\"composer\""), "统计行在输入框下方");

  const ring = await readSource("components/SessionStatsRing.vue");
  assert.ok(ring.includes("RING_SIZE") && ring.includes("RING_STROKE"), "几何来自纯函数模块");
  assert.ok(ring.includes(":data-tone=\"tone\""), "颜色档位必须落到 DOM 上");
  assert.ok(ring.includes("aria-label"), "圆环按钮要有读屏标签");
  assert.ok(ring.includes("PopoverContent"), "浮窗用 reka-ui Popover（含焦点归还）");
});

test("打开会话后拉一次统计，并把快照写进 Tab", async () => {
  const bridge = new FakeBridge();
  bridge.stats = sampledStats();
  const session = new WorkspaceSession(bridge);
  await session.openSession({ sessionId: SESSION, projectId: "prj_1", title: "会话 A" });
  await flush();

  const tab = session.tab(SESSION);
  assert.ok(tab);
  assert.equal(tab.stats.data?.context.used, 120_000);
  assert.equal(tab.stats.error, null);
  assert.equal(bridge.count("sessionStats"), 1, "打开会话只拉一次，不做轮询");

  await session.dispose();
});

test("事件驱动的刷新：settled 会补拉，流式增量不会", async () => {
  const bridge = new FakeBridge();
  const session = new WorkspaceSession(bridge);
  await session.openSession({ sessionId: SESSION, projectId: "prj_1", title: "会话 A" });
  await session.startRuntime(SESSION);
  await flush();
  const afterOpen = bridge.count("sessionStats");

  const base = { sessionId: SESSION, runtimeId: `${SESSION}#1`, generation: 1 };
  bridge.deliver({ ...base, type: "stream", event: "message_update", data: { delta: "x" } });
  await flush();
  assert.equal(bridge.count("sessionStats"), afterOpen, "流式增量不触发刷新");

  bridge.deliver({ ...base, type: "settled" });
  await flush();
  assert.equal(bridge.count("sessionStats"), afterOpen + 1, "settled 触发一次刷新");

  await session.dispose();
});

test("请求进行中再来的触发只排队一次补拉", async () => {
  const bridge = new FakeBridge();
  bridge.stats = sampledStats();
  const session = new WorkspaceSession(bridge);
  await session.openSession({ sessionId: SESSION, projectId: "prj_1", title: "会话 A" });
  await flush();
  const tab = session.tab(SESSION);
  assert.ok(tab);

  const gate = deferred();
  bridge.statsGate = gate.promise;
  const before = bridge.count("sessionStats");
  const first = session.refreshStats(SESSION);
  const second = session.refreshStats(SESSION);
  const third = session.refreshStats(SESSION);
  assert.equal(tab.stats.pending, true, "进行中的触发只排队，不并发发请求");
  gate.resolve();
  await Promise.all([first, second, third]);
  bridge.statsGate = null;
  await flush();

  assert.equal(
    bridge.count("sessionStats"),
    before + 2,
    "一次进行中的请求 + 一次补拉，三次触发不会打出三个请求",
  );
  assert.equal(tab.stats.pending, false);
  assert.equal(tab.stats.loading, false);

  await session.dispose();
});

test("刷新失败时保留上一次快照并给出原因", async () => {
  const bridge = new FakeBridge();
  bridge.stats = sampledStats();
  const session = new WorkspaceSession(bridge);
  await session.openSession({ sessionId: SESSION, projectId: "prj_1", title: "会话 A" });
  await flush();
  const tab = session.tab(SESSION);
  assert.ok(tab);

  bridge.statsError = "E_STATS_UNAVAILABLE: 后端未响应";
  await session.refreshStats(SESSION);
  assert.equal(tab.stats.error, "E_STATS_UNAVAILABLE: 后端未响应");
  assert.equal(tab.stats.data?.turn.turns, 3, "失败不清空旧数据");
  assert.equal(tab.stats.loading, false);

  await session.dispose();
});

test("新建 Tab 的统计状态是「什么都没观测到」", () => {
  const state = createStatsState();
  assert.deepEqual(state, { loading: false, pending: false, error: null, data: null, seq: 0 });
  assert.equal(composeStatsView(state.data, null).hasData, false);
});
