<script setup lang="ts">
/**
 * 会话 Tab 栏：等宽布局 + 指针拖拽排序（Issue #99）。
 *
 * 两条实现约束：
 * 1. 等宽由 `tabStripLayout.tabWidth` 统一计算后写进 CSS 变量，任何 Tab 都不单独定宽，
 *    数量变化时所有 Tab 一起变宽/变窄，超出下限交给 `.tabs-scroll` 横向滚动。
 * 2. 拖拽是手写的指针事件（不引入依赖）：状态机与 window 级 listener 在
 *    `useTabDrag`，这里只做 DOM 测量、样式绑定和 click 抑制。
 *
 * 资源所有权：`ResizeObserver` 在本组件 `onBeforeUnmount` 释放，
 * 指针 listener 由 `useTabDrag` 在自己的作用域里释放，两边都不留在模块级。
 */

import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { Plus, X } from "@lucide/vue";
import AppTooltip from "./AppTooltip.vue";
import { useLocale } from "../locales/index.ts";
import { overflows, tabWidth } from "../composables/tabStripLayout.ts";
import { useTabDrag } from "../composables/useTabDrag.ts";
import type { SessionId, SessionTab } from "../workspace/types.ts";

const props = defineProps<{
  tabs: SessionTab[];
  activeSessionId: SessionId | null;
}>();

const emit = defineEmits<{
  (event: "select", sessionId: SessionId): void;
  (event: "close", sessionId: SessionId): void;
  (event: "new-temporary"): void;
  /** 只表达「第 fromIndex 个换到第 toIndex 个」；activeSessionId 由上层保持不动。 */
  (event: "move", fromIndex: number, toIndex: number): void;
}>();

const { t } = useLocale();

const tabButtons = ref<(HTMLButtonElement | null)[]>([]);
const scrollEl = ref<HTMLDivElement | null>(null);
const stripWidth = ref(0);

/** 函数式 ref（v-for 里的字符串 ref 在 <script setup> 下行为不直观，这里显式收集）。 */
function setTabRef(element: unknown, index: number) {
  tabButtons.value[index] = element instanceof HTMLButtonElement ? element : null;
}

/** 同一栏内所有 Tab 共用一个宽度：随数量变化，并夹在上下限之间。 */
const width = computed(() => tabWidth(props.tabs.length, stripWidth.value));
/** 已经被下限夹住 = 放不下，进入横向滚动（是否滚动由这一处决定）。 */
const scrolls = computed(() => overflows(props.tabs.length, stripWidth.value));

const {
  active: dragActive,
  settling,
  markerStyle,
  onPointerDown,
  styleFor,
  isDragged,
  consumeClickSuppression,
} = useTabDrag({
  count: () => props.tabs.length,
  container: () => scrollEl.value,
  tabWidth: () => width.value,
  onMove: (fromIndex, toIndex) => emit("move", fromIndex, toIndex),
});

/** 「临时」徽标至少要这么宽的位置，否则会把标题挤成一个省略号。 */
const TEMPORARY_BADGE_MIN_WIDTH = 132;
const showTemporaryBadge = computed(() => width.value >= TEMPORARY_BADGE_MIN_WIDTH);

/** 徽标被挤掉时把会话类型写进提示，信息不因为窄而丢失。 */
function tabTooltip(tab: SessionTab): string {
  if (tab.mode === "temporary" && !showTemporaryBadge.value) {
    return t("session.tabs.temporary.tooltip", { title: tab.title });
  }
  return tab.title;
}

let resizeObserver: ResizeObserver | null = null;

onMounted(() => {
  const element = scrollEl.value;
  if (!element) return;
  // 极简环境（老 WebView）没有 ResizeObserver 时退化为一帧宽度的静态值：布局仍可用，只是不跟随窗口变化。
  if (typeof ResizeObserver === "undefined") {
    stripWidth.value = element.clientWidth;
    return;
  }
  resizeObserver = new ResizeObserver((entries) => {
    const rect = entries[0]?.contentRect;
    if (rect) stripWidth.value = rect.width;
  });
  resizeObserver.observe(element);
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
});

