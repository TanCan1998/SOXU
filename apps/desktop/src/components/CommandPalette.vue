<!--
  命令面板（Issue #123 · TASK-031，快捷键 Ctrl/⌘+K）。

  分工：
  - 匹配与排序在 commands/match.ts，命令清单与键盘语义在 commands/registry.ts，
    两者都是纯逻辑，Node 测试不需要 DOM；
  - 本组件只做三件事：渲染结果与高亮、把按键翻译成动作、把「执行」交给 App.vue；
  - 组件不持有定时器、也没有全局监听：按键监听挂在对话框元素上，关闭即卸载。
    唯一需要收尾的是焦点——打开前记下它在哪，卸载时还回去（见 onBeforeUnmount）；
    Tab 也被圈在面板内（aria-modal 的语义承诺，浏览器不会替你实现）。

  键盘可达（验收点）：输入 → ↑↓ 选择 → ↵ 执行 → Esc 关闭，全程不需要鼠标。
  DOM 有上界：结果最多 MAX_RESULTS 条（见 commands/match.ts），不会随命令增长而爆。

  文案（Issue #145）：面板自身与命令标题都走语言包，组件里不再有中文标题字面量；
  命令清单由 App.vue 传入（buildCommands(t) 的结果），切换语言后 props.commands 变化，
  这里的结果行、条数说明与空态提示一起重算。
-->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Search } from "@lucide/vue";

import { FOCUSABLE_SELECTOR, focusTargetIndex } from "../commands/focusTrap.ts";
import { useLocale } from "../locales/index.ts";
import {
  clampActiveIndex,
  nextActiveIndex,
  paletteKeyAction,
  type CommandContext,
  type CommandEntry,
} from "../commands/registry.ts";
import {
  highlightSegments,
  pinyinReady,
  rankCommands,
  setPinyinProvider,
  type PinyinChar,
} from "../commands/match.ts";

const props = defineProps<{
  /** 命令清单；由 App.vue 传入 buildCommands(t) 的结果，测试可以塞夹具。 */
  commands: readonly CommandEntry[];
  /** 可用性上下文（是否有会话 / 项目）。 */
  context: CommandContext;
}>();

const emit = defineEmits<{
  (event: "close"): void;
  /** 用户按下 ↵ 或点击了一条可用命令。 */
  (event: "run", command: CommandEntry): void;
}>();

const { t } = useLocale();
const query = ref("");
const activeIndex = ref(0);
/**
 * 拼音引擎是否已就绪。
 *
 * 字典有 173 KB gzip，不能塞进首屏 bundle：面板第一次打开时才动态 import（见 loadPinyinEngine）。
 * 它同时是 computed 依赖——引擎到位后，用户已经打了一半的输入要立刻重新排一次。
 */
const pinyinLoaded = ref(pinyinReady());
const input = ref<HTMLInputElement | null>(null);
const list = ref<HTMLElement | null>(null);
const dialog = ref<HTMLElement | null>(null);
/**
 * 打开前焦点在哪。
 *
 * 面板是 aria-modal 的模态层，关掉之后焦点必须回到触发它的地方（Ctrl+K 之前正在
 * 打字的输入框、侧栏按钮……）；否则焦点会掉到 <body>，键盘用户得从头 Tab 一遍。
 */
let focusBeforeOpen: HTMLElement | null = null;
/** 不可用命令被回车时给出的说明；null 表示没有提示。 */
const notice = ref<string | null>(null);

/**
 * 搜索输入 + 引擎状态。
 *
 * 拆成一层 computed 是为了让 pinyinLoaded 参与 ranked 的依赖：
 * 直接读 query 的话，引擎加载完成不会触发重排，用户得再敲一个字才能看到拼音结果。
 */
const searchState = computed(() => ({ query: query.value, ready: pinyinLoaded.value }));

const ranked = computed(() => rankCommands(props.commands, searchState.value.query));

/**
 * 结果行：高亮片段、不可用原因、右侧说明一次算好。
 *
 * 不在模板里对同一条命令重复调用 unavailable()：那是每帧都会跑的判断，
 * 而它可能读 props.context（响应式），放在 computed 里只随输入变化重算。
 */
