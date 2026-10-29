<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from "vue";
import { useVirtualizer } from "@tanstack/vue-virtual";
import MarkdownContent from "./MarkdownContent.vue";
import MessageActions from "./MessageActions.vue";
import { formatMessageTime } from "./messageTime.ts";
import type { SessionSettings } from "../settings/sessionSettings.ts";
import type { ChatMessage, HistoryCursor } from "../workspace/types.ts";
import {
  MESSAGE_OVERSCAN_ROWS,
  MESSAGE_ROW_ESTIMATE_PX,
  MESSAGE_STICK_THRESHOLD_PX,
} from "./messageVirtualizer.ts";
import { HIT_HIGHLIGHT_MS } from "./searchPanel.ts";

const props = defineProps<{
  messages: ChatMessage[];
  history: HistoryCursor;
  loading: boolean;
  /**
   * 设置 → 会话（Issue #116）：自动贴底、工具输出默认展开、消息时间戳。
   * 三项都只影响显示，不改变消息内容本身。
   */
  settings: SessionSettings;
  /**
   * 搜索抽屉（Issue #118）的跳转目标：消息 id + 递增序号。
   *
   * 用「id + nonce」而不是只传 id：同一条命中可以连点两次，只靠 id 变化不会触发
   * watch，第二次点击就会变成「什么都没发生」。nonce 由 App.vue 每次点击自增。
   */
  focusMessageId?: string | null;
  focusNonce?: number;
}>();

const emit = defineEmits<{ (event: "load-more"): void }>();

const scrollRef = ref<HTMLElement | null>(null);
const stickToBottom = ref(true);

/**
 * 虚拟列表：只渲染视口内的消息，长会话不会把整个 JSONL 拉进 DOM。
 * 行高由 `measureElement` 实测，避免流式输出导致的高度估算漂移。
 * 参数来自 `messageVirtualizer.ts`，回归测试核对的是同一份数值。
 */
const virtualizer = useVirtualizer<HTMLElement, HTMLElement>(
  computed(() => ({
    count: props.messages.length,
    getScrollElement: () => scrollRef.value,
    estimateSize: () => MESSAGE_ROW_ESTIMATE_PX,
    overscan: MESSAGE_OVERSCAN_ROWS,
    getItemKey: (index: number) => props.messages[index]?.id ?? index,
  })),
);

const virtualItems = computed(() => virtualizer.value.getVirtualItems());
const totalSize = computed(() => virtualizer.value.getTotalSize());
const lastText = computed(() => props.messages.at(-1)?.text ?? "");

/** 搜索命中跳转后的高亮；定时器由本组件创建，也由本组件清理（含卸载时）。 */
const highlightId = ref<string | null>(null);
let highlightTimer: ReturnType<typeof setTimeout> | null = null;

function clearHighlightTimer() {
  if (highlightTimer === null) return;
  clearTimeout(highlightTimer);
  highlightTimer = null;
}

/**
 * 滚动到指定消息并短暂高亮（搜索抽屉的「点击定位」）。
 *
 * 行高是实测的：先按估算高度滚一次，等一帧把实测高度写回尺寸缓存后再滚一次，
 * 否则远距离跳转会停在目标行上方或下方（虚拟列表的经典偏移）。
 * 目标行不在当前窗口时直接返回——上层负责翻页，这里不猜也不造假。
 */
async function focusMessage(messageId: string) {
  const index = props.messages.findIndex((message) => message.id === messageId);
  if (index < 0) return;
  await nextTick();
  virtualizer.value.scrollToIndex(index, { align: "center" });
  requestAnimationFrame(() => {
    virtualizer.value.scrollToIndex(index, { align: "center" });
  });
  highlightId.value = messageId;
  clearHighlightTimer();
  highlightTimer = setTimeout(() => {
    highlightId.value = null;
    highlightTimer = null;
  }, HIT_HIGHLIGHT_MS);
}

watch(
  () => [props.focusMessageId, props.focusNonce] as const,
  ([messageId]) => {
    if (messageId) void focusMessage(messageId);
  },
);

onUnmounted(clearHighlightTimer);

function onScroll() {
  const element = scrollRef.value;
  if (!element) return;
  const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
  stickToBottom.value = distance < MESSAGE_STICK_THRESHOLD_PX;
}

async function scrollToBottom() {
  await nextTick();
  const element = scrollRef.value;
  if (element) element.scrollTop = element.scrollHeight;
}

/**
 * 自动贴底（Issue #116）：设置里关掉「发送后滚动」后，滚动位置完全交给用户，
 * 新消息只会在用户本来就贴着底部时才跟随——这条判断仍然要保留，
 * 否则关掉开关后从底部往上翻历史会被硬拽回底部。
 */
watch(
  () => [props.messages.length, lastText.value],
  () => {
    if (props.settings.sendAfterScroll && stickToBottom.value) void scrollToBottom();
  },
);

