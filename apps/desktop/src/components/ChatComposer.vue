<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { CircleStop, Send } from "@lucide/vue";
import AppTooltip from "./AppTooltip.vue";
import type { TabStatus } from "../workspace/types.ts";

const props = defineProps<{
  draft: string;
  status: TabStatus;
  disabled: boolean;
  busy: boolean;
}>();

const emit = defineEmits<{
  (event: "update:draft", value: string): void;
  (event: "send"): void;
  (event: "cancel"): void;
}>();

const textarea = ref<HTMLTextAreaElement | null>(null);
const running = computed(() => props.status === "running" || props.status === "cancelling");
const canSend = computed(
  () => props.draft.trim().length > 0 && !props.disabled && !running.value && !props.busy,
);

function onInput(event: Event) {
  emit("update:draft", (event.target as HTMLTextAreaElement).value);
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (canSend.value) emit("send");
    return;
  }
  if (event.key === "Escape" && running.value) {
    event.preventDefault();
    emit("cancel");
  }
}

function send() {
  if (canSend.value) emit("send");
}

watch(
  () => props.status,
  async (status) => {
    if (status === "idle" || status === "ready") {
      await nextTick();
      textarea.value?.focus();
    }
  },
);

defineExpose({ focus: () => textarea.value?.focus() });
</script>

<template>
  <div class="composer-area">
    <div class="composer" :data-running="running">
      <label class="sr-only" for="soxu-composer">消息内容</label>
      <textarea
        id="soxu-composer"
        ref="textarea"
        :value="draft"
        rows="2"
        placeholder="向 Pi Agent 发送消息…"
        :disabled="disabled"
        :aria-describedby="'soxu-composer-hint'"
        @input="onInput"
        @keydown="onKeydown"
      ></textarea>
      <div class="composer-actions">
        <span id="soxu-composer-hint" class="hint">
          Enter 发送 · Shift+Enter 换行 · Esc 取消当前轮次
        </span>
        <div class="buttons">
          <button
            v-if="running"
            class="stop-button"
            type="button"
            :disabled="status === 'cancelling'"
            :aria-label="status === 'cancelling' ? '正在取消' : '取消当前轮次'"
            @click="emit('cancel')"
          >
            <CircleStop :size="16" :stroke-width="1.9" aria-hidden="true" />
            {{ status === "cancelling" ? "取消中…" : "取消" }}
          </button>
          <AppTooltip text="发送消息 (Enter)">
            <button
              class="send-button"
              type="button"
              :disabled="!canSend"
              aria-label="发送消息"
              @click="send"
            >
              <Send :size="17" :stroke-width="1.9" aria-hidden="true" />
            </button>
          </AppTooltip>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.composer-area {
  width: min(100% - 48px, 780px);
  margin: 0 auto 20px;
  flex: none;
}

.composer {
  border: 1px solid var(--soxu-border);
  border-radius: 20px;
  background: var(--soxu-input);
  padding: 12px 12px 10px 16px;
  box-shadow: 0 6px 26px rgb(0 0 0 / 4%);
}

.composer[data-running="true"] {
  border-color: color-mix(in srgb, var(--soxu-accent) 45%, var(--soxu-border));
}

.composer textarea {
  display: block;
  width: 100%;
  resize: none;
  min-height: 44px;
  max-height: 220px;
  border: 0;
  outline: none;
  background: transparent;
  /* 输入框写的就是会话正文，字体与消息气泡保持一致，不随「等宽」界面档变化。 */
  font-family: var(--soxu-font-family-body);
  font-size: 0.875rem;
  line-height: 1.7;
  color: var(--soxu-fg);
}

.composer textarea::placeholder {
  color: var(--soxu-muted);
}

.composer-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.hint {
  font-size: 0.65625rem;
  color: var(--soxu-muted);
}

.buttons {
  display: flex;
  align-items: center;
  gap: 8px;
}

.stop-button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 12px;
  border-radius: 999px;
  border: 1px solid var(--soxu-border);
  font-size: 0.75rem;
  color: var(--soxu-subtext);
}

.stop-button {
  transition: background-color var(--soxu-motion-fast) var(--soxu-motion-ease);
}

.stop-button:hover:enabled {
  background: var(--soxu-hover);
}

.send-button {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 999px;
  background: var(--soxu-ink);
  color: var(--soxu-on-ink);
  transition:
    opacity var(--soxu-motion-fast) var(--soxu-motion-ease),
    transform var(--soxu-motion-fast) var(--soxu-motion-ease);
}

.send-button:hover:not(:disabled) {
  transform: scale(var(--soxu-hover-scale));
}

.send-button:disabled {
  opacity: 0.35;
  cursor: default;
}
</style>
