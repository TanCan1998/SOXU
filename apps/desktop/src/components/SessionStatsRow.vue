<script setup lang="ts">
/**
 * 底部统计行（Issue #119 / TASK-027）。
 *
 * 七项：轮次 / 首 token / 回复耗时 / 流式 / 均速 / 缓存命中 / 输入输出。
 * 全部来自同一个统计快照，因此与浮窗里的同名项必然一致。
 * 没有观测到的项显示「—」，不是 0：`statsRowItems` 负责这条规则，组件不重复判断。
 */

import { computed } from "vue";

import { PLACEHOLDER, statsRowItems, type SessionStatsView } from "./sessionStats.ts";
import { useLocale } from "../locales/index.ts";

const props = defineProps<{ view: SessionStatsView }>();

const { t } = useLocale();

const items = computed(() => statsRowItems(props.view));
</script>

<template>
  <dl class="stats-row" :aria-label="t('session.stats.row.label')">
    <div v-for="item in items" :key="item.key" class="stat">
      <dt>{{ item.label }}</dt>
      <dd :data-empty="item.value === PLACEHOLDER">{{ item.value }}</dd>
    </div>
  </dl>
</template>

<style scoped>
.stats-row {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 14px;
  margin: 0;
  padding: 0 4px;
  font-size: 0.65625rem;
  color: var(--soxu-muted);
}

.stat {
  display: flex;
  align-items: baseline;
  gap: 5px;
}

.stat dt {
  color: var(--soxu-muted);
}

.stat dd {
  margin: 0;
  color: var(--soxu-subtext);
  font-variant-numeric: tabular-nums;
}

/* 占位值比真实数字更淡：一眼能看出「没有数据」而不是「数据是 0」。 */
.stat dd[data-empty="true"] {
  color: color-mix(in srgb, var(--soxu-muted) 70%, transparent);
}
</style>
