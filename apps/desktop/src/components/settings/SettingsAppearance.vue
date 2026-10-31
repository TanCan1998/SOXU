<script setup lang="ts">
/**
 * 设置 → 外观（Issue #116 · V4-S2）：6 项。
 *
 * 全部走「选项表 + 守卫」的写法：档位定义在 theme/appearance.ts，组件只渲染数组，
 * 事件里用 is*Name 收窄再冒泡，因此不存在「界面能选到 CSS 没有的档位」这种静默失效。
 * 落地 DOM 与持久化在 useAppearance（App.vue 持有），本组件只负责显示与冒泡。
 *
 * 行标题与说明不写在这里（Issue #123）：SettingsRow 按 setting id 从
 * settings/catalog.ts 取，命令面板读的是同一份元数据。
 */

import { computed } from "vue";

import { useLocale } from "../../locales/index.ts";
import { localizedOptions } from "../../settings/optionLabels.ts";
import {
  ACCENT_OPTIONS,
  CODE_FONT_OPTIONS,
  CONTENT_WIDTH_OPTIONS,
  FONT_FAMILY_OPTIONS,
  FONT_SIZE_OPTIONS,
  isAccentName,
  isCodeFontName,
  isContentWidthName,
  isFontFamilyName,
  isFontSizeName,
  type Appearance,
} from "../../theme/appearance.ts";
import { isThemeName, type ThemeName } from "../../theme/theme.ts";
import SettingsChoice from "./SettingsChoice.vue";
import SettingsRow from "./SettingsRow.vue";
import SettingsSwatches from "./SettingsSwatches.vue";

const props = defineProps<{
  theme: ThemeName;
  appearance: Appearance;
}>();

const emit = defineEmits<{
  (event: "update:theme", value: ThemeName): void;
  (event: "update:appearance", value: Appearance): void;
}>();

const { t } = useLocale();

/** 主题只有两档，顺序照原型（深色在前），默认跟随系统偏好由 App.vue 决定。 */
const THEME_OPTIONS = [
  { value: "dark", label: "深色" },
  { value: "light", label: "浅色" },
] as const;

/**
 * 选项文案按当前语言解析（Issue #145）：数据表仍是唯一档位来源，
 * 这里只把 label 换成语言包里的说法；缺 key 时回退表里的字面量。
 */
const themeOptions = computed(() => localizedOptions(THEME_OPTIONS, t, "settings.option.theme"));
const accentOptions = computed(() => localizedOptions(ACCENT_OPTIONS, t, "settings.option.accent"));
const fontSizeOptions = computed(() =>
  localizedOptions(FONT_SIZE_OPTIONS, t, "settings.option.font.size"),
);
const fontFamilyOptions = computed(() =>
  localizedOptions(FONT_FAMILY_OPTIONS, t, "settings.option.font.family"),
);
const codeFontOptions = computed(() =>
  localizedOptions(CODE_FONT_OPTIONS, t, "settings.option.code.font"),
);
const contentWidthOptions = computed(() =>
  localizedOptions(CONTENT_WIDTH_OPTIONS, t, "settings.option.content.width"),
);

function patch(next: Partial<Appearance>): void {
  emit("update:appearance", { ...props.appearance, ...next });
}

function onTheme(value: string): void {
  if (isThemeName(value)) emit("update:theme", value);
}

function onFontSize(value: string): void {
  if (isFontSizeName(value)) patch({ fontSize: value });
}

function onFontFamily(value: string): void {
  if (isFontFamilyName(value)) patch({ fontFamily: value });
}

function onCodeFont(value: string): void {
  if (isCodeFontName(value)) patch({ codeFont: value });
}

function onContentWidth(value: string): void {
  if (isContentWidthName(value)) patch({ contentWidth: value });
}

function onAccent(value: string): void {
  if (isAccentName(value)) patch({ accent: value });
}
</script>

<template>
  <div class="panel">
    <SettingsRow setting="appearance.theme">
      <template #default="{ labelId }">
        <SettingsChoice
          :model-value="theme"
          :options="themeOptions"
          :labelledby="labelId"
          @update:model-value="onTheme"
        />
      </template>
    </SettingsRow>

    <SettingsRow setting="appearance.accent">
      <template #default="{ labelId }">
        <SettingsSwatches
          :model-value="appearance.accent"
          :options="accentOptions"
          :labelledby="labelId"
          @update:model-value="onAccent"
        />
      </template>
    </SettingsRow>

    <SettingsRow setting="appearance.fontSize">
      <template #default="{ labelId }">
        <SettingsChoice
          :model-value="appearance.fontSize"
          :options="fontSizeOptions"
          :labelledby="labelId"
          @update:model-value="onFontSize"
        />
      </template>
    </SettingsRow>

    <SettingsRow setting="appearance.fontFamily">
      <template #default="{ labelId }">
        <SettingsChoice
          :model-value="appearance.fontFamily"
          :options="fontFamilyOptions"
          :labelledby="labelId"
          @update:model-value="onFontFamily"
        />
      </template>
      <template #note>
        {{ t("settings.note.appearance.font.family") }}
      </template>
    </SettingsRow>

    <SettingsRow setting="appearance.codeFont">
      <template #default="{ labelId }">
        <SettingsChoice
          :model-value="appearance.codeFont"
          :options="codeFontOptions"
          :labelledby="labelId"
          @update:model-value="onCodeFont"
        />
      </template>
      <template #note>
        {{ t("settings.note.appearance.code.font") }}
      </template>
    </SettingsRow>

    <SettingsRow setting="appearance.contentWidth">
      <template #default="{ labelId }">
        <SettingsChoice
          :model-value="appearance.contentWidth"
          :options="contentWidthOptions"
          :labelledby="labelId"
          @update:model-value="onContentWidth"
        />
      </template>
      <template #note>
        {{ t("settings.note.appearance.content.width") }}
      </template>
    </SettingsRow>
  </div>
</template>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
}
</style>
