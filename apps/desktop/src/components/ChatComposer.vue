<script setup lang="ts">
/**
 * 消息输入区。
 *
 * 结构照原型：上方是「下一条消息将 X」横条（send-mode-bar），下方是输入框 + 底部工具条，
 * 发送按钮拆成「主钮 + caret」两半（caret 打开三选菜单，见 ComposerSendMenu.vue）。
 *
 * 三条边界：
 * - 待发投递方式按会话记录（`pendingBySession`）：ChatPanel 在切换 Tab 时复用同一个组件实例，
 *   如果只放一个 ref，切回来会看到别的会话的选择；用完即清，不残留到下一轮。
 * - 主发送按钮在 agent 忙碌时仍然禁用：注入 / 排队 / 并行会话的运行时语义还没接上，
 *   输入区只做界面与参数管道，不在这里假装已经生效。
 * - 「忙碌时发送」的偏好来自设置（busyDelivery），投递语义接入后才由它决定忙碌时的行为，
 *   所以运行中的提示写「即将支持」而不是声称已经按偏好投递。
 */

import { computed, nextTick, ref, watch } from "vue";
import { CircleStop, ListOrdered, Send, X } from "@lucide/vue";

import AppTooltip from "./AppTooltip.vue";
import ComposerSendMenu from "./ComposerSendMenu.vue";
import SessionStatsRing from "./SessionStatsRing.vue";
import SessionStatsRow from "./SessionStatsRow.vue";
import { sendModeLabel } from "./sendMode.ts";
import type { SessionStatsView } from "./sessionStats.ts";
import type { BusySendDelivery } from "../settings/busyDelivery.ts";
import type { SendMode, TabStatus } from "../workspace/types.ts";

const props = defineProps<{
  /** 待发投递方式按会话记录，因此必须知道当前是哪个会话。 */
  sessionId: string;
  draft: string;
  status: TabStatus;
  disabled: boolean;
  busy: boolean;
  /** 设置里的「忙碌时发送」默认投递方式。 */
  defaultDelivery: BusySendDelivery;
  /** 设置 → 会话 → Enter 发送（Issue #116）：关掉后 Enter 换行、⌘/Ctrl+↵ 发送。 */
  enterToSend: boolean;
  /** 当前会话是否有已登记的项目：并行发送需要一个落点。 */
  hasProject: boolean;
  /** 上下文环 / 统计浮窗 / 统计行共用的视图（Issue #119）。 */
  statsView: SessionStatsView;
  statsLoading?: boolean;
  statsError?: string | null;
}>();

const emit = defineEmits<{
  (event: "update:draft", value: string): void;
  /** mode 为 null 表示「没选过，按默认投递」。 */
  (event: "send", mode: SendMode | null): void;
  (event: "cancel"): void;
  /** 打开统计浮窗时按需拉一次（事件驱动，不是轮询）。 */
  (event: "refresh-stats"): void;
}>();

const textarea = ref<HTMLTextAreaElement | null>(null);
const running = computed(() => props.status === "running" || props.status === "cancelling");
const canSend = computed(
  () => props.draft.trim().length > 0 && !props.disabled && !running.value && !props.busy,
);

/** 每个会话各自的待发投递方式；切换 Tab 不会串味。 */
const pendingBySession = ref<Record<string, SendMode>>({});
const pendingMode = computed<SendMode | null>(
  () => pendingBySession.value[props.sessionId] ?? null,
);
const defaultDeliveryLabel = computed(() => sendModeLabel(props.defaultDelivery));

/**
 * 发送快捷键（Issue #116）：文案必须与 onKeydown 的真实判定一致，
 * 否则用户按提示按下去没反应。
 */
const sendShortcut = computed(() => (props.enterToSend ? "Enter" : "Ctrl/⌘+Enter"));

const hint = computed(() =>
  running.value
    ? `本轮运行中 · 忙碌时发送即将支持（当前偏好「${defaultDeliveryLabel.value}」）`
    : props.enterToSend
      ? "Enter 发送 · Shift+Enter 换行 · Esc 取消当前轮次"
      : "Ctrl/⌘+Enter 发送 · Enter 换行 · Esc 取消当前轮次",
);

function onInput(event: Event) {
  emit("update:draft", (event.target as HTMLTextAreaElement).value);
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Enter" && !event.isComposing) {
    // 输入法组合中（event.isComposing）一律不拦截：中文候选词确认也会发 Enter。
    const modified = event.ctrlKey || event.metaKey;
    const sendNow = props.enterToSend
      ? !event.shiftKey
      : // 关掉「Enter 发送」后 Enter 换行，⌘/Ctrl+↵ 才发送；Shift+Enter 始终换行。
        modified && !event.shiftKey;
    if (sendNow) {
      event.preventDefault();
      if (canSend.value) send();
      return;
    }
  }
  if (event.key === "Escape" && running.value) {
    event.preventDefault();
    emit("cancel");
  }
}

function chooseMode(mode: SendMode) {
  pendingBySession.value = { ...pendingBySession.value, [props.sessionId]: mode };
  void nextTick(() => textarea.value?.focus());
}

