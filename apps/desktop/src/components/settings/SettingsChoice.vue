<script setup lang="ts">
/**
 * 分段单选（Issue #116）：reka-ui RadioGroupRoot + RadioGroupItem。
 *
 * 主题、字号、字体、代码字体、正文宽度、忙碌时发送都是「几选一」，
 * 用 radio 组而不是一排 toggle：读屏会读出「n 选 1」，方向键在组内移动，
 * Tab 只会在整组上停一次（roving focus），符合设置页的键盘预期。
 *
 * 值用 string 接收、由调用方用 is*Name 守卫收窄：选项表来自各自的设置模块，
 * 组件本身不需要认识每一档的具体类型。
 */

import { RadioGroupItem, RadioGroupRoot } from "reka-ui";

defineProps<{
  modelValue: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  /**
   * 行标题的 id（由 SettingsRow 的 useId 生成），必填。
   *
   * Issue #123 起不再接受独立的 label 字符串：行的可见标题来自 settings/catalog.ts，
   * 命令面板读的是同一份元数据。多一个 label 入参就等于多一份会漂移的文案。
   */
  labelledby: string;
}>();

const emit = defineEmits<{ (event: "update:modelValue", value: string): void }>();

function onChange(value: unknown): void {
  if (typeof value === "string") emit("update:modelValue", value);
}
</script>

<template>
  <RadioGroupRoot
    :model-value="modelValue"
    :aria-labelledby="labelledby"
    class="choice"
    orientation="horizontal"
    @update:model-value="onChange"
  >
    <RadioGroupItem
      v-for="option in options"
      :key="option.value"
      :value="option.value"
      class="choice-item"
    >
      {{ option.label }}
    </RadioGroupItem>
  </RadioGroupRoot>
</template>

<style scoped>
.choice {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.choice-item {
  padding: 5px 11px;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--bg-panel);
  color: var(--fg-muted);
  font-size: 0.75rem;
  line-height: 1.5;
  transition:
    background-color var(--dur-fast) var(--ease),
    border-color var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}

.choice-item:hover {
  background: var(--bg-hover);
  color: var(--fg);
}

.choice-item[data-state="checked"] {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--fg);
}
</style>
