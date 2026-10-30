<script setup lang="ts">
/**
 * 文件抽屉（Issue #120 / TASK-028）：目录树懒加载、排序、树形/平铺、只读预览与文件操作。
 *
 * 本组件只做渲染与表单输入：目录请求、迟到响应丢弃、写操作确认全部在
 * `workspace/filesWorkspace.ts` 里（可脱离 DOM 用 node:test 驱动）。
 *
 * 三条界面约束：
 * 1. 目录树按需展开：未展开的目录不会被读取，平铺视图也只展示**已加载**的条目。
 * 2. 预览只读：语法高亮复用 S1 的 shiki 管线（`markdown/highlighter.ts`），
 *    高亮失败退回纯文本，不显示错误横幅。
 * 3. 删除必须输入目标名称：确认串原样交给后端校验，前端不做「假装已确认」。
 *
 * 文件约 700 行（超过 coding-standards 的 600 行提示线），原因与 App.vue 相同：
 * 其中 ~300 行是 scoped 样式、~250 行是模板，逻辑一行都没有留在这里——
 * 目录请求、迟到响应丢弃、排序与写操作确认全在 workspace/filesWorkspace.ts（可脱离 DOM 测试）。
 * 再拆只能拆模板片段，反而会让「哪个状态属于谁」变得难以追踪。
 */
import { computed, ref, watch } from "vue";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  File as FileIcon,
  FilePlus2,
  Folder,
  Link2,
  Pencil,
  RefreshCw,
  Trash2,
  X,
} from "@lucide/vue";
import AppTooltip from "./AppTooltip.vue";
import { fileLanguage, formatFileSize, joinPath } from "../workspace/filesWorkspace.ts";
import { highlightToHtml } from "../markdown/highlighter.ts";
import type {
  FileBrowserState,
  FileRow,
  FileSortKey,
  FileViewMode,
} from "../workspace/types.ts";

const props = defineProps<{
  view: FileBrowserState;
  rows: FileRow[];
  bridgeAvailable: boolean;
  projectName: string;
}>();

const emit = defineEmits<{
  (event: "close"): void;
  (event: "refresh"): void;
  (event: "toggle", path: string): void;
  (event: "sort", key: FileSortKey): void;
  (event: "view", mode: FileViewMode): void;
  (event: "show-hidden", value: boolean): void;
  (event: "select", path: string): void;
  (event: "close-preview"): void;
  (event: "search", query: string): void;
  (event: "clear-search"): void;
  (event: "create", path: string): void;
  (event: "rename", from: string, to: string): void;
  (event: "remove", path: string, options: { recursive: boolean; confirmName: string }): void;
}>();

/** 名称/时间/大小：再点同一个键翻转方向（与文件管理器一致）。 */
const SORT_LABELS: { key: FileSortKey; label: string }[] = [
  { key: "name", label: "名称" },
  { key: "time", label: "时间" },
  { key: "size", label: "大小" },
];

const searchInput = ref("");
/** 新建/重命名的行内表单；null 表示没有打开表单。 */
const form = ref<{ mode: "create" | "rename"; path: string; value: string } | null>(null);
/** 删除确认：必须先输入目标名称。 */
const pendingDelete = ref<{ path: string; name: string; recursive: boolean; typed: string } | null>(
  null,
);
/** 预览高亮结果；null 表示纯文本渲染。 */
const highlighted = ref<string | null>(null);
/** 高亮是异步的：用序号丢弃迟到结果，避免把上一个文件的内容染到当前文件上。 */
let highlightSeq = 0;

const preview = computed(() => props.view.preview);
const previewName = computed(() => {
  const path = preview.value?.path ?? "";
  const index = path.lastIndexOf("/");
  return index < 0 ? path : path.slice(index + 1);
});
const previewLanguage = computed(() => fileLanguage(previewName.value));
const previewContent = computed(() => preview.value?.content ?? null);

const disabledReason = computed(() => (props.bridgeAvailable ? null : "浏览器预览不连接真实文件系统"));

const searchResult = computed(() => props.view.search?.result ?? null);

watch(
  () => [preview.value?.path, previewContent.value?.text, previewContent.value?.binary],
  async () => {
    const seq = ++highlightSeq;
    highlighted.value = null;
    const content = previewContent.value;
    if (!content || content.binary || !content.text) return;
    const html = await highlightToHtml(content.text, previewLanguage.value);
    if (seq !== highlightSeq) return;
    highlighted.value = html;
  },
  { flush: "post" },
);

