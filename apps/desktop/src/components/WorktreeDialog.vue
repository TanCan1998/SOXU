<script setup lang="ts">
/**
 * 工作树面板：只做呈现与本地表单状态，所有 Git 事实与危险操作都由
 * `WorktreeCatalog` 处理（通过 App 转发 emit）。删除必须两段确认：
 * 「准备删除」只请求只读计划，「确认删除」才携带令牌调用后端。
 */
import { computed, nextTick, ref, watch } from "vue";
import { GitBranch, RefreshCw, Trash2, X } from "@lucide/vue";
import { worktreeBadges, blockerLabel } from "../workspace/worktreeWorkspace.ts";
import type {
  CreateWorktreeInput,
  SessionSummary,
  WorktreeId,
  WorktreeState,
} from "../workspace/types.ts";

const props = defineProps<{
  open: boolean;
  projectId: string | null;
  projectName: string;
  bridgeAvailable: boolean;
  view: WorktreeState;
  /** 当前项目的会话摘要：用于展示「工作树 ↔ 会话」关联。 */
  sessions: SessionSummary[];
}>();

const emit = defineEmits<{
  (event: "close"): void;
  (event: "refresh"): void;
  (event: "select", worktreeId: WorktreeId): void;
  (event: "create", input: CreateWorktreeInput): void;
  (event: "diff", worktreeId: WorktreeId, staged: boolean): void;
  (event: "plan-removal", worktreeId: WorktreeId): void;
  (event: "confirm-removal"): void;
  (event: "cancel-removal"): void;
  (event: "prune"): void;
  (event: "open-session", payload: {
    sessionId: string;
    projectId: string;
    title: string;
    worktreeId: WorktreeId;
  }): void;
}>();

const dialog = ref<HTMLElement | null>(null);
const branch = ref("");
const newBranch = ref(true);
const base = ref("");
const path = ref("");

const selected = computed(
  () => props.view.worktrees.find((item) => item.id === props.view.selectedId) ?? null,
);
/** 会话归属由会话目录提供；这里只做筛选，不推断。 */
const selectedSessions = computed(() =>
  selected.value
    ? props.sessions.filter((session) => session.worktreeId === selected.value?.id)
    : [],
);

watch(
  () => props.open,
  async (open) => {
    if (!open) return;
    branch.value = "";
    base.value = "";
    path.value = "";
    newBranch.value = true;
    await nextTick();
    dialog.value?.focus();
  },
);

watch(
  () => (props.open ? props.projectId : null),
  (projectId) => {
    if (projectId) emit("refresh");
  },
);

function submitCreate() {
  const value = branch.value.trim();
  if (!value) return;
  emit("create", {
    branch: value,
    newBranch: newBranch.value,
    base: newBranch.value ? base.value.trim() || null : null,
    path: path.value.trim() || null,
  });
}

function onKeydown(event: KeyboardEvent) {
  if (event.key !== "Escape") return;
  event.stopPropagation();
  emit("close");
}
</script>

