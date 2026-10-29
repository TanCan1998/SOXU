<script setup lang="ts">
import { computed, ref } from "vue";
import {
  CircleAlert,
  Folder,
  GitBranch,
  MessageCircle,
  MessageSquareDashed,
  Moon,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Sun,
} from "@lucide/vue";
import AppTooltip from "./AppTooltip.vue";
import { useProjectDirectoryPick } from "../composables/useProjectDirectoryPick.ts";
import type { ProjectSummary, SessionId, WorktreeId } from "../workspace/types.ts";

const props = defineProps<{
  projects: ProjectSummary[];
  bridgeAvailable: boolean;
  busy: boolean;
  activeSessionId: SessionId | null;
  theme: "light" | "dark";
}>();

const emit = defineEmits<{
  (event: "open-session", payload: {
    sessionId: SessionId;
    projectId: string;
    title: string;
    worktreeId: WorktreeId;
  }): void;
  (event: "open-worktrees", projectId: string): void;
  (event: "new-temporary"): void;
  (event: "add-project", root: string): void;
  (event: "refresh-project", projectId: string): void;
  (event: "open-settings"): void;
  (event: "toggle-theme", payload: MouseEvent): void;
}>();

const search = ref("");
const { picking, pickError, pick } = useProjectDirectoryPick();

const visibleProjects = computed(() => {
  const needle = search.value.trim().toLowerCase();
  return props.projects.map((project) => ({
    ...project,
    sessions: project.sessions
      .filter((session) => {
        if (!needle) return true;
        return (
          session.title.toLowerCase().includes(needle) ||
          project.name.toLowerCase().includes(needle)
        );
      })
      .sort((left, right) => right.updatedAtMs - left.updatedAtMs),
  }));
});

const totalSessions = computed(() =>
  props.projects.reduce((sum, project) => sum + project.sessions.length, 0),
);

/**
 * 「添加项目目录」按钮的唯一入口（Issue #100）：点一次就开系统目录选择器，
 * 不再有手输路径的输入框。登记动作仍由上层负责，侧栏只把选中的绝对路径交出去。
 *
 * 取消或选择器不可用：pick 返回 null，不 emit，已登记项目保持不变。
 */
async function addProject() {
  const picked = await pick();
  if (!picked) return;
  emit("add-project", picked);
}
</script>

<template>
  <aside class="sidebar" aria-label="项目与会话导航">
    <div class="side-head">
      <div class="brand">
        <img class="brand-symbol" src="../assets/soxu-64.png" alt="" width="27" height="27" />
        <span class="brand-word">SOXU</span>
        <span class="brand-cn">索序</span>
      </div>
    </div>

    <button class="new-session" type="button" @click="emit('new-temporary')">
      <MessageSquareDashed :size="18" :stroke-width="1.75" aria-hidden="true" />
      <span>临时会话</span>
      <kbd>Ctrl K</kbd>
    </button>

    <div class="search-field">
      <Search :size="16" :stroke-width="1.75" aria-hidden="true" />
      <input v-model="search" type="search" placeholder="搜索会话" aria-label="搜索会话" />
    </div>

    <nav class="nav-sections visually-scroll" aria-label="项目与会话">
      <p v-if="!bridgeAvailable" class="side-note" role="status">
        未连接：这是浏览器预览，不会加载真实会话。
      </p>

      <section v-for="project in visibleProjects" :key="project.id" class="project-group">
        <div class="project-head">
          <AppTooltip :text="project.root">
            <span class="project-name">
              <Folder :size="14" :stroke-width="1.75" aria-hidden="true" />
              {{ project.name }}
            </span>
          </AppTooltip>
          <span class="project-actions">
            <AppTooltip text="工作树：枚举、创建、Diff 与受确认的删除">
              <button
                class="icon-button small"
                type="button"
                :disabled="!bridgeAvailable"
                :aria-label="`管理 ${project.name} 的工作树`"
                @click="emit('open-worktrees', project.id)"
              >
                <GitBranch :size="14" :stroke-width="1.75" aria-hidden="true" />
              </button>
            </AppTooltip>
            <AppTooltip text="重新扫描会话目录">
              <button
                class="icon-button small"
                type="button"
                :disabled="busy || !bridgeAvailable"
                :aria-label="`刷新项目 ${project.name}`"
                @click="emit('refresh-project', project.id)"
              >
                <RefreshCw :size="14" :stroke-width="1.75" aria-hidden="true" />
              </button>
            </AppTooltip>
          </span>
        </div>
        <ul class="session-list">
          <li v-for="session in project.sessions" :key="session.id">
            <AppTooltip :text="session.title">
              <button
                class="session-item"
                type="button"
                :class="{ chosen: session.id === activeSessionId }"
                :aria-current="session.id === activeSessionId ? 'page' : undefined"
                @click="
                  emit('open-session', {
                    sessionId: session.id,
                    projectId: project.id,
                    title: session.title,
                    worktreeId: session.worktreeId,
                  })
                "
              >
                <MessageCircle :size="14" :stroke-width="1.75" aria-hidden="true" />
                <span class="session-title">{{ session.title }}</span>
                <AppTooltip v-if="session.missing" text="会话文件已不在磁盘上">
                  <span class="missing">
                    <CircleAlert :size="13" :stroke-width="1.9" aria-hidden="true" />
                  </span>
                </AppTooltip>
              </button>
            </AppTooltip>
          </li>
          <li v-if="project.sessions.length === 0" class="session-empty">该目录下暂无 Pi 会话</li>
        </ul>
      </section>

      <p v-if="projects.length === 0 && bridgeAvailable" class="side-note">
        还没有登记项目。添加一个项目目录后，SOXU 会扫描该目录下的 Pi 会话（只读，不移动文件）。
      </p>
    </nav>

    <AppTooltip text="添加项目目录：打开系统目录选择器">
      <button
        class="add-project"
        type="button"
        :disabled="!bridgeAvailable || busy || picking"
        :aria-busy="picking"
        @click="addProject"
      >
        <Plus :size="16" :stroke-width="1.9" aria-hidden="true" />
        <span>添加项目目录</span>
      </button>
    </AppTooltip>

    <p v-if="pickError" class="side-note pick-error" role="alert">{{ pickError }}</p>

    <div class="side-bottom">
      <p class="connection" :data-online="bridgeAvailable">
        <span class="state-dot" :data-state="bridgeAvailable ? 'ready' : 'error'" aria-hidden="true"></span>
        {{ bridgeAvailable ? `已连接 · ${totalSessions} 个会话` : "未连接 · 浏览器预览" }}
      </p>
      <div class="side-bottom-row">
        <AppTooltip text="设置">
          <button class="icon-button" type="button" aria-label="设置" @click="emit('open-settings')">
            <Settings :size="20" :stroke-width="1.75" aria-hidden="true" />
          </button>
        </AppTooltip>
        <AppTooltip :text="theme === 'light' ? '切换到深色主题' : '切换到浅色主题'">
          <button
            class="icon-button"
            type="button"
            :aria-label="theme === 'light' ? '切换到深色主题' : '切换到浅色主题'"
            @click="emit('toggle-theme', $event)"
          >
            <Sun v-if="theme === 'dark'" :size="20" :stroke-width="1.75" aria-hidden="true" />
            <Moon v-else :size="20" :stroke-width="1.75" aria-hidden="true" />
          </button>
        </AppTooltip>
        <span class="workspace-label">本地工作区</span>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.sidebar {
  width: 262px;
  flex: none;
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 18px 12px 12px;
  gap: 8px;
  background: var(--soxu-sidebar);
  border-right: 1px solid var(--soxu-border);
}

