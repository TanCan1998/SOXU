<script setup lang="ts">
/**
 * V4 设计 token 色板（Issue #110 临时验证面）。
 *
 * 三件事：
 * 1. 把 tokens.css 里的每个变量渲染成看得见的样本（颜色块 / 圆角框 / 字号 / 阴影 / 缓动）；
 * 2. 深浅色切换走生产同一条链路 —— runThemeTransition() 的 startViewTransition 圆形扩散，
 *    不是简单的 class 切换；
 * 3. 切换前后对 [data-stable] 元素做矩形快照，用数字证明「无布局跳动」，而不是靠肉眼。
 *
 * 注意：这里刻意不写 localStorage（不调 persistTheme）。色板与正式应用同源，
 * 写进去会覆盖开发者自己选的主题偏好。
 */

import { computed, nextTick, onMounted, ref } from "vue";

import { EASE_CLASSES, TOKEN_GROUPS, UTILITY_CLASSES } from "./tokenCatalog.ts";
import { applyDocumentTheme, type ThemeName } from "../theme/theme.ts";
import { runThemeTransition } from "../theme/themeTransition.ts";

const props = defineProps<{ initialTheme: ThemeName }>();

const theme = ref<ThemeName>(props.initialTheme);
const values = ref<Record<string, string>>({});
const busy = ref(false);
const utilityValues = ref<Record<string, string>>({});
const easeValues = ref<Record<string, string>>({});
const layoutReport = ref<{ maxShift: number; scrollShift: number } | null>(null);
const transitionReason = ref<string>("");

const nextTheme = computed<ThemeName>(() => (theme.value === "dark" ? "light" : "dark"));

/** 读 :root 上的实际取值：色板展示的是「浏览器真的算出来的值」，不是文件里的字面量。 */
function readTokenValues(): void {
  const styles = getComputedStyle(document.documentElement);
  const next: Record<string, string> = {};
  for (const group of TOKEN_GROUPS) {
    for (const item of group.items) {
      next[item.token] = styles.getPropertyValue(item.token).trim() || "（未定义）";
    }
  }
  values.value = next;
}

/** 读工具类节点上的计算值，验证 @theme 注册确实生成了 CSS。 */
function readUtilityValues(): void {
  const node = document.querySelector<HTMLElement>("[data-utility-probe]");
  if (!node) return;
  const styles = getComputedStyle(node);
  utilityValues.value = {
    "background-color": styles.backgroundColor,
    color: styles.color,
    "border-color": styles.borderTopColor,
    "border-radius": styles.borderTopLeftRadius,
    "box-shadow": styles.boxShadow === "none" ? "none" : "有",
    "font-size": styles.fontSize,
    "font-family": styles.fontFamily.split(",")[0] ?? "",
  };
  const easing: Record<string, string> = {};
  document.querySelectorAll<HTMLElement>("[data-ease-probe]").forEach((node) => {
    const key = node.dataset.easeProbe ?? "";
    easing[key] = getComputedStyle(node).transitionTimingFunction;
  });
  easeValues.value = easing;
}

interface RectSnapshot {
  key: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 切换前的布局快照：[data-stable] 元素的矩形 + 文档滚动高度。 */
function snapshotLayout(): { rects: RectSnapshot[]; scrollHeight: number } {
  const rects: RectSnapshot[] = [];
  document.querySelectorAll<HTMLElement>("[data-stable]").forEach((node) => {
    const rect = node.getBoundingClientRect();
    rects.push({
      key: node.dataset.stable ?? "",
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    });
  });
  return { rects, scrollHeight: document.documentElement.scrollHeight };
}

/**
 * 对比两次快照。色板本身是固定尺寸网格，换主题只应该改颜色，
 * 因此任何位移/尺寸变化都算布局跳动，直接报出来。
 */
function compareLayout(
  before: { rects: RectSnapshot[]; scrollHeight: number },
  after: { rects: RectSnapshot[]; scrollHeight: number },
): { maxShift: number; scrollShift: number } {
  const byKey = new Map(after.rects.map((rect) => [rect.key, rect]));
  let maxShift = 0;
  for (const rect of before.rects) {
    const next = byKey.get(rect.key);
    if (!next) continue;
    maxShift = Math.max(
      maxShift,
      Math.abs(next.x - rect.x),
      Math.abs(next.y - rect.y),
      Math.abs(next.width - rect.width),
      Math.abs(next.height - rect.height),
    );
  }
  return {
    maxShift: Math.round(maxShift * 100) / 100,
    scrollShift: after.scrollHeight - before.scrollHeight,
  };
}

async function toggleTheme(event: MouseEvent): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  const before = snapshotLayout();
  const next = nextTheme.value;