<template>
  <div v-if="open" class="overlay" @click.self="emit('close')">
    <div
      ref="dialog"
      class="dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="soxu-worktree-title"
      tabindex="-1"
      @keydown="onKeydown"
    >
      <header class="dialog-head">
        <div class="titles">
          <h2 id="soxu-worktree-title">工作树</h2>
          <p class="subtitle">
            {{ projectName }}<template v-if="view.root"> · {{ view.root }}</template>
          </p>
        </div>
        <button class="icon-button" type="button" aria-label="关闭工作树面板" @click="emit('close')">
          <X :size="18" :stroke-width="1.75" aria-hidden="true" />
        </button>
      </header>

      <p v-if="!bridgeAvailable" class="notice" role="status">
        未连接 Rust 运行时：浏览器预览不读取 Git 工作树，也不会执行任何 Git 操作。
      </p>

      <div v-else class="body">
        <section class="list" aria-label="工作树列表">
          <div class="list-head">
            <span class="count">{{ view.worktrees.length }} 个工作树</span>
            <button
              class="icon-button small"
              type="button"
              :disabled="view.loading"
              aria-label="刷新工作树列表"
              title="重新枚举（只读）"
              @click="emit('refresh')"
            >
              <RefreshCw :size="14" :stroke-width="1.75" aria-hidden="true" />
            </button>
          </div>

          <ul class="worktree-list">
            <li v-for="item in view.worktrees" :key="item.id">
              <button
                class="worktree-item"
                type="button"
                :class="{ chosen: item.id === view.selectedId }"
                :aria-current="item.id === view.selectedId ? 'true' : undefined"
                :title="item.path"
                @click="emit('select', item.id)"
              >
                <span class="item-name">
                  <GitBranch :size="14" :stroke-width="1.75" aria-hidden="true" />
                  {{ item.name }}
                </span>
                <span class="item-branch">{{ item.branch ?? "detached HEAD" }}</span>
                <span v-if="worktreeBadges(item).length > 0" class="badges">
                  <span
                    v-for="badge in worktreeBadges(item)"
                    :key="badge.code"
                    class="badge"
                    :data-tone="badge.tone"
                  >
                    {{ badge.label }}
                  </span>
                </span>
                <span class="item-sessions">{{ item.sessionIds.length }} 个会话</span>
              </button>
            </li>
            <li v-if="view.worktrees.length === 0" class="empty">
              {{ view.loading ? "正在枚举工作树…" : "该项目没有可展示的工作树。" }}
            </li>
          </ul>

          <p v-if="view.stale.length > 0" class="stale">
            {{ view.stale.length }} 条失效记录（目录已不存在）：
            <button type="button" :disabled="view.pruning" @click="emit('prune')">
              {{ view.pruning ? "清理中…" : "清理失效记录" }}
            </button>
          </p>

          <form class="create" @submit.prevent="submitCreate">
            <p class="form-title">新建附加工作树</p>
            <label class="field">
              <span>分支</span>
              <input v-model="branch" type="text" placeholder="agent/issue-5" autocomplete="off" />
            </label>
            <label class="check">
              <input v-model="newBranch" type="checkbox" />
              新建分支（否则检出既有分支）
            </label>
            <label v-if="newBranch" class="field">
              <span>起点</span>
              <input v-model="base" type="text" placeholder="HEAD" autocomplete="off" />
            </label>
            <label class="field">
              <span>目标目录（可选）</span>
              <input v-model="path" type="text" placeholder="默认放在项目旁" autocomplete="off" />
            </label>
            <button class="primary" type="submit" :disabled="!branch.trim() || view.creating">
              {{ view.creating ? "创建中…" : "创建工作树" }}
            </button>
          </form>
        </section>

        <section class="detail" aria-label="工作树详情">
          <p v-if="view.error" class="alert" role="alert">{{ view.error }}</p>

          <template v-if="selected">
            <div class="detail-head">
              <h3>{{ selected.name }}</h3>
              <p class="detail-path">{{ selected.path }}</p>
              <p class="detail-meta">
                {{ selected.branch ?? "detached HEAD" }}
                <template v-if="selected.head"> · {{ selected.head.slice(0, 8) }}</template>
                · {{ selected.sessionIds.length }} 个会话
                <template v-if="selected.activeSessionIds.length > 0">
                  （{{ selected.activeSessionIds.length }} 个运行中）
                </template>
              </p>
              <div v-if="worktreeBadges(selected).length > 0" class="badges">
                <span
                  v-for="badge in worktreeBadges(selected)"
                  :key="badge.code"
                  class="badge"
                  :data-tone="badge.tone"
                >
                  {{ badge.label }}
                </span>
              </div>
            </div>

            <div class="sessions">
              <p class="section-title">该工作树下的会话（{{ selectedSessions.length }}）</p>
              <ul v-if="selectedSessions.length > 0" class="session-list">
                <li v-for="session in selectedSessions" :key="session.id">
                  <button
                    type="button"
                    @click="
                      emit('open-session', {
                        sessionId: session.id,
                        projectId: session.projectId,
                        title: session.title,
                        worktreeId: session.worktreeId,
                      })
                    "
                  >
                    <span class="session-title">{{ session.title }}</span>
                    <span v-if="session.runtimeId" class="badge" data-tone="danger">运行中</span>
                  </button>
                </li>
              </ul>
              <p v-else class="hint">该工作树还没有 Pi 会话。会话归属由 Pi 会话目录决定。</p>
            </div>

            <div class="diff">
              <div class="diff-actions">
                <button type="button" :disabled="view.diffLoading" @click="emit('diff', selected.id, false)">
                  工作区改动
                </button>
                <button type="button" :disabled="view.diffLoading" @click="emit('diff', selected.id, true)">
                  已暂存
                </button>
                <span class="hint">只读预览，有大小上限</span>
              </div>
              <p v-if="view.diffLoading" class="hint">正在读取 diff…</p>
              <p v-else-if="view.diffError" class="alert" role="alert">{{ view.diffError }}</p>
              <template v-else-if="view.diff">
                <p class="diff-meta">
                  {{ view.diff.totalFiles }} 个文件 · 读取 {{ view.diff.bytesRead }} 字节
                  <template v-if="view.diff.truncated"> · 输出已截断</template>
                  <template v-if="view.diff.staged"> · 已暂存</template>
                </p>
                <ul class="files">
                  <li v-for="file in view.diff.files" :key="file.path">
                    <span class="file-status">{{ file.status }}</span>
                    <span class="file-path">{{ file.path }}</span>
                    <span v-if="file.binary" class="file-count">二进制</span>
                    <span v-else class="file-count">+{{ file.added ?? 0 }} / -{{ file.removed ?? 0 }}</span>
                  </li>
                </ul>
                <pre v-if="view.diff.patch" class="patch">{{ view.diff.patch }}</pre>
              </template>
              <p v-else class="hint">尚未加载 diff。</p>
            </div>

            <div class="danger">
              <p class="danger-title">
                <Trash2 :size="14" :stroke-width="1.75" aria-hidden="true" />
                删除工作树
              </p>
              <p class="hint">
                只允许删除干净、无活跃运行时的附加工作树；SOXU 不会执行 reset、clean 或强制删除。
                失败时目录与 Git 元数据保持原样，可修正原因后重试。
              </p>
              <button
                v-if="!view.pendingRemoval"
                class="danger-button"
                type="button"
                @click="emit('plan-removal', selected.id)"
              >
                准备删除…
              </button>
              <div v-else class="confirm">
                <p class="confirm-line">确认删除 <strong>{{ selected.name }}</strong>（{{ selected.path }}）？</p>
                <ul v-if="view.pendingRemoval.blockers.length > 0" class="blockers">
                  <li v-for="blocker in view.pendingRemoval.blockers" :key="blocker">
                    {{ blocker }} · {{ blockerLabel(blocker) }}
                  </li>
                </ul>
                <p class="token">确认令牌 {{ view.pendingRemoval.token }}</p>
                <div class="confirm-actions">
                  <button
                    class="danger-button"
                    type="button"
                    :disabled="!view.pendingRemoval.removable || view.removing"
                    @click="emit('confirm-removal')"
                  >
                    {{ view.removing ? "删除中…" : "确认删除" }}
                  </button>
                  <button type="button" :disabled="view.removing" @click="emit('cancel-removal')">
                    取消
                  </button>
                </div>
              </div>
              <p v-if="view.pendingError" class="alert" role="alert">{{ view.pendingError }}</p>
            </div>
          </template>

          <p v-else class="empty">选择左侧工作树查看分支、改动与删除条件。</p>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  z-index: 45;
  display: grid;
  place-items: center;
  background: rgb(0 0 0 / 32%);
  padding: 24px;
}

