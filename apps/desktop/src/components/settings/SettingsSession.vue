<script setup lang="ts">
/**
 * 设置 → 会话（Issue #116）。
 *
 * 四个开关 + 思考强度 + 忙碌时发送 + 清空会话。开关与选择只改偏好（由 App.vue
 * 持有的 useSessionSettings 落地与持久化），本组件不做任何 IO。
 *
 * 「清空当前会话」不清 JSONL：它只释放界面内存里的消息缓存（重新从会话文件载入），
 * 因此临时会话被排除——临时会话关闭即结束，不能拿它当「清缓存」。
 *
 * 行标题与说明不写在这里（Issue #123）：SettingsRow 按 setting id 从
 * settings/catalog.ts 取，命令面板读的是同一份元数据。
 */

import { ChevronDown } from "@lucide/vue";
import {
  SelectContent,
  SelectIcon,
  SelectItem,
  SelectItemText,
  SelectPortal,
  SelectRoot,
  SelectTrigger,
  SelectValue,
  SelectViewport,
} from "reka-ui";

import {
  BUSY_DELIVERY_OPTIONS,
  isBusySendDelivery,
  type BusySendDelivery,
} from "../../settings/busyDelivery.ts";
import {
  THINKING_LEVEL_OPTIONS,
  isThinkingLevel,
  type SessionSettings,
} from "../../settings/sessionSettings.ts";
import SettingsButton from "./SettingsButton.vue";
import SettingsChoice from "./SettingsChoice.vue";
import SettingsRow from "./SettingsRow.vue";
import SettingsSwitch from "./SettingsSwitch.vue";

defineProps<{
  settings: SessionSettings;
  busyDelivery: BusySendDelivery;
  /** null = 可以清空；否则是「为什么现在不能清」的原因。 */
  clearBlockedReason: string | null;
}>();

const emit = defineEmits<{
  (event: "update:settings", value: Partial<SessionSettings>): void;
  (event: "update:busyDelivery", value: BusySendDelivery): void;
  (event: "clear-session"): void;
}>();

function setFlag(key: keyof SessionSettings, value: boolean): void {
  emit("update:settings", { [key]: value });
}

function onThinking(value: unknown): void {
  if (isThinkingLevel(value)) emit("update:settings", { thinkingLevel: value });
}

function onBusyDelivery(value: string): void {
  if (isBusySendDelivery(value)) emit("update:busyDelivery", value);
}

/** SelectValue 在没有选中项时会显示 placeholder；这里始终有值，直接把标签渲染出来。 */
function thinkingLabel(value: string): string {
  return THINKING_LEVEL_OPTIONS.find((option) => option.value === value)?.label ?? value;
}
</script>

<template>
  <div class="panel">
    <SettingsRow setting="session.sendAfterScroll">
      <template #default="{ labelId }">
        <SettingsSwitch
          :model-value="settings.sendAfterScroll"
          :labelledby="labelId"
          @update:model-value="setFlag('sendAfterScroll', $event)"
        />
      </template>
    </SettingsRow>

    <SettingsRow setting="session.enterToSend">
      <template #default="{ labelId }">
        <SettingsSwitch
          :model-value="settings.enterToSend"
          :labelledby="labelId"
          @update:model-value="setFlag('enterToSend', $event)"
        />
      </template>
    </SettingsRow>

    <SettingsRow setting="session.showToolCalls">
      <template #default="{ labelId }">
        <SettingsSwitch
          :model-value="settings.showToolCalls"
          :labelledby="labelId"
          @update:model-value="setFlag('showToolCalls', $event)"
        />
      </template>
    </SettingsRow>

    <SettingsRow setting="session.showTimestamps">
      <template #default="{ labelId }">
        <SettingsSwitch
          :model-value="settings.showTimestamps"
          :labelledby="labelId"
          @update:model-value="setFlag('showTimestamps', $event)"
        />
      </template>
    </SettingsRow>

    <SettingsRow setting="session.thinkingLevel">
      <template #default="{ labelId }">
        <SelectRoot
          :model-value="settings.thinkingLevel"
          @update:model-value="onThinking"
        >
          <SelectTrigger class="select-trigger" :aria-labelledby="labelId">
            <SelectValue>{{ thinkingLabel(settings.thinkingLevel) }}</SelectValue>
            <SelectIcon class="select-icon">
              <ChevronDown :size="14" :stroke-width="2" aria-hidden="true" />
            </SelectIcon>
          </SelectTrigger>
          <SelectPortal>
            <SelectContent class="select-content" position="popper" :side-offset="6">
              <SelectViewport>
                <SelectItem
                  v-for="option in THINKING_LEVEL_OPTIONS"
                  :key="option.value"
                  :value="option.value"
                  class="select-item"
                >
                  <SelectItemText>
                    {{ option.label }} · {{ option.description }}
                  </SelectItemText>
                </SelectItem>
              </SelectViewport>
            </SelectContent>
          </SelectPortal>
        </SelectRoot>
      </template>
    </SettingsRow>

    <SettingsRow setting="session.busyDelivery">
      <template #default="{ labelId }">
        <SettingsChoice
          :model-value="busyDelivery"
          :options="BUSY_DELIVERY_OPTIONS"
          :labelledby="labelId"
          @update:model-value="onBusyDelivery"
        />
      </template>
      <template #note>
        「加入当前」插进正在进行的回答，「排到下轮」等本轮结束后自动发送。这两种投递方式即将支持，
        现在只保存偏好。
      </template>
    </SettingsRow>

    <SettingsRow setting="session.clearSession">
      <SettingsButton
        label="清空"
        tone="danger"
        :disabled="clearBlockedReason !== null"
        @click="emit('clear-session')"
      />
      <template #note>
        {{ clearBlockedReason ?? "只清界面缓存，Pi 的会话 JSONL 不会被删除或改写。" }}
      </template>
    </SettingsRow>
  </div>
</template>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
}

.select-trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 132px;
  padding: 5px 10px;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--bg-panel);
  color: var(--fg);
  font-size: 0.75rem;
  line-height: 1.5;
}

.select-trigger:hover {
  background: var(--bg-hover);
}

.select-icon {
  margin-left: auto;
  color: var(--fg-muted);
}

.select-content {
  z-index: 70;
  min-width: var(--reka-select-trigger-width, 180px);
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--bg-panel);
  box-shadow: var(--shadow-pop);
}

.select-item {
  padding: 6px 8px;
  border-radius: var(--r-sm);
  color: var(--fg);
  font-size: 0.75rem;
  cursor: pointer;
}

.select-item[data-highlighted] {
  background: var(--bg-hover);
  outline: none;
}

.select-item[data-state="checked"] {
  color: var(--accent);
}
</style>
