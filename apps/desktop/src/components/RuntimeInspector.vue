<script setup lang="ts">
import { computed } from "vue";
import { RefreshCw, X } from "@lucide/vue";
import AppTooltip from "./AppTooltip.vue";
import type { SessionTab } from "../workspace/types.ts";

const props = defineProps<{
  tab: SessionTab | null;
  projectCount: number;
  sessionCount: number;
  bridgeAvailable: boolean;
}>();

const emit = defineEmits<{
  (event: "close"): void;
  (event: "refresh-projects"): void;
  (event: "stop"): void;
}>();

const diagnostics = computed(() => [...(props.tab?.diagnostics ?? [])].reverse().slice(0, 8));
const retry = computed(() => props.tab?.runtime.retry ?? null);
const retryText = computed(() => {
  const status = retry.value;
  if (!status) return "未发生重试";
  return `${status.attempts} / ${status.maxAttempts}`;
});
const historyText = computed(() => {
  const history = props.tab?.history;
  if (!history) return "—";
  const released = history.evicted + history.evictedLive;
  const evicted = released > 0 ? `（已释放 ${released} 条）` : "";
  return `${history.loaded} / ${history.total}${evicted}${history.next === null ? "（已到底）" : "（可继续加载）"}`;
});
</script>

<template>
  <aside class="inspector" aria-label="会话状态">
    <div class="inspector-head">
      <div>
        <strong>会话状态</strong>
        <p>真实状态 · 无演示数据</p>
      </div>
      <AppTooltip text="关闭会话状态面板">
        <button class="icon-button" type="button" aria-label="关闭会话状态面板" @click="emit('close')">
          <X :size="18" :stroke-width="1.75" aria-hidden="true" />
        </button>
      </AppTooltip>
    </div>

    <div class="inspector-scroll visually-scroll">
      <p class="label">连接</p>
      <div class="card">
        <div class="row">
          <span class="row-title">
            <span class="state-dot" :data-state="bridgeAvailable ? 'ready' : 'error'" aria-hidden="true"></span>
            {{ bridgeAvailable ? "已连接" : "未连接" }}
          </span>
          <span class="badge">{{ bridgeAvailable ? "桌面端" : "浏览器预览" }}</span>
        </div>
        <p v-if="!bridgeAvailable" class="note">浏览器预览不会加载真实会话，也无法启动运行时。</p>
        <div class="row sub">
          <span>已扫描</span>
          <strong>{{ projectCount }} 个项目 · {{ sessionCount }} 个会话</strong>
        </div>
        <AppTooltip text="重新扫描所有登记项目的会话目录（只读）">
          <button
            class="link-button"
            type="button"
            :disabled="!bridgeAvailable"
            @click="emit('refresh-projects')"
          >
            <RefreshCw :size="14" :stroke-width="1.9" aria-hidden="true" /> 重新扫描全部项目
          </button>
        </AppTooltip>
      </div>

      <p class="label">当前会话</p>
      <div v-if="tab" class="card">
        <div class="row">
          <span class="row-title">{{ tab.title }}</span>
          <span class="badge" :data-tone="tab.status === 'error' ? 'danger' : undefined">{{ tab.status }}</span>
        </div>
        <p class="mono">{{ tab.sessionId }}</p>
        <div class="row sub">
          <span>运行时</span>
          <strong>{{ tab.runtime.runtimeId ?? "未启动" }}</strong>
        </div>
        <div class="row sub">
          <span>generation</span>
          <strong>{{ tab.runtime.generation }}</strong>
        </div>
        <div class="row sub">
          <span>历史条目</span>
          <strong>{{ historyText }}</strong>
        </div>
        <div v-if="tab.runtime.exitReason" class="row sub">
          <span>退出原因</span>
          <strong>{{ tab.runtime.exitReason }}</strong>
        </div>
        <AppTooltip text="只停止 Pi 运行时，会话文件与历史保持不变">
          <button class="link-button" type="button" :disabled="!tab.runtime.runtimeId" @click="emit('stop')">
            停止运行时（保留会话文件）
          </button>
        </AppTooltip>
      </div>
      <div v-else class="card"><p class="note">未打开会话。左侧选择会话后这里显示真实运行时状态。</p></div>

      <p class="label">重试预算</p>
      <div class="card">
        <div class="row sub">
          <span>已重试 / 上限</span>
          <strong>{{ retryText }}</strong>
        </div>
        <div v-if="retry" class="row sub">
          <span>状态</span>
          <strong>{{ retry.exhausted ? "已耗尽 · 需人工恢复" : "可继续" }}</strong>
        </div>
        <div v-if="retry?.lastFailure" class="row sub">
          <span>最近失败</span>
          <strong>{{ retry.lastFailure }}</strong>
        </div>
        <p v-if="retry" class="note">
          {{ retry.costNotice }}
        </p>
        <p v-else class="note">
          只有网络中断与超时会自动有界重试；429、鉴权失败和主动取消不会重试。
        </p>
      </div>

      <p class="label">诊断</p>
      <div class="card">
        <ul v-if="diagnostics.length" class="diagnostics">
          <li v-for="(line, index) in diagnostics" :key="index">{{ line }}</li>
        </ul>
        <p v-else class="note">暂无诊断事件。</p>
      </div>

      <p class="label">边界</p>
      <div class="card">
        <p class="note">
          会话正文以 Pi 的 JSONL 为准；SOXU 只读索引并分页展示。长工具输出按需展开，
          不会整段留在界面状态里。
        </p>
      </div>
    </div>

    <footer class="inspector-footer">未连接或未知的状态一律显示为未知，不伪造实时数据。</footer>
  </aside>
</template>

<style scoped>
.inspector {
  width: 300px;
  flex: none;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-left: 1px solid var(--soxu-border);
  background: var(--soxu-panel);
}

.inspector-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-bottom: 1px solid var(--soxu-border);
}

.inspector-head strong {
  font-size: 13px;
}

.inspector-head p {
  margin: 4px 0 0;
  font-size: 11px;
  color: var(--soxu-muted);
}

.inspector-scroll {
  flex: 1;
  min-height: 0;
  padding: 16px 14px;
}

.label {
  margin: 4px 2px 8px;
  font-size: 11px;
  font-weight: 600;
  color: var(--soxu-muted);
}

.card {
  border: 1px solid var(--soxu-border);
  border-radius: 12px;
  padding: 12px;
  margin-bottom: 18px;
  font-size: 11.5px;
}

.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.row-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row.sub {
  color: var(--soxu-subtext);
  padding: 4px 0;
}

.row.sub strong {
  color: var(--soxu-fg);
  font-weight: 600;
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.note {
  margin: 8px 0 6px;
  color: var(--soxu-subtext);
  line-height: 1.75;
}

.mono {
  margin: 6px 0;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 10.5px;
  color: var(--soxu-muted);
  overflow-wrap: anywhere;
}

/* 排版细节留在组件；颜色、下划线渐现与禁用态统一由 base.css 的 .link-button 提供。 */
.card .link-button {
  margin-top: 8px;
}

.diagnostics {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 180px;
  overflow: auto;
  color: var(--soxu-subtext);
}

.diagnostics li {
  overflow-wrap: anywhere;
  line-height: 1.6;
}

.inspector-footer {
  border-top: 1px solid var(--soxu-border);
  padding: 12px 16px;
  font-size: 10.5px;
  line-height: 1.6;
  color: var(--soxu-muted);
}
</style>
