<script setup lang="ts">
// 复制到 apps/desktop/src/components/common/ 时可直接使用。
// 现有 @lucide/vue，替换 UiIcon.vue 的手绘齿轮，不需另装图标包。
import { Settings } from '@lucide/vue';
defineEmits<{ open: [] }>();
</script>
<template>
  <button class="rail-settings" type="button" aria-label="设置" title="设置" @click="$emit('open')">
    <Settings :size="20" :stroke-width="1.75" aria-hidden="true" />
  </button>
</template>
<style scoped>
.rail-settings { width:42px;height:42px;padding:0;display:grid;place-items:center;border:0;border-radius:11px;background:transparent;color:var(--soxu-fg);cursor:pointer }
.rail-settings > svg { display:block;flex:none;transform:none }
.rail-settings:hover { background:var(--soxu-selected) }
.rail-settings:focus-visible { outline:2px solid #3a83f7;outline-offset:2px }
</style>