/**
 * 行高实测：Vue 的 ref 回调同时可能收到组件实例，这里只处理真实 DOM。
 *
 * 必须推迟到 `nextTick`：Vue 在元素挂载进文档**之前**就调用 ref 回调，此时
 * `offsetHeight` 为 0。把 0 写进 tanstack 的尺寸缓存会让所有行叠在 0 位置、
 * 滚动高度远小于真实内容（50,000 条时肉眼可见的滚动条错位），而且缓存不会自愈。
 */
function measure(element: unknown) {
  if (!(element instanceof HTMLElement)) return;
  void nextTick(() => {
    // 卸载后才回调的元素不再测量，避免把已移除的节点重新登记进 observer。
    if (!element.isConnected) return;
    if (element.getBoundingClientRect().height > 0) {
      virtualizer.value.measureElement(element);
      return;
    }
    // 高度 0 说明这一帧还没有布局：绝不能把 0 写进 tanstack 的尺寸缓存，
    // 否则所有行都会叠在 0 位置、滚动高度远小于真实内容且不会自愈。
    // 下一帧再试一次，仍为 0 就保留估算行高（列表照常可用，只是不够精确）。
    requestAnimationFrame(() => {
      if (!element.isConnected) return;
      if (element.getBoundingClientRect().height > 0) virtualizer.value.measureElement(element);
    });
  });
}

/** 用户与 agent 的消息按 markdown 渲染（V4-S1）：代码块、行内 code、表格、引用。 */
function isRichRole(message: ChatMessage | undefined): boolean {
  return message?.role === "user" || message?.role === "assistant";
}

/** 工具输出超过这个长度就折叠：展开前不占滚动高度。 */
const TOOL_FOLD_CHARS = 360;

function isFoldedTool(message: ChatMessage | undefined): boolean {
  return message?.role === "tool" && (message.text.length ?? 0) > TOOL_FOLD_CHARS;
}

/**
 * 「显示工具调用」开关（Issue #116）：开着时工具输出块默认展开，
 * 默认关闭 = 改动前的行为（超过 TOOL_FOLD_CHARS 的输出块保持折叠）。
 * 开关只决定默认状态，用户仍然可以点 <summary> 手动折叠/展开。
 */
function toolExpandedByDefault(): boolean {
  return props.settings.showToolCalls;
}

/** 消息时间戳：设置关掉或时间缺失/非法时返回 null，界面不渲染。 */
function messageTime(message: ChatMessage | undefined): string | null {
  if (!props.settings.showTimestamps) return null;
  return formatMessageTime(message?.createdAt);
}

/** 只有 agent 消息有 hover 操作（复制/重试/回退），且必须真的有正文。 */
function showsActions(message: ChatMessage | undefined): boolean {
  return message?.role === "assistant" && (message.text?.length ?? 0) > 0;
}

function labelFor(message: ChatMessage): string {
  switch (message.role) {
    case "user":
      return "你";
    case "assistant":
      return "Agent";
    case "tool":
      return "工具输出";
    case "system":
      return "系统";
    default:
      return "事件";
  }
}
</script>

