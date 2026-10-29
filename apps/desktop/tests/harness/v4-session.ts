/**
 * Issue #111（V4-S1）的 DOM 夹具：把真正的 `ChatPanel` 挂到浏览器里，
 * 用确定性假数据验证「markdown 渲染 + 发送三选 + 消息操作」的视觉与状态。
 *
 * 只在 `pnpm dev` 的本地开发服务器里使用，不参与生产构建，也不连接 Pi：
 * - 消息是内存里的常量（含代码块、表格、引用、超长工具输出）；
 * - 发送事件由夹具自己"演"一遍：追加用户消息 → 600ms 后追加 agent 回复；
 * - 忙碌状态由 CDP 脚本通过 `window.__soxuV4.busy(true)` 切换，用来验证「加入当前」的置灰规则。
 */

import { computed, createApp, h, ref } from "vue";
import { TooltipProvider } from "reka-ui";

import "../../src/styles/base.css";
import ChatPanel from "../../src/components/ChatPanel.vue";
import { TOOLTIP_DELAY_MS, TOOLTIP_SKIP_DELAY_MS } from "../../src/components/tooltipConfig.ts";
import type { ChatMessage, SessionTab, TabStatus } from "../../src/workspace/types.ts";

const ASSISTANT_MARKDOWN = [
  "已经按切片要求把渲染链路接通，下面是这次改动涉及的三个点：",
  "",
  "- **markdown-it 激活**：代码块、行内 `code`、表格、引用都能渲染",
  "- **shiki 按需加载**：只有出现代码块时才下载对应语言包",
  "- **XSS 边界**：`html: false`，正文里的原始 HTML 一律转义",
  "",
  "> 注意：发送三选在本切片只做 UI 与参数管道，运行时语义由后续切片实现。",
  "",
  "```ts",
  "export function sendModeAvailability(context: SendModeContext) {",
  "  return { steer: context.busy, followUp: true };",
  "}",
  "```",
  "",
  "| 项 | 状态 |",
  "| --- | --- |",
  "| markdown | 已完成 |",
  "| shiki | 已完成 |",
].join("\n");

const TOOL_OUTPUT = Array.from(
  { length: 12 },
  (_, index) => `[tool] 第 ${index + 1} 行输出：读取 apps/desktop/src/components/MessageList.vue`,
).join("\n");

function message(
  id: string,
  role: ChatMessage["role"],
  text: string,
  extra: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    id,
    ordinal: null,
    role,
    text,
    partial: false,
    streaming: false,
    source: "live",
    createdAt: null,
    ...extra,
  };
}

const messages = ref<ChatMessage[]>([
  message("h1", "user", "帮我确认 V4-S1 的渲染链路，顺便看下 `sendModeAvailability` 的判定。"),
  message("h2", "assistant", ASSISTANT_MARKDOWN),
  message("h3", "tool", TOOL_OUTPUT),
]);

const draft = ref("把发送三选接到 composer 上，并验证忙碌时置灰");
const status = ref<TabStatus>("ready");
const defaultDelivery = ref<"steer" | "followUp">("steer");
let sequence = 0;

const tab = computed<SessionTab>(() => ({
  sessionId: "harness_ses_v4",
  projectId: "harness_prj",
  worktreeId: null,
  title: "V4-S1 会话主链路",
  mode: "persistent",
  status: status.value,
  error: null,
  messages: messages.value,
  history: {
    loaded: messages.value.length,
    total: messages.value.length,
    next: null,
    loading: false,
    evicted: 0,
    evictedLive: 0,
  },
  runtime: { runtimeId: "harness#1", generation: 1, state: "idle", exitReason: null, retry: null },
  draft: draft.value,
  diagnostics: [],
  promoting: false,
}));

/** 夹具版"发送"：追加用户消息，稍后补一条 agent 回复，模拟一轮完整往返。 */
function onSend(payload: { text: string; mode: string | null }) {
  sequence += 1;
  messages.value = [...messages.value, message(`live_user_${sequence}`, "user", payload.text)];
  draft.value = "";
  status.value = "running";
  setTimeout(() => {
    sequence += 1;
    messages.value = [
      ...messages.value,
      message(`live_agent_${sequence}`, "assistant", "收到，这一轮先按默认投递处理。"),
    ];
    status.value = "ready";
  }, 600);
}

/**
 * 外层壳必须与生产一致：`.app-shell` + `.main-column` 提供 flex 高度约束，
 * 否则面板随内容无限长，composer 会被挤到视口外（截图脚本就点不到发送钮）。
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
            defaultDelivery: defaultDelivery.value,
            onSend,
            onCancel: () => {
              status.value = "ready";
            },
            onStop: () => {
              status.value = "idle";
            },
            onLoadMore: () => undefined,
            onRetry: () => undefined,
            onPromote: () => undefined,
                "onUpdate:draft": (value: string) => {
                  draft.value = value;
                },
              }),
            ]),
          ]),
      },
    ),
};

createApp(Harness).mount("#app");

declare global {
  interface Window {
    __soxuV4: {
      busy: (value: boolean) => void;
      setDraft: (value: string) => void;
      setTheme: (theme: "light" | "dark") => void;
      highlighted: () => number;
      pending: () => number;
    };
  }
}

window.__soxuV4 = {
  busy: (value: boolean) => {
    status.value = value ? "running" : "ready";
  },
  setDraft: (value: string) => {
    draft.value = value;
  },
  setTheme: (theme: "light" | "dark") => {
    document.documentElement.dataset.theme = theme;
  },
  highlighted: () => document.querySelectorAll('.md-code[data-highlight="done"]').length,
  pending: () => document.querySelectorAll('.md-code[data-highlight="pending"]').length,
};