const rows = computed(() =>
  ranked.value.results.map(({ command, ranges }) => ({
    command,
    segments: highlightSegments(command.title, ranges),
    reason: command.unavailable?.(props.context) ?? null,
  })),
);

const countText = computed(() => {
  if (rows.value.length === 0) return t("commands.palette.empty");
  const total = ranked.value.matched;
  if (total > rows.value.length) {
    return t("commands.palette.count.limited", { shown: rows.value.length, total });
  }
  return t("commands.palette.count", { total });
});

/** 空查询时列表就是全部命令；有查询时按分数排序。提示文案随之变化。 */
const emptyHint = computed(() =>
  query.value.trim() ? t("commands.palette.empty.hint") : "",
);

/** 分组标签：注册表里存的是稳定 id，文案在这里查表（切语言后跟着变）。 */
function groupLabel(group: CommandEntry["group"]): string {
  return t("commands.group." + group);
}

watch(query, () => {
  notice.value = null;
  activeIndex.value = clampActiveIndex(activeIndex.value, rows.value.length);
});

/** 结果集变化后收敛下标：从 8 条筛到 2 条时不能继续指着第 7 条。 */
watch(
  () => rows.value.length,
  (length) => {
    activeIndex.value = clampActiveIndex(activeIndex.value, length);
  },
);

function optionId(index: number): string {
  return "soxu-command-option-" + String(index);
}

/** 无障碍：aria-activedescendant 只在真的有高亮项时给出。 */
const activeId = computed(() =>
  activeIndex.value >= 0 && activeIndex.value < rows.value.length
    ? optionId(activeIndex.value)
    : null,
);

function scrollActiveIntoView(): void {
  const index = activeIndex.value;
  if (index < 0) return;
  void nextTick(() => {
    const option = list.value?.querySelector<HTMLElement>('[data-index="' + String(index) + '"]');
    option?.scrollIntoView({ block: "nearest" });
  });
}

/** 执行第 index 条；不可用时只解释原因，不假装执行成功。 */
function run(index: number): void {
  const row = rows.value[index];
  if (!row) return;
  if (row.reason) {
    notice.value = t("commands.palette.unavailable", {
      title: row.command.title,
      reason: row.reason,
    });
    return;
  }
  emit("run", row.command);
}

/**
 * 把 Tab / Shift+Tab 圈在面板内。
 *
 * 面板里真正可聚焦的只有搜索框，但按「面板内所有可聚焦元素」通用处理：
 * 将来加了按钮或开关，焦点圈仍然成立，不用回来改这里。
 */
function trapTab(event: KeyboardEvent): void {
  // 无论圈内有没有元素都要拦：不拦就等于允许焦点跑到模态层背后。
  event.preventDefault();
  const root = dialog.value;
  if (!root) return;
  const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => element.getClientRects().length > 0,
  );
  const current = items.indexOf(document.activeElement as HTMLElement);
  const target = focusTargetIndex(current, items.length, event.shiftKey);
  items[target]?.focus();
}

function onKeydown(event: KeyboardEvent): void {
  // Tab 是浏览器默认行为，paletteKeyAction 不管它；不在这里拦就会跑出面板。
  if (event.key === "Tab") {
    trapTab(event);
    return;
  }
  const action = paletteKeyAction(event.key, {
    ctrl: event.ctrlKey,
    meta: event.metaKey,
    alt: event.altKey,
  });
  if (action === "none") return;
  // 全部拦下：↑↓ 在输入框里会把光标挪到行首/行尾，与「选择结果」冲突。
  event.preventDefault();
  if (action === "close") {
    // 只关自己：外层（App.vue）可能还挂着别的浮层，stopPropagation 防止连带关闭。
    event.stopPropagation();
    emit("close");
    return;
  }
  if (action === "execute") {
    run(activeIndex.value);
    return;
  }
  activeIndex.value = nextActiveIndex(activeIndex.value, rows.value.length, action);
  scrollActiveIntoView();
}

