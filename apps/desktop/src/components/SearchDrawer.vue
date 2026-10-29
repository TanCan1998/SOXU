<script setup lang="ts">
/**
 * 会话内搜索抽屉（Issue #118 · TASK-026，视觉基准是原型 data-panel="search"）。
 *
 * 分工：
 * - 本组件只渲染 tab.search 与输入框，**不自带定时器**：请求、防抖、迟到响应丢弃
 *   都在 WorkspaceSession.search / scheduleSearch（数据层已在 Issue #109 交付），
 *   跳转由 App.vue 负责（只有它知道消息窗口和当前 Tab）。因此组件卸载时没有
 *   需要清理的资源——这是「资源有单一 owner」的直接结果。
 * - 输入每敲一个字符就向上冒泡 query，防抖由 store 侧按会话登记，避免两处各有一份
 *   防抖窗口（两份窗口一定会漂移，最后变成「输完等 400ms 才出结果」）。
 *
 * 视觉：reka-ui 原语（AppTooltip / ScrollArea）+ V4-S0 token，不写死颜色。
 */

import { computed, nextTick, ref, watch } from "vue";
import { Search, X } from "@lucide/vue";
import {
  ScrollAreaRoot,
  ScrollAreaScrollbar,
  ScrollAreaThumb,
  ScrollAreaViewport,
} from "reka-ui";

import AppTooltip from "./AppTooltip.vue";
import {
  degradedNote,
  hitRoleLabel,
  hitSnippet,
  resultCountText,
  searchPanelStatus,
  sortHitsNewestFirst,
  truncationNote,
} from "./searchPanel.ts";
import { createSearchState, type SessionSearchHit, type SessionTab } from "../workspace/types.ts";

const props = defineProps<{
  /** 当前 Tab；null 表示没有打开的会话（抽屉仍可打开，只显示空态）。 */
  tab: SessionTab | null;
  bridgeAvailable: boolean;
  /** 跳转未能定位时的说明（由 App.vue 给出）；null 表示没有提示。 */
  notice: string | null;
}>();

const emit = defineEmits<{
  (event: "close"): void;
  /** 输入变化（未防抖）：防抖由 store.scheduleSearch 负责。 */
  (event: "query", value: string): void;
  /** 点击一条命中：由上层定位到对应消息。 */
  (event: "jump", hit: SessionSearchHit): void;
}>();

/** 没有会话时的只读占位：所有派生值都从它算，模板里不再写分支默认值。 */
const EMPTY_SEARCH = createSearchState();

const input = ref<HTMLInputElement | null>(null);
const draft = ref("");

const search = computed(() => props.tab?.search ?? EMPTY_SEARCH);
const status = computed(() => searchPanelStatus(search.value, draft.value));
/**
 * 结果行：排序 + 切片 + 角色标签一次算好。
 *
 * 不在模板里对同一条命中反复调 hitSnippet：那会每帧重复做三次 Array.from（码点切片），
 * 50 条结果就是 150 次无谓分配。
 */
const rows = computed(() =>
  sortHitsNewestFirst(search.value.hits).map((hit) => ({
    hit,
    parts: hitSnippet(hit),
    role: hitRoleLabel(hit.role),
  })),
);
const countText = computed(() => resultCountText(search.value, draft.value));
const truncated = computed(() => truncationNote(search.value));
const degraded = computed(() => degradedNote(search.value));

/** 切换 Tab 时把输入框同步到那个 Tab 已经提交过的查询（不重新发请求）。 */
watch(
  () => props.tab?.sessionId,
  () => {
    draft.value = props.tab?.search.query ?? "";
  },
  { immediate: true },
);

function onInput(event: Event) {
  const value = (event.target as HTMLInputElement).value;
  draft.value = value;
  emit("query", value);
}

/** 清空：把焦点留在输入框，用户可以立刻重新输入。 */
function clear() {
  draft.value = "";
  emit("query", "");
  input.value?.focus();
}

/** 打开抽屉时由 App.vue 调用，把焦点放进搜索框（Ctrl+F 之后可以直接打字）。 */
function focus() {
  void nextTick(() => input.value?.focus());
}

defineExpose({ focus });

/** Escape 关闭：只在本面板内处理，stopPropagation 避免连带关掉别的浮层。 */
function onKeydown(event: KeyboardEvent) {
  if (event.key !== "Escape") return;
  event.stopPropagation();
  emit("close");
}
</script>

