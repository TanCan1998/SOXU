<script setup lang="ts">
import { Clock3, Plus } from '@lucide/vue';
// 快捷入口显式区分两种 Session 类型；落盘行为由上层 Store/IPC 决定。
const emit = defineEmits<{ create: [mode: 'persistent' | 'temporary'] }>();
</script>
<template>
  <div class="session-actions">
    <button class="primary" type="button" @click="emit('create', 'persistent')">
      <Plus :size="17" :stroke-width="1.75" /> 新建会话
    </button>
    <button class="secondary" type="button" title="不加入持久会话历史" @click="emit('create', 'temporary')">
      <Clock3 :size="17" :stroke-width="1.75" /> 临时会话
    </button>
  </div>
</template>
<style scoped>
.session-actions { display:grid;grid-template-columns:1fr 1fr;gap:8px }
button { display:flex;align-items:center;justify-content:center;gap:6px;white-space:nowrap;border-radius:9px;min-height:36px;padding:0 8px;font-size:12px;cursor:pointer }
.primary { background:#3a83f7;color:white;border:1px solid #3a83f7 }
.secondary { background:var(--soxu-bg);color:var(--soxu-fg);border:1px solid var(--soxu-border) }
button:focus-visible { outline:2px solid #3a83f7;outline-offset:2px }
</style>
