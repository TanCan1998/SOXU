<script setup lang="ts">
/**
 * 设置 → 扩展 → 语言包（Issue #135）。
 *
 * 为什么单独成组件而不是塞进 SettingsExtensions.vue：扩展页上半部分是只读展示，
 * 有自己的回归测试（不读存储、不发 IPC）；语言包要真的读写磁盘，
 * 两者的失败方式与测试方式完全不同，混在一起会让只读页的约束失效。
 *
 * 交互只有四个动作：切语言、导入、复制基准包、移除。
 * 每个动作的结果都落到一条 notice 上（成功 status / 失败 alert），
 * 失败原因来自 locales/community.ts 的校验结果，不做「导入失败」这种没有信息量的提示。
 *
 * 不设定时器：复制回执与 notice 都保持到下一次操作，因此这里没有任何需要释放的
 * 计时器或监听器（资源 owner 就是组件本身，卸载即结束）。
 */

import { computed, onMounted, ref } from "vue";
import { X } from "@lucide/vue";
import { open } from "@tauri-apps/plugin-dialog";

import { BUILTIN_LOCALES, exportBaseLocaleJson, useLocale } from "../../locales/index.ts";
import { useLocalePacks } from "../../composables/useLocalePacks.ts";
import { copyText } from "../../services/clipboard.ts";
import { isTauriRuntime } from "../../workspace/bridge.ts";
import SettingsButton from "./SettingsButton.vue";
import SettingsChoice from "./SettingsChoice.vue";
import SettingsRow from "./SettingsRow.vue";

const { t, locale } = useLocale();
const {
  tags,
  directory,
  busy,
  notice,
  refresh,
  activate,
  importFromFile,
  remove,
  dismissNotice,
} = useLocalePacks();

/** 浏览器预览没有文件访问能力：导入按钮禁用并说明原因，而不是点了没反应。 */
const desktop = isTauriRuntime();
const importing = ref(false);
const copyState = ref<"idle" | "copied" | "failed">("idle");

/** 内置语言 + 已导入的语言包；内置语言始终排在最前，顺序稳定。 */
const options = computed(() => [
  ...BUILTIN_LOCALES.map((entry) => ({ value: entry.tag as string, label: entry.label })),
  ...tags.value
    .filter((tag) => !BUILTIN_LOCALES.some((entry) => entry.tag === tag))
    .map((tag) => ({ value: tag, label: tag })),
]);

onMounted(() => {
  if (desktop) void refresh();
});

async function select(value: string): Promise<void> {
  await activate(value);
}

async function importPack(): Promise<void> {
  if (!desktop || importing.value) return;
  importing.value = true;
  try {
    const picked = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    // 用户取消：不产生任何状态变化，也不显示错误。
    if (typeof picked !== "string") return;
    await importFromFile(picked);
  } catch (error) {
    notice.value = {
      tone: "error",
      text: t("settings.locale.failed", {
        reason: error instanceof Error ? error.message : String(error),
      }),
    };
  } finally {
    importing.value = false;
  }
}

async function copyBasePack(): Promise<void> {
  const copied = await copyText(exportBaseLocaleJson());
  copyState.value = copied ? "copied" : "failed";
}

function copyHint(): string | null {
  if (copyState.value === "copied") return t("settings.locale.copied");
  if (copyState.value === "failed") return t("settings.locale.copy.failed");
  return null;
}
</script>

<template>
  <div class="panel">
    <p class="section-title">{{ t("settings.locale.section", { count: options.length }) }}</p>
    <p class="banner">{{ t("settings.locale.description") }}</p>

    <SettingsRow label-key="settings.locale.builtin" :description="t('settings.locale.partial')">
      <template #default="{ labelId }">
        <SettingsChoice
          :model-value="locale"
          :options="options"
          :labelledby="labelId"
          :label="t('settings.locale.builtin')"
          @update:model-value="select"
        />
      </template>
    </SettingsRow>

    <SettingsRow label-key="settings.locale.imported" :description="t('settings.locale.storage')">
      <template #default>
        <SettingsButton
          :label="importing ? t('settings.locale.importing') : t('settings.locale.import')"
          :disabled="!desktop || importing"
          @click="importPack"
        />
        <SettingsButton
          :label="t('common.action.copy')"
          @click="copyBasePack"
        />
        <SettingsButton
          :label="t('common.action.refresh')"
          :disabled="!desktop"
          @click="refresh"
        />
      </template>
      <template #note>
        <span v-if="copyHint()">{{ copyHint() }}</span>
        <span v-else-if="!desktop">{{ t("settings.locale.bridge") }}</span>
        <span v-else-if="directory">{{ t("settings.locale.dir", { path: directory }) }}</span>
      </template>
    </SettingsRow>

    <p v-if="tags.length === 0" class="empty">{{ t("settings.locale.none") }}</p>
    <div v-for="tag in tags" :key="tag" class="item">
      <div class="item-main">
        <p class="item-title">{{ tag }}</p>
      </div>
      <span v-if="tag === locale" class="item-tag" data-tone="on">
        {{ t("settings.locale.active") }}
      </span>
      <SettingsButton
        :label="t('common.action.remove')"
        tone="danger"
        :disabled="busy"
        @click="remove(tag)"
      />
    </div>

    <p
      v-if="notice"
      class="notice"
      :data-tone="notice.tone"
      :role="notice.tone === 'error' ? 'alert' : 'status'"
    >
      <span class="notice-text">{{ notice.text }}</span>
      <button
        type="button"
        class="notice-close"
        :aria-label="t('common.action.close')"
        @click="dismissNotice"
      >
        <X :size="13" :stroke-width="1.75" aria-hidden="true" />
      </button>
    </p>
  </div>
</template>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
}

.banner {
  margin: 0 0 10px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--bg-raised);
  color: var(--fg-muted);
  font-size: 0.65625rem;
  line-height: 1.7;
}

.section-title {
  margin: 10px 0 4px;
  font-size: 0.6875rem;
  font-weight: 600;
  color: var(--fg-muted);
}

.empty {
  margin: 6px 0;
  font-size: 0.6875rem;
  color: var(--fg-subtle);
}

.item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 0;
  border-bottom: 1px solid var(--border);
}

.item:last-of-type {
  border-bottom: 0;
}

.item-main {
  min-width: 0;
  flex: 1;
}

.item-title {
  margin: 0;
  font-size: 0.78125rem;
  color: var(--fg);
  overflow-wrap: anywhere;
}

.item-tag {
  flex: none;
  padding: 2px 8px;
  border-radius: var(--r-full);
  border: 1px solid transparent;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 0.65625rem;
  white-space: nowrap;
}

.notice {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 10px 0 0;
  padding: 7px 9px;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--bg-raised);
  font-size: 0.65625rem;
  line-height: 1.65;
  color: var(--fg-muted);
}

.notice[data-tone="error"] {
  color: var(--danger);
}

.notice-text {
  flex: 1;
  overflow-wrap: anywhere;
}

.notice-close {
  flex: none;
  display: grid;
  place-items: center;
  padding: 1px;
  color: inherit;
  opacity: 0.75;
}

.notice-close:hover {
  opacity: 1;
}

.notice-close:focus-visible {
  outline: 2px solid var(--soxu-focus);
  outline-offset: 1px;
}
</style>