/** 鼠标移到某一行时同步高亮：键盘与鼠标指向同一条，不会出现两个选中态。 */
function onHover(index: number): void {
  if (activeIndex.value === index) return;
  activeIndex.value = index;
}

/**
 * 按需加载拼音字典。
 *
 * 加载失败（离线、chunk 被拦）不报错也不阻塞：标题字面匹配与别名仍然可用，
 * 只是拼音首字母搜不到。一个可选增强不该让整个面板不可用。
 */
async function loadPinyinEngine(): Promise<void> {
  if (pinyinReady()) return;
  try {
    const { pinyin } = await import("pinyin-pro");
    setPinyinProvider(
      (text) => pinyin(text, { type: "all", toneType: "none" }) as unknown as PinyinChar[],
    );
    pinyinLoaded.value = true;
  } catch {
    // 保持字面匹配；不弹错误，用户不会因为一个可选增强而被打断。
  }
}

/**
 * 挂载即聚焦：面板是 v-if 挂上去的，Ctrl+K 之后用户的第一动作就是打字，
 * 让他先点一下输入框等于快捷键只完成了一半。
 */
onMounted(() => {
  // 先记下焦点来源再抢焦点：顺序反了就只能记到自己（输入框）。
  const active = document.activeElement;
  focusBeforeOpen = active instanceof HTMLElement ? active : null;
  void nextTick(() => input.value?.focus());
  void loadPinyinEngine();
});

/**
 * 卸载时把焦点还回去。
 *
 * 只在原元素仍在文档里时还原：命令可能已经把那块界面换掉了（例如打开设置弹窗、
 * 关掉当前会话），对着一个已卸载的节点 focus() 什么也不会发生，焦点会留在 <body>。
 */
onBeforeUnmount(() => {
  const target = focusBeforeOpen;
  focusBeforeOpen = null;
  if (target?.isConnected) target.focus();
});
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div
      ref="dialog"
      class="palette"
      role="dialog"
      aria-modal="true"
      aria-labelledby="soxu-command-palette-title"
      :data-pinyin="pinyinLoaded ? 'ready' : 'pending'"
      @keydown="onKeydown"
    >
      <h2 id="soxu-command-palette-title" class="sr-only">{{ t("commands.palette.title") }}</h2>

      <div class="cp-input-row">
        <Search class="cp-input-icon" :size="15" :stroke-width="1.9" aria-hidden="true" />
        <input
          ref="input"
          v-model="query"
          class="cp-input"
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-autocomplete="list"
          aria-controls="soxu-command-list"
          :aria-activedescendant="activeId ?? undefined"
          :aria-label="t('commands.palette.search.label')"
          :placeholder="t('commands.palette.placeholder')"
          autocomplete="off"
          spellcheck="false"
        />
        <kbd class="cp-esc" aria-hidden="true">Esc</kbd>
      </div>

      <!-- role=status：条数变化会读出来，焦点始终留在输入框里。 -->
      <p class="cp-meta" role="status" aria-live="polite">{{ countText }}</p>

      <ul
        v-if="rows.length > 0"
        id="soxu-command-list"
        ref="list"
        class="cp-list"
        role="listbox"
        :aria-label="t('commands.palette.results')"
      >
        <li
          v-for="(row, index) in rows"
          :id="optionId(index)"
          :key="row.command.id"
          class="cp-item"
          role="option"
          :aria-selected="index === activeIndex"
          :aria-disabled="row.reason !== null"
          :data-index="index"
          :data-active="index === activeIndex"
          @mouseenter="onHover(index)"
          @click="run(index)"
        >
          <span class="cp-title">
            <template v-for="(segment, at) in row.segments" :key="at">
              <mark v-if="segment.hit" class="cp-mark">{{ segment.text }}</mark>
              <span v-else>{{ segment.text }}</span>
            </template>
          </span>
          <span v-if="row.reason" class="cp-reason">{{ row.reason }}</span>
          <span v-else-if="row.command.hint" class="cp-hint">{{ row.command.hint }}</span>
          <span class="cp-group">{{ groupLabel(row.command.group) }}</span>
          <kbd v-if="row.command.shortcut" class="cp-key">{{ row.command.shortcut }}</kbd>
        </li>
      </ul>

      <p v-else class="cp-empty">{{ emptyHint }}</p>

      <p v-if="notice" class="cp-notice" role="alert">{{ notice }}</p>

      <footer class="cp-footer">
        <span><kbd>↑</kbd><kbd>↓</kbd> {{ t("commands.palette.footer.select") }}</span>
        <span><kbd>↵</kbd> {{ t("commands.palette.footer.run") }}</span>
        <span><kbd>Esc</kbd> {{ t("commands.palette.footer.close") }}</span>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding: 12vh 24px 24px;
  background: rgb(0 0 0 / 28%);
}

