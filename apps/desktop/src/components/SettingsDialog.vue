<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import { X } from "@lucide/vue";
import AppTooltip from "./AppTooltip.vue";
import type { RuntimeInfo } from "../services/native.ts";
// 外观档位只在 theme/appearance.ts 定义一次，这里只渲染数组，
// 避免设置面板的「小/标准/大/特大」与保存逻辑各写一份而漂移。
import {
  FONT_FAMILY_OPTIONS,
  FONT_SIZE_OPTIONS,
  type FontFamilyName,
  type FontSizeName,
} from "../theme/appearance.ts";

const props = defineProps<{
  open: boolean;
  theme: "light" | "dark";
  fontSize: FontSizeName;
  fontFamily: FontFamilyName;
  info: RuntimeInfo | null;
  bridgeAvailable: boolean;
}>();

const emit = defineEmits<{
  (event: "close"): void;
  (event: "update:theme", value: "light" | "dark"): void;
  (event: "update:fontSize", value: FontSizeName): void;
  (event: "update:fontFamily", value: FontFamilyName): void;
}>();

const dialog = ref<HTMLElement | null>(null);

watch(
  () => props.open,
  async (open) => {
    if (!open) return;
    await nextTick();
    dialog.value?.focus();
  },
);

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.stopPropagation();
    emit("close");
  }
}
</script>

<template>
  <div v-if="open" class="overlay" @click.self="emit('close')">
    <div
      ref="dialog"
      class="dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="soxu-settings-title"
      tabindex="-1"
      @keydown="onKeydown"
    >
      <header class="dialog-head">
        <h2 id="soxu-settings-title">设置</h2>
        <AppTooltip text="关闭设置">
          <button class="icon-button" type="button" aria-label="关闭设置" @click="emit('close')">
            <X :size="18" :stroke-width="1.75" aria-hidden="true" />
          </button>
        </AppTooltip>
      </header>

      <section class="group">
        <p class="group-title">外观</p>

        <div class="field">
          <p id="soxu-settings-theme" class="field-label">主题</p>
          <div class="options" role="radiogroup" aria-labelledby="soxu-settings-theme">
            <label class="option" :class="{ chosen: theme === 'light' }">
              <input
                type="radio"
                name="soxu-theme"
                value="light"
                :checked="theme === 'light'"
                @change="emit('update:theme', 'light')"
              />
              浅色
            </label>
            <label class="option" :class="{ chosen: theme === 'dark' }">
              <input
                type="radio"
                name="soxu-theme"
                value="dark"
                :checked="theme === 'dark'"
                @change="emit('update:theme', 'dark')"
              />
              深色
            </label>
          </div>
        </div>

        <div class="field">
          <p id="soxu-settings-font-size" class="field-label">字号</p>
          <div class="options" role="radiogroup" aria-labelledby="soxu-settings-font-size">
            <label
              v-for="option in FONT_SIZE_OPTIONS"
              :key="option.value"
              class="option"
              :class="{ chosen: fontSize === option.value }"
            >
              <input
                type="radio"
                name="soxu-font-size"
                :value="option.value"
                :checked="fontSize === option.value"
                @change="emit('update:fontSize', option.value)"
              />
              {{ option.label }}
            </label>
          </div>
        </div>

        <div class="field">
          <p id="soxu-settings-font-family" class="field-label">字体</p>
          <div class="options" role="radiogroup" aria-labelledby="soxu-settings-font-family">
            <label
              v-for="option in FONT_FAMILY_OPTIONS"
              :key="option.value"
              class="option"
              :class="{ chosen: fontFamily === option.value }"
            >
              <input
                type="radio"
                name="soxu-font-family"
                :value="option.value"
                :checked="fontFamily === option.value"
                @change="emit('update:fontFamily', option.value)"
              />
              {{ option.label }}
            </label>
          </div>
          <!--
            文案必须与 base.css 的实际作用域一致（Issue #98 复审意见）：
            「等宽」改的是界面字体 token，代码块与工具输出本来就是等宽栈（不受本项影响），
            会话正文用独立 token 也不变。声称「只影响代码块」是错的：代码块恒等宽，
            那样说等于这一档什么都不做。改文案时同步 tests/appearance.test.ts 的断言。
          -->
          <!-- prettier-ignore: 单行是刻意的，中文折行会引入一个被折叠成空格的换行，看着别扭 -->
          <p class="field-note">「等宽」切换的是界面字体（侧栏、按钮、设置等）；代码块与工具输出始终等宽，会话正文不随这一项变化。</p>
        </div>
      </section>

      <section class="group">
        <p class="group-title">关于</p>
        <dl class="facts">
          <div>
            <dt>应用</dt>
            <dd>{{ info ? `${info.appName} ${info.appVersion}` : "未获取" }}</dd>
          </div>
          <div>
            <dt>平台</dt>
            <dd>{{ info?.platform ?? "未知" }}</dd>
          </div>
          <div>
            <dt>连接状态</dt>
            <dd>{{ bridgeAvailable ? "已连接" : "未连接（浏览器预览）" }}</dd>
          </div>
        </dl>
      </section>

      <p class="footnote">
        会话文件由 Pi 管理，SOXU 只读索引；本对话框不收集任何凭据。
      </p>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: grid;
  place-items: center;
  background: rgb(0 0 0 / 32%);
  padding: 24px;
}

.dialog {
  width: min(420px, 100%);
  border-radius: 16px;
  border: 1px solid var(--soxu-border);
  background: var(--soxu-panel);
  box-shadow: 0 20px 60px rgb(0 0 0 / 22%);
  padding: 18px 20px 16px;
}

.dialog:focus-visible {
  outline: 2px solid var(--soxu-focus);
}

.dialog-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
}

.dialog-head h2 {
  margin: 0;
  font-size: 0.9375rem;
  font-weight: 640;
}

.group {
  margin-bottom: 16px;
}

.group-title {
  margin: 0 0 8px;
  font-size: 0.6875rem;
  font-weight: 600;
  color: var(--soxu-muted);
}

.field + .field {
  margin-top: 12px;
}

.field-label {
  margin: 0 0 6px;
  font-size: 0.75rem;
  color: var(--soxu-subtext);
}

/* 字号档位有四个、字体档位有三个：允许换行，避免「特大」字号下挤成一行溢出。 */
.options {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.option {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border: 1px solid var(--soxu-border);
  border-radius: 10px;
  font-size: 0.78125rem;
  cursor: pointer;
  transition:
    background-color var(--soxu-motion-fast) var(--soxu-motion-ease),
    border-color var(--soxu-motion-fast) var(--soxu-motion-ease);
}

.option:hover {
  background: var(--soxu-hover);
  border-color: var(--soxu-muted);
}

.option.chosen {
  border-color: var(--soxu-accent);
  background: var(--soxu-accent-soft);
}

.option input {
  accent-color: var(--soxu-accent);
}

.field-note {
  margin: 6px 0 0;
  font-size: 0.65625rem;
  line-height: 1.6;
  color: var(--soxu-muted);
}

.facts {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 0.75rem;
}

.facts div {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}

.facts dt {
  color: var(--soxu-muted);
}

.facts dd {
  margin: 0;
  color: var(--soxu-fg);
}

.footnote {
  margin: 6px 0 0;
  font-size: 0.65625rem;
  line-height: 1.7;
  color: var(--soxu-muted);
}
</style>
