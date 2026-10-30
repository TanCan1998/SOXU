<script setup lang="ts">
/**
 * 上下文占用圆环 + 统计浮窗（Issue #119 / TASK-027）。
 *
 * 规格来自 Issue：14px SVG、stroke 2.8、按占用率变色（<60% 强调色 / 60–85% 警告 / >85% 危险）。
 * 浮窗用 reka-ui Popover（项目里 DropdownMenu/Dialog 已有同一套行为基座），
 * 键盘 Esc 关闭、焦点归还触发钮都由它负责，组件不自己写全局监听器。
 *
 * 数据全部来自 sessionStats.ts 的纯函数：组件不判断阈值、不格式化数字，
 * 因此「圆环颜色随占用率变化」与「无数据时显示占位」都能在 Node 里直接验证。
 *
 * 样式分两块（原因见文件末尾注释）：圆环用 scoped，浮窗用全局命名空间类。
 */

import { computed, ref, watch } from "vue";
import {
  PopoverContent,
  PopoverPortal,
  PopoverRoot,
  PopoverTrigger,
} from "reka-ui";

import {
  PLACEHOLDER,
  RING_SIZE,
  RING_STROKE,
  formatPercent,
  processDegradedNotes,
  ringGeometry,
  ringLabel,
  ringTone,
  statsPopoverSections,
  type SessionStatsView,
} from "./sessionStats.ts";

const props = withDefaults(
  defineProps<{
    view: SessionStatsView;
    loading?: boolean;
    error?: string | null;
  }>(),
  { loading: false, error: null },
);

const emit = defineEmits<{
  /** 浮窗打开时才拉一次统计：这是用户手势，不是轮询。 */
  (event: "refresh"): void;
}>();

const open = ref(false);
const tone = computed(() => ringTone(props.view.context.percent));
const geometry = computed(() => ringGeometry(props.view.context.percent));
const percentText = computed(() => formatPercent(props.view.context.percent));
const label = computed(() => ringLabel(props.view));
const sections = computed(() => statsPopoverSections(props.view));
const notes = computed(() => processDegradedNotes(props.view.process.degraded));

watch(open, (isOpen) => {
  if (isOpen) emit("refresh");
});
</script>

<template>
  <PopoverRoot v-model:open="open">
    <PopoverTrigger as-child>
      <button
        class="stats-ring"
        type="button"
        :aria-label="`${label}（打开统计浮窗）`"
        :data-tone="tone"
        :data-loading="loading"
      >
        <svg
          class="ring"
          :width="RING_SIZE"
          :height="RING_SIZE"
          :viewBox="`0 0 ${RING_SIZE} ${RING_SIZE}`"
          aria-hidden="true"
        >
          <circle
            class="ring-track"
            :cx="RING_SIZE / 2"
            :cy="RING_SIZE / 2"
            :r="geometry.radius"
            :stroke-width="RING_STROKE"
            fill="none"
          />
          <circle
            v-if="tone !== 'unknown'"
            class="ring-value"
            :cx="RING_SIZE / 2"
            :cy="RING_SIZE / 2"
            :r="geometry.radius"
            :stroke-width="RING_STROKE"
            fill="none"
            :stroke-dasharray="geometry.circumference"
            :stroke-dashoffset="geometry.dashOffset"
            :transform="`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`"
          />
        </svg>
        <span class="ring-text" aria-hidden="true">{{ percentText }}</span>
      </button>
    </PopoverTrigger>

    <PopoverPortal>
      <PopoverContent
        class="soxu-stats-popover"
        side="top"
        align="end"
        :side-offset="8"
        :collision-padding="8"
      >
        <header class="soxu-stats-popover__head">
          <strong>上下文与统计</strong>
          <span v-if="view.turn.inFlight" class="badge" data-tone="accent">进行中</span>
        </header>

        <p v-if="error" class="soxu-stats-popover__error" role="alert">{{ error }}</p>
        <p v-if="!view.hasData" class="soxu-stats-popover__note" role="note">
          还没有观测到运行时事件。发一条消息后，这里的数字会跟着事件流一起更新。
        </p>

        <section
          v-for="section in sections"
          :key="section.title"
          class="soxu-stats-popover__section"
        >
          <p class="soxu-stats-popover__title">{{ section.title }}</p>
          <dl class="soxu-stats-popover__list">
            <div
              v-for="item in section.items"
              :key="item.key"
              class="soxu-stats-popover__row"
            >
              <dt>{{ item.label }}</dt>
              <dd :data-empty="item.value === PLACEHOLDER">
                {{ item.value }}
                <span v-if="item.hint" class="soxu-stats-popover__hint">{{ item.hint }}</span>
              </dd>
            </div>
          </dl>
        </section>

        <p v-for="note in notes" :key="note" class="soxu-stats-popover__note">{{ note }}</p>
        <p v-if="view.session.worktree" class="soxu-stats-popover__foot">
          工作树：{{ view.session.worktree }}
        </p>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>

