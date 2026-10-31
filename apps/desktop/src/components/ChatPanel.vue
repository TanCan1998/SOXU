<script setup lang="ts">
import { computed } from "vue";
import { CircleAlert, CircleStop, RefreshCw, Save } from "@lucide/vue";
import AppTooltip from "./AppTooltip.vue";
import ChatComposer from "./ChatComposer.vue";
import MessageList from "./MessageList.vue";
import { composeStatsView } from "./sessionStats.ts";
import { useLocale } from "../locales/index.ts";
import type { BusySendDelivery } from "../settings/busyDelivery.ts";
import type { SessionSettings } from "../settings/sessionSettings.ts";
import type { SendMode, SessionTab } from "../workspace/types.ts";

const props = defineProps<{
  tab: SessionTab;
  bridgeAvailable: boolean;
  busy: boolean;
  /** 设置里的「忙碌时发送」默认投递方式，透传给 composer。 */
  defaultDelivery: BusySendDelivery;
  /** 设置 → 会话：自动贴底、工具输出展开、时间戳、Enter 发送，透传给列表与输入区。 */
  settings: SessionSettings;
  /** 搜索抽屉（Issue #118）的跳转目标，原样透传给消息列表。 */
  focusMessageId?: string | null;
  focusNonce?: number;
}>();

const emit = defineEmits<{
  /** mode 为 null 表示按默认投递；运行时语义由后续切片实现。 */
  (event: "send", payload: { text: string; mode: SendMode | null }): void;
  (event: "cancel"): void;
  (event: "stop"): void;
  (event: "load-more"): void;
  (event: "retry"): void;
  (event: "promote"): void;
  (event: "refresh-stats"): void;
  (event: "update:draft", value: string): void;
}>();

/**
 * 统计视图：后端快照 + 本 Tab 的内存窗口（已载入条数）。
 *
 * 合成规则在 sessionStats.ts 里，组件不自己拼数字；这样浮窗与底部统计行
 * 拿到的是**同一个对象**，不可能出现两处显示不同值。
 */
const statsView = computed(() => composeStatsView(props.tab.stats.data, props.tab));

/** 会话区文案走 session.json（Issue #144）：t() 读的是响应式表，切语言即重渲染。 */
const { t } = useLocale();

const statusLabel = computed(() => {
  switch (props.tab.status) {
    case "loading":
      return t("session.panel.status.loading");
    case "ready":
      return t("session.panel.status.ready");
    case "running":
      return t("session.panel.status.running");
    case "cancelling":
      return t("session.panel.status.cancelling");
    case "error":
      return t("session.panel.status.error");
    default:
      return t("session.panel.status.disconnected");
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
    return t("session.panel.promote.hint.runtime");
  }
  if (props.tab.status === "running" || props.tab.status === "cancelling") {
    return t("session.panel.promote.hint.busy");
  }
  return t("session.panel.promote.hint.ready");
});
const runtimeHint = computed(() => {
  if (props.tab.runtime.runtimeId) {
    return t("session.panel.runtime.detail", {
      runtimeId: props.tab.runtime.runtimeId,
      generation: props.tab.runtime.generation,
      state: props.tab.runtime.state,
    });
  }
  return props.tab.status === "idle"
    ? t("session.panel.runtime.idle")
    : t("session.panel.runtime.none");
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
        <span v-if="tab.mode === 'temporary'" class="badge" data-tone="accent">
          {{ t("session.panel.temporary.badge") }}
        </span>
        <AppTooltip v-if="tab.mode === 'temporary'" :text="promoteHint">
          <button
            class="promote"
            type="button"
            :disabled="!canPromote"
            @click="emit('promote')"
          >
            <Save :size="15" :stroke-width="1.85" aria-hidden="true" />
            {{ tab.promoting ? t("session.panel.promote.pending") : t("session.panel.promote.action") }}
          </button>
        </AppTooltip>
        <AppTooltip :text="t('session.panel.stop')" auto>
          <button
            class="icon-button"
            type="button"
            :disabled="!tab.runtime.runtimeId"
            :aria-label="t('session.panel.stop')"
            @click="emit('stop')"
          >
            <CircleStop :size="17" :stroke-width="1.75" aria-hidden="true" />
          </button>
        </AppTooltip>
      </div>
    </header>

    <p v-if="tab.mode === 'temporary'" class="temp-note" role="note">
      {{ t("session.panel.temporary.note") }}
    </p>

    <div v-if="tab.error" class="error-banner" role="alert">
      <CircleAlert :size="16" :stroke-width="1.9" aria-hidden="true" />
      <span class="error-text">{{ tab.error }}</span>
      <button class="retry" type="button" @click="emit('retry')">
        <RefreshCw :size="14" :stroke-width="1.9" aria-hidden="true" />
        {{ t("session.panel.retry") }}
      </button>
    </div>

    <div v-if="showEmpty" class="empty-chat">
      <img class="hero-mark" src="../assets/soxu-256.png" alt="" width="44" height="44" />
      <h2>{{ t("session.panel.empty.title") }}</h2>
      <p v-if="bridgeAvailable">{{ t("session.panel.empty.hint") }}</p>
      <p v-else>{{ t("session.panel.empty.bridge") }}</p>
    </div>
    <MessageList
      v-else
      :messages="tab.messages"
      :history="tab.history"
      :loading="tab.history.loading"
      :settings="settings"
      :focus-message-id="focusMessageId ?? null"
      :focus-nonce="focusNonce ?? 0"
      @load-more="emit('load-more')"
    />

    <ChatComposer
      :session-id="tab.sessionId"
      :draft="tab.draft"
      :status="tab.status"
      :disabled="!bridgeAvailable"
      :busy="busy"
      :default-delivery="defaultDelivery"
      :enter-to-send="settings.enterToSend"
      :has-project="Boolean(tab.projectId)"
      :stats-view="statsView"
      :stats-loading="tab.stats.loading"
      :stats-error="tab.stats.error"
      @refresh-stats="emit('refresh-stats')"
      @update:draft="emit('update:draft', $event)"
      @send="(mode: SendMode | null) => emit('send', { text: tab.draft, mode })"
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
  font-size: 1rem;
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
  font-size: 0.71875rem;
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
  font-size: 0.71875rem;
  font-weight: 560;
  transition:
    background-color var(--soxu-motion-fast) var(--soxu-motion-ease),
    border-color var(--soxu-motion-fast) var(--soxu-motion-ease);
}

.promote:hover:not(:disabled) {
  background: var(--soxu-hover);
  border-color: var(--soxu-muted);
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
  font-size: 0.71875rem;
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
  font-size: 0.75rem;
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
  font-size: 0.75rem;
  border: 1px solid color-mix(in srgb, var(--soxu-danger) 40%, transparent);
  border-radius: 999px;
  padding: 4px 10px;
  transition: background-color var(--soxu-motion-fast) var(--soxu-motion-ease);
}

.retry:hover {
  background: color-mix(in srgb, var(--soxu-danger) 14%, transparent);
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
  font-size: 1.1875rem;
  font-weight: 600;
  letter-spacing: -0.3px;
}

.empty-chat p {
  margin: 0;
  max-width: 460px;
  font-size: 0.78125rem;
  line-height: 1.9;
  color: var(--soxu-subtext);
}
</style>