.dialog {
  width: min(860px, 100%);
  max-height: min(720px, 92vh);
  display: flex;
  flex-direction: column;
  border-radius: 16px;
  border: 1px solid var(--soxu-border);
  background: var(--soxu-panel);
  color: var(--soxu-fg);
  box-shadow: 0 24px 60px rgb(0 0 0 / 22%);
  overflow: hidden;
}

.dialog:focus-visible {
  outline: 2px solid var(--soxu-focus);
  outline-offset: 2px;
}

.dialog-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 18px;
  border-bottom: 1px solid var(--soxu-border);
}

.titles h2 {
  margin: 0;
  font-size: 15px;
  font-weight: 650;
}

.subtitle {
  margin: 4px 0 0;
  font-size: 11.5px;
  color: var(--soxu-muted);
  overflow-wrap: anywhere;
}

.notice,
.empty,
.hint {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--soxu-muted);
}

.notice {
  padding: 16px 18px;
}

.body {
  display: grid;
  grid-template-columns: 268px minmax(0, 1fr);
  min-height: 0;
  flex: 1;
}

.list {
  display: flex;
  flex-direction: column;
  min-height: 0;
  gap: 10px;
  padding: 12px;
  border-right: 1px solid var(--soxu-border);
  background: var(--soxu-sidebar);
  overflow-y: auto;
}

.list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 4px;
}

.count {
  font-size: 11px;
  color: var(--soxu-muted);
}

.icon-button.small {
  width: 26px;
  height: 26px;
  border-radius: 7px;
}

.worktree-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.worktree-item {
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: 100%;
  padding: 8px 10px;
  border-radius: 8px;
  text-align: left;
  color: var(--soxu-fg);
}

.worktree-item:hover {
  background: var(--soxu-hover);
}

.worktree-item.chosen {
  background: var(--soxu-selected);
}