function activate(row: FileRow): void {
  if (row.kind === "dir") {
    emit("toggle", row.path);
    return;
  }
  if (row.symlink) return; // 链接条目不打开：写操作会被后端拒绝，读也会受根目录守卫限制
  emit("select", row.path);
}

function startCreate(): void {
  form.value = { mode: "create", path: "", value: "" };
  pendingDelete.value = null;
}

function startRename(row: FileRow): void {
  form.value = { mode: "rename", path: row.path, value: row.name };
  pendingDelete.value = null;
}

function startDelete(row: FileRow): void {
  pendingDelete.value = {
    path: row.path,
    name: row.name,
    recursive: row.kind === "dir",
    typed: "",
  };
  form.value = null;
}

function submitForm(): void {
  const current = form.value;
  if (!current) return;
  const value = current.value.trim();
  if (!value) return;
  if (current.mode === "create") {
    // 用户可以直接写相对路径（src/new.md），也可以只写文件名（落在根目录）。
    const parent = current.path.trim().replace(/\/+$/, "");
    emit("create", joinPath(parent, value));
  } else {
    const index = current.path.lastIndexOf("/");
    const parent = index < 0 ? "" : current.path.slice(0, index);
    emit("rename", current.path, joinPath(parent, value));
  }
  form.value = null;
}

function submitDelete(): void {
  const current = pendingDelete.value;
  if (!current) return;
  emit("remove", current.path, {
    recursive: current.recursive,
    confirmName: current.typed,
  });
  pendingDelete.value = null;
}

function submitSearch(): void {
  const query = searchInput.value.trim();
  if (!query) {
    emit("clear-search");
    return;
  }
  emit("search", query);
}

function resetSearch(): void {
  searchInput.value = "";
  emit("clear-search");
}

/** 输入框被清空时立刻收起上一轮结果，避免旧命中看起来像当前查询的结果。 */
function onSearchInput(): void {
  if (!searchInput.value.trim()) resetSearch();
}

function sortIndicator(key: FileSortKey): string {
  if (props.view.sort !== key) return "";
  return props.view.direction === "asc" ? "↑" : "↓";
}
</script>