<template>
  <aside class="search-drawer" aria-label="会话搜索" @keydown="onKeydown">
    <header class="sx-head">
      <div class="sx-title">
        <strong>搜索</strong>
        <span class="sx-shortcut" aria-hidden="true"><kbd>Ctrl</kbd><kbd>F</kbd></span>
        <AppTooltip text="关闭搜索 (Esc)">
          <button class="icon-button" type="button" aria-label="关闭搜索" @click="emit('close')">
            <X :size="17" :stroke-width="1.75" aria-hidden="true" />
          </button>
        </AppTooltip>
      </div>

      <div class="sx-input">
        <Search class="sx-input-icon" :size="14" :stroke-width="1.9" aria-hidden="true" />
        <input
          ref="input"
          class="sx-field"
          type="search"
          placeholder="搜索本会话…"
          aria-label="搜索本会话"
          autocomplete="off"
          spellcheck="false"
          :value="draft"
          @input="onInput"
        />
        <button
          v-if="draft"
          class="sx-clear"
          type="button"
          aria-label="清空搜索"
          @click="clear"
        >
          <X :size="13" :stroke-width="2" aria-hidden="true" />
        </button>
      </div>

      <!-- role=status + aria-live：结果数变化会读出来，不必把焦点移出输入框。 -->
      <p class="sx-meta" role="status" aria-live="polite">{{ countText }}</p>
    </header>

    <div class="sx-body">
      <div v-if="status === 'empty'" class="sx-empty">
        <Search :size="20" :stroke-width="1.6" aria-hidden="true" />
        <p v-if="!bridgeAvailable">浏览器预览未连接本机运行时，无法搜索真实会话。</p>
        <p v-else-if="!tab">先打开一个会话，再搜索它的内容。</p>
        <p v-else>输入关键词，搜索这个会话的整份内容（不只是已加载的消息）。</p>
      </div>

      <p v-else-if="status === 'searching'" class="sx-loading" role="status">搜索中…</p>

      <div v-else-if="status === 'error'" class="sx-error" role="alert">
        <p>{{ search.error }}</p>
      </div>

      <p v-else-if="status === 'no-results'" class="sx-empty-note">
        没有匹配的消息。换一个关键词，或确认搜索的是这个会话。
      </p>

      <ScrollAreaRoot v-else class="sx-results" type="hover">
        <ScrollAreaViewport class="sx-viewport">
          <ul class="sx-list">
            <li v-for="row in rows" :key="row.hit.ordinal">
              <button class="sx-item" type="button" @click="emit('jump', row.hit)">
                <span class="sx-idx">#{{ row.hit.ordinal }}</span>
                <span class="sx-text">
                  <span>{{ row.parts.before }}</span><mark class="sx-mark">{{
                    row.parts.match
                  }}</mark><span>{{ row.parts.after }}</span>
                </span>
                <span class="sx-role">
                  {{ row.role }}<template v-if="row.hit.totalMatches > 1">
                    ·{{ row.hit.totalMatches }} 处</template>
                </span>
              </button>
            </li>
          </ul>
        </ScrollAreaViewport>
        <ScrollAreaScrollbar class="sx-scrollbar" orientation="vertical">
          <ScrollAreaThumb class="sx-thumb" />
        </ScrollAreaScrollbar>
      </ScrollAreaRoot>

      <p v-if="notice" class="sx-notice" role="note">{{ notice }}</p>
      <p v-if="truncated && status === 'results'" class="sx-notice" role="note">{{ truncated }}</p>
      <p v-if="degraded && status === 'results'" class="sx-notice" role="note">{{ degraded }}</p>
    </div>

    <footer class="sx-footer">
      结果按消息时间倒序；点击一条会跳转到该消息并高亮。
    </footer>
  </aside>
</template>

<style scoped>
/*
 * 右侧抽屉：宽度与 V4 的 --insp-w 一致，与「会话状态」面板互斥显示
 * （右侧一次只开一个面板，避免两个 320px 抽屉把正文挤没）。
 */
.search-drawer {
  width: var(--insp-w);
  flex: none;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-left: 1px solid var(--border);
  background: var(--bg-panel);
  color: var(--fg);
}

.sx-head {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px 10px;
  border-bottom: 1px solid var(--border);
}

.sx-title {
  display: flex;
  align-items: center;
  gap: 8px;
}

.sx-title strong {
  font-size: var(--fs-control);
  font-weight: 640;
}

/* 快捷键提示：Ctrl+F 与 macOS 的 ⌘F 都由 aria-keyshortcuts 表达，这里只做视觉提示。 */
.sx-shortcut {
  display: inline-flex;
  gap: 3px;
  margin-right: auto;
}

