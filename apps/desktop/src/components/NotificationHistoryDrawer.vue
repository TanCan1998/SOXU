<script setup lang="ts">
/**
 * 通知历史抽屉（V4-S2b，Issue #117）。
 *
 * 顶栏铃铛打开，列出**本次运行**的全部通知（时间倒序），可清空。
 * 历史本身在 store 里（内存数组、有上限、重启清空），这里只做呈现。
 *
 * 三条关闭路径（与既有对话框一致）：× 按钮、点遮罩、Escape。
 * 打开时把焦点移进抽屉，关闭时还给原来的元素——否则键盘用户会掉到页面开头。
 */
import { CircleAlert, CircleCheck, CircleQuestionMark, X } from "@lucide/vue";
import { nextTick, onBeforeUnmount, ref, watch } from "vue";

import { formatNotificationClock, type NotificationRecord } from "../notifications/history.ts";
import type { NotificationEventKind } from "../notifications/settings.ts";

const props = defineProps<{ open: boolean; records: NotificationRecord[] }>();

const emit = defineEmits<{
  close: [];
  clear: [];
  "open-session": [sessionId: string];
}>();

const panel = ref<HTMLElement | null>(null);
/** 打开前拥有焦点的元素；关闭时把焦点还回去。 */
let restoreTarget: HTMLElement | null = null;

const ICONS = {
  sessionCompleted: CircleCheck,
  sessionError: CircleAlert,
  awaitingInput: CircleQuestionMark,
} as const;

function iconFor(kind: NotificationEventKind) {
  return ICONS[kind];
}

watch(
  () => props.open,
  async (open) => {
    if (typeof document === "undefined") return;
    if (open) {
      const active = document.activeElement;
      restoreTarget = active instanceof HTMLElement ? active : null;
      await nextTick();
      panel.value?.focus();
      return;
    }
    restoreTarget?.focus();
    restoreTarget = null;
  },
);

onBeforeUnmount(() => {
  restoreTarget = null;
});
</script>

<template>
  <Transition name="drawer">
    <div v-if="open" class="drawer-scrim" @click.self="emit('close')">
      <aside
        ref="panel"
        class="drawer-panel"
        role="dialog"
        aria-modal="true"
        aria-label="通知历史"
        tabindex="-1"
        @keydown.escape="emit('close')"
      >
        <header class="drawer-header">
          <div class="drawer-heading">
            <h2 class="drawer-title">通知历史</h2>
            <span class="drawer-count">{{ records.length }} 条</span>
          </div>
          <div class="drawer-actions">
            <button
              class="drawer-clear"
              type="button"
              :disabled="records.length === 0"
              @click="emit('clear')"
            >
              清空
            </button>
            <button
              class="drawer-close"
              type="button"
              aria-label="关闭通知历史"
              @click="emit('close')"
            >
              <X :size="15" :stroke-width="2" aria-hidden="true" />
            </button>
          </div>
        </header>

        <p v-if="records.length === 0" class="drawer-empty">
          本次运行还没有通知。会话完成、出错或等待你输入时，这里会留一条记录。
        </p>

        <ul v-else class="drawer-list">
          <li v-for="record in records" :key="record.id" class="drawer-item">
            <button
              class="drawer-record"
              type="button"
              @click="emit('open-session', record.sessionId)"
            >
              <component
                :is="iconFor(record.kind)"
                class="record-icon"
                :data-severity="record.severity"
                :size="15"
                :stroke-width="1.9"
                aria-hidden="true"
              />
              <span class="record-main">
                <span class="record-head">
                  <span class="record-title">{{ record.title }}</span>
                  <time class="record-time">{{ formatNotificationClock(record.atMs) }}</time>
                </span>
                <span class="record-body">{{ record.body }}</span>
              </span>
            </button>
          </li>
        </ul>
      </aside>
    </div>
  </Transition>
</template>

<style scoped>
/* 遮罩铺满整窗，抽屉贴在右侧；z-index 高于对话框（45），低于 tooltip（60）。 */
.drawer-scrim {
  position: fixed;
  inset: 0;
  z-index: 64;
  background: rgb(0 0 0 / 22%);
  animation: drawer-scrim-in var(--dur-base) var(--ease);
}

.drawer-panel {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 65;
  display: flex;
  flex-direction: column;
  width: min(340px, 100vw);
  border-left: 1px solid var(--border);
  background: var(--surface);
  color: var(--fg);
  box-shadow: var(--shadow-modal);
  animation: drawer-in var(--dur-slow) var(--ease-spring);
}

.drawer-panel:focus {
  outline: none;
}

.drawer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 12px 12px 10px 16px;
  border-bottom: 1px solid var(--border);
}

.drawer-heading {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.drawer-title {
  margin: 0;
  font-size: var(--fs-title);
  font-weight: 620;
  letter-spacing: -0.2px;
}

.drawer-count {
  font-size: var(--fs-micro);
  color: var(--fg-subtle);
}

.drawer-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.drawer-clear {
  padding: 4px 9px;
  border-radius: var(--r-sm);
  color: var(--fg-muted);
  font-size: var(--fs-micro);
  transition:
    background-color var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}

.drawer-clear:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--fg);
}

.drawer-clear:disabled {
  opacity: 0.45;
  cursor: default;
}

.drawer-close {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: var(--r-sm);
  color: var(--fg-muted);
  transition:
    background-color var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}

.drawer-close:hover {
  background: var(--bg-hover);
  color: var(--fg);
}

.drawer-empty {
  margin: 0;
  padding: 28px 16px;
  font-size: var(--fs-caption);
  line-height: 1.8;
  color: var(--fg-subtle);
}

.drawer-list {
  flex: 1;
  min-height: 0;
  margin: 0;
  padding: 6px;
  overflow-y: auto;
  list-style: none;
}

.drawer-record {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  width: 100%;
  padding: 8px 9px;
  border-radius: var(--r-md);
  text-align: left;
  transition: background-color var(--dur-fast) var(--ease);
}

.drawer-record:hover {
  background: var(--bg-raised);
}

.record-icon {
  flex: none;
  margin-top: 2px;
  color: var(--accent);
}

.record-icon[data-severity="success"] {
  color: var(--ok);
}

.record-icon[data-severity="error"] {
  color: var(--danger);
}

.record-main {
  flex: 1;
  min-width: 0;
}

.record-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.record-title {
  font-size: var(--fs-caption);
  font-weight: 600;
}

.record-time {
  flex: none;
  font-size: var(--fs-micro);
  font-variant-numeric: tabular-nums;
  color: var(--fg-subtle);
}

.record-body {
  display: block;
  margin-top: 1px;
  font-size: var(--fs-caption);
  line-height: 1.6;
  color: var(--fg-muted);
  overflow-wrap: anywhere;
}

@keyframes drawer-scrim-in {
  from {
    opacity: 0;
  }

  to {
    opacity: 1;
  }
}

@keyframes drawer-in {
  from {
    opacity: 0.6;
    transform: translateX(18px);
  }

  to {
    opacity: 1;
    transform: none;
  }
}

.drawer-enter-active,
.drawer-leave-active {
  transition: opacity var(--dur-base) var(--ease);
}

.drawer-enter-from,
.drawer-leave-to {
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .drawer-panel,
  .drawer-scrim {
    animation: none;
  }

  .drawer-enter-active,
  .drawer-leave-active {
    transition: opacity var(--dur-fast) linear;
  }
}
</style>