<template>
  <aside class="file-drawer" aria-label="文件">
    <header class="drawer-head">
      <div class="head-text">
        <strong>文件</strong>
        <p>{{ projectName }} · 仅项目目录内</p>
      </div>
      <AppTooltip text="重新读取当前目录（不会读取未展开的子目录）">
        <button
          class="icon-button"
          type="button"
          aria-label="刷新目录"
          :disabled="!bridgeAvailable || view.loading"
          @click="emit('refresh')"
        >
          <RefreshCw :size="15" :stroke-width="1.9" aria-hidden="true" />
        </button>
      </AppTooltip>
      <button class="icon-button" type="button" aria-label="关闭文件面板" @click="emit('close')">
        <X :size="15" :stroke-width="1.9" aria-hidden="true" />
      </button>
    </header>

    <div class="toolbar">
      <AppTooltip text="点击同一项切换升序/降序；目录始终排在文件前面" auto>
        <div class="segmented" role="group" aria-label="排序">
          <button
            v-for="option in SORT_LABELS"
            :key="option.key"
            class="seg"
            type="button"
            :aria-pressed="view.sort === option.key"
            @click="emit('sort', option.key)"
          >
            {{ option.label }}<span class="arrow" aria-hidden="true">{{ sortIndicator(option.key) }}</span>
          </button>
        </div>
      </AppTooltip>
      <div class="segmented" role="group" aria-label="视图">
        <button
          class="seg"
          type="button"
          :aria-pressed="view.view === 'tree'"
          @click="emit('view', 'tree')"
        >
          树形
        </button>
        <button
          class="seg"
          type="button"
          :aria-pressed="view.view === 'flat'"
          @click="emit('view', 'flat')"
        >
          平铺
        </button>
      </div>
      <button
        class="seg hidden-toggle"
        type="button"
        :aria-pressed="view.showHidden"
        @click="emit('show-hidden', !view.showHidden)"
      >
        {{ view.showHidden ? "隐藏项已显示" : "隐藏项已隐藏" }}
      </button>
    </div>

    <form class="search-row" role="search" @submit.prevent="submitSearch">
      <input
        v-model="searchInput"
        type="search"
        class="search-input"
        placeholder="在项目内搜索文本…"
        aria-label="在项目内搜索文本"
        :disabled="!bridgeAvailable"
        @input="onSearchInput"
      />
      <button class="seg" type="submit" :disabled="!bridgeAvailable || view.search?.loading">
        {{ view.search?.loading ? "搜索中" : "搜索" }}
      </button>
    </form>

    <p v-if="disabledReason" class="hint" role="status">{{ disabledReason }}</p>
    <p v-if="view.error" class="error" role="alert">{{ view.error }}</p>

    <div v-if="searchResult" class="search-results" aria-label="搜索结果">
      <div class="search-summary">
        <span>{{ searchResult.hits.length }} 条命中 · 扫描 {{ searchResult.scannedFiles }} 个文件</span>
        <button class="link-button" type="button" @click="resetSearch">清除</button>
      </div>
      <p v-if="searchResult.truncated" class="hint">结果已到上限，只显示前一部分。</p>
      <ul>
        <li v-for="hit in searchResult.hits.slice(0, 40)" :key="hit.path + ':' + hit.line">
          <button class="hit" type="button" @click="emit('select', hit.path)">
            <span class="hit-path">{{ hit.path }}:{{ hit.line }}</span>
            <span class="hit-preview">{{ hit.preview }}</span>
          </button>
        </li>
      </ul>
    </div>

    <div class="tree-wrap visually-scroll">
      <ul v-if="rows.length" class="tree" role="tree" aria-label="项目文件">
        <li
          v-for="row in rows"
          :key="row.path"
          role="treeitem"
          :aria-level="row.depth + 1"
          :aria-expanded="row.kind === 'dir' ? row.expanded : undefined"
          :aria-selected="view.selectedPath === row.path"
          class="row-item"
        >
          <button
            class="row"
            type="button"
            :style="{ paddingLeft: 6 + row.depth * 12 + 'px' }"
            :data-kind="row.kind"
            :data-selected="view.selectedPath === row.path ? 'true' : undefined"
            @click="activate(row)"
          >
            <span class="row-caret" aria-hidden="true">
              <ChevronDown v-if="row.kind === 'dir' && row.expanded" :size="13" :stroke-width="2" />
              <ChevronRight v-else-if="row.kind === 'dir'" :size="13" :stroke-width="2" />
            </span>
            <Link2 v-if="row.symlink" :size="14" :stroke-width="1.8" aria-hidden="true" />
            <Folder v-else-if="row.kind === 'dir'" :size="14" :stroke-width="1.8" aria-hidden="true" />
            <FileIcon v-else :size="14" :stroke-width="1.8" aria-hidden="true" />
            <span class="row-name">{{ row.name }}</span>
            <span v-if="row.kind === 'file'" class="row-size">{{ formatFileSize(row.size) }}</span>
          </button>
          <span class="row-actions">
            <button
              class="icon-button tiny"
              type="button"
              :aria-label="'重命名 ' + row.name"
              :disabled="!bridgeAvailable || view.mutating || row.symlink"
              @click.stop="startRename(row)"
            >
              <Pencil :size="13" :stroke-width="1.9" aria-hidden="true" />
            </button>
            <button
              class="icon-button tiny"
              type="button"
              :aria-label="'删除 ' + row.name"
              :disabled="!bridgeAvailable || view.mutating || row.symlink"
              @click.stop="startDelete(row)"
            >
              <Trash2 :size="13" :stroke-width="1.9" aria-hidden="true" />
            </button>
          </span>
        </li>
      </ul>
      <p v-else-if="view.loading" class="hint" role="status">正在读取目录…</p>
      <p v-else class="hint">目录为空，或用「新建文件」添加第一个文件。</p>
    </div>

    <div v-if="form" class="inline-form" role="group" :aria-label="form.mode === 'create' ? '新建文件' : '重命名'">
      <label class="form-label">
        {{ form.mode === "create" ? "新建文件路径" : "新名称" }}
        <input
          v-model="form.value"
          class="search-input"
          :placeholder="form.mode === 'create' ? '例如 src/new.md' : form.value"
          :aria-label="form.mode === 'create' ? '新建文件路径' : '新名称'"
          @keydown.enter.prevent="submitForm"
          @keydown.esc.prevent="form = null"
        />
      </label>
      <div class="form-actions">
        <button class="seg" type="button" :disabled="view.mutating" @click="submitForm">确定</button>
        <button class="seg" type="button" @click="form = null">取消</button>
      </div>
    </div>

    <div v-if="pendingDelete" class="inline-form danger" role="group" aria-label="确认删除">
      <p class="form-title">删除「{{ pendingDelete.name }}」？</p>
      <p class="hint">此操作不可撤销。请输入文件名以确认。</p>
      <input
        v-model="pendingDelete.typed"
        class="search-input"
        placeholder="输入文件名"
        aria-label="输入文件名以确认删除"
        @keydown.enter.prevent="submitDelete"
        @keydown.esc.prevent="pendingDelete = null"
      />
      <label v-if="pendingDelete.recursive" class="checkbox">
        <input v-model="pendingDelete.recursive" type="checkbox" />
        递归删除目录内容
      </label>
      <div class="form-actions">
        <button
          class="seg danger"
          type="button"
          :disabled="view.mutating || pendingDelete.typed !== pendingDelete.name"
          @click="submitDelete"
        >
          删除
        </button>
        <button class="seg" type="button" @click="pendingDelete = null">取消</button>
      </div>
    </div>

    <section v-if="preview" class="preview" aria-label="文件预览">
      <header class="preview-head">
        <AppTooltip :text="preview.path" auto>
          <span class="preview-path">{{ preview.path }}</span>
        </AppTooltip>
        <button class="icon-button tiny" type="button" aria-label="关闭预览" @click="emit('close-preview')">
          <X :size="13" :stroke-width="1.9" aria-hidden="true" />
        </button>
      </header>
      <p v-if="preview.loading" class="hint" role="status">正在读取文件…</p>
      <p v-else-if="preview.error" class="error" role="alert">{{ preview.error }}</p>
      <template v-else-if="previewContent">
        <p class="preview-meta">
          {{ formatFileSize(previewContent.size) }}
          <span v-if="previewContent.truncated">· 只显示前 {{ formatFileSize(previewContent.bytesRead) }}</span>
        </p>
        <p v-if="previewContent.binary" class="hint">二进制文件不预览内容。</p>
        <pre v-else-if="highlighted" class="md-code preview-code"><code v-html="highlighted"></code></pre>
        <pre v-else class="preview-code plain"><code>{{ previewContent.text }}</code></pre>
      </template>
    </section>

    <footer class="drawer-footer">
      <button
        class="link-button"
        type="button"
        :disabled="!bridgeAvailable || view.mutating"
        @click="startCreate"
      >
        <FilePlus2 :size="14" :stroke-width="1.9" aria-hidden="true" /> 新建文件
      </button>
      <span class="footer-note">删除需输入文件名确认</span>
    </footer>
  </aside>