.side-head {
  display: flex;
  align-items: center;
  padding: 0 6px 8px;
}

.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 700;
  letter-spacing: 0.5px;
}

.brand-symbol {
  width: 27px;
  height: 27px;
  border-radius: 8px;
  object-fit: contain;
}

.brand-word {
  font-size: 0.9375rem;
}

.brand-cn {
  font-size: 0.6875rem;
  font-weight: 400;
  color: var(--soxu-muted);
}

.new-session {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 10px 12px;
  border-radius: 9px;
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--soxu-fg);
}

.new-session:hover {
  background: var(--soxu-hover);
}

.new-session kbd {
  margin-left: auto;
  font-size: 0.625rem;
  font-weight: 400;
  color: var(--soxu-muted);
}

.search-field {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px;
  height: 36px;
  color: var(--soxu-muted);
}

.search-field input {
  width: 100%;
  border: 0;
  background: transparent;
  outline: none;
  font-size: 0.8125rem;
  color: var(--soxu-fg);
}

.nav-sections {
  flex: 1;
  min-height: 0;
  padding: 4px 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.project-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 2px 6px 4px 8px;
  font-size: 0.6875rem;
  font-weight: 600;
  color: var(--soxu-muted);
  letter-spacing: 0.3px;
}

.project-name {
  display: flex;
  align-items: center;
  gap: 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.project-actions {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}

.icon-button.small {
  width: 26px;
  height: 26px;
  border-radius: 7px;
}

.session-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.session-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 10px;
  border-radius: 8px;
  font-size: 0.78125rem;
  color: var(--soxu-fg);
  text-align: left;
}

.session-item:hover {
  background: var(--soxu-hover);
}

.session-item.chosen {
  background: var(--soxu-selected);
}

.session-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.missing {
  margin-left: auto;
  color: var(--soxu-warn);
  display: inline-flex;
}

.session-empty,
.side-note {
  margin: 0;
  padding: 4px 10px;
  font-size: 0.71875rem;
  line-height: 1.7;
  color: var(--soxu-muted);
}

/* 按钮而不是输入框（Issue #100）：一次点击直接开系统目录选择器。 */
.add-project {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 36px;
  padding: 0 10px;
  border: 1px solid var(--soxu-border);
  border-radius: 10px;
  background: var(--soxu-input);
  color: var(--soxu-fg);
  font-size: 0.78125rem;
  text-align: left;
  transition: background-color var(--soxu-motion-fast) var(--soxu-motion-ease);
}

.add-project:hover:not(:disabled) {
  background: var(--soxu-hover);
}

.add-project:disabled {
  opacity: 0.45;
  cursor: default;
}

.pick-error {
  color: var(--soxu-danger);
  overflow-wrap: anywhere;
}

.side-bottom {
  border-top: 1px solid var(--soxu-border);
  padding-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.connection {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  padding: 4px 8px;
  font-size: 0.6875rem;
  color: var(--soxu-subtext);
}

.side-bottom-row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 2px;
}

.workspace-label {
  margin-left: auto;
  font-size: 0.6875rem;
  color: var(--soxu-muted);
}
</style>