<style scoped>
/* 圆环按钮：14px 图形 + 右侧百分比文字，点击区域按可点面积撑到 24px。 */
.stats-ring {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 6px;
  border-radius: 999px;
  color: var(--soxu-muted);
  transition:
    background-color var(--soxu-motion-fast) var(--soxu-motion-ease),
    color var(--soxu-motion-fast) var(--soxu-motion-ease);
}

.stats-ring:hover {
  background: var(--soxu-hover);
  color: var(--soxu-fg);
}

.stats-ring[data-loading="true"] {
  opacity: 0.65;
}

.ring {
  display: block;
  flex: none;
}

.ring-track {
  stroke: var(--soxu-border);
}

/* 颜色档位：与 ringTone 的三档一一对应，阈值不在这里重复。 */
.stats-ring[data-tone="accent"] .ring-value {
  stroke: var(--soxu-accent);
}

.stats-ring[data-tone="warn"] .ring-value {
  stroke: var(--soxu-warn);
}

.stats-ring[data-tone="danger"] .ring-value {
  stroke: var(--soxu-danger);
}

.stats-ring[data-tone="accent"] .ring-text {
  color: var(--soxu-accent);
}

.stats-ring[data-tone="warn"] .ring-text {
  color: var(--soxu-warn);
}

.stats-ring[data-tone="danger"] .ring-text {
  color: var(--soxu-danger);
}

.ring-text {
  font-size: 0.6875rem;
  font-variant-numeric: tabular-nums;
}
</style>

<!--
  浮窗样式不能写在 scoped 块里：PopoverContent 经 Portal 传送到 body，
  reka-ui 的弹层根元素不会带上本组件的 scope 属性（data-v-*），
  scoped 选择器因此全部落空——实测表现为「透明背景 + 16px 正文字号」，
  浮窗内容直接压在页面卡片上。改为带命名空间的全局类，
  并用 shoot-issue-119-stats.mjs 断言背景不透明与字号上限，防止回退。
-->
<style>
.soxu-stats-popover {
  z-index: 60;
  width: 292px;
  max-height: 420px;
  overflow-y: auto;
  padding: 12px 14px;
  border-radius: 12px;
  border: 1px solid var(--soxu-border);
  background: var(--soxu-panel);
  box-shadow: 0 18px 48px rgb(0 0 0 / 18%);
  font-size: 0.71875rem;
  line-height: 1.6;
  color: var(--soxu-fg);
}

.soxu-stats-popover__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
}

.soxu-stats-popover__head strong {
  font-size: 0.75rem;
  font-weight: 600;
}

.soxu-stats-popover__section + .soxu-stats-popover__section {
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px solid var(--soxu-border);
}

.soxu-stats-popover__title {
  margin: 0 0 4px;
  color: var(--soxu-muted);
  font-size: 0.6875rem;
}

.soxu-stats-popover__list {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.soxu-stats-popover__row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
}

.soxu-stats-popover__row dt {
  color: var(--soxu-subtext);
}

.soxu-stats-popover__row dd {
  margin: 0;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

/* 占位值弱化显示：让「没有数据」和「数字是 0」在视觉上区分开。 */
.soxu-stats-popover__row dd[data-empty="true"] {
  color: var(--soxu-muted);
}

.soxu-stats-popover__hint {
  display: block;
  color: var(--soxu-muted);
  font-size: 0.65625rem;
}

.soxu-stats-popover__note {
  margin: 8px 0 0;
  color: var(--soxu-muted);
}

.soxu-stats-popover__error {
  margin: 0 0 8px;
  color: var(--soxu-danger);
}

.soxu-stats-popover__foot {
  margin: 8px 0 0;
  color: var(--soxu-muted);
  overflow-wrap: anywhere;
}
</style>
