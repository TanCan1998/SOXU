<script setup lang="ts">
/**
 * 单文件 diff 面板（Issue #121 · TASK-029）。
 *
 * 只负责「把一份补丁画出来」：
 * - 行号来自补丁自身（components/gitDiff.ts 解析 hunk 头）；
 * - 着色复用 S1 的 shiki 管线，失败退回纯文本；
 * - 高亮是异步的，用递增令牌丢弃迟到结果；组件卸载时作废在途任务。
 *
 * 抽屉一次只挂一个本组件，因此「谁持有高亮状态」始终唯一。
 */

import { onUnmounted, ref, watch } from "vue";

import {
  diffRows,
  highlightDiffLines,
  visibleDiffRows,
  withHighlight,
  type GitDiffRow,
} from "./gitDiff.ts";
import type { GitFileDiffView } from "../workspace/types.ts";

const props = defineProps<{
  path: string;
  diff: GitFileDiffView | null;
  loading: boolean;
  error: string | null;
}>();

const state = ref<{ loading: boolean; rows: GitDiffRow[]; hidden: number }>({
  loading: false,
  rows: [],
  hidden: 0,
});
/** 递增令牌：切换文件或卸载后，旧的高亮结果直接丢弃。 */
let token = 0;

watch(
  () => props.diff,
  async (diff) => {
    const ticket = ++token;
    if (!diff) {
      state.value = { loading: false, rows: [], hidden: 0 };
      return;
    }
    state.value = { loading: true, rows: [], hidden: 0 };
    const rows = diffRows(diff.patch);
    const lines = await highlightDiffLines(diff.patch).catch(() => null);
    if (ticket !== token) return;
    const visible = visibleDiffRows(withHighlight(rows, lines));
    state.value = { loading: false, rows: visible.rows, hidden: visible.hidden };
  },
  { immediate: true },
);

onUnmounted(() => {
  // 只作废在途的高亮：没有定时器、没有事件监听，不需要其他清理。
  token += 1;
});
</script>

<template>
  <div class="diff-panel" role="region" :aria-label="path + ' 的 diff'">
    <p v-if="loading || state.loading" class="hint" role="status">正在读取 diff…</p>
    <p v-else-if="error" class="error" role="alert">{{ error }}</p>
    <template v-else-if="diff">
      <p class="meta">
        {{ diff.staged ? "已暂存" : "工作区" }} ·
        <span class="plus">+{{ diff.added ?? 0 }}</span>
        <span class="minus">-{{ diff.removed ?? 0 }}</span>
        <template v-if="diff.binary"> · 二进制文件没有文本补丁</template>
        <template v-if="diff.truncated"> · 输出已截断</template>
      </p>
      <p v-if="state.rows.length === 0 && !diff.binary" class="hint">
        该文件在这个区没有文本差异。
      </p>
      <div v-else class="body" tabindex="0">
        <div v-for="(line, index) in state.rows" :key="index" class="line" :data-kind="line.kind">
          <span class="ln">{{ line.oldNumber ?? "" }}</span>
          <span class="ln">{{ line.newNumber ?? "" }}</span>
          <span v-if="line.html" class="code" v-html="line.html"></span>
          <span v-else class="code">{{ line.text }}</span>
        </div>
      </div>
      <p v-if="state.hidden > 0" class="hint" role="note">
        仅显示前 {{ state.rows.length }} 行，还有 {{ state.hidden }} 行未渲染；
        完整补丁请用 git 命令查看。
      </p>
    </template>
    <p v-else class="hint">尚未加载 diff。</p>
  </div>
</template>

<style scoped>
.diff-panel {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 2px 0 6px 16px;
  padding: 6px;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--bg-raised);
}

.meta {
  margin: 0;
  display: flex;
  gap: 6px;
  font-size: var(--fs-micro);
  color: var(--fg-subtle);
}

.plus {
  color: var(--ok);
}

.minus {
  color: var(--danger);
}

/*
 * 一次最多渲染 1200 行（见 MAX_RENDERED_DIFF_ROWS）：超出时父组件的列表与这里的
 * 滚动都保持流畅，并明确提示还有多少行未渲染。
 */
.body {
  max-height: 320px;
  overflow: auto;
  font-family: var(--soxu-font-family-mono);
  font-size: var(--fs-micro);
  line-height: 1.55;
}

.line {
  display: grid;
  grid-template-columns: 34px 34px minmax(0, 1fr);
  gap: 4px;
  white-space: pre;
}

.line[data-kind="add"] {
  background: color-mix(in srgb, var(--ok) 12%, transparent);
}

.line[data-kind="del"] {
  background: color-mix(in srgb, var(--danger) 12%, transparent);
}

.line[data-kind="hunk"] {
  color: var(--accent);
}

.line[data-kind="meta"],
.line[data-kind="note"] {
  color: var(--fg-subtle);
}

/* 行号列固定宽度 + 等宽数字，新增/删除行的内容才能对齐。 */
.ln {
  color: var(--fg-subtle);
  text-align: end;
  user-select: none;
  font-variant-numeric: tabular-nums;
}

.code {
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.hint {
  margin: 0;
  font-size: var(--fs-micro);
  line-height: 1.7;
  color: var(--fg-subtle);
}

.error {
  margin: 0;
  font-size: var(--fs-micro);
  line-height: 1.7;
  color: var(--danger);
  overflow-wrap: anywhere;
}
</style>
