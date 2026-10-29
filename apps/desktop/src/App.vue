<!--
  应用外壳（Issue #118 起约 790 行，超过 coding-standards 的 600 行提示线，理由如下）：
  - 它只做「装配」：状态与副作用已经按域拆到 composable（useAppearance / useBusyDelivery /
    useSessionSettings / useSystemSettings / useProjectDirectoryPick / useThemeTransition 等），
    本文件剩下的是 props/事件接线与顶栏、欢迎页、弹窗的模板。
  - 设置页的四个面板、工作树面板、会话面板、搜索抽屉都已是独立组件；再往下拆只能拆「模板片段」，
    那会让「谁持有哪个状态」变得难以追踪，反而增加生命周期泄漏的风险。
  - 搜索抽屉（Issue #118）只留下「接线」：打开/关闭、输入转发、跳转目标（focusMessageId + nonce），
    定位规则本身在 components/searchPanel.ts 里，可脱离 DOM 测试。
  - 主题切换（setTheme）与历史记录（history）必须留在壳层：它们是全应用唯一的入口。
-->
<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { ChevronLeft, ChevronRight, PanelLeft, PanelRight, Plus, Search } from "@lucide/vue";
import AppTooltip from "./components/AppTooltip.vue";
import ChatPanel from "./components/ChatPanel.vue";
import ProjectSidebar from "./components/ProjectSidebar.vue";
import RuntimeInspector from "./components/RuntimeInspector.vue";
import SearchDrawer from "./components/SearchDrawer.vue";
import { resolveJumpTarget } from "./components/searchPanel.ts";
import SessionTabs from "./components/SessionTabs.vue";
import SettingsDialog from "./components/SettingsDialog.vue";
import WorktreeDialog from "./components/WorktreeDialog.vue";
import { useAppearance } from "./composables/useAppearance.ts";
import { useBusyDelivery } from "./composables/useBusyDelivery.ts";
import { useProjectDirectoryPick } from "./composables/useProjectDirectoryPick.ts";
import { useSessionSettings } from "./composables/useSessionSettings.ts";
import { useSystemSettings } from "./composables/useSystemSettings.ts";
import { copyText } from "./services/clipboard.ts";
import { runtimeInfo, type RuntimeInfo } from "./services/native.ts";
import { dataDirectoryHint } from "./settings/dataDirectory.ts";
import type { Appearance } from "./theme/appearance.ts";
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
  SessionSearchHit,
  WorktreeId,
} from "./workspace/types.ts";

const store = useWorkspaceStore();
const info = ref<RuntimeInfo | null>(null);
const sidebarOpen = ref(true);
const inspectorOpen = ref(true);
const settingsOpen = ref(false);
/** 右侧搜索抽屉（Issue #118）；与「会话状态」面板互斥，一次只开一个。 */
const searchOpen = ref(false);
const searchDrawer = ref<InstanceType<typeof SearchDrawer> | null>(null);
/** 搜索跳转的目标消息 + 递增序号：同一条命中连点两次也要重新定位。 */
const focusMessageId = ref<string | null>(null);
const focusNonce = ref(0);
/** 跳转未能定位时的说明；null 表示没有提示。 */
const searchNotice = ref<string | null>(null);
/** 工作树面板观察的项目；null 表示面板关闭。 */
const worktreeProjectId = ref<string | null>(null);
const theme = ref<ThemeName>(resolveInitialTheme());
/**
 * 外观（字号 + 界面字体 + 代码字体 + 正文宽度 + 强调色）：初始值与 main.ts 一致
 * （挂载前就已写进 <html>），这里接管后续修改、持久化与 DOM 落地。
 */
const { appearance, patchAppearance } = useAppearance();
/** 设置 → 会话 → 忙碌时发送的默认投递方式（V4-S1）。 */
const { busyDelivery, setBusyDelivery } = useBusyDelivery();
/** 设置 → 会话页其余偏好（Issue #116）：自动贴底、Enter 发送、工具输出、时间戳、思考强度。 */
const { session, patchSession } = useSessionSettings();
/** 设置 → 系统页开关（Issue #116）：只持久化，真实能力随对应切片接入。 */
const { system, patchSystem } = useSystemSettings();
/** Tauri 框架版本（「设置 → 系统 → 关于」用）；浏览器预览下保持 null。 */
const tauriVersion = ref<string | null>(null);
/** 「数据目录」复制按钮的结果回显。 */
const copyState = ref<"idle" | "copied" | "failed">("idle");
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
 * 右侧抽屉一次只显示一个面板（Issue #118）：打开「会话状态」就收起「搜索」。
 *
 * 两个 320px 抽屉并排会把正文挤到不可读，用户也不需要同时看两份；
 * 顶栏两个按钮因此各自保持「点自己就开自己」的简单语义，互斥在这里统一收口。
 * 监听 inspectorOpen 而不是改顶栏按钮的 @click：PanelRight 的开关行为是既有契约
 * （tests/interactionPolish.test.ts 断言它直接写 inspectorOpen）。
 */
