<script setup lang="ts">
/**
 * 设置弹窗外壳（Issue #116 · V4-S2）：外观 / 会话 / 扩展 / 系统 四页。
 *
 * 分工：
 * - 外壳只管弹窗、Esc、焦点与 tab 切换；四个页面各自在自己的组件里，
 *   避免单个文件涨到几百行后没人敢改（上一版 304 行只有两项）。
 * - 所有偏好由 App.vue 持有（useAppearance / useSessionSettings / useSystemSettings），
 *   本组件只把改动原样冒泡，不写存储、不碰 DOM —— 因此设置页没有任何隐藏副作用。
 *
 * 键盘可达：reka-ui Tabs 提供 role=tablist/tab/tabpanel、方向键在标签间移动、
 * 只有当前标签在 Tab 序列里（roving focus）；Tab 键从标签栏进入面板内容。
 */

import { nextTick, ref, watch } from "vue";
import { X } from "@lucide/vue";
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from "reka-ui";

import AppTooltip from "./AppTooltip.vue";
import { SETTINGS_TABS, type SettingsTabId } from "../settings/catalog.ts";
import { settingsOpenTransition } from "../settings/openRequest.ts";
import SettingsAppearance from "./settings/SettingsAppearance.vue";
import SettingsExtensions from "./settings/SettingsExtensions.vue";
import SettingsSession from "./settings/SettingsSession.vue";
import SettingsSystem from "./settings/SettingsSystem.vue";
import type { RuntimeInfo } from "../services/native.ts";
import type { BusySendDelivery } from "../settings/busyDelivery.ts";
import type { SessionSettings } from "../settings/sessionSettings.ts";
import type { SystemSettings } from "../settings/systemSettings.ts";
import type { Appearance } from "../theme/appearance.ts";
import type { ThemeName } from "../theme/theme.ts";

const props = defineProps<{
  open: boolean;
  theme: ThemeName;
  appearance: Appearance;
  /** 设置 → 会话 → 忙碌时发送（V4-S1）。 */
  busyDelivery: BusySendDelivery;
  session: SessionSettings;
  system: SystemSettings;
  info: RuntimeInfo | null;
  bridgeAvailable: boolean;
  tauriVersion: string | null;
  dataDirectory: string;
  copyState: "idle" | "copied" | "failed";
  /** 会话页「清空当前会话」的禁用原因；null 表示可以点。 */
  clearBlockedReason: string | null;
  /**
   * 打开时先落到哪一页（Issue #123 的命令面板会带着目标页打开）；null = 沿用上次看的那页。
   * 只是「初始页」，之后用户仍可自由切换。
   */
  initialTab: SettingsTabId | null;
  /**
   * 打开请求序号：每次 App.vue 调用 openSettings 都 +1（含「设置已经开着」的那次）。
   * 有了它，同一页被再请求一次也能生效——见 settings/openRequest.ts 的说明。
   */
  request: number;
}>();

const emit = defineEmits<{
  (event: "close"): void;
  (event: "update:theme", value: ThemeName): void;
  (event: "update:appearance", value: Appearance): void;
  (event: "update:busyDelivery", value: BusySendDelivery): void;
  (event: "update:session", value: Partial<SessionSettings>): void;
  (event: "update:system", value: Partial<SystemSettings>): void;
  (event: "clear-session"): void;
  (event: "reset-layout"): void;
  (event: "copy-data-dir"): void;
}>();

/**
 * 打开时停留的页面：默认沿用上次看的那页（设置页常被用来反复调同一项）；
 * 命令面板带目标页打开时（initialTab 非 null）直接落到那一页。
 *
 * 四个页面的 id 与文案来自 settings/catalog.ts，与命令面板的设置类命令同源，
 * 因此这里不再有第二份 TABS 数组。
 */
const tab = ref<string>("appearance");
const dialog = ref<HTMLElement | null>(null);

