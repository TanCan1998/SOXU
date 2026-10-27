<script setup lang="ts">
import { nextTick, ref } from "vue";
import { Plus, X } from "@lucide/vue";
import type { SessionId, SessionTab } from "../workspace/types.ts";

const props = defineProps<{
  tabs: SessionTab[];
  activeSessionId: SessionId | null;
}>();

const emit = defineEmits<{
  (event: "select", sessionId: SessionId): void;
  (event: "close", sessionId: SessionId): void;
  (event: "new-temporary"): void;
}>();

const tabButtons = ref<(HTMLButtonElement | null)[]>([]);

/** 函数式 ref（v-for 里的字符串 ref 在 <script setup> 下行为不直观，这里显式收集）。 */
function setTabRef(element: unknown, index: number) {
  tabButtons.value[index] = element instanceof HTMLButtonElement ? element : null;
}

/** 会话 Tab 的键盘导航：方向键移动、Home/End 跳到首尾、Delete 关闭当前。 */
async function onKeydown(event: KeyboardEvent, index: number) {
  const last = props.tabs.length - 1;
  let next = -1;
  if (event.key === "ArrowRight") next = index === last ? 0 : index + 1;
  else if (event.key === "ArrowLeft") next = index === 0 ? last : index - 1;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = last;
  else if (event.key === "Delete") {
    const tab = props.tabs[index];
    if (tab) emit("close", tab.sessionId);
    return;
  }
  if (next < 0) return;
  event.preventDefault();
  const tab = props.tabs[next];
  if (!tab) return;
  emit("select", tab.sessionId);
  await nextTick();
  tabButtons.value[next]?.focus();
}
</script>

<template>
  <div class="tab-strip" role="tablist" aria-label="已打开的会话">
    <div class="tabs-scroll">
      <div v-for="(tab, index) in tabs" :key="tab.sessionId" class="tab-item">
        <button
          :id="`soxu-tab-${tab.sessionId}`"
          :ref="(element) => setTabRef(element, index)"
          class="tab"
          type="button"
          role="tab"
          :aria-selected="tab.sessionId === activeSessionId"
          :aria-controls="'soxu-chat-panel'"
          :tabindex="tab.sessionId === activeSessionId ? 0 : -1"
          :class="{ chosen: tab.sessionId === activeSessionId }"
          :title="tab.title"
          @click="emit('select', tab.sessionId)"
          @keydown="onKeydown($event, index)"
        >
          <span class="state-dot" :data-state="tab.status" aria-hidden="true"></span>
          <span class="tab-title">{{ tab.title }}</span>
          <span v-if="tab.mode === 'temporary'" class="tab-tag">临时</span>
        </button>
        <button
          class="tab-close"
          type="button"
          :aria-label="`关闭会话 ${tab.title}`"
          title="关闭 Tab（不停止 Agent）"
          @click="emit('close', tab.sessionId)"
        >
          <X :size="14" :stroke-width="2" aria-hidden="true" />
        </button>
      </div>
    </div>
    <button
      class="icon-button"
      type="button"
      aria-label="新建临时会话"
      title="新建临时会话"
      @click="emit('new-temporary')"
    >
      <Plus :size="18" :stroke-width="1.75" aria-hidden="true" />
    </button>
  </div>
</template>

<style scoped>
.tab-strip {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px 6px 18px;
  border-bottom: 1px solid var(--soxu-border);
  min-height: 46px;
}

.tabs-scroll {
  display: flex;
  align-items: center;
  gap: 6px;
  overflow-x: auto;
  scrollbar-width: none;
  padding: 2px;
  flex: 1;
  min-width: 0;
}

.tab-item {
  display: flex;
  align-items: center;
  border-radius: 9px;
  flex: none;
  max-width: 240px;
}

.tab-item:hover {
  background: var(--soxu-hover);
}

.tab {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 7px 4px 7px 10px;
  font-size: 12.5px;
  color: var(--soxu-subtext);
  max-width: 220px;
}

.tab.chosen {
  color: var(--soxu-fg);
  background: var(--soxu-selected);
  border-radius: 9px 0 0 9px;
}

.tab-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 168px;
}

.tab-tag {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--soxu-accent-soft);
  color: var(--soxu-accent);
}

.tab-close {
  display: grid;
  place-items: center;
  width: 26px;
  height: 30px;
  border-radius: 0 9px 9px 0;
  color: var(--soxu-muted);
}

.tab-close:hover {
  color: var(--soxu-fg);
}
</style>
