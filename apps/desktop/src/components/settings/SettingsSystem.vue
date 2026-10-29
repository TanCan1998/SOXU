<script setup lang="ts">
/**
 * 设置 → 系统（Issue #116 · V4-S2）：7 项。
 *
 * 三个开关只做「UI + 持久化」：更新检查、系统通知、托盘策略都还没有对应的后端能力
 * （分别属于发布流程、Issue #117 通知切片与托盘策略切片），所以每一项都在注释位置
 * 写清楚当前的真实状态，不让用户以为开关已经生效。
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
    <SettingsRow label="自动更新" description="有新版时提示下载">
      <template #default="{ labelId }">
        <SettingsSwitch
          :model-value="settings.autoUpdate"
          :labelledby="labelId"
          @update:model-value="setFlag('autoUpdate', $event)"
        />
      </template>
      <template #note>
        更新通道尚未接入：本项只保存偏好，下面的「检查更新」会说明当前版本。
      </template>
    </SettingsRow>

    <SettingsRow label="任务完成通知" description="合并、失败时弹系统通知">
      <template #default="{ labelId }">
        <SettingsSwitch
          :model-value="settings.notifyOnComplete"
          :labelledby="labelId"
          @update:model-value="setFlag('notifyOnComplete', $event)"
        />
      </template>
      <template #note>
        通知呈现（Toast / 系统通知 / 声音）见 Issue #117；本项只保存开关状态。
      </template>
    </SettingsRow>

    <SettingsRow label="关闭时最小化到托盘" description="进程保留，托盘可恢复">
      <template #default="{ labelId }">
        <SettingsSwitch
          :model-value="settings.minimizeToTray"
          :labelledby="labelId"
          @update:model-value="setFlag('minimizeToTray', $event)"
        />
      </template>
      <template #note>
        当前版本关闭窗口总是最小化到托盘（Issue #90）；本开关随托盘策略切片接入后端。
      </template>
    </SettingsRow>

    <SettingsRow
      label="检查更新"
      :description="`当前 ${info?.appVersion ?? '未获取'}`"
    >
      <SettingsButton label="检查更新" disabled />
      <template #note>
        更新检查需要后端命令与发布通道，本切片只显示当前版本。
      </template>
    </SettingsRow>

    <SettingsRow label="恢复默认布局" description="侧栏 272px · 抽屉 320px">
      <SettingsButton label="重置" @click="emit('reset-layout')" />
      <template #note>
        两个面板的宽度目前是固定 token（无法拖拽改宽）：重置会把面板恢复为展开，
        并让会话正文回到「固定 768」。
      </template>
    </SettingsRow>

    <SettingsRow label="数据目录" :description="dataDirectory">
      <SettingsButton
        :label="copyLabel[copyState]"
        @click="emit('copy-data-dir')"
      />
      <template #note>
        打开文件夹需要后端命令（等 #112 的命令层拆分完成后接入）；现在可以复制路径自行打开，
        该目录可安全删除重建。
      </template>
    </SettingsRow>

    <SettingsRow
      label="关于"
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
