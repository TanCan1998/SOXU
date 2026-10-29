<script setup lang="ts">
import { computed, ref } from "vue";
import {
  CircleAlert,
  Folder,
  GitBranch,
  MessageCircle,
  Moon,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Sun,
} from "@lucide/vue";
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
const rootPath = ref("");

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

function submitProject() {
  const value = rootPath.value.trim();
  if (!value) return;
  emit("add-project", value);
  rootPath.value = "";
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
      <Plus :size="18" :stroke-width="1.75" aria-hidden="true" />
      <span>临时会话</span>
      <kbd>Ctrl K</kbd>
    </button>

    <div class="search-field">
      <Search :size="16" :stroke-width="1.75" aria-hidden="true" />
      <input v-model="search" type="search" placeholder="搜索会话" aria-label="搜索会话" />
    </div>

    <nav class="nav-sections visually-scroll" aria-label="项目与会话">
      <p v-if="!bridgeAvailable" class="side-note" role="status">
        未连接 Rust 运行时：这是浏览器预览，不会加载真实会话。
      </p>

      <section v-for="project in visibleProjects" :key="project.id" class="project-group">
        <div class="project-head">
          <span class="project-name" :title="project.root">
            <Folder :size="14" :stroke-width="1.75" aria-hidden="true" />
            {{ project.name }}
          </span>
          <span class="project-actions">
            <button
              class="icon-button small"
              type="button"
              :disabled="!bridgeAvailable"
              :aria-label="`管理 ${project.name} 的工作树`"
              title="工作树：枚举、创建、Diff 与受确认的删除"
              @click="emit('open-worktrees', project.id)"
            >
              <GitBranch :size="14" :stroke-width="1.75" aria-hidden="true" />
            </button>
            <button
              class="icon-button small"
              type="button"
              :disabled="busy || !bridgeAvailable"
              :aria-label="`刷新项目 ${project.name}`"
              title="重新扫描会话目录"
              @click="emit('refresh-project', project.id)"
            >
              <RefreshCw :size="14" :stroke-width="1.75" aria-hidden="true" />
            </button>
          </span>
        </div>
        <ul class="session-list">
          <li v-for="session in project.sessions" :key="session.id">
            <button
              class="session-item"
              type="button"
              :class="{ chosen: session.id === activeSessionId }"
              :aria-current="session.id === activeSessionId ? 'page' : undefined"
              :title="session.title"
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
              <span v-if="session.missing" class="missing" title="会话文件已不在磁盘上">
                <CircleAlert :size="13" :stroke-width="1.9" aria-hidden="true" />
              </span>
            </button>
          </li>
          <li v-if="project.sessions.length === 0" class="session-empty">该目录下暂无 Pi 会话</li>
        </ul>
      </section>

      <p v-if="projects.length === 0 && bridgeAvailable" class="side-note">
        还没有登记项目。添加一个项目目录后，SOXU 会扫描该目录下的 Pi 会话（只读，不移动文件）。
      </p>
    </nav>

    <form class="add-project" @submit.prevent="submitProject">
      <label class="sr-only" for="soxu-project-root">项目目录绝对路径</label>
      <input
        id="soxu-project-root"
        v-model="rootPath"
        type="text"
        placeholder="添加项目目录…"
        :disabled="!bridgeAvailable || busy"
        autocomplete="off"
      />
      <button
        class="icon-button"
        type="submit"
        :disabled="!rootPath.trim() || !bridgeAvailable || busy"
        aria-label="添加项目"
        title="添加项目目录"
      >
        <Plus :size="18" :stroke-width="1.75" aria-hidden="true" />
      </button>
    </form>

    <div class="side-bottom">
      <p class="connection" :data-online="bridgeAvailable">
        <span class="state-dot" :data-state="bridgeAvailable ? 'ready' : 'error'" aria-hidden="true"></span>
        {{ bridgeAvailable ? `已连接 Rust 运行时 · ${totalSessions} 个会话` : "浏览器预览 · 未连接运行时" }}
      </p>
      <div class="side-bottom-row">
        <button class="icon-button" type="button" aria-label="设置" title="设置" @click="emit('open-settings')">
          <Settings :size="20" :stroke-width="1.75" aria-hidden="true" />
        </button>
        <button
          class="icon-button"
          type="button"
          :aria-label="theme === 'light' ? '切换到深色主题' : '切换到浅色主题'"
          :title="theme === 'light' ? '切换到深色主题' : '切换到浅色主题'"
          @click="emit('toggle-theme', $event)"
        >
          <Sun v-if="theme === 'dark'" :size="20" :stroke-width="1.75" aria-hidden="true" />
          <Moon v-else :size="20" :stroke-width="1.75" aria-hidden="true" />
        </button>
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
  font-size: 15px;
}

.brand-cn {
  font-size: 11px;
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
  font-size: 13px;
  font-weight: 600;
  color: var(--soxu-fg);
}

.new-session:hover {
  background: var(--soxu-hover);
}

.new-session kbd {
  margin-left: auto;
  font-size: 10px;
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
  font-size: 13px;
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
  font-size: 11px;
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
  font-size: 12.5px;
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
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--soxu-muted);
}

.add-project {
  display: flex;
  align-items: center;
  gap: 4px;
  border: 1px solid var(--soxu-border);
  border-radius: 10px;
  padding: 2px 4px 2px 10px;
  background: var(--soxu-input);
}

.add-project input {
  flex: 1;
  min-width: 0;
  border: 0;
  background: transparent;
  outline: none;
  font-size: 12px;
  height: 32px;
  color: var(--soxu-fg);
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
  font-size: 11px;
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
  font-size: 11px;
  color: var(--soxu-muted);
}
</style>
