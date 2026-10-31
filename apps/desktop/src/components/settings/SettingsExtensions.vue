<script setup lang="ts">
/**
 * 设置 → 扩展。
 *
 * 上半部分是纯只读展示：扩展、技能与 MCP 服务各列一份「名字 + 一句用途」。
 * 这里刻意没有开关，也没有「已启用 / 未连接」徽章与数量统计——SOXU 还读不到
 * 本机真实的扩展状态，渲染一个点了也不会改变任何东西的开关，比不渲染更糟。
 * 页尾的「语言包」不同：它真的读写应用数据目录，所以单独一块。
 */

import {
  EXTENSION_ENTRIES,
  MCP_SERVICE_ENTRIES,
  SKILL_ENTRIES,
} from "../../settings/extensions.ts";
import SettingsLocale from "./SettingsLocale.vue";
</script>

<template>
  <div class="panel">
    <p class="intro" role="note">
      以下为 SOXU 内置的扩展、技能与 MCP 服务说明，仅供查阅；实际加载哪些由 Pi 的配置决定。
    </p>

    <p class="section-title">扩展 · {{ EXTENSION_ENTRIES.length }} 个</p>
    <div v-for="entry in EXTENSION_ENTRIES" :key="entry.name" class="item">
      <div class="item-main">
        <p class="item-title">{{ entry.name }}</p>
        <p class="item-desc">{{ entry.description }}</p>
      </div>
    </div>

    <p class="section-title">技能 · 按需加载</p>
    <div v-for="entry in SKILL_ENTRIES" :key="entry.name" class="item">
      <div class="item-main">
        <p class="item-title">{{ entry.name }}</p>
        <p class="item-desc">{{ entry.description }}</p>
      </div>
    </div>

    <p class="section-title">MCP 服务</p>
    <div v-for="entry in MCP_SERVICE_ENTRIES" :key="entry.name" class="item">
      <div class="item-main">
        <p class="item-title">{{ entry.name }}</p>
        <p class="item-desc">{{ entry.description }}</p>
      </div>
    </div>

    <div class="divider" role="separator" />
    <SettingsLocale />
  </div>
</template>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
}

.intro {
  margin: 0 0 6px;
  font-size: 0.65625rem;
  line-height: 1.7;
  color: var(--fg-muted);
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

.divider {
  height: 1px;
  margin: 16px 0 4px;
  background: var(--border);
}
</style>
