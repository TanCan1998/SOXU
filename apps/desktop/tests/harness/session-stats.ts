/**
 * Issue #119 的 DOM 夹具：把真正的 SessionStatsRing 与 SessionStatsRow 挂到浏览器里，
 * 用四组确定性快照验证「圆环随占用率变色」与「无数据时显示占位」。
 *
 * 只在 pnpm dev 的本地开发服务器里使用，不参与生产构建，也不连接 Pi：
 * 四组快照覆盖 <60 / 60–85 / >85 三档阈值与「窗口未知」的空态，
 * 数值来自与 Rust 侧同形的 session_stats 返回。
 */

import { createApp, h, ref } from "vue";

import "../../src/styles/tokens.css";
import "../../src/styles/base.css";
import SessionStatsRing from "../../src/components/SessionStatsRing.vue";
import SessionStatsRow from "../../src/components/SessionStatsRow.vue";
import { composeStatsView, type SessionStatsView } from "../../src/components/sessionStats.ts";
import { emptyStats } from "../support/fakeBridge.ts";
import type { SessionStats } from "../../src/workspace/types.ts";

const SESSION = "harness_ses_stats";

function sampled(used: number, total: number, percent: number): SessionStats {
  return {
    ...emptyStats(SESSION),
    runtimeId: SESSION + "#1",
    generation: 1,
    context: { used, total, percent },
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
  };
}

interface Case {
  key: string;
  title: string;
  view: SessionStatsView;
}

const HISTORY = { loaded: 240, total: 1_203, next: null, loading: false, evicted: 0, evictedLive: 0 };

const CASES: Case[] = [
  { key: "accent", title: "42% · 强调色（<60%）", view: composeStatsView(sampled(84_000, 200_000, 42), { history: HISTORY }) },
  { key: "warn", title: "72% · 警告（60–85%）", view: composeStatsView(sampled(144_000, 200_000, 72), { history: HISTORY }) },
  { key: "danger", title: "92% · 危险（>85%）", view: composeStatsView(sampled(184_000, 200_000, 92), { history: HISTORY }) },
  {
    key: "empty",
    title: "无数据 · 全部占位",
    view: composeStatsView(null, { history: { ...HISTORY, loaded: 0, total: 0 } }),
  },
];

const app = createApp({
  setup() {
    const open = ref<string | null>(null);
    return () =>
      h(
        "main",
        {
          style: {
            display: "flex",
            flexDirection: "column",
            gap: "14px",
            padding: "24px",
            fontFamily: "var(--soxu-font-family)",
            background: "var(--soxu-bg)",
            color: "var(--soxu-fg)",
            minHeight: "100%",
          },
        },
        CASES.map((item) =>
          h(
            "section",
            {
              key: item.key,
              class: "harness-case",
              "data-case": item.key,
              style: {
                display: "flex",
                flexDirection: "column",
                gap: "8px",
                padding: "12px 14px",
                border: "1px solid var(--soxu-border)",
                borderRadius: "12px",
                background: "var(--soxu-panel)",
                maxWidth: "560px",
              },
            },
            [
              h("strong", { style: { fontSize: "0.75rem" } }, item.title),
              h(
                "div",
                { style: { display: "flex", alignItems: "center", gap: "10px" } },
                [
                  h(SessionStatsRing, {
                    view: item.view,
                    onRefresh: () => {
                      open.value = item.key;
                    },
                  }),
                ],
              ),
              h(SessionStatsRow, { view: item.view }),
            ],
          ),
        ),
      );
  },
});

app.mount("#app");

// 供截图脚本探测：暴露夹具状态，避免脚本去猜 DOM 结构。
(window as unknown as Record<string, unknown>).__soxuStats = {
  cases: CASES.map((item) => ({ key: item.key, hasData: item.view.hasData })),
};