function onTabClick(sessionId: SessionId) {
  // 拖拽刚结束时浏览器还会补发一次 click，不能让它顺手切换会话。
  if (consumeClickSuppression()) return;
  emit("select", sessionId);
}

/** 会话 Tab 的键盘导航：方向键移动、Home/End 跳到首尾、Delete 关闭当前。 */
async function onKeydown(event: KeyboardEvent, index: number) {
  const last = props.tabs.length - 1;
  let next = -1;
  if (event.key === "ArrowRight") next = index === last ? 0 : index + 1;
  else if (event.key === "ArrowLeft") next = index === 0 ? last : index - 1;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = last;
  else if (event.key === "Delete") {
    const tab = props.tabs[index];
    if (tab) emit("close", tab.sessionId);
    return;
  }
  if (next < 0) return;
  event.preventDefault();
  const tab = props.tabs[next];
  if (!tab) return;
  emit("select", tab.sessionId);
  await nextTick();
  tabButtons.value[next]?.focus();
}
</script>

<template>
  <div class="tab-strip" role="tablist" :aria-label="t('session.tabs.list.label')">
    <div
      ref="scrollEl"
      class="tabs-scroll"
      :class="{ 'is-scrollable': scrolls, 'is-settling': settling }"
      :style="{ '--soxu-tab-width': `${width}px` }"
    >
      <div
        v-for="(tab, index) in tabs"
        :key="tab.sessionId"
        class="tab-item"
        :class="{ dragging: isDragged(index) }"
        :style="styleFor(index)"
        @pointerdown="onPointerDown"
      >
        <AppTooltip :text="tabTooltip(tab)" :disabled="dragActive">
          <button
            :id="`soxu-tab-${tab.sessionId}`"
            :ref="(element) => setTabRef(element, index)"
            class="tab"
            type="button"
            role="tab"
            :aria-selected="tab.sessionId === activeSessionId"
            :aria-controls="'soxu-chat-panel'"
            :tabindex="tab.sessionId === activeSessionId ? 0 : -1"
            :class="{ chosen: tab.sessionId === activeSessionId }"
            @click="onTabClick(tab.sessionId)"
            @keydown="onKeydown($event, index)"
          >
            <span class="state-dot" :data-state="tab.status" aria-hidden="true"></span>
            <span class="tab-title">{{ tab.title }}</span>
            <span v-if="tab.mode === 'temporary' && showTemporaryBadge" class="tab-tag">
              {{ t("session.tabs.temporary.badge") }}
            </span>
          </button>
        </AppTooltip>
        <AppTooltip :text="t('session.tabs.close.hint')" :disabled="dragActive">
          <button
            class="tab-close"
            type="button"
            :aria-label="t('session.tabs.close.label', { title: tab.title })"
            @click="emit('close', tab.sessionId)"
          >
            <X :size="14" :stroke-width="2" aria-hidden="true" />
          </button>
        </AppTooltip>
      </div>
      <span v-if="markerStyle" class="drop-marker" :style="markerStyle" aria-hidden="true"></span>
    </div>
    <AppTooltip :text="t('session.tabs.new')">
      <button
        class="icon-button"
        type="button"
        :aria-label="t('session.tabs.new')"
        @click="emit('new-temporary')"
      >
        <Plus :size="18" :stroke-width="1.75" aria-hidden="true" />
      </button>
    </AppTooltip>
  </div>
</template>

<style scoped>
.tab-strip {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px 6px 18px;
  border-bottom: 1px solid var(--soxu-border);
  min-height: 46px;
}

.tabs-scroll {
  position: relative;
  display: flex;
  align-items: center;
  /* 与 tabStripLayout.ts 的 TAB_GAP 必须一致：等宽计算按这个值扣掉间距。 */
  gap: 6px;
  overflow-x: auto;
  scrollbar-width: none;
  padding: 2px;
  flex: 1;
  min-width: 0;
}

