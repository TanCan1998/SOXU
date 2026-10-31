/**
 * Pinia 域 store：把 `WorkspaceSession` 的状态接到 Vue 响应式系统。
 *
 * store 自己不实现业务规则——所有 Tab/历史/运行时行为都在 workspace 核心层，
 * 这样测试和 UI 使用同一份逻辑。
 */

import { computed, reactive, ref } from "vue";
import { defineStore } from "pinia";

import { createTauriBridge, createUnavailableBridge, isTauriRuntime } from "../workspace/bridge.ts";
import { GitWorkspace } from "../workspace/gitWorkspace.ts";
import {
  WorkspaceSession,
  type RuntimeEventObserver,
} from "../workspace/sessionWorkspace.ts";
import { FileBrowser } from "../workspace/filesWorkspace.ts";
import { WorktreeCatalog } from "../workspace/worktreeWorkspace.ts";
import {
  createWorkspaceState,
  type CreateWorktreeInput,
  type GitLayout,
  type FileSortKey,
  type FileViewMode,
  type SendPromptOptions,
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
  const git = new GitWorkspace(bridge, state);
  const files = new FileBrowser(bridge, state);

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
  /** Git 抽屉状态：只观察仓库事实，不改写任何 Tab。 */
  const gitView = computed(() => state.git);
  const selectedWorktree = computed(
    () => state.worktrees.worktrees.find((item) => item.id === state.worktrees.selectedId) ?? null,
  );
  /** 文件抽屉状态：只装已展开过的目录层，与 Tab 状态完全分开。 */
  const fileView = computed(() => state.files);
  const fileRows = computed(() => files.rows());

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
  function openTemporary(): Promise<SessionId | null> {
    return session.openTemporary(state.projects[0]?.id ?? null);
  }

  /** 显式把临时会话转为普通会话；失败时保留临时会话并显示原因。 */
  function promote(sessionId: SessionId): Promise<void> {
    return session.promoteSession(sessionId);
  }

  function setActive(sessionId: SessionId | null): void {
    session.setActive(sessionId);
  }

  /**
   * 订阅运行时事件（已按 generation 过滤），返回取消订阅函数。
   *
   * 通知层（`useNotifications`）用它接上同一条事件流，不另开 Tauri 监听器；
   * 取消订阅由调用方在作用域销毁时执行。
   */
  function onRuntimeEvent(observer: RuntimeEventObserver): () => void {
    return session.onRuntimeEvent(observer);
  }

  function setDraft(sessionId: SessionId, draft: string): void {
    session.setDraft(sessionId, draft);
  }

  /** 拖拽排序后写回顺序；activeSessionId 保持不动（整理栏位不是切换会话）。 */
  function moveTab(fromIndex: number, toIndex: number): boolean {
    return session.moveTab(fromIndex, toIndex);
  }

  function send(
    sessionId: SessionId,
    text: string,
    options?: SendPromptOptions,
  ): Promise<void> {
    return session.sendPrompt(sessionId, text, options);
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

  /**
   * 统计快照（Issue #119）：事件驱动的刷新入口，打开浮窗时也走这里。
   * store 不缓存第二份数据，视图始终读 Tab 上的那一份。
   */
  function refreshStats(sessionId: SessionId): Promise<void> {
    return session.refreshStats(sessionId);
  }

  /**
   * 会话内搜索的输入防抖（Issue #118）：请求与定时器都在 WorkspaceSession 里，
   * store 只做转发——UI 不自己起定时器，避免出现第二份防抖窗口。
   *
   * 只暴露这一个入口：抽屉的每一次输入都走它，没有「绕过防抖立刻搜一次」的第二条路径，
   * 否则两条路径的语义迟早分叉（一条记请求序号、一条不记）。
   */
  function scheduleSearch(sessionId: SessionId, query: string): void {
    session.scheduleSearch(sessionId, query);
  }

  /** 取消待触发的防抖（清空输入框时用），不会取消已在途的请求。 */
  function cancelSearch(sessionId: SessionId): void {
    session.cancelScheduledSearch(sessionId);
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

  /** 打开/切换 Git 抽屉观察的项目与工作树；身份变化时清空旧仓库的视图。 */
  function openGit(projectId: string | null, worktreeId: WorktreeId | null): Promise<void> {
    return git.open(projectId, worktreeId);
  }

  function refreshGit(): Promise<void> {
    return git.reload();
  }

  function selectGitFile(path: string | null): Promise<void> {
    return git.select(path);
  }

  function toggleGitDir(path: string): void {
    git.toggleDir(path);
  }

  function setGitLayout(layout: GitLayout): void {
    git.setLayout(layout);
  }

  function collapseGitAll(): void {
    git.collapseAll();
  }

  function stageGitAll(): Promise<boolean> {
    return git.stageAll();
  }

  function commitGit(): Promise<boolean> {
    return git.commit();
  }

  function pushGit(): Promise<boolean> {
    return git.push();
  }

  function pullGit(): Promise<boolean> {
    return git.pull();
  }

  function setGitMessage(value: string): void {
    git.setCommitMessage(value);
  }

  function openFiles(projectId: string | null): Promise<void> {
    return files.open(projectId);
  }

  function refreshFiles(path?: string): Promise<void> {
    return files.refresh(path);
  }

  function toggleFileDirectory(path: string): Promise<void> {
    return files.toggle(path);
  }

  function setFileSort(key: FileSortKey): void {
    files.setSort(key);
  }

  function setFileView(mode: FileViewMode): void {
    files.setView(mode);
  }

  function setFileShowHidden(show: boolean): void {
    files.setShowHidden(show);
  }

  function selectFile(path: string): Promise<unknown> {
    return files.select(path);
  }

  function closeFilePreview(): void {
    files.clearPreview();
  }

  function searchFiles(query: string): Promise<unknown> {
    return files.search(query);
  }

  function clearFileSearch(): void {
    files.clearSearch();
  }

  function createFile(path: string): Promise<boolean> {
    return files.createFile(path);
  }

  function renameFile(from: string, to: string): Promise<boolean> {
    return files.rename(from, to);
  }

  function removeFile(
    path: string,
    options: { recursive: boolean; confirmName: string },
  ): Promise<boolean> {
    return files.remove(path, options);
  }

  async function dispose(): Promise<void> {
    worktrees.dispose();
    git.dispose();
    files.dispose();
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
    gitView,
    fileView,
    fileRows,
    bootstrap,
    addProject,
    refreshProjects,
    refreshProject,
    openSession,
    openTemporary,
    promote,
    setActive,
    onRuntimeEvent,
    setDraft,
    moveTab,
    send,
    cancel,
    stop,
    closeTab,
    loadMore,
    refreshStats,
    scheduleSearch,
    cancelSearch,
    openWorktrees,
    reloadWorktrees,
    selectWorktree,
    createWorktree,
    previewWorktreeDiff,
    planWorktreeRemoval,
    confirmWorktreeRemoval,
    cancelWorktreeRemoval,
    pruneWorktrees,
    openGit,
    refreshGit,
    selectGitFile,
    toggleGitDir,
    setGitLayout,
    collapseGitAll,
    stageGitAll,
    commitGit,
    pushGit,
    pullGit,
    setGitMessage,
    openFiles,
    refreshFiles,
    toggleFileDirectory,
    setFileSort,
    setFileView,
    setFileShowHidden,
    selectFile,
    closeFilePreview,
    searchFiles,
    clearFileSearch,
    createFile,
    renameFile,
    removeFile,
    dispose,
  };
});
