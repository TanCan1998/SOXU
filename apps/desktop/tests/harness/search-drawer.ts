/**
 * Issue #118 的 DOM 夹具：把真正的 SearchDrawer 与 ChatPanel 挂到浏览器里，
 * 用确定性假数据验证「三态 + 命中高亮 + 点击跳转并高亮」的视觉与行为。
 *
 * 只在 pnpm dev 的本地开发服务器里使用，不参与生产构建，也不连接 Pi：
 * - 会话是 60 条内存消息（每 9 条有一条含「扩散」，用来验证倒序与远距离跳转）；
 * - 「后端」是 fakeSearch：线性子串匹配，命中片段与字符偏移按 Rust 的口径给出；
 * - 防抖与 store.scheduleSearch 一致（SEARCH_DEBOUNCE_MS，只保留最后一次查询），
 *   跳转复用生产代码里的 resolveJumpTarget —— 夹具不重写被测逻辑。
 */

import { computed, createApp, h, ref } from "vue";
import { TooltipProvider } from "reka-ui";

import "../../src/styles/tokens.css";
import "../../src/styles/base.css";
import ChatPanel from "../../src/components/ChatPanel.vue";
import SearchDrawer from "../../src/components/SearchDrawer.vue";
import { resolveJumpTarget } from "../../src/components/searchPanel.ts";
import { TOOLTIP_DELAY_MS, TOOLTIP_SKIP_DELAY_MS } from "../../src/components/tooltipConfig.ts";
import { DEFAULT_SESSION_SETTINGS } from "../../src/settings/sessionSettings.ts";
import {
  SEARCH_DEBOUNCE_MS,
  createSearchState,
  type ChatMessage,
  type SearchState,
  type SessionSearchHit,
  type SessionTab,
} from "../../src/workspace/types.ts";

const SESSION = "harness_ses_search";
const TOTAL = 60;

/** 会话正文：只有每 9 条一条含「扩散」，其余用来撑出虚拟列表的滚动高度。 */
const MESSAGES: ChatMessage[] = Array.from({ length: TOTAL }, (_, index) => {
  const ordinal = index + 1;
  const text =
    ordinal % 9 === 0
      ? "第 " + ordinal + " 条：讨论扩散模型的采样步数与显存占用"
      : "第 " + ordinal + " 条：记录一次普通对话，用来撑出虚拟列表的滚动高度";
  return {
    id: SESSION + ":h:" + ordinal,
    ordinal,
    role: ordinal % 2 === 0 ? "assistant" : "user",
    text,
    partial: false,
    streaming: false,
    source: "history",
    createdAt: null,
  };
});

/** 夹具版 search_session：大小写不敏感子串匹配 + 码点偏移，与 Rust 侧口径一致。 */
function fakeSearch(query: string): SessionSearchHit[] {
  const needle = query.trim();
  if (!needle) return [];
  const hits: SessionSearchHit[] = [];
  for (const message of MESSAGES) {
    const index = message.text.indexOf(needle);
    if (index < 0) continue;
    const start = Array.from(message.text.slice(0, index)).length;
    hits.push({
      ordinal: message.ordinal ?? 0,
      kind: "message",
      role: message.role === "assistant" ? "assistant" : message.role === "user" ? "user" : "custom",
      snippet: message.text,
      matchStart: start,
      matchEnd: start + Array.from(needle).length,
      totalMatches: 1,
      truncated: false,
    });
  }
  return hits;
}

const search = ref<SearchState>(createSearchState());
const notice = ref<string | null>(null);
const focusMessageId = ref<string | null>(null);
const focusNonce = ref(0);

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let lastInputAt = 0;
let latencyMs: number | null = null;

/** 与 store.scheduleSearch 同语义：窗口内只保留最后一次查询，空查询直接清空。 */
function onQuery(value: string) {
  notice.value = null;
  lastInputAt = performance.now();
  latencyMs = null;
  if (debounceTimer !== null) clearTimeout(debounceTimer);
  const trimmed = value.trim();
  if (!trimmed) {
    search.value = { ...createSearchState(), query: "" };
    return;
  }
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    const hits = fakeSearch(trimmed);
    search.value = {
      ...search.value,
      query: trimmed,
      loading: false,
      error: null,
      hits,
      totalHits: hits.length,
      scannedEntries: MESSAGES.length,
      truncated: false,
      degraded: false,
      tookMs: 1,
    };
    // 结果写进状态后再等一帧：量到的是「用户看到结果」的时刻，不是「状态变了」的时刻。
    requestAnimationFrame(() => {
      if (latencyMs === null) latencyMs = performance.now() - lastInputAt;
    });
  }, SEARCH_DEBOUNCE_MS);
}