.item-name {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.item-branch,
.item-sessions {
  font-size: 11px;
  color: var(--soxu-subtext);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.badges {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.badge {
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 10.5px;
  border: 1px solid var(--soxu-border);
  background: var(--soxu-soft);
  color: var(--soxu-subtext);
}

.badge[data-tone="danger"] {
  color: var(--soxu-danger);
  border-color: color-mix(in srgb, var(--soxu-danger) 35%, transparent);
}

.badge[data-tone="warn"] {
  color: var(--soxu-warn);
  border-color: color-mix(in srgb, var(--soxu-warn) 35%, transparent);
}

.badge[data-tone="info"] {
  color: var(--soxu-accent);
  border-color: color-mix(in srgb, var(--soxu-accent) 35%, transparent);
}

.stale {
  margin: 0;
  padding: 8px 10px;
  border-radius: 9px;
  background: var(--soxu-soft);
  font-size: 11px;
  line-height: 1.7;
  color: var(--soxu-subtext);
}

.stale button {
  color: var(--soxu-accent);
  font-size: 11px;
}

.create {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border-radius: 10px;
  border: 1px solid var(--soxu-border);
  background: var(--soxu-input);
}

.form-title {
  margin: 0;
  font-size: 11px;
  font-weight: 600;
  color: var(--soxu-muted);
}

.field {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 11px;
  color: var(--soxu-subtext);
}

.field input {
  height: 30px;
  padding: 0 8px;
  border-radius: 7px;
  border: 1px solid var(--soxu-border);
  background: var(--soxu-panel);
  color: var(--soxu-fg);
  font-size: 12px;
  outline: none;
}

.field input:focus-visible {
  border-color: var(--soxu-focus);
}

.check {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--soxu-subtext);
}

.primary {
  height: 30px;
  border-radius: 8px;
  background: var(--soxu-ink);
  color: var(--soxu-on-ink);
  font-size: 12px;
}

.primary:disabled,
.danger-button:disabled {
  opacity: 0.45;
  cursor: default;
}

.detail {
  min-height: 0;
  overflow-y: auto;
  padding: 14px 18px 18px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.detail-head h3 {
  margin: 0;
  font-size: 13.5px;
  font-weight: 650;
  overflow-wrap: anywhere;
}

.detail-path,
.detail-meta {
  margin: 3px 0 0;
  font-size: 11px;
  color: var(--soxu-muted);
  overflow-wrap: anywhere;
}

.detail-head .badges {
  margin-top: 6px;
}

.sessions {
  border: 1px solid var(--soxu-border);
  border-radius: 11px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.section-title {
  margin: 0;
  font-size: 11px;
  font-weight: 600;
  color: var(--soxu-muted);
}

.session-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 140px;
  overflow-y: auto;
}

.session-list button {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  border-radius: 7px;
  font-size: 12px;
  text-align: left;
  color: var(--soxu-fg);
}

.session-list button:hover {
  background: var(--soxu-hover);
}

.session-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.diff,
.danger {
  border: 1px solid var(--soxu-border);
  border-radius: 11px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.diff-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.diff-actions button {
  height: 28px;
  padding: 0 10px;
  border-radius: 8px;
  border: 1px solid var(--soxu-border);
  font-size: 11.5px;
  color: var(--soxu-fg);
}

.diff-actions button:hover:not(:disabled) {
  background: var(--soxu-hover);
}

.diff-meta {
  margin: 0;
  font-size: 11px;
  color: var(--soxu-subtext);
}

.files {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 160px;
  overflow-y: auto;
  font-size: 11px;
}

.files li {
  display: flex;
  gap: 8px;
  align-items: baseline;
}

.file-status {
  width: 22px;
  color: var(--soxu-muted);
  font-variant-numeric: tabular-nums;
}

.file-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-count {
  color: var(--soxu-subtext);
  font-variant-numeric: tabular-nums;
}

.patch {
  margin: 0;
  max-height: 220px;
  overflow: auto;
  padding: 8px;
  border-radius: 8px;
  background: var(--soxu-soft);
  font-size: 11px;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.danger {
  border-color: color-mix(in srgb, var(--soxu-danger) 30%, var(--soxu-border));
}

.danger-title {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--soxu-danger);
}

.danger-button {
  align-self: flex-start;
  height: 30px;
  padding: 0 12px;
  border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--soxu-danger) 40%, transparent);
  color: var(--soxu-danger);
  font-size: 11.5px;
}

.confirm {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.confirm-line,
.token {
  margin: 0;
  font-size: 11.5px;
  color: var(--soxu-subtext);
  overflow-wrap: anywhere;
}

.token {
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 10.5px;
  color: var(--soxu-muted);
}

.blockers {
  margin: 0;
  padding-left: 16px;
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--soxu-danger);
}

.confirm-actions {
  display: flex;
  gap: 8px;
}

.confirm-actions button:not(.danger-button) {
  height: 30px;
  padding: 0 12px;
  border-radius: 8px;
  border: 1px solid var(--soxu-border);
  font-size: 11.5px;
  color: var(--soxu-fg);
}

.alert {
  margin: 0;
  padding: 8px 10px;
  border-radius: 9px;
  background: color-mix(in srgb, var(--soxu-danger) 10%, transparent);
  color: var(--soxu-danger);
  font-size: 11.5px;
  line-height: 1.7;
  overflow-wrap: anywhere;
}

@media (max-width: 780px) {
  .body {
    grid-template-columns: minmax(0, 1fr);
  }

  .list {
    border-right: 0;
    border-bottom: 1px solid var(--soxu-border);
    max-height: 46%;
  }
}
</style>