watch(inspectorOpen, (open) => {
  if (open) searchOpen.value = false;
});

/** 切换会话时清掉上一条跳转目标与提示：它们只对原来的会话有意义。 */
watch(
  () => store.state.activeSessionId,
  () => {
    focusMessageId.value = null;
    searchNotice.value = null;
  },
);

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
  void store.send(tab.sessionId, payload.text, {
    ...(payload.mode ? { mode: payload.mode } : {}),
    // 设置 → 会话 → 默认思考强度（Issue #116）：每次发送都带上当前档位。
    thinking: session.value.thinkingLevel,
  });
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

/**
 * 打开搜索抽屉（顶栏按钮与 Ctrl+F 共用）。
 *
 * 焦点必须在打开后立刻进搜索框：Ctrl+F 之后用户的第一动作就是打字，
 * 让他先点一下输入框等于快捷键只完成了一半。
 */
function openSearch() {
  searchOpen.value = true;
  inspectorOpen.value = false;
  searchNotice.value = null;
  void nextTick(() => searchDrawer.value?.focus());
}

function closeSearch() {
  searchOpen.value = false;
}

/** 输入变化：防抖在 store 侧按会话登记，这里只决定「发请求」还是「取消待触发」。 */
function onSearchQuery(value: string) {
  const tab = activeTab.value;
  if (!tab) return;
  searchNotice.value = null;
  if (!value.trim()) {
    store.cancelSearch(tab.sessionId);
    return;
  }
  store.scheduleSearch(tab.sessionId, value);
}

/**
 * 点击一条命中：定位到对应消息并高亮。
 *
 * 命中可能落在尚未加载的历史窗口里（搜索搜的是整份会话），所以先按 ordinal 找，
 * 找不到就有界翻页再找——最多 MAX_JUMP_PAGES（3）页，绝不为了一个旧命中无限加载。
 * 仍然找不到时如实提示，不假装跳过去了。
 */
