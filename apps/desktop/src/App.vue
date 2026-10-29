<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { ChevronLeft, ChevronRight, PanelLeft, PanelRight, Plus } from "@lucide/vue";
import AppTooltip from "./components/AppTooltip.vue";
import ChatPanel from "./components/ChatPanel.vue";
import ProjectSidebar from "./components/ProjectSidebar.vue";
import RuntimeInspector from "./components/RuntimeInspector.vue";
import SessionTabs from "./components/SessionTabs.vue";
import SettingsDialog from "./components/SettingsDialog.vue";
import WorktreeDialog from "./components/WorktreeDialog.vue";
import { useAppearance } from "./composables/useAppearance.ts";
import { useBusyDelivery } from "./composables/useBusyDelivery.ts";
import { useProjectDirectoryPick } from "./composables/useProjectDirectoryPick.ts";
import { runtimeInfo, type RuntimeInfo } from "./services/native.ts";
import { useWorkspaceStore } from "./stores/workspace.ts";
import {
  applyDocumentTheme,
  persistTheme,
  resolveInitialTheme,
  syncWindowTheme,
  type ThemeName,
} from "./theme/theme.ts";
import { runThemeTransition } from "./theme/themeTransition.ts";
import { currentWindowTarget } from "./theme/windowTheme.ts";
import {
  createSessionHistory,
  findTarget,
  moveTo,
  recordVisit,
  type SessionHistory,
} from "./workspace/sessionHistory.ts";
import type {
  CreateWorktreeInput,
  SendMode,
  SessionId,
  WorktreeId,
} from "./workspace/types.ts";

const store = useWorkspaceStore();
const info = ref<RuntimeInfo | null>(null);
const sidebarOpen = ref(true);
const inspectorOpen = ref(true);
const settingsOpen = ref(false);
/** 工作树面板观察的项目；null 表示面板关闭。 */
const worktreeProjectId = ref<string | null>(null);
const theme = ref<ThemeName>(resolveInitialTheme());
/**
 * 外观（字号 + 字体族）：初始值与 main.ts 一致（挂载前就已写进 <html>），
 * 这里接管后续修改、持久化与 DOM 落地。
 */
const { appearance, setFontSize, setFontFamily } = useAppearance();
/** 设置 → 会话 → 忙碌时发送的默认投递方式（V4-S1）。 */
const { busyDelivery, setBusyDelivery } = useBusyDelivery();
const {
  picking: pickingProject,
  pickError: pickProjectError,
  pick: pickProjectDirectory,
} = useProjectDirectoryPick();

const activeTab = computed(() => store.activeTab);
const worktreeProject = computed(
  () => store.state.projects.find((project) => project.id === worktreeProjectId.value) ?? null,
);
const worktreeProjectName = computed(() => worktreeProject.value?.name ?? "项目");
const worktreeProjectSessions = computed(() => worktreeProject.value?.sessions ?? []);
const lastSession = computed(() =>
  [...store.sessionList].sort((left, right) => right.updatedAtMs - left.updatedAtMs)[0] ?? null,
);

/**
 * 顶栏后退 / 前进（Issue #96）。
 *
 * 历史只记录「查看过的会话」，由 activeSessionId 的变化驱动，不需要每个入口
 * 各自埋点：侧栏打开、Tab 点击、工作树打开、重试重开都会自然进入历史。
 * 目标必须是仍然打开的 Tab，否则重置后跳回已关闭会话只会得到空白面板。
 */
const history = ref<SessionHistory>(createSessionHistory());
const isOpenTab = (sessionId: SessionId) =>
  store.state.tabs.some((tab) => tab.sessionId === sessionId);
const backTarget = computed(() => findTarget(history.value, "back", isOpenTab));
const forwardTarget = computed(() => findTarget(history.value, "forward", isOpenTab));

/**
 * flush: "sync" 是必需的：后退时先移动游标再切会话，如果记录发生在下一个 tick，
 * 中间那次 recordVisit 会把刚保留的前进分支截断，前进按钮会凭空失效。
 */
