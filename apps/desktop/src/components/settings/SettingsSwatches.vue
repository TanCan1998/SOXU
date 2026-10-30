<script setup lang="ts">
/**
 * 强调色色板（Issue #116）：reka-ui RadioGroup + 圆形色块。
 *
 * 色块的 fill 用 `--swatch` 内联变量传入，色值只在 theme/appearance.ts 的
 * ACCENT_OPTIONS 里写一次；base.css 的 data-accent 分支与它同源（测试核对）。
 * 读屏读的是 aria-label（「索序蓝」「青绿」…），不依赖颜色本身传达信息。
 */

import { Check } from "@lucide/vue";
import { RadioGroupItem, RadioGroupRoot } from "reka-ui";
import type { AccentOption } from "../../theme/appearance.ts";

defineProps<{
  modelValue: string;
  options: readonly AccentOption[];
  /** 行标题的 id；与 SettingsChoice 同理，Issue #123 起必填、不再接受独立 label。 */
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
    class="swatches"
    orientation="horizontal"
    @update:model-value="onChange"
  >
    <RadioGroupItem
      v-for="option in options"
      :key="option.value"
      :value="option.value"
      :aria-label="option.label"
      class="swatch"
      :style="{ '--swatch': option.hex }"
    >
      <Check
        v-if="modelValue === option.value"
        :size="12"
        :stroke-width="3"
        aria-hidden="true"
      />
    </RadioGroupItem>
  </RadioGroupRoot>
</template>

<style scoped>
.swatches {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.swatch {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border-radius: var(--r-full);
  border: 1px solid var(--border-strong);
  background: var(--swatch);
  color: var(--soxu-on-accent);
  transition: transform var(--dur-fast) var(--ease);
}

.swatch:hover {
  transform: scale(1.08);
}

/* 选中态加一圈底色描边，避免与相邻色块混在一起（深色下尤其明显）。 */
.swatch[data-state="checked"] {
  box-shadow:
    0 0 0 2px var(--surface),
    0 0 0 3px var(--accent);
}

@media (prefers-reduced-motion: reduce) {
  .swatch {
    transition: none;
  }
}
</style>