  // 与 App.vue 完全相同的调用方式：commit 里同步写 <html data-theme>，
  // 再由 runThemeTransition 用 startViewTransition 做从点击位置扩散的圆形切换。
  const result = await runThemeTransition({
    origin: { clientX: event.clientX, clientY: event.clientY },
    commit: () => {
      theme.value = next;
      applyDocumentTheme(next);
    },
  });
  transitionReason.value = result.mode === "animated" ? "圆形扩散" : `直接切换（${result.reason}）`;

  await nextTick();
  readTokenValues();
  readUtilityValues();
  layoutReport.value = compareLayout(before, snapshotLayout());
  busy.value = false;
}

onMounted(() => {
  readTokenValues();
  readUtilityValues();
});
</script>

<template>
  <div class="palette" :data-theme="theme">
    <header class="palette-head" data-stable="head">
      <div>
        <p class="eyebrow">V4 设计 token · 开发验证</p>
        <h1>色板 / 字号 / 圆角 / 阴影 / 动效</h1>
        <p class="note">
          当前主题：<strong data-theme-readout>{{ theme }}</strong> ·
          切换方式：<span data-transition-readout>{{ transitionReason || "尚未切换" }}</span>
        </p>
      </div>
      <button
        class="toggle"
        type="button"
        :disabled="busy"
        :aria-label="`切换到${nextTheme === 'dark' ? '深色' : '浅色'}主题`"
        @click="toggleTheme"
      >
        切换到{{ nextTheme === "dark" ? "深色" : "浅色" }}
      </button>
    </header>

    <!--
      这一行必须「一直在、高度恒定」：它是切换后才填内容的测量结果，
      如果切换前不存在，它自己的出现就会把下面所有区块往下推 50px，
      于是测量工具反而制造出它要测的布局跳动。
    -->
    <p class="layout" data-layout-report>
      <template v-if="layoutReport">
        布局位移：最大 {{ layoutReport.maxShift }}px · 文档高度变化 {{ layoutReport.scrollShift }}px
        <span v-if="layoutReport.maxShift === 0 && layoutReport.scrollShift === 0" data-layout-ok>
          （无跳动）
        </span>
      </template>
      <template v-else>布局位移：切换后自动测量</template>
    </p>

    <section class="utility-probe" data-stable="utility">
      <h2>@theme 工具类自检</h2>
      <p class="hint">下面这块直接用 Tailwind 类名，不用任何手写 CSS：{{ UTILITY_CLASSES }}</p>
      <div :class="UTILITY_CLASSES" class="probe" data-utility-probe>
        bg-bg-raised · text-fg · border-border · rounded-lg · shadow-pop · text-chat · font-mono
      </div>
      <div class="ease-probes">
        <span
          v-for="name in EASE_CLASSES"
          :key="name"
          :class="name"
          :data-ease-probe="name"
          class="ease-probe font-mono"
        >
          {{ name }}
        </span>
      </div>
      <dl class="values">
        <template v-for="(value, name) in utilityValues" :key="name">
          <dt>{{ name }}</dt>
          <dd class="font-mono" :data-utility-value="name">{{ value }}</dd>
        </template>
        <template v-for="(value, name) in easeValues" :key="name">
          <dt>{{ name }}</dt>
          <dd class="font-mono" :data-ease-value="name">{{ value }}</dd>
        </template>
      </dl>
    </section>

    <section
      v-for="group in TOKEN_GROUPS"
      :key="group.title"
      class="group"
      :data-stable="group.title"
    >
      <h2>{{ group.title }}<span class="hint">{{ group.hint }}</span></h2>
      <div class="grid">
        <figure v-for="item in group.items" :key="item.token" class="card">
          <div
            v-if="item.kind === 'color'"
            class="chip"
            :data-swatch="item.token"
            :data-contrast="item.contrast"
            :style="{ background: `var(${item.token})` }"
          />
          <div
            v-else-if="item.kind === 'radius'"
            class="chip radius"
            :data-swatch="item.token"
            :style="{ borderRadius: `var(${item.token})` }"
          />
          <div
            v-else-if="item.kind === 'shadow'"
            class="chip shadow"
            :data-swatch="item.token"
            :style="{ boxShadow: `var(${item.token})` }"
          />
          <div
            v-else-if="item.kind === 'text'"
            class="chip text"
            :data-swatch="item.token"
            :style="{ fontSize: `var(${item.token})` }"
          >
            {{ item.text ?? item.token }}
          </div>
          <div
            v-else
            class="chip motion"
            :data-swatch="item.token"
            :style="{ animationTimingFunction: `var(${item.token})` }"
          >
            <span class="dot" />
          </div>
          <figcaption>
            <code class="font-mono">{{ item.token }}</code>
            <span class="value" :data-value="item.token">{{ values[item.token] ?? "…" }}</span>
          </figcaption>
        </figure>
      </div>
    </section>
  </div>