watch(
  () => store.state.activeSessionId,
  (sessionId) => {
    if (sessionId) history.value = recordVisit(history.value, sessionId);
  },
  { flush: "sync" },
);

function goBack() {
  const target = backTarget.value;
  if (!target) return;
  history.value = moveTo(history.value, target.index);
  store.setActive(target.sessionId);
}

function goForward() {
  const target = forwardTarget.value;
  if (!target) return;
  history.value = moveTo(history.value, target.index);
  store.setActive(target.sessionId);
}

/** 持久化只发生在用户切换时；没选过的用户继续跟随系统偏好，不被首次启动写死。 */
watch(theme, (value) => {
  persistTheme(value);
});

/**
 * 主题落地：写 <html data-theme>（:root token 与 color-scheme）并同步原生窗口标题栏。
 *
 * - flush: "sync"：属性必须在提交的同一帧写进 <html>，否则主题过渡的新快照会拍到旧配色；
 * - immediate：启动时（Vue 挂载前）就生效，避免深色主题先闪一帧浅色；
 * - 两个副作用互不阻塞：窗口同步失败（Linux/浏览器预览）只记 failed，应用内主题照常。
 */
watch(
  theme,
  (value) => {
    applyDocumentTheme(value);
    void syncWindowTheme(value, currentWindowTarget());
  },
  { flush: "sync", immediate: true },
);

/**
 * 主题切换统一入口：有点击坐标就从按钮位置圆形扩散，没有坐标（设置对话框）从视口中心扩散。
 * 动画降级、发光涟漪和清理都由 runThemeTransition 负责，这里只改响应式状态。
 */
async function setTheme(next: ThemeName, event?: MouseEvent): Promise<void> {
  if (next === theme.value) return;
  await runThemeTransition({
    origin: event ? { clientX: event.clientX, clientY: event.clientY } : null,
    commit: () => {
      theme.value = next;
    },
  });
}

function toggleTheme(event?: MouseEvent) {
  void setTheme(theme.value === "light" ? "dark" : "light", event);
}

function openSession(payload: {
  sessionId: SessionId;
  projectId: string;
  title: string;
  worktreeId?: WorktreeId;
}) {
  void store.openSession(payload);
}

function openWorktrees(projectId: string) {
  worktreeProjectId.value = projectId;
}

function closeWorktrees() {
  worktreeProjectId.value = null;
}

function openSessionFromWorktree(payload: {
  sessionId: SessionId;
  projectId: string;
  title: string;
  worktreeId: WorktreeId;
}) {
  closeWorktrees();
  void store.openSession(payload);
}

function refreshWorktrees() {
  const projectId = worktreeProjectId.value;
  if (projectId) void store.openWorktrees(projectId);
}

function selectWorktree(worktreeId: WorktreeId) {
  store.selectWorktree(worktreeId);
}

function createWorktree(input: CreateWorktreeInput) {
  void store.createWorktree(input);
}

function previewWorktreeDiff(worktreeId: WorktreeId, staged: boolean) {
  void store.previewWorktreeDiff(worktreeId, staged);
}

function planWorktreeRemoval(worktreeId: WorktreeId) {
  void store.planWorktreeRemoval(worktreeId);
}

function confirmWorktreeRemoval() {
  void store.confirmWorktreeRemoval();
}

function pruneWorktrees() {
  void store.pruneWorktrees();
}

function newTemporary() {
  void store.openTemporary();
}

function selectTab(sessionId: SessionId) {
  store.setActive(sessionId);
}

function closeTab(sessionId: SessionId) {
  void store.closeTab(sessionId);
}

/**
 * 发送消息：`mode` 是 composer 三选菜单的选择（null = 按默认投递）。
 * 本切片把 mode 作为参数传给后端管道，运行时语义（注入/排队/并行会话）由后续切片实现。
 */
function send(payload: { text: string; mode: SendMode | null }) {
  const tab = activeTab.value;
  if (!tab) return;
  void store.send(tab.sessionId, payload.text, payload.mode ? { mode: payload.mode } : undefined);
}