/* 面板本身不滚动：只有结果列表滚，输入框与底部提示始终可见。 */
.palette {
  display: flex;
  flex-direction: column;
  width: min(560px, 100%);
  max-height: min(64vh, 520px);
  border-radius: var(--r-lg);
  border: 1px solid var(--border);
  background: var(--bg-panel);
  color: var(--fg);
  box-shadow: var(--shadow-modal);
  overflow: hidden;
}

.cp-input-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 11px 12px;
  border-bottom: 1px solid var(--border);
}

.cp-input-icon {
  flex: none;
  color: var(--fg-subtle);
}

.cp-input {
  flex: 1;
  min-width: 0;
  border: 0;
  background: transparent;
  color: var(--fg);
  font-size: var(--fs-body);
}

.cp-input:focus-visible {
  outline: none;
}

.cp-input::placeholder {
  color: var(--fg-subtle);
}

/* 快捷键提示：等宽字体只能来自 token（见 tests/appearance.test.ts）。 */
.cp-esc,
.cp-key,
.cp-footer kbd {
  padding: 1px 5px;
  border-radius: var(--r-sm);
  border: 1px solid var(--border);
  background: var(--bg-raised);
  color: var(--fg-subtle);
  font-family: var(--soxu-font-family-mono);
  font-size: var(--fs-micro);
  line-height: 1.5;
  white-space: nowrap;
}

.cp-meta {
  margin: 0;
  padding: 6px 14px 0;
  min-height: 1em;
  font-size: var(--fs-micro);
  color: var(--fg-subtle);
}

.cp-list {
  list-style: none;
  margin: 0;
  padding: 6px;
  overflow-y: auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.cp-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 9px;
  border-radius: var(--r-md);
  cursor: default;
  transition: background-color var(--dur-fast) var(--ease);
}

/* 高亮用 data 属性而不是 :hover：键盘移动时也要有同样的视觉反馈。 */
.cp-item[data-active="true"] {
  background: var(--bg-hover);
}

.cp-item[aria-disabled="true"] {
  color: var(--fg-subtle);
}

.cp-title {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-control);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 命中字符：强调色 token，不用浏览器默认黄底（深色主题下对比度不可控）。 */
.cp-mark {
  border-radius: 3px;
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 640;
}

.cp-hint,
.cp-reason {
  flex: none;
  max-width: 45%;
  font-size: var(--fs-micro);
  color: var(--fg-subtle);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cp-reason {
  color: var(--warn);
}

.cp-group {
  flex: none;
  font-size: var(--fs-micro);
  color: var(--fg-subtle);
}

.cp-empty {
  margin: 0;
  padding: 22px 16px;
  font-size: var(--fs-caption);
  line-height: 1.8;
  color: var(--fg-muted);
}

.cp-notice {
  margin: 0;
  padding: 8px 14px;
  border-top: 1px solid var(--border);
  background: color-mix(in srgb, var(--warn) 12%, transparent);
  color: var(--warn);
  font-size: var(--fs-micro);
  line-height: 1.7;
}

.cp-footer {
  display: flex;
  gap: 14px;
  border-top: 1px solid var(--border);
  padding: 8px 12px;
  font-size: var(--fs-micro);
  color: var(--fg-subtle);
}

.cp-footer kbd + kbd {
  margin-left: 3px;
}

@media (prefers-reduced-motion: reduce) {
  .cp-item {
    transition: none;
  }
}
</style>
