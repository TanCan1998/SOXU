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
import { createWorkspaceState, type SessionId, type SessionMode } from "../workspace/types.ts";

export const useWorkspaceStore = defineStore("workspace", () => {
  const bridgeAvailable = isTauriRuntime();
  const bridge = bridgeAvailable
    ? createTauriBridge()
    : createUnavailableBridge("当前是浏览器预览，未连接 Rust 运行时；请用 pnpm tauri:dev 启动桌面端");
  const state = reactive(createWorkspaceState());
  state.bridgeAvailable = bridgeAvailable;
  const session = new WorkspaceSession(bridge, state);

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
  }): Promise<void> {
    return session.openSession(meta);
  }

  function openTemporary(): Promise<void> {
    const id = `ses_tmp_${Date.now().toString(36)}`;
    return session.openSession({
      sessionId: id,
      projectId: state.projects[0]?.id ?? "prj_memory",
      title: "临时会话",
      mode: "temporary",
    });
  }

  function setActive(sessionId: SessionId | null): void {
    session.setActive(sessionId);
  }

  function setDraft(sessionId: SessionId, draft: string): void {
    session.setDraft(sessionId, draft);
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

  async function dispose(): Promise<void> {
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
    bootstrap,
    addProject,
    refreshProjects,
    refreshProject,
    openSession,
    openTemporary,
    setActive,
    setDraft,
    send,
    cancel,
    stop,
    closeTab,
    loadMore,
    dispose,
  };
});