function cancel() {
  const tab = activeTab.value;
  if (tab) void store.cancel(tab.sessionId);
}

function stop() {
  const tab = activeTab.value;
  if (tab) void store.stop(tab.sessionId);
}

function loadMore() {
  const tab = activeTab.value;
  if (tab) void store.loadMore(tab.sessionId);
}

function promote() {
  const tab = activeTab.value;
  if (tab) void store.promote(tab.sessionId);
}

function setDraft(value: string) {
  const tab = activeTab.value;
  if (tab) store.setDraft(tab.sessionId, value);
}

function retry() {
  const tab = activeTab.value;
  if (!tab) return;
  const meta = {
    sessionId: tab.sessionId,
    projectId: tab.projectId,
    title: tab.title,
    mode: tab.mode,
    worktreeId: tab.worktreeId,
  };
  void (async () => {
    await store.closeTab(meta.sessionId);
    await store.openSession(meta);
  })();
}

/**
 * 欢迎页的添加项目入口（Issue #100）：只走系统目录选择器，不再手输路径。
 *
 * 手输框需要用户自己拼绝对路径，写错了只会得到一条扫描失败；选择器给出的
 * 路径由系统保证存在。取消或选择器不可用时 pick 返回 null，此时既不登记
 * 也不报错，已登记项目与界面状态都保持原样。
 */
async function addProject() {
  const picked = await pickProjectDirectory();
  if (!picked) return;
  await store.addProject(picked);
}

function onKeydown(event: KeyboardEvent) {
  const mod = event.ctrlKey || event.metaKey;
  if (!mod) return;
  const key = event.key.toLowerCase();
  if (key === "b") {
    event.preventDefault();
    sidebarOpen.value = !sidebarOpen.value;
  } else if (key === "i") {
    event.preventDefault();
    inspectorOpen.value = !inspectorOpen.value;
  } else if (key === "k") {
    event.preventDefault();
    newTemporary();
  }
}

onMounted(async () => {
  window.addEventListener("keydown", onKeydown);
  try {
    info.value = await runtimeInfo();
  } catch {
    info.value = null;
  }
  await store.bootstrap();
  const first = lastSession.value;
  if (first) {
    await store.openSession({
      sessionId: first.id,
      projectId: first.projectId,
      title: first.title,
      worktreeId: first.worktreeId,
    });
  }
});

onUnmounted(() => {
  window.removeEventListener("keydown", onKeydown);
  void store.dispose();
});
</script>

