<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import { X } from "@lucide/vue";
import AppTooltip from "./AppTooltip.vue";
import type { RuntimeInfo } from "../services/native.ts";

const props = defineProps<{
  open: boolean;
  theme: "light" | "dark";
  info: RuntimeInfo | null;
  bridgeAvailable: boolean;
}>();

const emit = defineEmits<{
  (event: "close"): void;
  (event: "update:theme", value: "light" | "dark"): void;
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
        <div class="theme-options" role="radiogroup" aria-label="主题">
          <label class="theme-option" :class="{ chosen: theme === 'light' }">
            <input
              type="radio"
              name="soxu-theme"
              value="light"
              :checked="theme === 'light'"
              @change="emit('update:theme', 'light')"
            />
            浅色
          </label>
          <label class="theme-option" :class="{ chosen: theme === 'dark' }">
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
  font-size: 15px;
  font-weight: 640;
}

.group {
  margin-bottom: 16px;
}

.group-title {
  margin: 0 0 8px;
  font-size: 11px;
  font-weight: 600;
  color: var(--soxu-muted);
}

.theme-options {
  display: flex;
  gap: 8px;
}

.theme-option {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border: 1px solid var(--soxu-border);
  border-radius: 10px;
  font-size: 12.5px;
  cursor: pointer;
  transition:
    background-color var(--soxu-motion-fast) var(--soxu-motion-ease),
    border-color var(--soxu-motion-fast) var(--soxu-motion-ease);
}

.theme-option:hover {
  background: var(--soxu-hover);
  border-color: var(--soxu-muted);
}

.theme-option.chosen {
  border-color: var(--soxu-accent);
  background: var(--soxu-accent-soft);
}

.theme-option input {
  accent-color: var(--soxu-accent);
}

.facts {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
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
  font-size: 10.5px;
  line-height: 1.7;
  color: var(--soxu-muted);
}
</style>
