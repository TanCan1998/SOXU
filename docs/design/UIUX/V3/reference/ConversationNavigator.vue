<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Search, ChevronUp, ChevronDown } from '@lucide/vue';
interface MessageIndex { id: string; role: 'user' | 'assistant'; excerpt: string }
const props = defineProps<{ messages: readonly MessageIndex[] }>();
const emit = defineEmits<{ jump: [messageId: string]; searchHistory: [query: string] }>();
const query = ref('');
const active = ref(0);
const matches = computed(() => props.messages.filter(m => m.excerpt.toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase())));
watch(query, () => { active.value = 0; });
function jump(delta: number) {
  if (!matches.value.length) return;
  active.value = (active.value + delta + matches.value.length) % matches.value.length;
  emit('jump', matches.value[active.value]!.id);
}
</script>
<template>
  <aside class="conversation-navigator" aria-label="对话导航">
    <strong>对话导航</strong>
    <label class="search-field"><Search :size="16" /><input v-model="query" type="search" aria-label="搜索本次对话" placeholder="搜索本次对话" /></label>
    <div class="meta"><span>{{ matches.length }} 条已加载消息</span><span><button aria-label="上一条" @click="jump(-1)"><ChevronUp :size="17" /></button><button aria-label="下一条" @click="jump(1)"><ChevronDown :size="17" /></button></span></div>
    <div class="items"><button v-for="(msg,i) in matches" :key="msg.id" class="item" :class="{ active: i===active }" @click="active=i;emit('jump',msg.id)"><small>{{ msg.role==='user'?'你':'Agent' }}</small><span>{{ msg.excerpt }}</span></button></div>
    <button v-if="query" class="history" @click="emit('searchHistory',query)">搜索完整历史（后端分页）</button>
  </aside>
</template>
<style scoped>
.conversation-navigator{display:flex;flex-direction:column;gap:12px;width:210px;padding:14px 10px;background:var(--soxu-bg);color:var(--soxu-fg);border-left:1px solid var(--soxu-border)}
.search-field{display:flex;align-items:center;gap:7px;padding:6px;border:1px solid var(--soxu-border);border-radius:8px}
.search-field input{width:100%;min-width:0;border:0;outline:none;background:transparent;color:inherit}
.meta{display:flex;align-items:center;justify-content:space-between;color:gray;font-size:11px}
.meta span:last-child{display:flex}.meta button,.item,.history{background:transparent;border:0;color:inherit;cursor:pointer}
.items{display:grid;gap:4px;overflow:auto;min-height:0}.item{padding:10px;text-align:left;border-radius:8px;display:grid;gap:5px}.item small{color:gray}.item span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.item.active{background:color-mix(in srgb,#3a83f7 12%,transparent)}
.history{font-size:11px;text-align:left;color:#3a83f7}
</style>
