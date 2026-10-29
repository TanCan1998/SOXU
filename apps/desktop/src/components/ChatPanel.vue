<script setup lang="ts">
import { computed } from "vue";
import { CircleAlert, CircleStop, RefreshCw, Save } from "@lucide/vue";
import ChatComposer from "./ChatComposer.vue";
import MessageList from "./MessageList.vue";
import type { SessionTab } from "../workspace/types.ts";

const props = defineProps<{
  tab: SessionTab;
  bridgeAvailable: boolean;
  busy: boolean;
}>();

const emit = defineEmits<{
  (event: "send", text: string): void;
  (event: "cancel"): void;
  (event: "stop"): void;
  (event: "load-more"): void;
  (event: "retry"): void;
  (event: "promote"): void;
  (event: "update:draft", value: string): void;
}>();

const statusLabel = computed(() => {
  switch (props.tab.status) {
    case "loading":
      return "加载历史";
    case "ready":
      return "就绪";
    case "running":
      return "运行中";
    case "cancelling":
      return "取消中";
    case "error":
      return "错误";
    default:
      return "未连接";
  }
});

const showEmpty = computed(() => props.tab.messages.length === 0 && props.tab.status !== "loading");
/**
 * 转正的两个前提：没有正在进行的轮次，且**没有活运行时**。
 *
 * 只按 status 拦截是不够的：idle 但 runtimeId 仍在的临时会话，其 Pi 进程仍持有会话文件，
 * 转正后它会失去 owner（停止变成 no-op 假成功），再次启动就会双写同一 JSONL。
 */
const canPromote = computed(
  () =>
    props.tab.mode === "temporary" &&
    !props.tab.promoting &&
    !props.tab.runtime.runtimeId &&
    props.tab.status !== "running" &&
    props.tab.status !== "cancelling" &&
    props.tab.status !== "loading",
);
/** 按钮提示：告诉用户「为什么现在不能转正」，而不是只把按钮置灰。 */
const promoteHint = computed(() => {
  if (props.tab.runtime.runtimeId) {
    return "先停止 Pi 运行时再转为普通会话：运行中的进程仍持有会话文件";
  }
  if (props.tab.status === "running" || props.tab.status === "cancelling") {
    return "当前轮次还没结束，结束后才能转正";
  }
  return "把临时会话写入持久化历史";
});
const runtimeHint = computed(() => {
  if (props.tab.runtime.runtimeId) {
    return `${props.tab.runtime.runtimeId} · generation ${props.tab.runtime.generation} · ${props.tab.runtime.state}`;
  }
  return props.tab.status === "idle" ? "尚未启动 Pi 运行时，发送消息时自动启动" : "无活动运行时";
});
</script>