.tabs-scroll.is-scrollable {
  /* 横向滚动与拖拽排序互斥，滚动仍可用触控板/滚轮；这里只约束滚动链。 */
  overscroll-behavior-x: contain;
}

.tab-item {
  display: flex;
  align-items: center;
  /* 等宽：宽度只来自组件算出的 CSS 变量，单个 Tab 不再有自己的 min/max 宽度。 */
  width: var(--soxu-tab-width, 220px);
  flex: 0 0 auto;
  border-radius: 9px;
  /*
   * hover 用 inset 阴影画 1px 边框：加真实 border 会让 Tab 宽度跳 2px，
   * 鼠标经过时整条 Tab 会抖动。
   */
  box-shadow: inset 0 0 0 1px transparent;
  transition:
    box-shadow var(--soxu-motion-fast) var(--soxu-motion-ease),
    transform var(--soxu-motion-base) var(--soxu-motion-ease);
  /* 触屏：横向滑动归拖拽排序，纵向仍交给页面滚动。 */
  touch-action: pan-y;
}

.tab-item,
.tab {
  cursor: grab;
}

.tab-item:hover {
  background: var(--soxu-hover);
  box-shadow: inset 0 0 0 1px var(--soxu-border);
}

.tab-item.dragging {
  /* 跟随指针时不能有过渡，否则手感发飘。 */
  transition: none;
  background: var(--soxu-hover);
  /* 卡片抬起的阴影：拖动时会盖住相邻 Tab，需要视觉上「浮起来」才不像是错位。 */
  box-shadow:
    var(--soxu-shadow-raised),
    inset 0 0 0 1px var(--soxu-border);
}

.tab-item.dragging,
.tab-item.dragging .tab {
  cursor: grabbing;
}

/* 松手当帧关掉过渡：顺序改写与 transform 移除同帧生效，瞬时落位而不是回弹重影。 */
.tabs-scroll.is-settling .tab-item {
  transition: none;
}

.tab {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 7px 4px 7px 10px;
  font-size: 0.78125rem;
  color: var(--soxu-subtext);
  flex: 1 1 auto;
  min-width: 0;
}

.tab.chosen {
  color: var(--soxu-fg);
  background: var(--soxu-selected);
  border-radius: 9px 0 0 9px;
}

.tab-title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tab-tag {
  /* #99 的 flex: none 与 #98 的 rem 字号都要保留：rem 让字号跟随全局设置。 */
  flex: none;
  font-size: 0.625rem;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--soxu-accent-soft);
  color: var(--soxu-accent);
}

.tab-close {
  display: grid;
  place-items: center;
  flex: none;
  width: 26px;
  height: 30px;
  border-radius: 0 9px 9px 0;
  color: var(--soxu-muted);
}

.tab-close {
  transition:
    color var(--soxu-motion-fast) var(--soxu-motion-ease),
    background-color var(--soxu-motion-fast) var(--soxu-motion-ease);
}

.tab-close:hover {
  color: var(--soxu-fg);
  background: var(--soxu-border);
}

/* 插入位置指示：把腾出来的槽位画成虚线框，比一根竖线更不容易被误认成文本光标。 */
.drop-marker {
  position: absolute;
  top: 2px;
  bottom: 2px;
  left: 0;
  /* 宽度跟随同一个等宽变量，槽位框和 Tab 永远一样宽。 */
  width: calc(var(--soxu-tab-width, 220px) - 2px);
  border: 2px dashed var(--soxu-accent);
  border-radius: 9px;
  background: var(--soxu-accent-soft);
  pointer-events: none;
  /* 放在被拖卡片下面：卡片压在自己的目标槽位上时，框仍然从边缘露出来。 */
  z-index: 1;
}

@media (prefers-reduced-motion: reduce) {
  /*
   * 让位与落位退化为瞬时切换：保留位置信息，不做补间。
   * base.css 已把通配 transition-duration 压到 0.01ms，这里直接取消 transform 过渡，
   * 免得不同渲染引擎对「极短但仍存在」的过渡处理不一致。
   */
  .tab-item {
    transition: none;
  }
}
</style>
