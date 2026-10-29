<script setup lang="ts">
/**
 * 右下角通知堆栈（V4-S2b，Issue #117）。
 *
 * 布局：固定在右下角、向上增长；同一时刻最多 `MAX_VISIBLE_TOASTS`（4）条，
 * 超出的由 store 排队，关掉一条就顶上一条。这里只负责呈现与派发动作，
 * 倒计时、队列、历史全在 store 里。
 *
 * 三条交互约定：
 * 1. **点击穿透**：容器 `pointer-events: none`，只有卡片本身可点，
 *    空白区域的点击会落到下面的界面上，不会被一个透明层挡住；
 * 2. **悬停暂停**：`mouseenter/focusin` 派发 pause，离开派发 resume——
 *    键盘用户把焦点移进卡片同样暂停，否则读屏还没读完卡片就消失了；
 * 3. **点卡片即关闭**：卡片任意非按钮区域点击都关闭它，按钮自己 stopPropagation。
 */
import { CircleAlert, CircleCheck, CircleQuestionMark, X } from "@lucide/vue";

import type { NotificationEventKind } from "../notifications/settings.ts";
import type { ToastItem } from "../notifications/toast.ts";

defineProps<{ toasts: ToastItem[] }>();

const emit = defineEmits<{
  dismiss: [id: string];
  pause: [id: string];
  resume: [id: string];
  open: [sessionId: string];
}>();

const ICONS = {
  sessionCompleted: CircleCheck,
  sessionError: CircleAlert,
  awaitingInput: CircleQuestionMark,
} as const;

function iconFor(kind: NotificationEventKind) {
  return ICONS[kind];
}

/** 点按钮时不关闭卡片：操作按钮与关闭按钮自己处理点击。 */
function onCardClick(toast: ToastItem, event: MouseEvent): void {
  const target = event.target;
  if (target instanceof Element && target.closest("button")) return;
  emit("dismiss", toast.id);
}
</script>

<template>
  <section class="toast-stack" aria-label="通知" aria-live="polite" aria-relevant="additions">
    <TransitionGroup name="toast">
      <article
        v-for="toast in toasts"
        :key="toast.id"
        class="toast"
        :data-kind="toast.kind"
        :data-severity="toast.severity"
        :data-fading="toast.fading ? 'true' : undefined"
        :role="toast.severity === 'error' ? 'alert' : 'status'"
        @mouseenter="emit('pause', toast.id)"
        @mouseleave="emit('resume', toast.id)"
        @focusin="emit('pause', toast.id)"
        @focusout="emit('resume', toast.id)"
        @click="onCardClick(toast, $event)"
      >
        <component
          :is="iconFor(toast.kind)"
          class="toast-icon"
          :size="17"
          :stroke-width="1.9"
          aria-hidden="true"
        />
        <div class="toast-main">
          <p class="toast-title">{{ toast.title }}</p>
          <p class="toast-text">{{ toast.body }}</p>
          <button
            v-if="toast.actionLabel"
            class="toast-action"
            type="button"
            @click.stop="emit('open', toast.sessionId)"
          >
            {{ toast.actionLabel }}
          </button>
        </div>
        <button
          class="toast-close"
          type="button"
          aria-label="关闭通知"
          @click.stop="emit('dismiss', toast.id)"
        >
          <X :size="14" :stroke-width="2" aria-hidden="true" />
        </button>
      </article>
    </TransitionGroup>
  </section>
</template>

<style scoped>
/*
 * 固定在右下角、向上增长。
 *
 * column 方向 + 底部对齐：新 toast 追加在数组末尾（也就是最下面），
 * 旧的被顶上去，视觉上就是「从右下角滑入、整摞往上长」。
 * pointer-events: none 让空白区域点击穿透到应用界面。
 */
.toast-stack {
  position: fixed;
  right: 18px;
  bottom: 18px;
  z-index: 55;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  width: min(360px, calc(100vw - 36px));
  pointer-events: none;
}

.toast {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  width: 100%;
  padding: 10px 10px 10px 12px;
  border-radius: var(--r-lg);
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--fg);
  box-shadow: var(--shadow-pop);
  pointer-events: auto;
  cursor: default;
  transition: opacity var(--dur-slow) var(--ease);
}

/* 淡出是「消失之前」发生的：store 在到期前 TOAST_FADE_LEAD_MS 就置位。 */
.toast[data-fading="true"] {
  opacity: 0;
}

.toast-icon {
  flex: none;
  margin-top: 1px;
  color: var(--accent);
}

.toast[data-severity="success"] .toast-icon {
  color: var(--ok);
}

.toast[data-severity="error"] .toast-icon {
  color: var(--danger);
}

.toast-main {
  flex: 1;
  min-width: 0;
}

.toast-title {
  margin: 0;
  font-size: var(--fs-control);
  font-weight: 600;
  line-height: 1.5;
}

.toast-text {
  margin: 1px 0 0;
  font-size: var(--fs-caption);
  line-height: 1.65;
  color: var(--fg-muted);
  overflow-wrap: anywhere;
}

.toast-action {
  margin-top: 6px;
  padding: 3px 9px;
  border-radius: var(--r-sm);
  background: var(--bg-raised);
  color: var(--fg);
  font-size: var(--fs-micro);
  transition: background-color var(--dur-fast) var(--ease);
}

.toast-action:hover {
  background: var(--bg-hover);
}

.toast-close {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  flex: none;
  border-radius: var(--r-sm);
  color: var(--fg-subtle);
  transition:
    background-color var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}

.toast-close:hover {
  background: var(--bg-hover);
  color: var(--fg);
}

/* 入场：从右下滑入 + 轻微缩放，缓动走 --ease-spring。 */
.toast-enter-active {
  transition:
    opacity var(--dur-base) var(--ease),
    transform var(--dur-slow) var(--ease-spring);
}

/*
 * 离场保留原槽位，只在 200ms 内淡出 + 上移；移除后由 .toast-move 把下面的卡片补上来。
 * 不改成 position: absolute：那样离场卡片会瞬间跳到右下角，视觉上像闪了一下。
 */
.toast-leave-active {
  transition:
    opacity var(--dur-fast) var(--ease),
    transform var(--dur-fast) var(--ease);
}

.toast-move {
  transition: transform var(--dur-base) var(--ease);
}

.toast-enter-from {
  opacity: 0;
  transform: translate(26px, 18px) scale(0.96);
}

.toast-leave-to {
  opacity: 0;
  transform: translateY(-6px) scale(0.98);
}

/* 无障碍：偏好减少动效时只保留透明度变化，不做位移与缩放。 */
@media (prefers-reduced-motion: reduce) {
  .toast-enter-active,
  .toast-leave-active,
  .toast-move {
    transition: opacity var(--dur-fast) linear;
  }

  .toast-enter-from,
  .toast-leave-to {
    transform: none;
  }
}
</style>
