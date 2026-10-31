<script setup lang="ts">
/**
 * 设置 → 扩展（Issue #147：真数据接入）。
 *
 * 内容全部来自本机 Pi 的配置目录：扩展、技能与 MCP 服务各列一份，
 * 每条都带真实的来源与启停状态。**这里没有任何开关**：启停属于 Pi 的配置所有权，
 * 渲染一个点了也不会改变任何东西的开关，比不渲染更糟。
 *
 * 三态如实呈现：读取中 / 读取失败（带后端给出的具体原因与重试）/ 空列表。
 * 失败时绝不显示成空列表——用户会以为自己机器上什么都没装。
 *
 * 技能的文件数要遍历目录，因此按需展开：点一下才请求 read_extension_detail，
 * 展开结果按 id 缓存，收起再展开不会重复扫描。
 *
 * 页尾的「语言包」不同：它真的读写应用数据目录，所以单独一块。
 */

import { onMounted } from "vue";
import { ChevronRight } from "@lucide/vue";

import { useExtensionCatalog } from "../../composables/useExtensionCatalog.ts";
import { useLocale } from "../../locales/index.ts";
import SettingsButton from "./SettingsButton.vue";
import SettingsLocale from "./SettingsLocale.vue";

const { t, formatNumber } = useLocale();
const { status, catalog, error, refresh, isExpanded, detailOf, toggleDetail } =
  useExtensionCatalog();

onMounted(() => {
  void refresh();
});

/** 来源徽章：内置 / 用户安装。 */
function sourceLabel(source: "builtin" | "user"): string {
  return source === "builtin"
    ? t("settings.extensions.source.builtin")
    : t("settings.extensions.source.user");
}

/** 启停状态直接来自后端（Pi 的默认是加载，settings 里的排除项才会关掉）。 */
function stateLabel(enabled: boolean): string {
  return enabled ? t("settings.extensions.enabled") : t("settings.extensions.disabled");
}

/** 技能详情：文件数、统计是否触顶、失败原因。 */
function filesLabel(count: number, truncated: boolean): string {
  return truncated
    ? t("settings.extensions.detail.files.at.least", { count: formatNumber(count) })
    : t("settings.extensions.detail.files", { count: formatNumber(count) });
}

/** 已取到的详情才有内容：模板里不做非空断言，缺数据就渲染空串。 */
function detailFiles(id: string): string {
  const detail = detailOf(id)?.detail;
  return detail ? filesLabel(detail.fileCount, detail.fileCountTruncated) : "";
}

function detailPath(id: string): string {
  return detailOf(id)?.detail?.path ?? "";
}
</script>