<template>
  <div class="app-shell" :data-theme="theme">
    <ProjectSidebar
      v-if="sidebarOpen"
      :projects="store.state.projects"
      :bridge-available="store.bridgeAvailable"
      :busy="store.busy"
      :active-session-id="store.state.activeSessionId"
      :theme="theme"
      @open-session="openSession"
      @new-temporary="newTemporary"
      @add-project="(root: string) => void store.addProject(root)"
      @refresh-project="(id: string) => void store.refreshProject(id)"
      @open-worktrees="openWorktrees"
      @open-settings="settingsOpen = true"
      @toggle-theme="toggleTheme"
    />

    <div class="main-column">
      <header class="app-header">
        <div class="header-start">
          <AppTooltip text="侧栏 (Ctrl+B)">
            <button
              class="icon-button"
              type="button"
              :aria-label="sidebarOpen ? '收起侧栏' : '展开侧栏'"
              :aria-expanded="sidebarOpen"
              aria-keyshortcuts="Control+B"
              @click="sidebarOpen = !sidebarOpen"
            >
              <PanelLeft :size="18" :stroke-width="1.75" aria-hidden="true" />
            </button>
          </AppTooltip>
          <AppTooltip text="后退：上一个查看过的会话">
            <span class="icon-button-frame">
              <button
                class="icon-button"
                type="button"
                :disabled="!backTarget"
                aria-label="后退到上一个查看过的会话"
                @click="goBack"
              >
                <ChevronLeft :size="18" :stroke-width="1.75" aria-hidden="true" />
              </button>
            </span>
          </AppTooltip>
          <AppTooltip text="前进：回到下一个查看过的会话">
            <span class="icon-button-frame">
              <button
                class="icon-button"
                type="button"
                :disabled="!forwardTarget"
                aria-label="前进到下一个查看过的会话"
                @click="goForward"
              >
                <ChevronRight :size="18" :stroke-width="1.75" aria-hidden="true" />
              </button>
            </span>
          </AppTooltip>
        </div>
        <div class="header-end">
          <AppTooltip
            :text="store.bridgeAvailable ? '已连接本机运行时' : '浏览器预览：未连接本机运行时'"
          >
            <span class="badge" :data-tone="store.bridgeAvailable ? undefined : 'danger'">
              {{ store.bridgeAvailable ? "已连接" : "未连接" }}
            </span>
          </AppTooltip>
          <AppTooltip text="会话状态 (Ctrl+I)">
            <button
              class="icon-button"
              type="button"
              :aria-label="inspectorOpen ? '关闭会话状态面板' : '打开会话状态面板'"
              :aria-expanded="inspectorOpen"
              aria-keyshortcuts="Control+I"
              @click="inspectorOpen = !inspectorOpen"
            >
              <PanelRight :size="18" :stroke-width="1.75" aria-hidden="true" />
            </button>
          </AppTooltip>
        </div>
      </header>

      <SessionTabs
        v-if="store.state.tabs.length > 0"
        :tabs="store.state.tabs"
        :active-session-id="store.state.activeSessionId"
        @select="selectTab"
        @move="store.moveTab"
        @close="closeTab"
        @new-temporary="newTemporary"
      />

      <ChatPanel
        v-if="activeTab"
        :tab="activeTab"
        :bridge-available="store.bridgeAvailable"
        :busy="store.busy"
        :default-delivery="busyDelivery"
        @send="send"
        @cancel="cancel"
        @stop="stop"
        @load-more="loadMore"
        @retry="retry"
        @promote="promote"
        @update:draft="setDraft"
      />

      <section v-else class="welcome" aria-label="开始使用">
        <img class="welcome-mark" src="./assets/soxu-256.png" alt="" width="52" height="52" />
        <h1>选择一个会话，或添加项目目录</h1>
        <p v-if="store.state.projectsError" class="welcome-error" role="alert">
          {{ store.state.projectsError }}
        </p>
        <p v-else-if="store.state.projectsLoading" class="welcome-note" role="status">
          正在扫描 Pi 会话目录…
        </p>
        <p v-else-if="store.hasProjects" class="welcome-note">
          左侧已经登记项目，但还没有打开会话。点击会话即可加载历史并继续对话。
        </p>
        <p v-else class="welcome-note">
          SOXU 只读扫描 Pi 的会话目录，不会移动或删除会话文件。
        </p>

        <AppTooltip text="添加项目：打开系统目录选择器">
          <button
            class="welcome-add"
            type="button"
            :disabled="!store.bridgeAvailable || pickingProject"
            :aria-busy="pickingProject"
            @click="addProject"
          >
            <Plus :size="16" :stroke-width="1.9" aria-hidden="true" /> 添加项目
          </button>
        </AppTooltip>

        <p v-if="pickProjectError" class="welcome-error" role="alert">{{ pickProjectError }}</p>
        <button class="welcome-secondary link-button" type="button" @click="newTemporary">
          先开一个临时会话
        </button>
      </section>
    </div>

    <RuntimeInspector
      v-if="inspectorOpen"
      :tab="activeTab"
      :project-count="store.state.projects.length"
      :session-count="store.sessionList.length"
      :bridge-available="store.bridgeAvailable"
      @refresh-projects="() => void store.refreshProjects()"
      @stop="stop"
    />

    <WorktreeDialog
      :open="worktreeProjectId !== null"
      :project-id="worktreeProjectId"
      :project-name="worktreeProjectName"
      :bridge-available="store.bridgeAvailable"
      :view="store.worktreeView"
      :sessions="worktreeProjectSessions"
      @close="closeWorktrees"
      @open-session="openSessionFromWorktree"
      @refresh="refreshWorktrees"
      @select="selectWorktree"
      @create="createWorktree"
      @diff="previewWorktreeDiff"
      @plan-removal="planWorktreeRemoval"
      @confirm-removal="confirmWorktreeRemoval"
      @cancel-removal="() => store.cancelWorktreeRemoval()"
      @prune="pruneWorktrees"
    />

    <SettingsDialog
      :open="settingsOpen"
      :theme="theme"
      :font-size="appearance.fontSize"
      :font-family="appearance.fontFamily"
      :busy-delivery="busyDelivery"
      :info="info"
      :bridge-available="store.bridgeAvailable"
      @close="settingsOpen = false"
      @update:theme="(value: ThemeName) => void setTheme(value)"
      @update:fontSize="setFontSize"
      @update:fontFamily="setFontFamily"
      @update:busyDelivery="setBusyDelivery"
    />
  </div>
