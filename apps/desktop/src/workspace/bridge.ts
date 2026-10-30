/**
 * Tauri 桥：把 `WorkspaceBridge` 契约落到 Rust 命令与运行时事件上。
 *
 * 浏览器预览（无 Tauri）时返回一个显式失败的实现：UI 必须显示「未连接」，
 * 不能用假数据冒充真实运行时。
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type {
  CreateWorktreeInput,
  EntryRef,
  EntryText,
  HistoryPage,
  ProjectId,
  ProjectSummary,
  PromotedSession,
  RuntimeEvent,
  RuntimeStarted,
  RuntimeStatus,
  SearchOptions,
  SessionId,
  SessionStats,
  SendPromptOptions,
  SessionMode,
  SessionSearchResult,
  TemporarySessionView,
  WorktreeDiffView,
  WorktreeId,
  WorktreeRemovalView,
  WorktreeSummary,
  WorktreeWorkspace,
  WorkspaceBridge,
} from "./types.ts";

/** 与 `apps/desktop/src-tauri/src/events.rs` 的常量保持一致。 */
export const RUNTIME_EVENT_NAME = "soxu://runtime-event";

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function createTauriBridge(): WorkspaceBridge {
  return {
    listProjects: () => invoke<ProjectSummary[]>("list_projects"),
    registerProject: (root: string) => invoke<ProjectSummary>("register_project", { root }),
    refreshProject: (projectId: ProjectId) =>
      invoke<ProjectSummary>("refresh_project", { projectId }),
    fetchHistory: (sessionId: SessionId, offset: number, limit: number) =>
      invoke<HistoryPage>("open_session_history", { sessionId, offset, limit }),
    fetchTexts: (sessionId: SessionId, refs: EntryRef[]) =>
      invoke<EntryText[]>("read_session_texts", { sessionId, entries: refs }),
    searchSession: (sessionId: SessionId, query: string, options: SearchOptions = {}) =>
      invoke<SessionSearchResult>("search_session", {
        sessionId,
        query,
        limit: options.limit ?? null,
        afterOrdinal: options.afterOrdinal ?? null,
      }),
    startRuntime: (sessionId: SessionId, mode: SessionMode) =>
      invoke<RuntimeStarted>("start_session", { sessionId, temporary: mode === "temporary" }),
    openTemporarySession: (projectId: ProjectId) =>
      invoke<TemporarySessionView>("open_temporary_session", { projectId }),
    bindTemporaryFile: (sessionId: SessionId, file: string) =>
      invoke<TemporarySessionView>("bind_temporary_session_file", { sessionId, file }),
    promoteSession: (sessionId: SessionId) =>
      invoke<PromotedSession>("promote_session", { sessionId }),
    discardTemporarySession: (sessionId: SessionId) =>
      invoke<boolean>("discard_temporary_session", { sessionId }),
    // mode / thinking 是可选参数：undefined 在 JSON 序列化时被丢掉，
    // Rust 侧按 Option<T> 接收（缺省即 None），旧后端也不会因此报错。
    sendPrompt: (sessionId: SessionId, text: string, options?: SendPromptOptions) =>
      invoke<void>("send_prompt", {
        sessionId,
        text,
        mode: options?.mode,
        thinking: options?.thinking,
      }),
    cancelRuntime: (sessionId: SessionId) => invoke<void>("cancel_session", { sessionId }),
    stopRuntime: (sessionId: SessionId) => invoke<void>("stop_session", { sessionId }),
    runtimeStatus: (sessionId: SessionId) =>
      invoke<RuntimeStatus | null>("runtime_status", { sessionId }),
    sessionStats: (sessionId: SessionId) =>
      invoke<SessionStats>("session_stats", { sessionId }),
    retainSession: async (sessionId: SessionId) => {
      await invoke<number>("retain_session_events", { sessionId });
    },
    releaseSession: async (sessionId: SessionId) => {
      await invoke<number>("release_session_events", { sessionId });
    },
    listWorktrees: (projectId: ProjectId) =>
      invoke<WorktreeWorkspace>("list_worktrees", { projectId }),
    createWorktree: (projectId: ProjectId, input: CreateWorktreeInput) =>
      invoke<WorktreeSummary>("create_worktree", { projectId, input }),
    planWorktreeRemoval: (projectId: ProjectId, worktreeId: WorktreeId) =>
      invoke<WorktreeSummary>("plan_worktree_removal", { projectId, worktreeId }),
    worktreeDiff: (projectId: ProjectId, worktreeId: WorktreeId, staged: boolean) =>
      invoke<WorktreeDiffView>("worktree_diff", { projectId, worktreeId, staged }),
    removeWorktree: (projectId: ProjectId, worktreeId: WorktreeId, token: string) =>
      invoke<WorktreeRemovalView>("remove_worktree", { projectId, worktreeId, token }),
    pruneWorktrees: (projectId: ProjectId, token: string) =>
      invoke<number>("prune_worktrees", { projectId, token }),
    subscribe(handler: (event: RuntimeEvent) => void): () => void {
      let disposed = false;
      let unlisten: UnlistenFn | null = null;
      // listen 是异步注册：即使调用方立刻取消订阅，也不会留下悬挂监听器。
      void listen<RuntimeEvent>(RUNTIME_EVENT_NAME, (event) => handler(event.payload))
        .then((off) => {
          if (disposed) off();
          else unlisten = off;
        })
        .catch((error: unknown) => {
          console.error("SOXU: 运行时事件订阅失败", error);
        });
      return () => {
        disposed = true;
        unlisten?.();
        unlisten = null;
      };
    },
  };
}

/** 浏览器预览：所有调用都显式失败，界面据此显示「未连接」。 */
export function createUnavailableBridge(reason: string): WorkspaceBridge {
  const fail = async (): Promise<never> => {
    throw new Error(reason);
  };
  return {
    listProjects: fail,
    registerProject: fail,
    refreshProject: fail,
    fetchHistory: fail,
    fetchTexts: fail,
    searchSession: fail,
    startRuntime: fail,
    openTemporarySession: fail,
    bindTemporaryFile: fail,
    promoteSession: fail,
    discardTemporarySession: fail,
    sendPrompt: fail,
    cancelRuntime: fail,
    stopRuntime: fail,
    runtimeStatus: async () => null,
    sessionStats: fail,
    retainSession: async () => undefined,
    releaseSession: async () => undefined,
    listWorktrees: fail,
    createWorktree: fail,
    planWorktreeRemoval: fail,
    worktreeDiff: fail,
    removeWorktree: fail,
    pruneWorktrees: fail,
    subscribe: () => () => undefined,
  };
}
