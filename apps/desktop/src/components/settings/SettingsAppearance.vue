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

/** 主题只有两档，顺序照原型（深色在前），默认跟随系统偏好由 App.vue 决定。 */
const THEME_OPTIONS = [
  { value: "dark", label: "深色" },
  { value: "light", label: "浅色" },
] as const;

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
          :options="THEME_OPTIONS"
          :labelledby="labelId"
          @update:model-value="onTheme"
        />
      </template>
    </SettingsRow>

    <SettingsRow setting="appearance.accent">
      <template #default="{ labelId }">
        <SettingsSwatches
          :model-value="appearance.accent"
          :options="ACCENT_OPTIONS"
          :labelledby="labelId"
          @update:model-value="onAccent"
        />
      </template>
    </SettingsRow>

    <SettingsRow setting="appearance.fontSize">
      <template #default="{ labelId }">
        <SettingsChoice
          :model-value="appearance.fontSize"
          :options="FONT_SIZE_OPTIONS"
          :labelledby="labelId"
          @update:model-value="onFontSize"
        />
      </template>
    </SettingsRow>

    <SettingsRow setting="appearance.fontFamily">
      <template #default="{ labelId }">
        <SettingsChoice
          :model-value="appearance.fontFamily"
          :options="FONT_FAMILY_OPTIONS"
          :labelledby="labelId"
          @update:model-value="onFontFamily"
        />
      </template>
      <template #note>
        「等宽」切换的是界面字体（侧栏、按钮、设置等）；代码块与工具输出始终等宽，会话正文不随这一项变化。
      </template>
    </SettingsRow>

    <SettingsRow setting="appearance.codeFont">
      <template #default="{ labelId }">
        <SettingsChoice
          :model-value="appearance.codeFont"
          :options="CODE_FONT_OPTIONS"
          :labelledby="labelId"
          @update:model-value="onCodeFont"
        />
      </template>
      <template #note>
        后两档需要本机已安装对应字体；未安装时自动回退到系统等宽栈，不会出现空白字形。
      </template>
    </SettingsRow>

    <SettingsRow setting="appearance.contentWidth">
      <template #default="{ labelId }">
        <SettingsChoice
          :model-value="appearance.contentWidth"
          :options="CONTENT_WIDTH_OPTIONS"
          :labelledby="labelId"
          @update:model-value="onContentWidth"
        />
      </template>
      <template #note>
        「固定 768」保持一行约 40–60 个汉字的阅读宽度；「自适应」随窗口与面板宽度铺开。
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