function clearMode() {
  const next = { ...pendingBySession.value };
  delete next[props.sessionId];
  pendingBySession.value = next;
}

function send() {
  if (!canSend.value) return;
  const mode = pendingMode.value;
  emit("send", mode);
  // 选择只对「下一条消息」生效：发出去就清掉，避免用户以为还会继续生效。
  if (mode) clearMode();
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
    <div v-if="pendingMode" class="send-mode-bar" data-show="true">
      <ListOrdered :size="14" :stroke-width="1.9" aria-hidden="true" />
      <span class="mode-text">
        下一条消息将 <b>{{ sendModeLabel(pendingMode) }}</b>
      </span>
      <AppTooltip text="取消发送方式">
        <button class="mode-x" type="button" aria-label="取消发送方式" @click="clearMode">
          <X :size="12" :stroke-width="2.2" aria-hidden="true" />
        </button>
      </AppTooltip>
    </div>

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
        <span id="soxu-composer-hint" class="hint">{{ hint }}</span>
        <div class="buttons">
          <SessionStatsRing
            :view="statsView"
            :loading="statsLoading ?? false"
            :error="statsError ?? null"
            @refresh="emit('refresh-stats')"
          />
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
          <div class="send-split">
            <AppTooltip :text="`发送消息 (${sendShortcut})`" side="top">
              <button
                class="send-main"
                type="button"
                :disabled="!canSend"
                aria-label="发送消息"
                @click="send"
              >
                <Send :size="16" :stroke-width="1.9" aria-hidden="true" />
              </button>
            </AppTooltip>
            <ComposerSendMenu
              :busy="running"
              :draft="draft"
              :has-project="hasProject"
              :disabled="disabled"
              @select="chooseMode"
            />
          </div>
        </div>
      </div>
    </div>

    <SessionStatsRow :view="statsView" />
  </div>
</template>

<style scoped>
/* 输入区与消息列表共用同一个宽度上限（Issue #116 的正文宽度设置）。 */
.composer-area {
  width: min(100% - 48px, var(--soxu-content-max));
  margin: 0 auto 20px;
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* 「下一条消息将 X」横条（原型 send-mode-bar）：浅强调底 + 1px 强调边框。 */
.send-mode-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 32px;
  padding: 0 8px 0 12px;
  border-radius: 10px;
  border: 1px solid color-mix(in srgb, var(--soxu-accent) 32%, transparent);
  background: var(--soxu-accent-soft);
  color: var(--soxu-fg);
  font-size: 0.75rem;
  animation: soxu-mode-bar-in var(--soxu-motion-base) var(--ease-spring, var(--soxu-motion-ease));
}

.send-mode-bar > svg {
  color: var(--soxu-accent);
}

.mode-text b {
  font-weight: 500;
  color: var(--soxu-accent);
}

.mode-x {
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  margin-left: auto;
  border-radius: 6px;
  color: var(--soxu-muted);
  transition:
    background-color var(--soxu-motion-fast) var(--soxu-motion-ease),
    color var(--soxu-motion-fast) var(--soxu-motion-ease);
}

.mode-x:hover {
  background: var(--soxu-hover);
  color: var(--soxu-fg);
}

@keyframes soxu-mode-bar-in {
  from {
    opacity: 0;
    transform: translateY(4px);
  }

  to {
    opacity: 1;
    transform: none;
  }
}

.composer {
  border: 1px solid var(--soxu-border);
  border-radius: 16px;
  background: var(--soxu-input);
  padding: 12px 12px 10px 16px;
  box-shadow: 0 6px 26px rgb(0 0 0 / 4%);
  transition:
    border-color var(--soxu-motion-fast) var(--soxu-motion-ease),
    box-shadow var(--soxu-motion-fast) var(--soxu-motion-ease);
}

.composer:focus-within {
  border-color: var(--soxu-accent);
  box-shadow: 0 0 0 3px var(--soxu-accent-soft);
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
  transition: background-color var(--soxu-motion-fast) var(--soxu-motion-ease);
}

.stop-button:hover:enabled {
  background: var(--soxu-hover);
}

/* 主钮 + caret 拼成一块（原型 send-split）：圆角只在整块外侧，中间用分隔线。 */
.send-split {
  display: flex;
  align-items: stretch;
  border-radius: 9px;
  overflow: hidden;
  background: var(--soxu-accent);
  transition: transform var(--soxu-motion-fast) var(--ease-spring, var(--soxu-motion-ease));
}

.send-split:hover {
  background: color-mix(in srgb, var(--soxu-accent) 88%, #000);
}

.send-main {
  display: grid;
  place-items: center;
  width: 34px;
  height: 30px;
  color: var(--soxu-on-accent);
  transition: transform var(--soxu-motion-fast) var(--ease-spring, var(--soxu-motion-ease));
}

.send-main:hover:enabled {
  transform: scale(var(--soxu-hover-scale));
}

.send-main:disabled {
  opacity: 0.35;
  cursor: default;
}

@media (prefers-reduced-motion: reduce) {
  .send-mode-bar {
    animation: none;
  }
}
</style>
