<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useVirtualizer } from "@tanstack/vue-virtual";
import type { ChatMessage, HistoryCursor } from "../workspace/types.ts";

const props = defineProps<{
  messages: ChatMessage[];
  history: HistoryCursor;
  loading: boolean;
}>();

const emit = defineEmits<{ (event: "load-more"): void }>();

const scrollRef = ref<HTMLElement | null>(null);
const stickToBottom = ref(true);

/**
 * 虚拟列表：只渲染视口内的消息，长会话不会把整个 JSONL 拉进 DOM。
 * 行高由 `measureElement` 实测，避免流式输出导致的高度估算漂移。
 */
const virtualizer = useVirtualizer<HTMLElement, HTMLElement>(
  computed(() => ({
    count: props.messages.length,
    getScrollElement: () => scrollRef.value,
    estimateSize: () => 96,
    overscan: 6,
    getItemKey: (index: number) => props.messages[index]?.id ?? index,
  })),
);

const virtualItems = computed(() => virtualizer.value.getVirtualItems());
const totalSize = computed(() => virtualizer.value.getTotalSize());
const lastText = computed(() => props.messages.at(-1)?.text ?? "");

function onScroll() {
  const element = scrollRef.value;
  if (!element) return;
  const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
  stickToBottom.value = distance < 120;
}

async function scrollToBottom() {
  await nextTick();
  const element = scrollRef.value;
  if (element) element.scrollTop = element.scrollHeight;
}

watch(
  () => [props.messages.length, lastText.value],
  () => {
    if (stickToBottom.value) void scrollToBottom();
  },
);

/** 行高实测：Vue 的 ref 回调同时可能收到组件实例，这里只处理真实 DOM。 */
function measure(element: unknown) {
  if (element instanceof HTMLElement) virtualizer.value.measureElement(element);
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
    <div v-if="history.next !== null" class="older-row">
      <button class="older" type="button" :disabled="loading" @click="emit('load-more')">
        {{ loading ? "正在加载更早的消息…" : `加载更早的消息（已载入 ${history.loaded}/${history.total}）` }}
      </button>
    </div>
    <div
      ref="scrollRef"
      class="message-scroll visually-scroll"
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
          >
            <p class="message-label">{{ labelFor(messages[item.index]!) }}</p>
            <details
              v-if="messages[item.index]?.role === 'tool' && (messages[item.index]?.text.length ?? 0) > 360"
              class="tool-block"
            >
              <summary>展开工具输出</summary>
              <pre>{{ messages[item.index]?.text }}</pre>
            </details>
            <div v-else class="bubble">
              <span class="text">{{ messages[item.index]?.text || "（空内容）" }}</span>
              <span v-if="messages[item.index]?.partial" class="partial">预览，正文未载入</span>
              <span
                v-if="messages[item.index]?.streaming"
                class="streaming"
                aria-hidden="true"
              ></span>
            </div>
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
  justify-content: center;
  padding: 10px 0 0;
}

.older {
  font-size: 11.5px;
  color: var(--soxu-subtext);
  border: 1px solid var(--soxu-border);
  border-radius: 999px;
  padding: 6px 14px;
  background: var(--soxu-panel);
}

.older:hover:enabled {
  background: var(--soxu-hover);
}

.message-scroll {
  flex: 1;
  min-height: 0;
  padding: 8px 0 20px;
}

.virtual-canvas {
  position: relative;
  width: min(100% - 48px, 780px);
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

.message-label {
  margin: 0;
  font-size: 10.5px;
  letter-spacing: 0.3px;
  color: var(--soxu-muted);
}

.bubble {
  max-width: 100%;
  padding: 12px 15px;
  border-radius: 14px;
  border: 1px solid var(--soxu-border);
  background: var(--soxu-panel);
  font-size: 14px;
  line-height: 1.75;
  overflow-wrap: anywhere;
}

.message[data-role="user"] .bubble {
  background: var(--soxu-accent-soft);
  border-color: transparent;
  max-width: 86%;
}

.message[data-role="tool"] .bubble,
.message[data-role="other"] .bubble {
  font-family: ui-monospace, SFMono-Regular, "Cascadia Mono", Consolas, monospace;
  font-size: 12px;
  color: var(--soxu-subtext);
  background: var(--soxu-soft);
}

.text {
  white-space: pre-wrap;
}

.partial {
  display: block;
  margin-top: 6px;
  font-size: 10.5px;
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
  font-size: 12px;
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
