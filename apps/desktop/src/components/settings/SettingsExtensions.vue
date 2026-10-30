<script setup lang="ts">
/**
 * 设置 → 扩展（Issue #116 · V4-S2）。
 *
 * **本切片只做静态列表渲染 + 开关 UI**：真实数据来自后续切片的 `list_extensions`
 * 命令（TODO(V4-S7)），现在用 settings/extensions.ts 的常量占位。
 * 因此这里的开关只在本次打开期间有效，不写存储、不发 IPC——不给用户
 * 「已经改了真实扩展状态」的错觉，页面顶部的说明也如实写了这一点。
 */

import { ref } from "vue";

import {
  EXTENSION_ENTRIES,
  MCP_SERVICE_ENTRIES,
  SKILL_ENTRIES,
} from "../../settings/extensions.ts";
import SettingsLocale from "./SettingsLocale.vue";
import SettingsSwitch from "./SettingsSwitch.vue";

/** 占位开关状态：初始值来自常量表的 enabled 字段。 */
const enabled = ref<Record<string, boolean>>(
  Object.fromEntries(EXTENSION_ENTRIES.map((entry) => [entry.name, entry.enabled])),
);

function toggle(name: string, value: boolean): void {
  enabled.value = { ...enabled.value, [name]: value };
}
</script>

<template>
  <div class="panel">
    <p class="banner" role="note">
      以下列表是本切片的静态占位：真实扩展、技能与 MCP 服务由后续切片读取，
      开关状态不会写回本机配置。页尾的「语言包」除外——它真的读写本机语言包文件。
    </p>

    <p class="section-title">扩展 · {{ EXTENSION_ENTRIES.length }} 个</p>
    <div v-for="(entry, index) in EXTENSION_ENTRIES" :key="entry.name" class="item">
      <div class="item-main">
        <p :id="`soxu-ext-${index}`" class="item-title">{{ entry.name }}</p>
        <p class="item-desc">{{ entry.description }}</p>
      </div>
      <span class="item-tag" :data-tone="enabled[entry.name] ? 'on' : 'off'">
        {{ enabled[entry.name] ? "已启用" : "未启用" }}
      </span>
      <SettingsSwitch
        :model-value="enabled[entry.name] ?? false"
        :labelledby="`soxu-ext-${index}`"
        @update:model-value="toggle(entry.name, $event)"
      />
    </div>

    <p class="section-title">技能 · 按需加载</p>
    <div v-for="entry in SKILL_ENTRIES" :key="entry.name" class="item">
      <div class="item-main">
        <p class="item-title">{{ entry.name }}</p>
        <p class="item-desc">{{ entry.description }}</p>
      </div>
      <span class="item-tag">{{ entry.fileCount }} 个文件</span>
    </div>

    <p class="section-title">MCP 服务</p>
    <div v-for="entry in MCP_SERVICE_ENTRIES" :key="entry.name" class="item">
      <div class="item-main">
        <p class="item-title">{{ entry.name }}</p>
        <p class="item-desc">{{ entry.description }}</p>
      </div>
      <span class="item-tag">{{ entry.toolCount }} 个工具</span>
      <span class="item-tag" :data-tone="entry.connected ? 'on' : 'off'">
        {{ entry.connected ? "已连接" : "未连接" }}
      </span>
    </div>

    <!-- 语言包（Issue #135）：与上面的静态占位不同，这一块真的读写磁盘。 -->
    <div class="divider" role="separator" />
    <SettingsLocale />
  </div>
</template>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
}

.banner {
  margin: 0 0 12px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--bg-raised);
  color: var(--fg-muted);
  font-size: 0.65625rem;
  line-height: 1.7;
}

.section-title {
  margin: 14px 0 4px;
  font-size: 0.6875rem;
  font-weight: 600;
  color: var(--fg-muted);
}

.item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 0;
  border-bottom: 1px solid var(--border);
}

.item:last-child {
  border-bottom: 0;
}

.item-main {
  min-width: 0;
  flex: 1;
}

.item-title {
  margin: 0;
  font-size: 0.78125rem;
  color: var(--fg);
  overflow-wrap: anywhere;
}

.item-desc {
  margin: 2px 0 0;
  font-size: 0.6875rem;
  line-height: 1.55;
  color: var(--fg-muted);
}

.item-tag {
  flex: none;
  padding: 2px 8px;
  border-radius: var(--r-full);
  border: 1px solid var(--border);
  background: var(--bg-raised);
  color: var(--fg-muted);
  font-size: 0.65625rem;
  white-space: nowrap;
}

.item-tag[data-tone="on"] {
  border-color: transparent;
  background: var(--accent-soft);
  color: var(--accent);
}

.divider {
  height: 1px;
  margin: 16px 0 4px;
  background: var(--border);
}
</style>