<template>
  <div class="panel">
    <p class="intro" role="note">
      {{ t("settings.extensions.intro") }}
    </p>

    <p v-if="status === 'loading'" class="state" role="status">
      {{ t("settings.extensions.state.loading") }}
    </p>

    <div v-else-if="status === 'error'" class="failure" role="alert">
      <p class="failure-text">
        {{ t("settings.extensions.state.failed", { reason: error ?? "" }) }}
      </p>
      <SettingsButton :label="t('settings.extensions.state.retry')" @click="refresh" />
    </div>

    <template v-else-if="catalog">
      <!-- 三段清单包在一个容器里：走查脚本按 .catalog 作用域读取，不会串到页尾的语言包区。 -->
      <div class="catalog">
        <p class="source">{{ t("settings.extensions.dir", { path: catalog.agentDir }) }}</p>

        <p class="section-title">
          {{ t("settings.extensions.section.extensions", { count: catalog.extensions.length }) }}
        </p>
        <p v-if="catalog.extensions.length === 0" class="empty">
          {{ t("settings.extensions.empty.extensions") }}
        </p>
        <div v-for="item in catalog.extensions" :key="item.id" class="item">
          <div class="item-main">
            <p class="item-title">{{ item.name }}</p>
            <p v-if="item.description" class="item-desc">{{ item.description }}</p>
          </div>
          <span class="item-source">{{ sourceLabel(item.source) }}</span>
          <span class="item-state" :data-on="item.enabled ? 'on' : 'off'">
            {{ stateLabel(item.enabled) }}
          </span>
        </div>

        <p class="section-title">
          {{ t("settings.extensions.section.skills", { count: catalog.skills.length }) }}
        </p>
        <p v-if="catalog.skills.length === 0" class="empty">
          {{ t("settings.extensions.empty.skills") }}
        </p>
        <div v-for="(item, index) in catalog.skills" :key="item.id" class="item item-stacked">
          <div class="item-row">
            <div class="item-main">
              <p class="item-title">{{ item.name }}</p>
              <p v-if="item.description" class="item-desc">{{ item.description }}</p>
            </div>
            <span class="item-state" :data-on="item.enabled ? 'on' : 'off'">
              {{ stateLabel(item.enabled) }}
            </span>
            <button
              type="button"
              class="expand"
              :aria-expanded="isExpanded(item.id)"
              :aria-controls="'skill-detail-' + index"
              :aria-label="t('settings.extensions.detail.toggle') + ' ' + item.name"
              :data-open="isExpanded(item.id) ? 'yes' : 'no'"
              @click="toggleDetail(item.id)"
            >
              <ChevronRight :size="13" :stroke-width="1.75" aria-hidden="true" />
            </button>
          </div>
          <div v-if="isExpanded(item.id)" :id="'skill-detail-' + index" class="item-detail">
            <p v-if="detailOf(item.id)?.loading" role="status">
              {{ t("settings.extensions.detail.loading") }}
            </p>
            <p v-else-if="detailOf(item.id)?.error" role="alert">
              {{ t("settings.extensions.detail.failed", { reason: detailOf(item.id)?.error ?? "" }) }}
            </p>
            <template v-else-if="detailOf(item.id)?.detail">
              <p>{{ detailFiles(item.id) }}</p>
              <p class="item-path">{{ detailPath(item.id) }}</p>
            </template>
          </div>
        </div>

        <p class="section-title">
          {{ t("settings.extensions.section.mcp", { count: catalog.mcpServers.length }) }}
        </p>
        <p v-if="catalog.mcpServers.length === 0" class="empty">
          {{ t("settings.extensions.empty.mcp") }}
        </p>
        <div v-for="item in catalog.mcpServers" :key="item.id" class="item">
          <div class="item-main">
            <p class="item-title">{{ item.name }}</p>
            <p v-if="item.description" class="item-desc">{{ item.description }}</p>
          </div>
          <span v-if="item.transport" class="item-source">{{ item.transport }}</span>
          <!-- 连接状态只读拿不到：如实写「未知」，不伪造「已连接」。 -->
          <span class="item-state" data-on="unknown">
            {{ t("settings.extensions.mcp.status.unknown") }}
          </span>
        </div>

        <p class="note">{{ t("settings.extensions.note.readonly") }}</p>
      </div>
    </template>

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

.state,
.empty {
  margin: 6px 0;
  font-size: 0.6875rem;
  color: var(--fg-subtle);
}

.failure {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin: 6px 0;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--bg-raised);
}

.failure-text {
  flex: 1;
  margin: 0;
  font-size: 0.65625rem;
  line-height: 1.65;
  color: var(--danger);
  overflow-wrap: anywhere;
}

.source {
  margin: 6px 0 0;
  font-size: 0.65625rem;
  color: var(--fg-subtle);
  overflow-wrap: anywhere;
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

.item-stacked {
  display: block;
}

.item-row {
  display: flex;
  align-items: center;
  gap: 10px;
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
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  overflow: hidden;
}

.item-source {
  flex: none;
  padding: 1px 7px;
  border: 1px solid var(--border);
  border-radius: var(--r-full);
  color: var(--fg-muted);
  font-size: 0.65625rem;
  white-space: nowrap;
}

.item-state {
  flex: none;
  font-size: 0.65625rem;
  color: var(--fg-subtle);
  white-space: nowrap;
}

.item-state[data-on="on"] {
  color: var(--accent);
}

.item-state[data-on="off"] {
  color: var(--fg-muted);
}

.expand {
  flex: none;
  display: grid;
  place-items: center;
  padding: 2px;
  color: var(--fg-muted);
  border-radius: var(--r-sm);
}

.expand:hover {
  color: var(--fg);
}

.expand:focus-visible {
  outline: 2px solid var(--soxu-focus);
  outline-offset: 1px;
}

.expand[data-open="yes"] svg {
  transform: rotate(90deg);
}

.item-detail {
  margin: 4px 0 2px 2px;
  padding-left: 10px;
  border-left: 2px solid var(--border);
  font-size: 0.65625rem;
  line-height: 1.6;
  color: var(--fg-muted);
}

.item-detail p {
  margin: 0 0 2px;
}

.item-path {
  color: var(--fg-subtle);
  overflow-wrap: anywhere;
}

.note {
  margin: 12px 0 0;
  font-size: 0.65625rem;
  line-height: 1.65;
  color: var(--fg-subtle);
}

.divider {
  height: 1px;
  margin: 16px 0 4px;
  background: var(--border);
}
</style>
