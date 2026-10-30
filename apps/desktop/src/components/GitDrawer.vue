<script setup lang="ts">
/**
 * Git 抽屉（Issue #121 · TASK-029）。
 *
 * 分工：
 * - 数据与写操作都在 GitWorkspace（workspace/gitWorkspace.ts）：本组件只渲染
 *   props.view 并把点击转成事件，不自带防抖/重试，也不直接调用 bridge；
 * - diff 的行号与高亮在这里异步准备（components/gitDiff.ts）：行号来自补丁本身，
 *   高亮复用 S1 的 shiki 管线；切换文件或卸载时用递增令牌丢弃迟到结果，
 *   因此组件卸载没有残留任务需要清理。
 *
 * 一次只展开一个文件 diff（accordion）：抽屉宽 320px，多份补丁同时展开既读不清，
 * 也会让内存里堆着多份最大 512 KiB 的补丁文本。
 */

import { computed } from "vue";
import {
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  Download,
  FolderTree,
  GitBranch,
  List,
  RefreshCw,
  Upload,
  X,
} from "@lucide/vue";

import AppTooltip from "./AppTooltip.vue";
import GitDiffPanel from "./GitDiffPanel.vue";
import { flatRows, treeRows, type GitRow } from "../workspace/gitTree.ts";
import type { GitLayout, GitState, ProjectId, WorktreeId } from "../workspace/types.ts";

const props = defineProps<{
  projectId: ProjectId | null;
  worktreeId: WorktreeId | null;
  bridgeAvailable: boolean;
  view: GitState;
}>();

const emit = defineEmits<{
  (event: "close"): void;
  (event: "refresh"): void;
  (event: "select", path: string): void;
  (event: "toggle-dir", path: string): void;
  (event: "layout", layout: GitLayout): void;
  (event: "collapse-all"): void;
  (event: "stage-all"): void;
  (event: "commit"): void;
  (event: "push"): void;
  (event: "pull"): void;
  (event: "update:message", value: string): void;
}>();

const files = computed(() => props.view.status?.files ?? []);
const rows = computed<GitRow[]>(() =>
  props.view.layout === "tree" ? treeRows(files.value, props.view.collapsedDirs) : flatRows(files.value),
);
const busy = computed(() => props.view.action !== "idle");
const hasChanges = computed(() => files.value.length > 0);
const ahead = computed(() => props.view.status?.ahead ?? 0);
const behind = computed(() => props.view.status?.behind ?? 0);

function isCollapsed(path: string): boolean {
  return props.view.collapsedDirs.includes(path);
}

function isSelected(path: string): boolean {
  return props.view.selectedPath === path;
}

/** 徽章字母 → 中文说明（徽章本身仍显示字母，与 git status 一致）。 */
function statusLabel(status: string): string {
  switch (status) {
    case "A":
      return "新增";
    case "M":
      return "修改";
    case "D":
      return "删除";
    case "U":
      return "冲突";
    default:
      return "改动";
  }
}

function onCommitInput(event: Event) {
  emit("update:message", (event.target as HTMLTextAreaElement).value);
}

function onKeydown(event: KeyboardEvent) {
  if (event.key !== "Escape") return;
  event.stopPropagation();
  emit("close");
}
</script>

