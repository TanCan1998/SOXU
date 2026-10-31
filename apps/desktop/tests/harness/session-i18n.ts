/**
 * Issue #144 的 DOM 夹具：把真正的 SessionTabs / ChatPanel（含 MessageList、
 * MessageActions、ChatComposer、ComposerSendMenu、SessionStatsRow / Ring）挂到浏览器里，
 * 用一份确定性数据验证「切到 en-US 后会话区与输入区完整英文渲染」。
 *
 * 语言由查询串决定（?locale=en-US），走的是和真实应用同一个 useLocale().setLocale，
 * 因此截图里看到的文案就是用户切语言后看到的文案，不是手写的翻译表。
 *
 * 只在 pnpm dev 的本地开发服务器里使用，不参与生产构建，也不连接 Pi。
 */

import { createApp, h } from "vue";
import { TooltipProvider } from "reka-ui";

import "../../src/styles/tokens.css";
import "../../src/styles/base.css";
import ChatPanel from "../../src/components/ChatPanel.vue";
import SessionTabs from "../../src/components/SessionTabs.vue";
import { useLocale } from "../../src/locales/index.ts";
import { DEFAULT_SESSION_SETTINGS } from "../../src/settings/sessionSettings.ts";
import { emptyStats } from "../support/fakeBridge.ts";
import type { ChatMessage, SessionTab } from "../../src/workspace/types.ts";

const SESSION = "harness_ses_i18n";
const CREATED = new Date(2026, 0, 2, 9, 5, 0).toISOString();

function message(
  over: Partial<ChatMessage> & { id: string; role: ChatMessage["role"]; text: string },
): ChatMessage {
  return {
    ordinal: null,
    partial: false,
    streaming: false,
    source: "history",
    createdAt: CREATED,
    ...over,
  };
}

/** 覆盖会话区的每条文案：标签、角色、时间戳、截断提示、工具折叠、历史提示。 */
const MESSAGES: ChatMessage[] = [
  message({ id: SESSION + ":1", role: "user", text: "Show the failing test in the composer." }),
  message({
    id: SESSION + ":2",
    role: "assistant",
    text: "The composer hint comes from the locale pack now.\n\n```ts\nt('composer.hint.enter')\n```",
  }),
  message({ id: SESSION + ":3", role: "tool", text: "x".repeat(420) }),
  message({
    id: SESSION + ":4",
    role: "assistant",
    text: "Truncated preview entry.",
    truncated: true,
  }),
  message({ id: SESSION + ":5", role: "system", text: "Session resumed from JSONL.", partial: true }),
];

const stats = {
  ...emptyStats(SESSION),
  runtimeId: SESSION + "#1",
  generation: 3,
  context: { used: 120_000, total: 200_000, percent: 60 },
  turn: {
    turns: 3,
    inFlight: true,
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

const tab: SessionTab = {
  sessionId: SESSION,
  projectId: "prj_1",
  worktreeId: null,
  title: "i18n harness",
  mode: "temporary",
  status: "running",
  error: null,
  messages: MESSAGES,
  history: {
    loaded: 12,
    total: 1_203,
    next: 12,
    loading: false,
    evicted: 12,
    evictedLive: 3,
  },
  runtime: {
    runtimeId: SESSION + "#1",
    generation: 3,
    state: "running",
    exitReason: null,
    retry: null,
  },
  stats: { loading: false, pending: false, error: null, data: stats, seq: 1 },
  draft: "Check the composer hint",
  diagnostics: [],
  promoting: false,
  search: {
    query: "",
    loading: false,
    error: null,
    hits: [],
    totalHits: 0,
    scannedEntries: 0,
    truncated: false,
    degraded: false,
    tookMs: 0,
    seq: 0,
  },
};

/** 时间戳打开，才能在截图里看到「语言决定 12/24 小时制」。 */
const SETTINGS = { ...DEFAULT_SESSION_SETTINGS, showTimestamps: true, showToolCalls: false };

const requested = new URLSearchParams(location.search).get("locale") ?? "zh-CN";
// 与真实应用同一个运行时：换表即重渲染，组件不重建。
await useLocale().setLocale(requested, { persist: false });

const app = createApp({
  setup() {
    // 与 main.ts 一致：AppTooltip 必须处在 TooltipProvider 之内，否则 Reka UI 直接抛错。
    return () =>
      h(TooltipProvider, { delayDuration: 400 }, () =>
        h(
          "div",
          {
            style: {
              display: "flex",
              flexDirection: "column",
              height: "100%",
              background: "var(--soxu-bg)",
              color: "var(--soxu-fg)",
              fontFamily: "var(--soxu-font-family)",
            },
          },
          [
            h(SessionTabs, { tabs: [tab], activeSessionId: SESSION }),
            h(ChatPanel, {
              tab,
              bridgeAvailable: true,
              busy: false,
              defaultDelivery: "steer",
              settings: SETTINGS,
              focusMessageId: null,
              focusNonce: 0,
            }),
          ],
        ),
      );
  },
});

app.mount("#app");

(window as unknown as Record<string, unknown>).__soxuI18n = {
  locale: useLocale().locale.value,
  messages: MESSAGES.length,
};