</template>

<style scoped>
.palette {
  min-height: 100vh;
  padding: 28px 32px 56px;
  background: var(--surface);
  color: var(--fg);
  /*
   * 字体栈一律由 token 提供：界面字体继承 base.css 的 body，等宽处直接挂 Tailwind 的
   * font-mono 工具类（= var(--font-code)）。组件里不写 font-family 声明，与既有组件的
   * 约定保持一致（tests/appearance.test.ts 有守卫）。
   */
  font-size: var(--fs-body);
}

.palette-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
  padding-bottom: 20px;
  border-bottom: 1px solid var(--border);
}

.eyebrow {
  margin: 0 0 6px;
  font-size: var(--fs-micro);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--fg-subtle);
}

h1 {
  margin: 0;
  font-size: var(--fs-heading);
  font-weight: 600;
}

.note,
.hint {
  margin: 6px 0 0;
  font-size: var(--fs-caption);
  color: var(--fg-muted);
}

h2 {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin: 0 0 12px;
  font-size: var(--fs-title);
  font-weight: 600;
}

h2 .hint {
  margin: 0;
  font-weight: 400;
}

.toggle {
  flex: none;
  height: 34px;
  padding: 0 16px;
  border-radius: var(--r-md);
  background: var(--accent);
  color: #fff;
  font-size: var(--fs-control);
  transition: background var(--dur-fast) var(--ease);
}

.toggle:hover:not(:disabled) {
  background: var(--accent-hover);
}

.toggle:disabled {
  opacity: 0.6;
  cursor: default;
}

.layout {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 34px;
  margin: 16px 0 0;
  padding: 0 12px;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--bg-raised);
  font-size: var(--fs-caption);
  color: var(--fg-muted);
  white-space: nowrap;
  overflow: hidden;
}

.utility-probe {
  margin-top: 24px;
  padding: 18px;
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  background: var(--bg-panel);
}

.probe {
  margin-top: 12px;
  padding: 14px 16px;
  border-width: 1px;
  border-style: solid;
}

.ease-probes {
  display: flex;
  gap: 10px;
  margin-top: 10px;
}

.ease-probe {
  padding: 3px 8px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  font-size: var(--fs-micro);
  color: var(--fg-muted);
}

.values {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 2px 16px;
  margin: 14px 0 0;
  font-size: var(--fs-caption);
}

.values dt {
  color: var(--fg-subtle);
}

.values dd {
  margin: 0;
  color: var(--fg);
  overflow-wrap: anywhere;
}

.group {
  margin-top: 28px;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(168px, 1fr));
  gap: 12px;
}

.card {
  margin: 0;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--bg-panel);
}

.chip {
  height: 56px;
  border-radius: var(--r-sm);
  background: var(--bg-raised);
}

.chip.radius,
.chip.shadow {
  border: 1px solid var(--border-strong);
  background: var(--bg-raised);
}

.chip.text {
  display: flex;
  align-items: center;
  color: var(--fg);
  background: none;
  height: auto;
  min-height: 56px;
  overflow: hidden;
  white-space: nowrap;
}

.chip.motion {
  position: relative;
  background: var(--bg-raised);
  overflow: hidden;
}

.chip.motion .dot {
  position: absolute;
  top: 50%;
  left: 0;
  width: 12px;
  height: 12px;
  margin-top: -6px;
  border-radius: var(--r-full);
  background: var(--accent);
  animation: slide 1.4s var(--ease) infinite alternate;
}

@keyframes slide {
  from {
    transform: translateX(8px);
  }

  to {
    transform: translateX(calc(100% + 128px));
  }
}

figcaption {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 8px;
  font-size: var(--fs-micro);
  color: var(--fg-muted);
}

figcaption code {
  color: var(--fg);
}

figcaption .value {
  color: var(--fg-subtle);
  overflow-wrap: anywhere;
}

[data-contrast="light"] {
  color: var(--fg);
}

@media (prefers-reduced-motion: reduce) {
  .chip.motion .dot {
    animation: none;
  }
}
</style>