const tab = computed<SessionTab>(() => ({
  sessionId: SESSION,
  projectId: "harness_prj",
  worktreeId: null,
  title: "搜索抽屉夹具",
  mode: "persistent",
  status: "ready",
  error: null,
  messages: MESSAGES,
  history: {
    loaded: MESSAGES.length,
    total: MESSAGES.length,
    next: null,
    loading: false,
    evicted: 0,
    evictedLive: 0,
  },
  runtime: { runtimeId: null, generation: 0, state: "idle", exitReason: null, retry: null },
  draft: "",
  diagnostics: [],
  promoting: false,
  search: search.value,
}));

/** 与 App.vue 的 onSearchJump 同一份逻辑：定位规则来自生产代码，夹具只负责接线。 */
async function onJump(hit: SessionSearchHit) {
  notice.value = null;
  const resolution = await resolveJumpTarget({
    sessionId: SESSION,
    ordinal: hit.ordinal,
    messages: () => MESSAGES,
    hasMore: () => false,
    loadMore: async () => undefined,
    isActive: () => true,
  });
  notice.value = resolution.notice;
  if (!resolution.messageId) return;
  focusMessageId.value = resolution.messageId;
  focusNonce.value += 1;
}

/**
 * 外层壳必须与生产一致：.app-shell + .main-column 提供 flex 高度约束，
 * 否则消息列表与抽屉都会随内容无限长，截图脚本也就量不到滚动行为。
 */
const Harness = {
  render: () =>
    h(
      TooltipProvider,
      { delayDuration: TOOLTIP_DELAY_MS, skipDelayDuration: TOOLTIP_SKIP_DELAY_MS },
      {
        default: () =>
          h("div", { class: "app-shell" }, [
            h("div", { class: "main-column" }, [
              h(ChatPanel, {
                tab: tab.value,
                bridgeAvailable: true,
                busy: false,
                defaultDelivery: "steer",
                settings: DEFAULT_SESSION_SETTINGS,
                focusMessageId: focusMessageId.value,
                focusNonce: focusNonce.value,
                onSend: () => undefined,
                onCancel: () => undefined,
                onStop: () => undefined,
                onLoadMore: () => undefined,
                onRetry: () => undefined,
                onPromote: () => undefined,
                "onUpdate:draft": () => undefined,
              }),
            ]),
            h(SearchDrawer, {
              tab: tab.value,
              bridgeAvailable: true,
              notice: notice.value,
              onClose: () => undefined,
              onQuery,
              onJump,
            }),
          ]),
      },
    ),
};

createApp(Harness).mount("#app");

/** 面板状态直接从 DOM 读：脚本验证的是渲染结果，不是内部状态。 */
function readState() {
  const items = Array.from(document.querySelectorAll(".sx-item"));
  return {
    status: document.querySelector(".sx-item")
      ? "results"
      : document.querySelector(".sx-loading")
        ? "searching"
        : document.querySelector(".sx-error")
          ? "error"
          : document.querySelector(".sx-empty-note")
            ? "no-results"
            : document.querySelector(".sx-empty")
              ? "empty"
              : "unknown",
    count: document.querySelector(".sx-meta")?.textContent?.trim() ?? "",
    hits: items.length,
    ordinals: Array.from(document.querySelectorAll(".sx-idx")).map((node) =>
      Number((node.textContent ?? "").replace("#", "")),
    ),
    marks: document.querySelectorAll(".sx-mark").length,
    markText: document.querySelector(".sx-mark")?.textContent ?? null,
    notice: document.querySelector(".sx-notice")?.textContent?.trim() ?? null,
  };
}

declare global {
  interface Window {
    __soxuSearch: {
      type: (text: string) => void;
      patch: (partial: Partial<SearchState>) => void;
      reset: () => void;
      timing: () => { debounceMs: number; latencyMs: number | null };
      state: () => ReturnType<typeof readState>;
      highlight: () => { present: boolean; text: string };
      setTheme: (theme: "light" | "dark") => void;
      drawerBackground: () => string;
    };
  }
}

window.__soxuSearch = {
  type: (text: string) => {
    const input = document.querySelector<HTMLInputElement>(".sx-field");
    if (!input) return;
    input.focus();
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  },
  patch: (partial: Partial<SearchState>) => {
    search.value = { ...search.value, ...partial };
  },
  reset: () => {
    const input = document.querySelector<HTMLInputElement>(".sx-field");
    if (input) {
      input.value = "";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    notice.value = null;
    focusMessageId.value = null;
    latencyMs = null;
  },
  timing: () => ({ debounceMs: SEARCH_DEBOUNCE_MS, latencyMs }),
  state: readState,
  highlight: () => {
    const article = document.querySelector('.message[data-highlight="true"]');
    return { present: article !== null, text: article?.textContent?.trim() ?? "" };
  },
  setTheme: (theme: "light" | "dark") => {
    document.documentElement.dataset.theme = theme;
    const shell = document.querySelector<HTMLElement>(".app-shell");
    if (shell) shell.dataset.theme = theme;
  },
  drawerBackground: () => {
    const drawer = document.querySelector(".search-drawer");
    return drawer ? getComputedStyle(drawer).backgroundColor : "";
  },
};
