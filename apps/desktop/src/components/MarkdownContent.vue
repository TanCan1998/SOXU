<script setup lang="ts">
/**
 * 一条消息的 markdown 渲染容器（Issue #111 · V4-S1）。
 *
 * 渲染分两步：markdown-it 同步产出 HTML（代码块先显示为纯文本），
 * 挂载/更新后再由 shiki 异步升级成高亮版本。这样流式输出时不会因为
 * 等待语言包而卡住整条消息，也不会出现「先白后彩」的闪动。
 *
 * 安全边界：markdown-it 保持 `html: false`，正文里的原始 HTML 全部转义；
 * `v-html` 里只可能出现本模块与 highlighter 生成的标签。
 *
 * 资源所有权：高亮批次令牌与「链接已复制」提示的计时器都在本组件内，
 * 卸载时清掉——迟到的异步结果不会再写 DOM。
 */

import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

import { highlightWithin } from "../markdown/highlightDom.ts";
import { renderMarkdown } from "../markdown/markdownRenderer.ts";
import { copyText } from "../services/clipboard.ts";

const props = defineProps<{
  text: string;
  /** 正在流式输出的消息：先不排队高亮，等这一轮结束再一次性着色（见 upgrade）。 */
  streaming?: boolean;
}>();

/** 提示停留时长：够读完一行字，又不会一直挂着。 */
const LINK_HINT_MS = 1_600;

const root = ref<HTMLElement | null>(null);
const hint = ref("");
const html = computed(() => renderMarkdown(props.text));

let alive = false;
let batch = 0;
let hintTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 排队高亮当前正文里的代码块。
 *
 * 流式输出期间直接跳过：每个 delta 都会整体重渲染，逐帧重新着色一个长代码块
 * 会把「低内存、低占用」的预算吃掉，而中途的着色结果下一帧就被替换掉了。
 * 一轮结束（streaming 变 false）时再着色一次。
 */
async function upgrade() {
  const element = root.value;
  if (!alive || !element || props.streaming) return;
  const token = ++batch;
  await highlightWithin(element, () => alive && token === batch);
}

function showHint(text: string) {
  hint.value = text;
  if (hintTimer !== null) clearTimeout(hintTimer);
  hintTimer = setTimeout(() => {
    hint.value = "";
    hintTimer = null;
  }, LINK_HINT_MS);
}

/**
 * 链接点击：当前切片没有接 opener 插件，直接跟随 href 会把整个应用导航走
 * （桌面端等于白屏），因此先复制链接并给出一行提示；接上 opener 后改成打开外部浏览器。
 */
async function onClick(event: MouseEvent) {
  const anchor = (event.target as HTMLElement | null)?.closest<HTMLAnchorElement>("a.md-link");
  if (!anchor) return;
  event.preventDefault();
  const href = anchor.getAttribute("href") ?? "";
  if (!href) return;
  showHint((await copyText(href)) ? "链接已复制到剪贴板" : "复制链接失败");
}

onMounted(() => {
  alive = true;
  void upgrade();
});

onBeforeUnmount(() => {
  alive = false;
  if (hintTimer !== null) {
    clearTimeout(hintTimer);
    hintTimer = null;
  }
});

// 文本变化或一轮结束（streaming → false）时，对新增的代码块排队高亮。
watch(() => [html.value, props.streaming], () => void upgrade(), { flush: "post" });
</script>

<template>
  <div class="md">
    <div ref="root" class="md-body" @click="onClick" v-html="html"></div>
    <p v-if="hint" class="md-hint" role="status">{{ hint }}</p>
  </div>
</template>

<style scoped>
.md {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.md-body {
  min-width: 0;
}

/* markdown-it 生成的节点没有 scoped 属性，样式必须走 :deep()。 */
.md-body :deep(p) {
  margin: 0;
}

.md-body :deep(p + p),
.md-body :deep(p + ul),
.md-body :deep(p + ol),
.md-body :deep(p + .md-code),
.md-body :deep(p + .md-table),
.md-body :deep(ul + p),
.md-body :deep(ol + p) {
  margin-top: 0.625rem;
}

.md-body :deep(h1),
.md-body :deep(h2),
.md-body :deep(h3),
.md-body :deep(h4) {
  margin: 0.75rem 0 0.375rem;
  font-size: 0.9375rem;
  font-weight: 640;
  line-height: 1.5;
}

.md-body :deep(ul),
.md-body :deep(ol) {
  margin: 0;
  padding-left: 1.25rem;
}

.md-body :deep(li + li) {
  margin-top: 0.25rem;
}

.md-body :deep(blockquote) {
  margin: 0.5rem 0;
  padding: 2px 0 2px 0.75rem;
  border-left: 2px solid var(--soxu-border);
  color: var(--soxu-subtext);
}

.md-body :deep(hr) {
  margin: 0.75rem 0;
  border: 0;
  border-top: 1px solid var(--soxu-border);
}

/* 行内 code：与代码块同一等宽 token，但不占整块背景。 */
.md-body :deep(code) {
  font-family: var(--soxu-font-family-mono);
  font-size: 0.8125rem;
  padding: 1px 5px;
  border-radius: 5px;
  border: 1px solid var(--soxu-border);
  background: var(--soxu-soft);
}

.md-body :deep(a.md-link) {
  color: var(--soxu-accent);
  text-decoration: underline;
  text-decoration-color: color-mix(in srgb, var(--soxu-accent) 40%, transparent);
  text-underline-offset: 2px;
  cursor: pointer;
  overflow-wrap: anywhere;
}

.md-body :deep(.md-table) {
  max-width: 100%;
  overflow-x: auto;
  border: 1px solid var(--soxu-border);
  border-radius: 10px;
}

.md-body :deep(table) {
  border-collapse: collapse;
  width: 100%;
  font-size: 0.8125rem;
}

.md-body :deep(th),
.md-body :deep(td) {
  padding: 6px 10px;
  text-align: left;
  border-bottom: 1px solid var(--soxu-border);
}

.md-body :deep(th) {
  background: var(--soxu-soft);
  font-weight: 600;
}

.md-body :deep(tr:last-child td) {
  border-bottom: 0;
}

/* 代码块：语言标签 + 可横向滚动的正文，深色配色由 base.css 的 data-theme 规则接管。 */
.md-body :deep(.md-code) {
  margin: 0.5rem 0;
  border: 1px solid var(--soxu-border);
  border-radius: 10px;
  background: var(--soxu-soft);
  overflow: hidden;
}

.md-body :deep(.md-code-head) {
  display: flex;
  align-items: center;
  height: 26px;
  padding: 0 10px;
  border-bottom: 1px solid var(--soxu-border);
  font-size: 0.6875rem;
  letter-spacing: 0.3px;
  color: var(--soxu-muted);
}

.md-body :deep(.md-code-lang) {
  font-family: var(--soxu-font-family-mono);
}

.md-body :deep(.md-code-body) {
  margin: 0;
  padding: 9px 11px 11px;
  overflow-x: auto;
  font-family: var(--soxu-font-family-mono);
  font-size: 0.75rem;
  line-height: 1.65;
  tab-size: 2;
}

.md-body :deep(.md-code-body code) {
  padding: 0;
  border: 0;
  background: none;
  font-size: inherit;
}

/* 高亮后每行是 block：行号/折行都按行处理，复制时仍是原始换行。 */
.md-body :deep(.md-code-body .line) {
  display: block;
  min-height: 1.65em;
}

.md-hint {
  margin: 0;
  font-size: 0.6875rem;
  color: var(--soxu-muted);
}
</style>