<template>
  <div class="message-area">
    <div
      v-if="history.next !== null || history.evicted > 0 || history.evictedLive > 0"
      class="older-row"
    >
      <button
        v-if="history.next !== null"
        class="older"
        type="button"
        :disabled="loading"
        @click="emit('load-more')"
      >
        {{ loading ? "正在加载后续历史…" : `加载更多历史（已载入 ${history.loaded}/${history.total}）` }}
      </button>
      <p v-if="history.evicted > 0" class="evicted-note" role="note">
        更早的 {{ history.evicted }} 条已从内存释放，Pi 的会话文件未受影响
      </p>
      <p v-if="history.evictedLive > 0" class="evicted-note" role="note">
        更早的 {{ history.evictedLive }} 条实时消息已从内存窗口释放，重新加载历史可查看
      </p>
    </div>
    <div
      ref="scrollRef"
      class="message-scroll visually-scroll soxu-selectable"
      role="log"
      aria-live="polite"
      aria-relevant="additions text"
      aria-label="会话消息"
      @scroll="onScroll"
    >
      <div class="virtual-canvas" :style="{ height: `${totalSize}px` }">
        <div
          v-for="item in virtualItems"
          :key="String(item.key)"
          :ref="measure"
          class="virtual-row"
          :data-index="item.index"
          :style="{ transform: `translateY(${item.start}px)` }"
        >
          <article
            v-if="messages[item.index]"
            class="message"
            :data-role="messages[item.index]?.role"
            :data-highlight="messages[item.index]?.id === highlightId ? 'true' : undefined"
          >
            <p class="message-label">
              {{ labelFor(messages[item.index]!) }}
              <time
                v-if="messageTime(messages[item.index])"
                class="message-time"
                :datetime="messages[item.index]?.createdAt ?? undefined"
              >
                {{ messageTime(messages[item.index]) }}
              </time>
            </p>
            <details
              v-if="isFoldedTool(messages[item.index])"
              class="tool-block"
              :open="toolExpandedByDefault()"
            >
              <summary>展开工具输出</summary>
              <pre>{{ messages[item.index]?.text }}</pre>
            </details>
            <template v-else>
              <div class="bubble">
                <MarkdownContent
                  v-if="isRichRole(messages[item.index]) && messages[item.index]?.text"
                  :text="messages[item.index]?.text ?? ''"
                  :streaming="messages[item.index]?.streaming ?? false"
                />
                <span v-else class="text">{{ messages[item.index]?.text || "（空内容）" }}</span>
                <span v-if="messages[item.index]?.partial" class="partial">预览，正文未载入</span>
                <span v-if="messages[item.index]?.truncated" class="partial">
                  正文超过单条上限，已截断
                </span>
                <span
                  v-if="messages[item.index]?.streaming"
                  class="streaming"
                  aria-hidden="true"
                ></span>
              </div>
              <MessageActions
                v-if="showsActions(messages[item.index])"
                :text="messages[item.index]?.text ?? ''"
              />
            </template>
          </article>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.message-area {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.older-row {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 10px 0 0;
}

.older {
  font-size: 0.71875rem;
  color: var(--soxu-subtext);
  border: 1px solid var(--soxu-border);
  border-radius: 999px;
  padding: 6px 14px;
  background: var(--soxu-panel);
}

.older:hover:enabled {
  background: var(--soxu-hover);
}

.evicted-note {
  margin: 0;
  font-size: 0.65625rem;
  color: var(--soxu-muted);
}

.message-scroll {
  flex: 1;
  min-height: 0;
  padding: 8px 0 20px;
}

/*
 * 正文宽度（Issue #116）：上限来自 --soxu-content-max —— 默认「固定 768」，
 * 设置选「自适应」时 base.css 把它改成 100%，组件不需要判断档位。
 */
.virtual-canvas {
  position: relative;
  width: min(100% - 48px, var(--soxu-content-max));
  margin: 0 auto;
}

.virtual-row {
  position: absolute;
  inset-inline: 0;
  top: 0;
  padding-bottom: 14px;
}

.message {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.message[data-role="user"] {
  align-items: flex-end;
}

/*
 * 搜索命中跳转后的高亮（Issue #118）：用强调色画一圈 2px 描边，
 * 深浅主题都看得见；只在 data-highlight 期间生效，不改变布局（不占空间）。
 */
.message[data-highlight="true"] .bubble,
.message[data-highlight="true"] .tool-block {
  box-shadow: 0 0 0 2px var(--soxu-accent);
  transition: box-shadow var(--soxu-motion-base) var(--soxu-motion-ease);
}

.message-label {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: 0.65625rem;
  letter-spacing: 0.3px;
  color: var(--soxu-muted);
}

/* 时间戳（Issue #116）：与消息标签同一行、弱化一档，不新增一行高度。 */
.message-time {
  font-size: 0.625rem;
  color: var(--soxu-muted);
  opacity: 0.85;
}

.bubble {
  max-width: 100%;
  padding: 12px 15px;
  border-radius: 14px;
  border: 1px solid var(--soxu-border);
  background: var(--soxu-panel);
  /*
   * 正文字体走独立 token（Issue #98）：选「等宽」时界面变等宽，
   * 会话正文仍然保持正文栈，长段落不会因为布局字体选择而变难读。
   */
  font-family: var(--soxu-font-family-body);
  font-size: 0.875rem;
  line-height: 1.75;
  overflow-wrap: anywhere;
}

.message[data-role="user"] .bubble {
  background: var(--soxu-accent-soft);
  border-color: transparent;
  max-width: 86%;
}

/*
 * agent 消息不套气泡（V4 原型 msg-agent）：直接排版更好读长文，
 * 也让 markdown 里的代码块/表格能占满可用宽度。
 */
.message[data-role="assistant"] .bubble {
  padding: 0;
  border-color: transparent;
  background: transparent;
}

/* hover 或键盘聚焦时露出消息操作，静止时不抢注意力（原型 .msg:hover .msg-actions）。 */
.message:hover :deep(.message-actions),
.message:focus-within :deep(.message-actions) {
  opacity: 1;
}

.message[data-role="tool"] .bubble,
.message[data-role="other"] .bubble {
  font-family: var(--soxu-font-family-mono);
  font-size: 0.75rem;
  color: var(--soxu-subtext);
  background: var(--soxu-soft);
}

.text {
  white-space: pre-wrap;
}

.partial {
  display: block;
  margin-top: 6px;
  font-size: 0.65625rem;
  color: var(--soxu-muted);
}

.streaming {
  display: inline-block;
  width: 8px;
  height: 15px;
  margin-left: 3px;
  vertical-align: text-bottom;
  background: var(--soxu-accent);
  animation: soxu-blink 1s steps(2, start) infinite;
}

@keyframes soxu-blink {
  to {
    visibility: hidden;
  }
}

.tool-block {
  border: 1px solid var(--soxu-border);
  border-radius: 10px;
  background: var(--soxu-soft);
  padding: 8px 12px;
  /* 折叠块里的原始输出同样是代码，字体走等宽 token。 */
  font-family: var(--soxu-font-family-mono);
  font-size: 0.75rem;
  color: var(--soxu-subtext);
}

.tool-block pre {
  margin: 8px 0 0;
  max-height: 320px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.tool-block summary {
  cursor: pointer;
}
</style>
