<script setup lang="ts">
/**
 * 设置 → 系统（Issue #116；Issue #145 起真接线）。
 *
 * 五项：
 * - 任务完成通知：并入通知系统的事件开关链（notifications/settings.ts 的模型），
 *   关闭后完成/出错不再提醒，等待输入仍然提醒；
 * - 关闭时最小化到托盘：偏好经 Tauri 命令传给 Rust（tray::ClosePreference），
 *   关闭为 false 时点 × 直接退出进程；
 * - 恢复默认布局、数据目录（复制路径 + 用系统文件管理器打开）、关于。
 *
 * 更新通道落地前**不出现**「自动更新」「检查更新」入口（Issue #145）：
 * 一个点了没反应的开关只会误导用户，所以整行移除而不是禁用。
 *
 * 行标题与说明来自 settings/catalog.ts（Issue #123），文案在语言包里（Issue #145）；
 * 本组件只写 key 与真实状态，不编造未接入的能力。
 */

import { computed } from "vue";

import { useLocale } from "../../locales/index.ts";
import type { RuntimeInfo } from "../../services/native.ts";
import type { SystemSettings } from "../../settings/systemSettings.ts";
import SettingsButton from "./SettingsButton.vue";
import SettingsRow from "./SettingsRow.vue";
import SettingsSwitch from "./SettingsSwitch.vue";

const props = defineProps<{
  settings: SystemSettings;
  info: RuntimeInfo | null;
  bridgeAvailable: boolean;
  /** Tauri 框架版本（core:app 的 getTauriVersion）；浏览器预览下为 null。 */
  tauriVersion: string | null;
  /** 应用数据目录的真实路径（Tauri app_data_dir）。 */
  dataDirectory: string;
  /** 复制路径的结果，用于按钮文案回显。 */
  copyState: "idle" | "copied" | "failed";
  /** 「打开数据目录」的结果；failed 时按钮文案如实说明失败。 */
  openState: "idle" | "opened" | "failed";
}>();

const emit = defineEmits<{
  (event: "update:settings", value: Partial<SystemSettings>): void;
  (event: "reset-layout"): void;
  (event: "copy-data-dir"): void;
  (event: "open-data-dir"): void;
}>();

const { t } = useLocale();

function setFlag(key: keyof SystemSettings, value: boolean): void {
  emit("update:settings", { [key]: value });
}

const copyLabel = computed(() =>
  props.copyState === "copied"
    ? t("settings.system.action.copied")
    : props.copyState === "failed"
      ? t("settings.system.action.copy.failed")
      : t("settings.system.action.copy"),
);

const openLabel = computed(() =>
  props.openState === "opened"
    ? t("settings.system.action.opened")
    : props.openState === "failed"
      ? t("settings.system.action.open.failed")
      : t("settings.system.action.open.data.dir"),
);

/** 关于行的描述：版本 + Tauri 版本 + 协议，缺一项就如实写未知。 */
const aboutDescription = computed(() => {
  const info = props.info;
  if (!info) return t("settings.system.description.about.unknown");
  return t("settings.system.description.about", {
    app: info.appName,
    version: info.appVersion,
    tauri: props.tauriVersion ?? t("settings.system.value.unknown"),
  });
});

const connectionLabel = computed(() =>
  props.bridgeAvailable ? t("common.status.connected") : t("common.status.disconnected"),
);

const aboutNote = computed(() =>
  t("settings.system.note.about", {
    status: props.bridgeAvailable
      ? t("common.status.connected.hint")
      : t("common.status.disconnected.hint"),
    platform: props.info?.platform ?? t("settings.system.value.unknown"),
  }),
);
</script>

<template>
  <div class="panel">
    <SettingsRow setting="system.notifyOnComplete">
      <template #default="{ labelId }">
        <SettingsSwitch
          :model-value="settings.notifyOnComplete"
          :labelledby="labelId"
          @update:model-value="setFlag('notifyOnComplete', $event)"
        />
      </template>
      <template #note>
        {{ t("settings.system.note.notify.on.complete") }}
      </template>
    </SettingsRow>

    <SettingsRow setting="system.minimizeToTray">
      <template #default="{ labelId }">
        <SettingsSwitch
          :model-value="settings.minimizeToTray"
          :labelledby="labelId"
          @update:model-value="setFlag('minimizeToTray', $event)"
        />
      </template>
      <template #note>
        {{ t("settings.system.note.minimize.to.tray") }}
      </template>
    </SettingsRow>

    <SettingsRow setting="system.resetLayout">
      <SettingsButton :label="t('settings.system.action.reset')" @click="emit('reset-layout')" />
      <template #note>
        {{ t("settings.system.note.reset.layout") }}
      </template>
    </SettingsRow>

    <SettingsRow setting="system.dataDirectory" :description="dataDirectory">
      <SettingsButton :label="copyLabel" @click="emit('copy-data-dir')" />
      <SettingsButton :label="openLabel" @click="emit('open-data-dir')" />
      <template #note>
        {{ t("settings.system.note.data.directory") }}
      </template>
    </SettingsRow>

    <SettingsRow setting="system.about" :description="aboutDescription">
      <template #default>
        <span class="badge" :data-tone="bridgeAvailable ? undefined : 'danger'">
          {{ connectionLabel }}
        </span>
      </template>
      <template #note>
        {{ aboutNote }}
      </template>
    </SettingsRow>
  </div>
</template>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
}
</style>