<template>
  <aside class="git-drawer" aria-label="Git 面板" @keydown="onKeydown">
    <header class="gd-head">
      <div class="gd-title">
        <GitBranch :size="15" :stroke-width="1.9" aria-hidden="true" />
        <strong>Git</strong>
        <span v-if="view.status?.branch" class="gd-branch">{{ view.status.branch }}</span>
        <span v-if="view.status?.upstream" class="gd-upstream">
          → {{ view.status.upstream }}
        </span>
        <span class="gd-spacer" />
        <AppTooltip text="刷新更改列表">
          <button
            class="icon-button small"
            type="button"
            :disabled="view.loading"
            aria-label="刷新更改列表"
            @click="emit('refresh')"
          >
            <RefreshCw :size="14" :stroke-width="1.75" aria-hidden="true" />
          </button>
        </AppTooltip>
        <AppTooltip text="关闭 Git 面板 (Esc)">
          <button class="icon-button small" type="button" aria-label="关闭 Git 面板" @click="emit('close')">
            <X :size="15" :stroke-width="1.75" aria-hidden="true" />
          </button>
        </AppTooltip>
      </div>

      <div v-if="bridgeAvailable && projectId" class="gd-actions">
        <AppTooltip text="拉取（只快进，不产生合并提交）">
          <button
            class="gd-action"
            type="button"
            :disabled="busy || !view.status"
            :aria-busy="view.action === 'pulling'"
            @click="emit('pull')"
          >
            <Download :size="13" :stroke-width="1.9" aria-hidden="true" />
            拉取<span v-if="behind > 0" class="gd-count">{{ behind }}</span>
          </button>
        </AppTooltip>
        <AppTooltip text="推送当前分支（不做强制覆盖）">
          <button
            class="gd-action"
            type="button"
            :disabled="busy || !view.status"
            :aria-busy="view.action === 'pushing'"
            @click="emit('push')"
          >
            <Upload :size="13" :stroke-width="1.9" aria-hidden="true" />
            推送<span v-if="ahead > 0" class="gd-count">{{ ahead }}</span>
          </button>
        </AppTooltip>
        <AppTooltip text="暂存全部改动（git add -A）">
          <button
            class="gd-action"
            type="button"
            :disabled="busy || !hasChanges"
            :aria-busy="view.action === 'staging'"
            @click="emit('stage-all')"
          >
            <Check :size="13" :stroke-width="2" aria-hidden="true" />
            全部暂存
          </button>
        </AppTooltip>
      </div>
    </header>

    <p v-if="!bridgeAvailable" class="gd-notice" role="status">
      浏览器预览未连接本机运行时，不读取 Git，也不会执行任何 Git 操作。
    </p>
    <p v-else-if="!projectId" class="gd-notice" role="status">
      先打开一个项目或会话，Git 面板会显示它的更改。
    </p>

    <template v-else>
      <p v-if="view.status?.operation" class="gd-warn" role="alert">
        有进行中的 Git 操作：{{ view.status.operation }}。完成前不要推送或拉取。
      </p>
      <p v-if="view.status?.indexLocked" class="gd-warn" role="alert">
        索引被其他进程锁定（index.lock）。确认没有其他 git 进程后再刷新。
      </p>
      <p v-if="view.error" class="gd-error" role="alert">{{ view.error }}</p>

      <div class="gd-list-head">
        <span class="gd-count-text">
          {{ view.loading ? "读取中…" : files.length + " 个改动" }}
          <template v-if="view.status && view.status.totalFiles > files.length">
            （共 {{ view.status.totalFiles }} 个）
          </template>
        </span>
        <AppTooltip :text="view.layout === 'tree' ? '切换为平铺' : '切换为树形'">
          <button
            class="icon-button small"
            type="button"
            :aria-label="view.layout === 'tree' ? '切换为平铺视图' : '切换为树形视图'"
            :aria-pressed="view.layout === 'flat'"
            @click="emit('layout', view.layout === 'tree' ? 'flat' : 'tree')"
          >
            <List v-if="view.layout === 'tree'" :size="14" :stroke-width="1.75" aria-hidden="true" />
            <FolderTree v-else :size="14" :stroke-width="1.75" aria-hidden="true" />
          </button>
        </AppTooltip>
        <AppTooltip text="全部折叠">
          <button
            class="icon-button small"
            type="button"
            aria-label="全部折叠"
            :disabled="!hasChanges"
            @click="emit('collapse-all')"
          >
            <ChevronsDownUp :size="14" :stroke-width="1.75" aria-hidden="true" />
          </button>
        </AppTooltip>
      </div>

      <ul v-if="rows.length > 0" class="gd-list" aria-label="更改列表">
        <li
          v-for="row in rows"
          :key="row.path"
          class="gd-row"
          :style="{ paddingInlineStart: 6 + row.depth * 12 + 'px' }"
        >
          <button
            v-if="row.isDir"
            class="gd-row-main"
            type="button"
            :aria-expanded="!isCollapsed(row.path)"
            :aria-label="row.name + ' 目录'"
            @click="emit('toggle-dir', row.path)"
          >
            <ChevronDown v-if="!isCollapsed(row.path)" :size="13" :stroke-width="1.9" aria-hidden="true" />
            <ChevronRight v-else :size="13" :stroke-width="1.9" aria-hidden="true" />
            <FolderTree :size="13" :stroke-width="1.75" aria-hidden="true" />
            <span class="gd-name">{{ row.name }}</span>
            <span class="gd-stats">
              {{ row.count }} 个 · <span class="plus">+{{ row.added }}</span>
              <span class="minus">-{{ row.removed }}</span>
            </span>
          </button>

          <button
            v-else
            class="gd-row-main"
            type="button"
            :aria-expanded="isSelected(row.path)"
            :aria-label="statusLabel(row.file?.status ?? '') + ' ' + row.path"
            @click="emit('select', row.path)"
          >
            <ChevronDown v-if="isSelected(row.path)" :size="13" :stroke-width="1.9" aria-hidden="true" />
            <ChevronRight v-else :size="13" :stroke-width="1.9" aria-hidden="true" />
            <span class="gd-badge" :data-status="row.file?.status">{{ row.file?.status }}</span>
            <span class="gd-name">{{ row.name }}</span>
            <span class="gd-stats">
              <span v-if="row.file?.binary" class="muted">二进制</span>
              <template v-else>
                <span v-if="row.file?.added !== null" class="plus">+{{ row.file?.added ?? 0 }}</span>
                <span v-if="row.file?.removed !== null" class="minus">-{{ row.file?.removed ?? 0 }}</span>
                <span v-if="row.file?.untracked" class="muted">未跟踪</span>
              </template>
            </span>
          </button>

          <!-- 一次只挂一个 diff 面板：高亮状态由它自己持有，切换文件即卸载。 -->
          <GitDiffPanel
            v-if="!row.isDir && isSelected(row.path)"
            :path="row.path"
            :diff="view.diff"
            :loading="view.diffLoading"
            :error="view.diffError"
          />
        </li>
      </ul>
      <p v-else-if="!view.loading" class="gd-empty">
        {{ view.error ? "读取失败，修正原因后重新刷新。" : "工作区没有未提交改动。" }}
      </p>

      <p v-if="view.status?.truncated" class="gd-hint" role="note">
        改动文件过多，列表只显示前一部分；计数仍然完整。
      </p>

      <form class="gd-commit" @submit.prevent="emit('commit')">
        <textarea
          class="gd-message"
          rows="2"
          placeholder="提交说明（必填）"
          aria-label="提交说明"
          spellcheck="false"
          :value="view.commitMessage"
          @input="onCommitInput"
        ></textarea>
        <button class="gd-primary" type="submit" :disabled="busy || !view.commitMessage.trim()">
          {{ view.action === "committing" ? "提交中…" : "提交" }}
        </button>
      </form>

      <p v-if="view.actionError" class="gd-error" role="alert">{{ view.actionError }}</p>
      <p v-else-if="view.actionNotice" class="gd-notice" role="status">{{ view.actionNotice }}</p>
    </template>
  </aside>
