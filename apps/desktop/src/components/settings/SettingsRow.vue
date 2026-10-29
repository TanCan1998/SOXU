<script setup lang="ts">
/**
 * 设置项的统一行布局（Issue #116）：左侧标题 + 说明，右侧控件，下方可选注释。
 *
 * 为什么做成组件：四个页面共 26 个设置项，行距、标签字号、注释样式必须一致；
 * 逐个页面手写 <div class="field"> 迟早漂移。
 *
 * 无障碍：标题元素带 useId 生成的 id，并通过插槽把 labelId 交给控件，
 * 控件用它做 aria-labelledby —— 读屏读到的名字与界面上的可见标题逐字一致。
 */

import { useId } from "reka-ui";

defineProps<{
  label: string;
  description?: string;
}>();

const labelId = useId();
</script>

<template>
  <div class="row">
    <div class="row-text">
      <p :id="labelId" class="row-label">{{ label }}</p>
      <p v-if="description" class="row-desc">{{ description }}</p>
    </div>
    <div class="row-control">
      <slot :label-id="labelId" />
    </div>
    <p v-if="$slots.note" class="row-note">
      <slot name="note" />
    </p>
  </div>
</template>

<style scoped>
.row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 16px;
  padding: 11px 0;
  border-bottom: 1px solid var(--border);
}

.row:last-child {
  border-bottom: 0;
}

.row-text {
  min-width: 0;
  flex: 1 1 190px;
}

.row-label {
  margin: 0;
  font-size: 0.78125rem;
  color: var(--fg);
}

.row-desc {
  margin: 3px 0 0;
  font-size: 0.6875rem;
  line-height: 1.55;
  color: var(--fg-muted);
  overflow-wrap: anywhere;
}

.row-control {
  display: flex;
  flex: 0 1 auto;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

/* 注释占满一整行：它解释的是「为什么现在只能这样」，属于整行的补充说明。 */
.row-note {
  flex: 1 0 100%;
  margin: 0;
  font-size: 0.65625rem;
  line-height: 1.65;
  color: var(--fg-subtle);
}
</style>