<template>
  <section id="soxu-chat-panel" class="chat-panel" role="tabpanel" :aria-label="tab.title">
    <header class="chat-head">
      <div class="title-block">
        <h1 class="chat-title">{{ tab.title }}</h1>
        <p class="chat-sub">
          <span class="state-dot" :data-state="tab.status" aria-hidden="true"></span>
          <span>{{ statusLabel }}</span>
          <span class="dot-sep" aria-hidden="true">·</span>
          <span class="runtime-hint">{{ runtimeHint }}</span>
        </p>
      </div>
      <div class="head-actions">
        <span v-if="tab.mode === 'temporary'" class="badge" data-tone="accent">临时会话</span>
        <button
          v-if="tab.mode === 'temporary'"
          class="promote"
          type="button"
          :disabled="!canPromote"
          :title="promoteHint"
          @click="emit('promote')"
        >
          <Save :size="15" :stroke-width="1.85" aria-hidden="true" />
          {{ tab.promoting ? "转存中…" : "转为普通会话" }}
        </button>
        <button
          class="icon-button"
          type="button"
          :disabled="!tab.runtime.runtimeId"
          title="停止 Pi 运行时"
          aria-label="停止 Pi 运行时"
          @click="emit('stop')"
        >
          <CircleStop :size="17" :stroke-width="1.75" aria-hidden="true" />
        </button>
      </div>
    </header>

    <p v-if="tab.mode === 'temporary'" class="temp-note" role="note">
      临时会话默认不写入 SOXU 的会话历史，也不会出现在侧栏；Pi 仍按自己的规则管理会话文件。
      只有显式点击「转为普通会话」才会登记进历史，失败时保留临时会话并显示原因。
    </p>

    <div v-if="tab.error" class="error-banner" role="alert">
      <CircleAlert :size="16" :stroke-width="1.9" aria-hidden="true" />
      <span class="error-text">{{ tab.error }}</span>
      <button class="retry" type="button" @click="emit('retry')">
        <RefreshCw :size="14" :stroke-width="1.9" aria-hidden="true" /> 重新加载
      </button>
    </div>

    <div v-if="showEmpty" class="empty-chat">
      <img class="hero-mark" src="../assets/soxu-256.png" alt="" width="44" height="44" />
      <h2>这个会话还没有消息</h2>
      <p v-if="bridgeAvailable">
        发送第一条消息后，Pi 负责写入会话 JSONL，SOXU 只做只读索引与展示。
      </p>
      <p v-else>当前是浏览器预览，未连接 Rust 运行时，无法读取或发送真实会话内容。</p>
    </div>
    <MessageList
      v-else
      :messages="tab.messages"
      :history="tab.history"
      :loading="tab.history.loading"
      @load-more="emit('load-more')"
    />

    <ChatComposer
      :draft="tab.draft"
      :status="tab.status"
      :disabled="!bridgeAvailable"
      :busy="busy"
      @update:draft="emit('update:draft', $event)"
      @send="emit('send', tab.draft)"
      @cancel="emit('cancel')"
    />
  </section>
</template>

<style scoped>
.chat-panel {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  background: var(--soxu-bg);
}

.chat-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 16px 26px 10px;
}

.chat-title {
  margin: 0;
  font-size: 16px;
  font-weight: 640;
  letter-spacing: -0.2px;
  max-width: 560px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chat-sub {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 6px 0 0;
  font-size: 11.5px;
  color: var(--soxu-muted);
}

.dot-sep {
  opacity: 0.6;
}

.runtime-hint {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 420px;
}

.head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.promote {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 11px;
  border-radius: 999px;
  border: 1px solid var(--soxu-border);
  background: var(--soxu-panel);
  color: var(--soxu-fg);
  font-size: 11.5px;
  font-weight: 560;
}

.promote:disabled {
  opacity: 0.55;
}

.temp-note {
  margin: 0 26px 8px;
  padding: 8px 12px;
  border-radius: 10px;
  background: var(--soxu-soft);
  color: var(--soxu-subtext);
  font-size: 11.5px;
  line-height: 1.6;
}

.error-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 26px 10px;
  padding: 10px 14px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--soxu-danger) 12%, transparent);
  color: var(--soxu-danger);
  font-size: 12px;
}

.error-text {
  flex: 1;
  overflow-wrap: anywhere;
}

.retry {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--soxu-danger);
  font-size: 12px;
  border: 1px solid color-mix(in srgb, var(--soxu-danger) 40%, transparent);
  border-radius: 999px;
  padding: 4px 10px;
}

.empty-chat {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 24px;
  gap: 10px;
}

.hero-mark {
  width: 44px;
  height: 44px;
  border-radius: 12px;
  object-fit: contain;
  box-shadow: 0 6px 18px rgb(0 0 0 / 8%);
}

.empty-chat h2 {
  margin: 6px 0 0;
  font-size: 19px;
  font-weight: 600;
  letter-spacing: -0.3px;
}

.empty-chat p {
  margin: 0;
  max-width: 460px;
  font-size: 12.5px;
  line-height: 1.9;
  color: var(--soxu-subtext);
}
</style>
