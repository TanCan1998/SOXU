<script setup lang="ts">
/**
 * 开关（Issue #116）：reka-ui SwitchRoot + SwitchThumb。
 *
 * 用 reka 而不是自己写 role="switch"：它提供 role、aria-checked、Space/Enter 切换，
 * 并保证点击整个轨道都能切换，键盘焦点环由全局 :focus-visible 提供。
 * 视觉沿用原型 .switch：34×20 的胶囊，滑块 16px，选中时轨道用强调色。
 */

import { SwitchRoot, SwitchThumb } from "reka-ui";

defineProps<{
  modelValue: boolean;
  /** 控件的可访问名称；由调用方传入行标题对应的 id，保证与可见标题一致。 */
  labelledby: string;
}>();

const emit = defineEmits<{ (event: "update:modelValue", value: boolean): void }>();

/** reka 的 CheckedState 允许 "indeterminate"，这里只有开/关两态，非 true 一律按关处理。 */
function onChange(value: unknown): void {
  emit("update:modelValue", value === true);
}
</script>

<template>
  <SwitchRoot
    :model-value="modelValue"
    :aria-labelledby="labelledby"
    class="switch"
    @update:model-value="onChange"
  >
    <SwitchThumb class="switch-thumb" />
  </SwitchRoot>
</template>

<style scoped>
.switch {
  position: relative;
  display: inline-flex;
  align-items: center;
  flex: none;
  width: 34px;
  height: 20px;
  padding: 2px;
  border-radius: var(--r-full);
  border: 1px solid var(--border-strong);
  background: var(--bg-raised);
  transition:
    background-color var(--dur-fast) var(--ease),
    border-color var(--dur-fast) var(--ease);
}

.switch[data-state="checked"] {
  background: var(--accent);
  border-color: transparent;
}

.switch-thumb {
  display: block;
  width: 14px;
  height: 14px;
  border-radius: var(--r-full);
  background: var(--surface);
  box-shadow: 0 1px 2px rgb(0 0 0 / 24%);
  transform: translateX(0);
  transition: transform var(--dur-fast) var(--ease);
}

.switch-thumb[data-state="checked"] {
  transform: translateX(14px);
}

@media (prefers-reduced-motion: reduce) {
  .switch,
  .switch-thumb {
    transition: none;
  }
}
</style>