async function onSearchJump(hit: SessionSearchHit) {
  const tab = activeTab.value;
  if (!tab) return;
  searchNotice.value = null;
  // 定位规则（含「有界翻页」与「切走就放弃」）在 searchPanel.ts 里，可脱离 DOM 测试。
  const resolution = await resolveJumpTarget({
    sessionId: tab.sessionId,
    ordinal: hit.ordinal,
    messages: () => tab.messages,
    hasMore: () => tab.history.next !== null,
    loadMore: () => store.loadMore(tab.sessionId),
    isActive: () => activeTab.value?.sessionId === tab.sessionId,
  });
  searchNotice.value = resolution.notice;
  if (!resolution.messageId) return;
  focusMessageId.value = resolution.messageId;
  focusNonce.value += 1;
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

/** 「设置 → 系统 → 数据目录」展示的路径：按平台推导，与应用标识符一致。 */
const dataDirectory = computed(() => dataDirectoryHint(info.value?.platform));

/**
 * 「清空当前会话」的可用条件（Issue #116）。
 *
 * 这个动作只释放界面内存里的消息缓存（关闭后立即从会话文件重新载入），
 * 所以临时会话被排除：临时会话关闭即结束，拿它当「清缓存」会真的丢数据。
 */
const clearBlockedReason = computed(() => {
  const tab = activeTab.value;
  if (!tab) return "当前没有打开的会话";
  if (tab.mode === "temporary") return "临时会话关闭即结束，不能只清界面缓存";
  if (tab.status === "running" || tab.status === "cancelling") {
    return "当前轮次还没结束，结束后再清空";
  }
  return null;
});

/**
 * 清空界面缓存：关掉再打开同一个会话，内存里的消息对象随之释放并从 JSONL 重新载入。
 * 不调用任何删除命令，会话文件保持原样（与设置页文案一致）。
 *
 * 草稿不是消息缓存：closeTab 会连 Tab 对象一起丢掉，用户正在写的半句话会凭空消失。
 * 所以先取下来、重开后再写回——「清空」清的是已上屏的消息，不是用户没发出去的内容。
 */
async function clearSessionCache() {
  const tab = activeTab.value;
  if (!tab || clearBlockedReason.value !== null) return;
  const meta = {
    sessionId: tab.sessionId,
    projectId: tab.projectId,
    title: tab.title,
    mode: tab.mode,
    worktreeId: tab.worktreeId,
  };
  const draft = tab.draft;
  const index = store.state.tabs.findIndex((candidate) => candidate.sessionId === meta.sessionId);
  await store.closeTab(meta.sessionId);
  try {
    await store.openSession(meta);
  } finally {
    // 草稿不是消息缓存：重开后写回，用户没发出去的内容不能因为「清空」而消失。
    if (draft) store.setDraft(meta.sessionId, draft);
    // 重开会话会把 Tab 追加到末尾：搬回原位置，tab 栏顺序不因清缓存而跳动。
    const reopened = store.state.tabs.findIndex((c) => c.sessionId === meta.sessionId);
    if (index >= 0 && reopened >= 0) store.moveTab(reopened, index);
  }
}

/**
 * 恢复默认布局（Issue #116）：两个面板的宽度目前是固定 token（无法拖拽改宽），
 * 所以这里重置的是「面板显隐 + 正文宽度」，并把这一点写进设置页的说明文案。
 */
function resetLayout() {
  sidebarOpen.value = true;
  inspectorOpen.value = true;
  if (appearance.value.contentWidth !== "fixed") {
    patchAppearance({ ...appearance.value, contentWidth: "fixed" });
  }
}

/** 复制数据目录路径：打开文件夹需要后端命令，本切片只保证路径可复制。 */
async function copyDataDirectory() {
  copyState.value = (await copyText(dataDirectory.value)) ? "copied" : "failed";
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
  } else if (key === "f") {
    // Ctrl+F / ⌘F：打开搜索抽屉并把焦点放进搜索框（浏览器默认的页内查找在这里没有意义）。
    event.preventDefault();
    openSearch();
  }
}

onMounted(async () => {
  window.addEventListener("keydown", onKeydown);
  try {
    info.value = await runtimeInfo();
  } catch {
    info.value = null;
  }
  // Tauri 版本只在桌面端可读（core:app 的 getTauriVersion）；浏览器预览保持 null。
  if (store.bridgeAvailable) {
    try {
      const { getTauriVersion } = await import("@tauri-apps/api/app");
      tauriVersion.value = await getTauriVersion();
    } catch {
      tauriVersion.value = null;
    }
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
          <AppTooltip text="会话内搜索 (Ctrl+F)">
            <button
              class="icon-button"
              type="button"
              :aria-label="searchOpen ? '关闭搜索面板' : '打开搜索面板'"
              :aria-expanded="searchOpen"
              aria-keyshortcuts="Control+F"
              @click="searchOpen ? closeSearch() : openSearch()"
            >
              <Search :size="18" :stroke-width="1.75" aria-hidden="true" />
            </button>
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
        :settings="session"
        :focus-message-id="focusMessageId"
        :focus-nonce="focusNonce"
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

    <SearchDrawer
      v-if="searchOpen"
      ref="searchDrawer"
      :tab="activeTab"
      :bridge-available="store.bridgeAvailable"
      :notice="searchNotice"
      @close="closeSearch"
      @query="onSearchQuery"
      @jump="onSearchJump"
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
      :appearance="appearance"
      :busy-delivery="busyDelivery"
      :session="session"
      :system="system"
      :info="info"
      :bridge-available="store.bridgeAvailable"
      :tauri-version="tauriVersion"
      :data-directory="dataDirectory"
      :copy-state="copyState"
      :clear-blocked-reason="clearBlockedReason"
      @close="settingsOpen = false"
      @update:theme="(value: ThemeName) => void setTheme(value)"
      @update:appearance="(value: Appearance) => patchAppearance(value)"
      @update:busyDelivery="setBusyDelivery"
      @update:session="patchSession"
      @update:system="patchSystem"
      @clear-session="clearSessionCache"
      @reset-layout="resetLayout"
      @copy-data-dir="copyDataDirectory"
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
