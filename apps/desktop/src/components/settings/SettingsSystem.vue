<script setup lang="ts">
/**
 * 设置 → 系统（Issue #116）：7 项。
 *
 * 三个开关只做「界面 + 持久化」：自动更新、完成通知与托盘行为都还没有对应的后端能力，
 * 所以每一项的说明都写清楚此刻的真实状态，不让用户以为开关已经生效。
 * 开关本身会落盘（下次打开保持），这一点在说明里也写明，不夸大也不含糊。
 *
 * 行标题与说明不写在这里（Issue #123）：SettingsRow 按 setting id 从
 * settings/catalog.ts 取，命令面板读的是同一份元数据。
 *
 * 两个动作按钮同样如实：
 * - 检查更新：只显示当前版本，更新通道未接入（需要后端命令）；
 * - 数据目录：复制真实路径（%APPDATA%\<应用标识符>），打开文件夹需要后端命令。
 */

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
}>();

const emit = defineEmits<{
  (event: "update:settings", value: Partial<SystemSettings>): void;
  (event: "reset-layout"): void;
  (event: "copy-data-dir"): void;
}>();

function setFlag(key: keyof SystemSettings, value: boolean): void {
  emit("update:settings", { [key]: value });
}

const copyLabel = { idle: "复制路径", copied: "已复制", failed: "复制失败" } as const;
</script>

<template>
  <div class="panel">
    <SettingsRow setting="system.autoUpdate">
      <template #default="{ labelId }">
        <SettingsSwitch
          :model-value="settings.autoUpdate"
          :labelledby="labelId"
          @update:model-value="setFlag('autoUpdate', $event)"
        />
      </template>
      <template #note>
        本项只保存偏好：当前版本不会自动下载更新。
      </template>
    </SettingsRow>

    <SettingsRow setting="system.notifyOnComplete">
      <template #default="{ labelId }">
        <SettingsSwitch
          :model-value="settings.notifyOnComplete"
          :labelledby="labelId"
          @update:model-value="setFlag('notifyOnComplete', $event)"
        />
      </template>
      <template #note>
        本项只保存开关状态；提醒的呈现方式（浮层 / 系统通知 / 声音）还没有单独的设置项。
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
        当前版本关闭窗口总是最小化到托盘；本开关只保存偏好，暂不改变该行为。
      </template>
    </SettingsRow>

    <SettingsRow
      setting="system.updateCheck"
      :description="`当前 ${info?.appVersion ?? '未获取'}`"
    >
      <SettingsButton label="检查更新" disabled />
      <template #note>
        当前版本只显示已安装的版本号，还不能在线检查更新。
      </template>
    </SettingsRow>

    <SettingsRow setting="system.resetLayout">
      <SettingsButton label="重置" @click="emit('reset-layout')" />
      <template #note>
        两个面板的宽度目前是固定 token（无法拖拽改宽）：重置会把面板恢复为展开，
        并让会话正文回到「固定 768」。
      </template>
    </SettingsRow>

    <SettingsRow setting="system.dataDirectory" :description="dataDirectory">
      <SettingsButton
        :label="copyLabel[copyState]"
        @click="emit('copy-data-dir')"
      />
      <template #note>
        可以复制路径后在文件管理器中打开。该目录由应用自行维护，删除会连同已导入的社区语言包
        一起丢失。
      </template>
    </SettingsRow>

    <SettingsRow
      setting="system.about"
      :description="
        info
          ? `${info.appName} ${info.appVersion} · Tauri ${tauriVersion ?? '未知'} · Pi RPC`
          : '版本信息未获取'
      "
    >
      <template #default>
        <span class="badge" :data-tone="bridgeAvailable ? undefined : 'danger'">
          {{ bridgeAvailable ? "已连接" : "未连接" }}
        </span>
      </template>
      <template #note>
        连接状态：{{ bridgeAvailable ? "已连接本机运行时" : "未连接（浏览器预览）" }} ·
        平台：{{ info?.platform ?? "未知" }} ·
        会话文件由 Pi 管理，SOXU 只读索引。
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
