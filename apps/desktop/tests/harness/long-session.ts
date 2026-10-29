/**
 * Issue #36 的 DOM 夹具：把 `MessageList` 挂到真实浏览器里，用 50,000 条消息
 * 验证「DOM 行数只取决于视口高度」。
 *
 * 只在 `pnpm dev` 的本地开发服务器里使用，不参与生产构建，也不读真实会话：
 * 正文来自 `tests/support/longSession.ts` 的确定性夹具（预览长度）。
 */

import { createApp, h } from "vue";
// 与桌面端一致的基础样式（.visually-scroll 的 overflow 等），由 Vite 注入。
import "../../src/styles/base.css";
import MessageList from "../../src/components/MessageList.vue";
import { DEFAULT_SESSION_SETTINGS } from "../../src/settings/sessionSettings.ts";
import { LongSessionFixture, LONG_SESSION_EVENTS } from "../support/longSession.ts";
import type { ChatMessage, HistoryCursor } from "../../src/workspace/types.ts";

const params = new URLSearchParams(location.search);
const count = Math.min(
  Math.max(Number.parseInt(params.get("count") ?? "240", 10) || 240, 1),
  LONG_SESSION_EVENTS,
);

const fixture = new LongSessionFixture();
const messages: ChatMessage[] = [];
for (let ordinal = 0; ordinal < count; ordinal += 1) {
  messages.push({
    id: `harness:${ordinal}`,
    ordinal,
    role: fixture.role(ordinal) === "tool_result" ? "tool" : "assistant",
    text: fixture.preview(ordinal),
    partial: false,
    streaming: false,
    source: "history",
    createdAt: null,
  });
}

const history: HistoryCursor = {
  loaded: count,
  total: LONG_SESSION_EVENTS,
  next: null,
  loading: false,
  evicted: 0,
  evictedLive: 0,
};

createApp({
  // Issue #116 起 MessageList 多了 settings（贴底 / 工具输出 / 时间戳），夹具用默认值即可。
  render: () => h(MessageList, { messages, history, loading: false, settings: DEFAULT_SESSION_SETTINGS }),
}).mount("#app");
