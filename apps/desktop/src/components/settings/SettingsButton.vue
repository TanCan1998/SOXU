<script setup lang="ts">
/**
 * 设置页里的动作按钮（Issue #116）：检查更新、恢复默认布局、复制路径、清空会话。
 *
 * 统一成组件是为了让「次要动作」与「危险动作」只有一处样式：
 * danger 只改文字色，不铺红底——设置页里的危险操作需要一个确认，而不是视觉噪音。
 */

defineProps<{
  label: string;
  tone?: "default" | "danger";
  disabled?: boolean;
}>();

const emit = defineEmits<{ (event: "click"): void }>();
</script>

<template>
  <button
    type="button"
    class="action"
    :data-tone="tone ?? 'default'"
    :disabled="disabled"
    @click="emit('click')"
  >
    {{ label }}
  </button>
</template>

<style scoped>
.action {
  padding: 5px 13px;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--bg-raised);
  color: var(--fg-muted);
  font-size: 0.75rem;
  line-height: 1.5;
  transition:
    background-color var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}

.action:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--fg);
}

.action[data-tone="danger"] {
  color: var(--danger);
}

.action:disabled {
  opacity: 0.45;
  cursor: default;
}
</style>