</template>

<style scoped>
.file-drawer {
  width: 320px;
  flex: none;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-left: 1px solid var(--soxu-border);
  background: var(--soxu-panel);
}

.drawer-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--soxu-border);
}

.head-text {
  flex: 1;
  min-width: 0;
}

.head-text strong {
  font-size: 0.8125rem;
}

.head-text p {
  margin: 3px 0 0;
  font-size: 0.65625rem;
  color: var(--soxu-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 10px 12px 6px;
}

.segmented {
  display: inline-flex;
  border: 1px solid var(--soxu-border);
  border-radius: 8px;
  overflow: hidden;
}

.seg {
  border: 0;
  background: transparent;
  color: var(--soxu-subtext);
  font: inherit;
  font-size: 0.6875rem;
  padding: 4px 8px;
  cursor: pointer;
}

.seg[aria-pressed="true"] {
  background: var(--soxu-soft);
  color: var(--soxu-fg);
  font-weight: 600;
}

.seg:disabled {
  opacity: 0.5;
  cursor: default;
}

.seg.danger {
  color: var(--danger);
  font-weight: 600;
}

.arrow {
  margin-left: 2px;
}

.hidden-toggle {
  border: 1px solid var(--soxu-border);
  border-radius: 8px;
}

.search-row {
  display: flex;
  gap: 6px;
  padding: 6px 12px 10px;
}

.search-input {
  flex: 1;
  min-width: 0;
  border: 1px solid var(--soxu-border);
  border-radius: 8px;
  background: var(--soxu-bg);
  color: var(--soxu-fg);
  font: inherit;
  font-size: 0.71875rem;
  padding: 5px 8px;
}

.hint {
  margin: 4px 12px;
  font-size: 0.6875rem;
  line-height: 1.7;
  color: var(--soxu-muted);
}

.error {
  margin: 4px 12px;
  font-size: 0.6875rem;
  line-height: 1.7;
  color: var(--danger);
  overflow-wrap: anywhere;
}

.search-results {
  border-bottom: 1px solid var(--soxu-border);
  max-height: 40%;
  overflow: auto;
}

.search-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px 4px;
  font-size: 0.6875rem;
  color: var(--soxu-subtext);
}