</template>

<style scoped>
/*
 * 右侧抽屉：宽度与 --insp-w 一致；与「会话状态」「搜索」互斥显示
 * （右侧一次只开一个面板，避免把正文挤到不可读）。
 */
.git-drawer {
  width: var(--insp-w);
  flex: none;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-left: 1px solid var(--border);
  background: var(--bg-panel);
  color: var(--fg);
}

.gd-head {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 12px 10px;
  border-bottom: 1px solid var(--border);
}

.gd-title {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: var(--fs-control);
}

.gd-title strong {
  font-weight: 640;
}

.gd-branch {
  font-family: var(--soxu-font-family-mono);
  font-size: var(--fs-micro);
  color: var(--accent);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gd-upstream {
  font-size: var(--fs-micro);
  color: var(--fg-subtle);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gd-spacer { flex: 1; }

.icon-button.small {
  width: 26px;
  height: 26px;
  border-radius: var(--r-sm);
}

.gd-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.gd-action {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 26px;
  padding: 0 8px;
  border-radius: var(--r-sm);
  border: 1px solid var(--border);
  background: var(--bg-raised);
  color: var(--fg-muted);
  font-size: var(--fs-micro);
  transition: background-color var(--dur-fast) var(--ease);
}

.gd-action:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--fg);
}