</template>

<style scoped>
.app-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 18px;
  min-height: 52px;
  flex: none;
  min-width: 0;
  /*
   * 与页面融合（Issue #96）：顶栏不再有自己的底色，用与 body 完全相同的
   * --soxu-bg，只留 1px 分隔线。之所以不用 transparent：「透明」的 computed
   * background-color 是 rgba(0,0,0,0)，与 body 不一致，验收与截图都无法比对，
   * 而显式同色既能保证一致，也不会透出窗口 backgroundColor 的纯白。
   */
  background: var(--soxu-bg);
  color: var(--soxu-fg);
  border-bottom: 1px solid var(--soxu-border);
}

.header-start,
.header-end {
  display: flex;
  align-items: center;
  gap: 10px;
}

/*
 * 后退 / 前进的提示挂在容器上而不是按钮上。
 *
 * 浏览器不会给 disabled 按钮派发鼠标事件，把 tooltip 触发器放在按钮上时，
 * 「为什么点不动」这段说明恰恰在最需要的时候看不到；容器仍能接收悬停。
 * 按钮本身保留 disabled + aria-label，键盘语义不变。
 */
.icon-button-frame {
  display: inline-flex;
  border-radius: 9px;
}

.welcome {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 32px;
  gap: 10px;
}

.welcome-mark {
  width: 52px;
  height: 52px;
  border-radius: 14px;
  object-fit: contain;
  box-shadow: 0 8px 22px rgb(0 0 0 / 8%);
}

.welcome h1 {
  margin: 8px 0 0;
  font-size: 1.375rem;
  font-weight: 620;
  letter-spacing: -0.4px;
}

.welcome-note {
  margin: 0;
  max-width: 460px;
  font-size: 0.78125rem;
  line-height: 1.9;
  color: var(--soxu-subtext);
}

.welcome-error {
  margin: 0;
  max-width: 520px;
  font-size: 0.78125rem;
  line-height: 1.8;
  color: var(--soxu-danger);
  overflow-wrap: anywhere;
}

/*
 * 「添加项目」是一个按钮而不是输入框（Issue #100）：点击直接开系统目录选择器，
 * 所以这里只需要一次点击目标，不再有输入框与提交按钮的两段式布局。
 */
.welcome-add {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 14px;
  height: 34px;
  padding: 0 16px;
  border-radius: 10px;
  background: var(--soxu-ink);
  color: var(--soxu-on-ink);
  font-size: 0.78125rem;
  transition:
    opacity var(--soxu-motion-fast) var(--soxu-motion-ease),
    transform var(--soxu-motion-fast) var(--soxu-motion-ease);
}

.welcome-add:hover:not(:disabled) {
  opacity: 0.88;
}

.welcome-add:disabled {
  opacity: 0.4;
  cursor: default;
}

.welcome-secondary {
  margin-top: 4px;
  font-size: 0.75rem;
  color: var(--soxu-accent);
}
</style>