.search-results ul {
  list-style: none;
  margin: 0;
  padding: 0 8px 8px;
}

.hit {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 2px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--soxu-fg);
  font: inherit;
  text-align: left;
  padding: 6px 8px;
  cursor: pointer;
}

.hit:hover {
  background: var(--soxu-soft);
}

.hit-path {
  font-family: var(--soxu-font-family-mono);
  font-size: 0.65625rem;
  color: var(--soxu-muted);
}

.hit-preview {
  font-size: 0.6875rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tree-wrap {
  flex: 1;
  min-height: 120px;
  overflow: auto;
  padding: 4px 8px 8px;
}

.tree {
  list-style: none;
  margin: 0;
  padding: 0;
}

.row-item {
  position: relative;
  display: flex;
  align-items: center;
}

.row {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--soxu-fg);
  font: inherit;
  font-size: 0.71875rem;
  text-align: left;
  padding: 4px 6px;
  cursor: pointer;
}

.row:hover {
  background: var(--soxu-soft);
}

.row[data-selected="true"] {
  background: var(--soxu-soft);
  font-weight: 600;
}

.row[data-kind="symlink"] {
  color: var(--soxu-muted);
  cursor: default;
}

.row-caret {
  display: inline-flex;
  width: 13px;
  flex: none;
  color: var(--soxu-muted);
}

.row-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-size {
  font-family: var(--soxu-font-family-mono);
  font-size: 0.625rem;
  color: var(--soxu-muted);
}

/* 行操作只在悬停/聚焦时显现，但始终可被键盘访问（不是 display:none）。 */
.row-actions {
  display: inline-flex;
  gap: 2px;
  opacity: 0;
  transition: opacity 120ms ease;
}

.row-item:hover .row-actions,
.row-item:focus-within .row-actions {
  opacity: 1;
}

.icon-button.tiny {
  padding: 2px;
}

.inline-form {
  border-top: 1px solid var(--soxu-border);
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.inline-form.danger .form-title {
  margin: 0;
  font-size: 0.75rem;
  font-weight: 600;
}

.form-label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 0.6875rem;
  color: var(--soxu-subtext);
}

.form-actions {
  display: flex;
  gap: 6px;
}

.form-actions .seg {
  border: 1px solid var(--soxu-border);
  border-radius: 8px;
}

.checkbox {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.6875rem;
  color: var(--soxu-subtext);
}

.preview {
  border-top: 1px solid var(--soxu-border);
  max-height: 45%;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.preview-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px 4px;
}

.preview-path {
  flex: 1;
  min-width: 0;
  font-family: var(--soxu-font-family-mono);
  font-size: 0.65625rem;
  color: var(--soxu-subtext);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.preview-meta {
  margin: 0 12px 6px;
  font-size: 0.65625rem;
  color: var(--soxu-muted);
}

.preview-code {
  margin: 0 8px 10px;
  border: 1px solid var(--soxu-border);
  border-radius: 10px;
  background: var(--soxu-soft);
  padding: 8px 10px;
  overflow: auto;
  flex: 1;
  min-height: 0;
  font-family: var(--soxu-font-family-mono);
  font-size: 0.6875rem;
  line-height: 1.6;
  tab-size: 2;
}

.preview-code :deep(.line) {
  display: block;
  min-height: 1.6em;
}

.preview-code.plain {
  color: var(--soxu-fg);
  white-space: pre;
}

.drawer-footer {
  border-top: 1px solid var(--soxu-border);
  padding: 8px 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.footer-note {
  font-size: 0.625rem;
  color: var(--soxu-muted);
}
</style>