.gd-action:disabled {
  opacity: 0.45;
  cursor: default;
}


.gd-count {
  padding: 0 4px;
  border-radius: var(--r-full);
  background: var(--accent-soft);
  color: var(--accent);
  font-variant-numeric: tabular-nums;
}

.gd-list-head {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 8px 10px 4px;
}


.gd-count-text {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-micro);
  color: var(--fg-subtle);
}

.gd-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  list-style: none;
  margin: 0;
  padding: 2px 6px 6px;
}

.gd-row { display: flex; flex-direction: column; }

.gd-row-main {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
  min-height: 26px;
  padding: 3px 4px;
  border-radius: var(--r-sm);
  text-align: start;
  color: var(--fg);
  font-size: var(--fs-caption);
  transition: background-color var(--dur-fast) var(--ease);
}

.gd-row-main:hover { background: var(--bg-hover); }

.gd-row-main:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

.gd-badge {
  flex: none;
  width: 16px;
  text-align: center;
  border-radius: 4px;
  font-family: var(--soxu-font-family-mono);
  font-size: var(--fs-micro);
  font-weight: 700;
  color: var(--fg-subtle);
}

.gd-badge[data-status="A"] { color: var(--ok); }

.gd-badge[data-status="M"] { color: var(--accent); }

.gd-badge[data-status="D"],
.gd-badge[data-status="U"] { color: var(--danger); }

.gd-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gd-stats {
  flex: none;
  display: inline-flex;
  gap: 4px;
  font-family: var(--soxu-font-family-mono);
  font-size: var(--fs-micro);
  font-variant-numeric: tabular-nums;
}

.plus { color: var(--ok); }

.minus { color: var(--danger); }

.muted { color: var(--fg-subtle); }

.gd-empty,
.gd-hint {
  margin: 8px 10px;
  font-size: var(--fs-micro);
  line-height: 1.7;
  color: var(--fg-subtle);
}

.gd-notice,
.gd-warn,
.gd-error {
  margin: 8px 10px;
  padding: 6px 8px;
  border-radius: var(--r-sm);
  font-size: var(--fs-micro);
  line-height: 1.7;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.gd-notice {
  background: var(--bg-raised);
  color: var(--fg-muted);
}

.gd-warn {
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  color: var(--accent);
}

.gd-error {
  background: color-mix(in srgb, var(--danger) 12%, transparent);
  color: var(--danger);
}

.gd-commit {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px;
  border-top: 1px solid var(--border);
}

.gd-message {
  width: 100%;
  resize: vertical;
  min-height: 46px;
  padding: 6px 8px;
  border-radius: var(--r-sm);
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--fg);
  font-family: inherit;
  font-size: var(--fs-caption);
  line-height: 1.6;
}

.gd-message:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -1px;
}

.gd-primary {
  height: 28px;
  border-radius: var(--r-sm);
  background: var(--accent);
  color: var(--surface);
  font-size: var(--fs-caption);
  font-weight: 600;
}

.gd-primary:disabled {
  opacity: 0.45;
  cursor: default;
}

@media (prefers-reduced-motion: reduce) {
  .gd-action,
  .gd-row-main { transition: none; }
}
</style>
