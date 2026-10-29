<script setup lang="ts">
/**
 * agent 消息的 hover 操作（Issue #111 · V4-S1）。
 *
 * 三个动作与原型一致：
 * - 复制：真实现（`copyText`，clipboard API + execCommand 兜底），成功后图标变勾 1.6s；
 * - 重试 / 回退到这里：后端命令（`retry_message` / `rewind_to`）属于后续切片，
 *   这里按决策文档「UI 置灰 + 提示即将支持」处理，绝不假装成功。
 *
 * 资源所有权：复制成功的复位计时器在本组件内，卸载时清掉。
 */

import { computed, onBeforeUnmount, ref } from "vue";
import { Check, Copy, RotateCcw, Undo2 } from "@lucide/vue";

import AppTooltip from "./AppTooltip.vue";
import { copyText } from "../services/clipboard.ts";

const props = defineProps<{
  /** 该条消息的 markdown 原文（不是渲染后的 HTML）。 */
  text: string;
}>();

/** 复制成功的反馈时长。 */
const COPIED_FEEDBACK_MS = 1_600;

const copied = ref(false);
let timer: ReturnType<typeof setTimeout> | null = null;

const copyLabel = computed(() => (copied.value ? "已复制" : "复制消息"));

function clearTimer() {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

async function copy() {
  const ok = await copyText(props.text);
  copied.value = ok;
  clearTimer();
  if (!ok) return;
  timer = setTimeout(() => {
    copied.value = false;
    timer = null;
  }, COPIED_FEEDBACK_MS);
}

onBeforeUnmount(clearTimer);
</script>

<template>
  <div class="message-actions">
    <AppTooltip :text="copyLabel" auto>
      <button class="action" type="button" :aria-label="copyLabel" @click="copy">
        <Check v-if="copied" :size="14" :stroke-width="2" aria-hidden="true" />
        <Copy v-else :size="14" :stroke-width="1.85" aria-hidden="true" />
      </button>
    </AppTooltip>
    <AppTooltip text="即将支持：从这条消息重新生成" auto>
      <button class="action" type="button" aria-label="重试（即将支持）" disabled>
        <RotateCcw :size="14" :stroke-width="1.85" aria-hidden="true" />
      </button>
    </AppTooltip>
    <AppTooltip text="即将支持：把会话回退到这条消息之前" auto>
      <button class="action" type="button" aria-label="回退到这里（即将支持）" disabled>
        <Undo2 :size="14" :stroke-width="1.85" aria-hidden="true" />
      </button>
    </AppTooltip>
  </div>
</template>

<style scoped>
.message-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  /* 默认隐藏，指针悬停或键盘聚焦时才出现：静止时不抢正文的注意力。 */
  opacity: 0;
  transition: opacity var(--soxu-motion-fast) var(--ease-spring, var(--soxu-motion-ease));
}

.action {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: 7px;
  color: var(--soxu-muted);
  transition:
    background-color var(--soxu-motion-fast) var(--soxu-motion-ease),
    color var(--soxu-motion-fast) var(--soxu-motion-ease),
    transform var(--soxu-motion-fast) var(--ease-spring, var(--soxu-motion-ease));
}

.action:hover:enabled {
  background: var(--soxu-hover);
  color: var(--soxu-fg);
  transform: scale(var(--soxu-hover-scale));
}

.action:disabled {
  opacity: 0.4;
  cursor: default;
}
</style>
