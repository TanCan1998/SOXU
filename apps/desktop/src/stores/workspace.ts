/**
 * Pinia 域 store：把 `WorkspaceSession` 的状态接到 Vue 响应式系统。
 *
 * store 自己不实现业务规则——所有 Tab/历史/运行时行为都在 workspace 核心层，
 * 这样测试和 UI 使用同一份逻辑。
 */

import { computed, reactive, ref } from "vue";
import { defineStore } from "pinia";

import { createTauriBridge, createUnavailableBridge, isTauriRuntime } from "../workspace/bridge.ts";
import { WorkspaceSession } from "../workspace/sessionWorkspace.ts";
import { WorktreeCatalog } from "../workspace/worktreeWorkspace.ts";
import {
  createWorkspaceState,
  type CreateWorktreeInput,
  type SessionId,
  type SessionMode,
  type WorktreeId,
} from "../workspace/types.ts";

export const useWorkspaceStore = defineStore("workspace", () => {
  const bridgeAvailable = isTauriRuntime();
  const bridge = bridgeAvailable
    ? createTauriBridge()
    : createUnavailableBridge("当前是浏览器预览，尚未连接本机运行时；请用 pnpm tauri:dev 启动桌面端");
  const state = reactive(createWorkspaceState());
  state.bridgeAvailable = bridgeAvailable;
  const session = new WorkspaceSession(bridge, state);
  const worktrees = new WorktreeCatalog(bridge, state);

  const bootstrapped = ref(false);
  const busy = ref(false);
  const activeTab = computed(
    () => state.tabs.find((tab) => tab.sessionId === state.activeSessionId) ?? null,
  );
  /** 侧栏会话清单：项目名 + 会话标题，全部来自会话目录（不是本地假数据）。 */
  const sessionList = computed(() =>
    state.projects.flatMap((project) =>
      project.sessions.map((summary) => ({
        ...summary,
        projectName: project.name,
      })),
    ),
  );
  const hasProjects = computed(() => state.projects.length > 0);
  /** 工作树面板状态：与 Tab 状态完全分开，选择工作树不会切换会话。 */
  const worktreeView = computed(() => state.worktrees);
  const selectedWorktree = computed(
    () => state.worktrees.worktrees.find((item) => item.id === state.worktrees.selectedId) ?? null,
  );

  async function bootstrap(): Promise<void> {
    if (bootstrapped.value) return;
    bootstrapped.value = true;
    if (!bridgeAvailable) return;
    await session.loadProjects();
  }

  async function addProject(root: string): Promise<void> {
    busy.value = true;
    try {
      await session.registerProject(root.trim());
    } finally {
      busy.value = false;
    }
  }

  async function refreshProjects(): Promise<void> {
    await session.loadProjects();
  }

  async function refreshProject(projectId: string): Promise<void> {
    busy.value = true;
    try {
      await session.refreshProject(projectId);
    } finally {
      busy.value = false;
    }
  }

  function openSession(meta: {
    sessionId: SessionId;
    projectId: string;
    title: string;
    mode?: SessionMode;
    worktreeId?: WorktreeId | null;
  }): Promise<void> {
    return session.openSession(meta);
  }

  /**
   * 新建临时会话：身份由后端分配（只在内存里），因此重启后不会出现在历史中。
   * 没有已登记项目时仍可打开（浏览器预览/空工作区），此时不会写任何后端状态。
   */
  function openTemporary(): Promise<void> {
    return session.openTemporary(state.projects[0]?.id ?? null);
  }

  /** 显式把临时会话转为普通会话；失败时保留临时会话并显示原因。 */
  function promote(sessionId: SessionId): Promise<void> {
    return session.promoteSession(sessionId);
  }

  function setActive(sessionId: SessionId | null): void {
    session.setActive(sessionId);
  }

  function setDraft(sessionId: SessionId, draft: string): void {
    session.setDraft(sessionId, draft);
  }

  /** 拖拽排序后写回顺序；activeSessionId 保持不动（整理栏位不是切换会话）。 */
  function moveTab(fromIndex: number, toIndex: number): boolean {
    return session.moveTab(fromIndex, toIndex);
  }

  function send(sessionId: SessionId, text: string): Promise<void> {
    return session.sendPrompt(sessionId, text);
  }

  function cancel(sessionId: SessionId): Promise<void> {
    return session.cancel(sessionId);
  }

  function stop(sessionId: SessionId): Promise<void> {
    return session.stopRuntime(sessionId);
  }

  function closeTab(sessionId: SessionId): Promise<void> {
    return session.closeTab(sessionId);
  }

  function loadMore(sessionId: SessionId): Promise<void> {
    return session.loadMore(sessionId);
  }

  function openWorktrees(projectId: string): Promise<void> {
    return worktrees.open(projectId);
  }

  function reloadWorktrees(): Promise<void> {
    return worktrees.reload();
  }

  function selectWorktree(worktreeId: WorktreeId | null): void {
    worktrees.select(worktreeId);
  }

  function createWorktree(input: CreateWorktreeInput) {
    return worktrees.create(input);
  }

  function previewWorktreeDiff(worktreeId?: WorktreeId | null, staged = false) {
    return worktrees.previewDiff(worktreeId ?? state.worktrees.selectedId, staged);
  }

  function planWorktreeRemoval(worktreeId: WorktreeId) {
    return worktrees.planRemoval(worktreeId);
  }

  function confirmWorktreeRemoval(): Promise<boolean> {
    return worktrees.confirmRemoval();
  }

  function cancelWorktreeRemoval(): void {
    worktrees.cancelRemoval();
  }

  function pruneWorktrees() {
    return worktrees.prune();
  }

  async function dispose(): Promise<void> {
    worktrees.dispose();
    await session.dispose();
  }

  return {
    state,
    bridgeAvailable,
    bootstrapped,
    busy,
    activeTab,
    sessionList,
    hasProjects,
    worktreeView,
    selectedWorktree,
    bootstrap,
    addProject,
    refreshProjects,
    refreshProject,
    openSession,
    openTemporary,
    promote,
    setActive,
    setDraft,
    moveTab,
    send,
    cancel,
    stop,
    closeTab,
    loadMore,
    openWorktrees,
    reloadWorktrees,
    selectWorktree,
    createWorktree,
    previewWorktreeDiff,
    planWorktreeRemoval,
    confirmWorktreeRemoval,
    cancelWorktreeRemoval,
    pruneWorktrees,
    dispose,
  };
});