/**
 * 打开 / 重新指定页面。
 *
 * 判定逻辑（none / opened / retargeted）在 settings/openRequest.ts，可脱离 DOM 测试：
 * 复审阻塞点正是「open 一直是 true 时那次请求被丢掉」，靠一个纯函数把它钉住。
 */
watch(
  () => ({ open: props.open, request: props.request }),
  async (next, previous) => {
    const transition = settingsOpenTransition(previous, next);
    if (transition === "none") return;
    if (props.initialTab) tab.value = props.initialTab;

    // 刚打开：焦点进弹窗（键盘用户不必先 Tab 一圈才进得来）。
    // 已经开着又换了页：只把焦点留在弹窗里，不抢用户正在操作的那个控件。
    await nextTick();
    const active = document.activeElement;
    const focusInside = dialog.value !== null && active !== null && dialog.value.contains(active);
    if (transition === "opened" || !focusInside) dialog.value?.focus();
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

      <TabsRoot v-model="tab" class="tabs">
        <TabsList class="tab-list" aria-label="设置分类">
          <TabsTrigger
            v-for="item in SETTINGS_TABS"
            :key="item.id"
            :value="item.id"
            class="tab"
          >
            {{ item.label }}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="appearance" class="tab-panel">
          <SettingsAppearance
            :theme="theme"
            :appearance="appearance"
            @update:theme="(value: ThemeName) => emit('update:theme', value)"
            @update:appearance="(value: Appearance) => emit('update:appearance', value)"
          />
        </TabsContent>

        <TabsContent value="session" class="tab-panel">
          <SettingsSession
            :settings="session"
            :busy-delivery="busyDelivery"
            :clear-blocked-reason="clearBlockedReason"
            @update:settings="(value: Partial<SessionSettings>) => emit('update:session', value)"
            @update:busyDelivery="(value: BusySendDelivery) => emit('update:busyDelivery', value)"
            @clear-session="emit('clear-session')"
          />
        </TabsContent>

        <TabsContent value="extensions" class="tab-panel">
          <SettingsExtensions />
        </TabsContent>

        <TabsContent value="system" class="tab-panel">
          <SettingsSystem
            :settings="system"
            :info="info"
            :bridge-available="bridgeAvailable"
            :tauri-version="tauriVersion"
            :data-directory="dataDirectory"
            :copy-state="copyState"
            @update:settings="(value: Partial<SystemSettings>) => emit('update:system', value)"
            @reset-layout="emit('reset-layout')"
            @copy-data-dir="emit('copy-data-dir')"
          />
        </TabsContent>
      </TabsRoot>

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
  display: flex;
  flex-direction: column;
  width: min(680px, 100%);
  max-height: min(88vh, 720px);
  border-radius: var(--r-lg);
  border: 1px solid var(--border);
  background: var(--bg-panel);
  color: var(--fg);
  box-shadow: var(--shadow-modal);
  padding: 16px 18px 14px;
}

.dialog:focus-visible {
  outline: 2px solid var(--soxu-focus);
}

.dialog-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

.dialog-head h2 {
  margin: 0;
  font-size: 0.9375rem;
  font-weight: 640;
}

.tabs {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

/* 标签栏：底部一条分隔线，选中项用强调色下划线（原型 modal-tabs）。 */
.tab-list {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 6px;
}

.tab {
  position: relative;
  padding: 8px 12px;
  color: var(--fg-muted);
  font-size: 0.75rem;
  line-height: 1.5;
  border-bottom: 2px solid transparent;
  transition: color var(--dur-fast) var(--ease);
}

.tab:hover {
  color: var(--fg);
}

.tab[data-state="active"] {
  color: var(--fg);
  border-bottom-color: var(--accent);
}

/*
 * 面板区滚动：四页内容高度不同（扩展页最长），外壳高度固定、只有面板滚动，
 * 这样切换页面时弹窗不会跟着跳。
 */
.tab-panel {
  min-height: 0;
  overflow-y: auto;
  padding-right: 4px;
}

.footnote {
  margin: 10px 0 0;
  font-size: 0.65625rem;
  line-height: 1.7;
  color: var(--fg-subtle);
}
</style>