.sx-shortcut kbd {
  padding: 1px 5px;
  border-radius: var(--r-sm);
  border: 1px solid var(--border);
  background: var(--bg-raised);
  color: var(--fg-subtle);
  /* 字体栈只能来自 base.css 的 --soxu-font-family-* token（见 tests/appearance.test.ts）。 */
  font-family: var(--soxu-font-family-mono);
  font-size: var(--fs-micro);
  line-height: 1.5;
}

.sx-input {
  display: flex;
  align-items: center;
  gap: 7px;
  height: 32px;
  padding: 0 8px;
  border-radius: var(--r-md);
  border: 1px solid var(--border);
  background: var(--bg-raised);
  transition:
    border-color var(--dur-fast) var(--ease),
    background-color var(--dur-fast) var(--ease);
}

.sx-input:focus-within {
  border-color: var(--accent);
  background: var(--surface);
}

.sx-input-icon {
  flex: none;
  color: var(--fg-subtle);
}

.sx-field {
  flex: 1;
  min-width: 0;
  border: 0;
  background: transparent;
  color: var(--fg);
  font-size: var(--fs-caption);
}

.sx-field:focus-visible {
  outline: none;
}

/* 原生 search 的清除按钮各平台样式不一，统一用自己的按钮。 */
.sx-field::-webkit-search-cancel-button {
  display: none;
}

.sx-clear {
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  flex: none;
  border-radius: var(--r-full);
  color: var(--fg-muted);
  transition: background-color var(--dur-fast) var(--ease);
}

.sx-clear:hover {
  background: var(--bg-hover);
  color: var(--fg);
}

.sx-meta {
  margin: 0;
  min-height: 1em;
  font-size: var(--fs-micro);
  color: var(--fg-subtle);
}

.sx-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 8px 10px 10px;
}

.sx-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  margin: auto 0;
  padding: 24px 16px;
  text-align: center;
  color: var(--fg-subtle);
}

.sx-empty p {
  margin: 0;
  font-size: var(--fs-caption);
  line-height: 1.8;
}

.sx-empty-note {
  margin: 18px 6px;
  font-size: var(--fs-caption);
  line-height: 1.8;
  color: var(--fg-muted);
}

.sx-loading {
  margin: 18px 6px;
  font-size: var(--fs-caption);
  color: var(--fg-muted);
}

.sx-error {
  margin: 10px 2px;
  padding: 8px 10px;
  border-radius: var(--r-md);
  background: color-mix(in srgb, var(--danger) 12%, transparent);
  color: var(--danger);
  font-size: var(--fs-caption);
  line-height: 1.7;
}

.sx-error p {
  margin: 0;
  overflow-wrap: anywhere;
}

.sx-results {
  flex: 1;
  min-height: 0;
  position: relative;
  overflow: hidden;
}

.sx-viewport {
  width: 100%;
  height: 100%;
}

.sx-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.sx-item {
  display: grid;
  grid-template-columns: auto 1fr;
  grid-template-areas:
    "idx role"
    "text text";
  gap: 2px 6px;
  width: 100%;
  padding: 7px 8px;
  border-radius: var(--r-md);
  text-align: start;
  color: var(--fg);
  transition: background-color var(--dur-fast) var(--ease);
}

.sx-item:hover {
  background: var(--bg-hover);
}

.sx-item:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

.sx-idx {
  grid-area: idx;
  font-family: var(--soxu-font-family-mono);
  font-size: var(--fs-micro);
  color: var(--fg-subtle);
}

.sx-role {
  grid-area: role;
  justify-self: end;
  font-size: var(--fs-micro);
  color: var(--fg-subtle);
}

.sx-text {
  grid-area: text;
  font-size: var(--fs-caption);
  line-height: 1.7;
  color: var(--fg-muted);
  overflow-wrap: anywhere;
}

/* 命中词高亮：用强调色 token，不用浏览器默认的黄底（深色主题下刺眼且对比度不可控）。 */
.sx-mark {
  border-radius: 3px;
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 620;
}

.sx-scrollbar {
  display: flex;
  width: 8px;
  padding: 2px;
  user-select: none;
  touch-action: none;
}

.sx-thumb {
  flex: 1;
  border-radius: var(--r-full);
  background: var(--border-strong);
}

.sx-notice {
  margin: 8px 4px 0;
  font-size: var(--fs-micro);
  line-height: 1.7;
  color: var(--fg-subtle);
}

.sx-footer {
  border-top: 1px solid var(--border);
  padding: 10px 14px;
  font-size: var(--fs-micro);
  line-height: 1.7;
  color: var(--fg-subtle);
}

@media (prefers-reduced-motion: reduce) {
  .sx-input,
  .sx-clear,
  .sx-item {
    transition: none;
  }
}
</style>
