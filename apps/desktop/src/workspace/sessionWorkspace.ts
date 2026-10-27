/**
 * 多会话工作区核心：Tab 生命周期、历史分页、流式追加、取消与订阅释放。
 *
 * 这一层不依赖 Vue：Pinia store 把 `WorkspaceState` 放进 `reactive()`，
 * 组件只读状态、调用方法；测试用普通对象 + 假 bridge 驱动同一份逻辑。
 *
 * 三条不可让步的规则：
 * 1. 事件必须匹配 `runtimeId + generation`，迟到事件整条丢弃。
 * 2. 关闭 Tab 只释放订阅，不停止 Agent（Pane 销毁 ≠ 停止任务）。
 * 3. dispose 之后任何 await 回来的结果都不得再写状态。
 */

import {
  HISTORY_PAGE_SIZE,
  createWorkspaceState,
  type ChatMessage,
  type EntryRef,
  type HistoryEntry,
  type HistoryPage,
  type RuntimeEvent,
  type SessionId,
  type SessionMode,
  type SessionTab,
  type WorkspaceBridge,
  type WorkspaceState,
} from "./types.ts";
import {
  deltaText,
  describeError,
  finalizeStreaming,
  mergeHistory,
  pushDiagnostic,
} from "./mapping.ts";

/** 单页最多补齐多少条正文；与服务端 `MAX_BATCH_TEXTS` 保持一致。 */
export const MAX_TEXT_HYDRATION = 40;
let liveSeq = 0;

export interface SessionMeta {
  sessionId: SessionId;
  projectId: string;
  title: string;
  mode?: SessionMode;
}

export function createTab(meta: SessionMeta): SessionTab {
  return {
    sessionId: meta.sessionId,
    projectId: meta.projectId,
    title: meta.title,
    mode: meta.mode ?? "persistent",
    status: "idle",
    error: null,
    messages: [],
    history: { loaded: 0, total: 0, next: null, loading: false },
    runtime: { runtimeId: null, generation: 0, state: "idle", exitReason: null },
    draft: "",
    diagnostics: [],
  };
}

export class WorkspaceSession {
  private readonly bridge: WorkspaceBridge;
  private readonly state: WorkspaceState;
  private readonly pageSize: number;
  private unlisten: (() => void) | null = null;
  private disposed = false;

  constructor(
    bridge: WorkspaceBridge,
    state: WorkspaceState = createWorkspaceState(),
    options: { pageSize?: number } = {},
  ) {
    this.bridge = bridge;
    this.state = state;
    this.pageSize = options.pageSize ?? HISTORY_PAGE_SIZE;
  }

  get workspace(): WorkspaceState {
    return this.state;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** 0 或 1：整块工作区只保留一个运行时事件监听器。 */
  get subscriptionCount(): number {
    return this.unlisten ? 1 : 0;
  }

  tab(sessionId: SessionId): SessionTab | undefined {
    return this.state.tabs.find((tab) => tab.sessionId === sessionId);
  }

  setActive(sessionId: SessionId | null): void {
    this.state.activeSessionId = sessionId;
  }

  setDraft(sessionId: SessionId, draft: string): void {
    const tab = this.tab(sessionId);
    if (tab) tab.draft = draft;
  }

  async loadProjects(): Promise<void> {
    this.state.projectsLoading = true;
    try {
      const projects = await this.bridge.listProjects();
      if (this.disposed) return;
      this.state.projects = projects;
      this.state.projectsError = null;
    } catch (error) {
      if (this.disposed) return;
      this.state.projectsError = describeError(error);
    } finally {
      if (!this.disposed) this.state.projectsLoading = false;
    }
  }

  async registerProject(root: string): Promise<void> {
    try {
      const project = await this.bridge.registerProject(root);
      if (this.disposed) return;
      this.state.projects = [
        ...this.state.projects.filter((candidate) => candidate.id !== project.id),
        project,
      ];
      this.state.projectsError = null;
    } catch (error) {
      if (!this.disposed) this.state.projectsError = describeError(error);
    }
  }

  async refreshProject(projectId: string): Promise<void> {
    try {
      const project = await this.bridge.refreshProject(projectId);
      if (this.disposed) return;
      this.state.projects = this.state.projects.map((candidate) =>
        candidate.id === project.id ? project : candidate,
      );
    } catch (error) {
      if (!this.disposed) this.state.projectsError = describeError(error);
    }
  }

  /** 打开（或切换回）一个会话 Tab；已存在时只切换 active，不重复加载。 */
  async openSession(meta: SessionMeta): Promise<void> {
    if (this.disposed) return;
    const existing = this.tab(meta.sessionId);
    if (existing) {
      this.state.activeSessionId = meta.sessionId;
      return;
    }
    const created = createTab(meta);
    this.state.tabs = [...this.state.tabs, created];
    this.state.activeSessionId = meta.sessionId;
    // 必须取回响应式代理：直接改 `created` 原始对象不会触发 Vue 重新渲染。
    const tab = this.tab(meta.sessionId) ?? created;
    this.ensureSubscribed();
    try {
      await this.bridge.retainSession(meta.sessionId);
    } catch (error) {
      if (!this.disposed) tab.diagnostics = pushDiagnostic(tab, describeError(error));
    }
    await this.loadPage(tab, 0);
  }

  async loadMore(sessionId: SessionId): Promise<void> {
    const tab = this.tab(sessionId);
    if (!tab || this.disposed) return;
    if (tab.history.next === null || tab.history.loading) return;
    await this.loadPage(tab, tab.history.next);
  }

  async startRuntime(sessionId: SessionId): Promise<void> {
    const tab = this.tab(sessionId);
    if (!tab || this.disposed || tab.runtime.runtimeId) return;
    try {
      const started = await this.bridge.startRuntime(tab.sessionId, tab.mode);
      if (this.disposed || !this.tab(tab.sessionId)) return;
      tab.runtime = {
        runtimeId: started.runtimeId,
        generation: started.generation,
        state: started.state,
        exitReason: null,
      };
      tab.error = null;
      if (tab.status === "idle" || tab.status === "error") tab.status = "ready";
    } catch (error) {
      if (this.disposed) return;
      tab.status = "error";
      tab.error = describeError(error);
    }
  }

  async sendPrompt(sessionId: SessionId, text: string): Promise<void> {
    const tab = this.tab(sessionId);
    const content = text.trim();
    if (!tab || this.disposed || !content) return;
    if (tab.status === "running" || tab.status === "cancelling" || tab.status === "loading") return;
    if (!tab.runtime.runtimeId) {
      await this.startRuntime(sessionId);
      if (!tab.runtime.runtimeId) return; // 启动失败：保留草稿，由 UI 展示错误
    }
    tab.draft = "";
    tab.messages.push({
      id: `live:${tab.runtime.generation}:${++liveSeq}`,
      ordinal: null,
      role: "user",
      text: content,
      partial: false,
      streaming: false,
      source: "live",
      createdAt: new Date().toISOString(),
    });
    tab.status = "running";
    tab.error = null;
    try {
      await this.bridge.sendPrompt(tab.sessionId, content);
    } catch (error) {
      if (this.disposed) return;
      tab.status = "error";
      tab.error = describeError(error);
    }
  }

  /** 取消是幂等的：只有 running 状态才发命令，重复点击不会重复 abort。 */
  async cancel(sessionId: SessionId): Promise<void> {
    const tab = this.tab(sessionId);
    if (!tab || this.disposed || tab.status !== "running") return;
    tab.status = "cancelling";
    try {
      await this.bridge.cancelRuntime(tab.sessionId);
    } catch (error) {
      if (this.disposed) return;
      tab.status = "running";
      tab.error = describeError(error);
    }
  }

  async stopRuntime(sessionId: SessionId): Promise<void> {
    const tab = this.tab(sessionId);
    if (!tab || this.disposed) return;
    try {
      await this.bridge.stopRuntime(tab.sessionId);
    } catch (error) {
      if (!this.disposed) tab.error = describeError(error);
    }
    tab.runtime = {
      runtimeId: null,
      generation: tab.runtime.generation,
      state: "exited",
      exitReason: "requested",
    };
    tab.status = "idle";
    finalizeStreaming(tab);
  }

  /** 关闭 Tab：释放订阅，但不停止 Agent（重新打开时从 JSONL 历史恢复）。 */
  async closeTab(sessionId: SessionId): Promise<void> {
    const tab = this.tab(sessionId);
    if (!tab) return;
    this.state.tabs = this.state.tabs.filter((candidate) => candidate.sessionId !== sessionId);
    if (this.state.activeSessionId === sessionId) {
      this.state.activeSessionId = this.state.tabs.at(-1)?.sessionId ?? null;
    }
    await this.release(sessionId);
  }

  /** 组件卸载：先摘掉监听器，再逐个释放订阅；之后不再写任何状态。 */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const unlisten = this.unlisten;
    this.unlisten = null;
    unlisten?.();
    const sessions = this.state.tabs.map((tab) => tab.sessionId);
    this.state.tabs = [];
    this.state.activeSessionId = null;
    await Promise.allSettled(sessions.map((sessionId) => this.bridge.releaseSession(sessionId)));
  }

  handleEvent(event: RuntimeEvent): void {
    if (this.disposed) return;
    const tab = this.tab(event.sessionId);
    if (!tab) return;
    // 迟到事件：runtimeId 或 generation 不匹配即丢弃，不写状态也不上屏。
    if (
      !tab.runtime.runtimeId ||
      tab.runtime.runtimeId !== event.runtimeId ||
      tab.runtime.generation !== event.generation
    ) {
      return;
    }
    switch (event.type) {
      case "state":
        tab.runtime.state = event.state;
        if (event.state === "running" && tab.status !== "cancelling") tab.status = "running";
        if (event.state === "idle" && tab.status === "running") tab.status = "ready";
        break;
      case "stream":
        applyStream(tab, event);
        break;
      case "settled":
        finalizeStreaming(tab);
        tab.runtime.state = "idle";
        tab.status = "ready";
        break;
      case "warning":
        tab.diagnostics = pushDiagnostic(tab, event.detail);
        break;
      case "stderr":
        tab.diagnostics = pushDiagnostic(tab, event.line);
        break;
      case "exit":
        finalizeStreaming(tab);
        tab.runtime = {
          runtimeId: null,
          generation: tab.runtime.generation,
          state: "exited",
          exitReason: event.reason,
        };
        if (event.reason === "requested_abort" || (event.code ?? 0) === 0) {
          tab.status = "idle";
        } else {
          tab.status = "error";
          const code = event.code === null || event.code === undefined ? "" : ` (code ${event.code})`;
          tab.error = `运行时退出：${event.reason}${code}`;
        }
        break;
      default:
        break;
    }
  }

  private ensureSubscribed(): void {
    if (this.unlisten || this.disposed) return;
    try {
      this.unlisten = this.bridge.subscribe((event) => this.handleEvent(event));
    } catch (error) {
      this.state.bridgeAvailable = false;
      this.state.projectsError = describeError(error);
    }
  }

  private async loadPage(tab: SessionTab, offset: number): Promise<void> {
    tab.history = { ...tab.history, loading: true };
    if (offset === 0) tab.status = "loading";
    try {
      const page = await this.bridge.fetchHistory(tab.sessionId, offset, this.pageSize);
      if (this.disposed || !this.tab(tab.sessionId)) return;
      mergeHistory(tab, page);
      if (tab.status === "loading") tab.status = "ready";
      tab.error = null;
      await this.hydrateTexts(tab, page.entries);
    } catch (error) {
      if (this.disposed) return;
      tab.history = { ...tab.history, loading: false };
      tab.status = "error";
      tab.error = describeError(error);
    }
  }

  /** 补齐完整正文；失败时保留预览，绝不把预览当作完整消息。 */
  private async hydrateTexts(tab: SessionTab, entries: HistoryEntry[]): Promise<void> {
    const refs: EntryRef[] = entries
      .filter((entry) => entry.kind === "message" && entry.length > 0 && !entry.oversized)
      .slice(0, MAX_TEXT_HYDRATION)
      .map((entry) => ({ ordinal: entry.ordinal, offset: entry.offset, length: entry.length }));
    if (refs.length === 0) return;
    try {
      const texts = await this.bridge.fetchTexts(tab.sessionId, refs);
      if (this.disposed) return;
      for (const item of texts) {
        const message = tab.messages.find(
          (candidate) => candidate.id === `${tab.sessionId}:h:${item.ordinal}`,
        );
        if (!message) continue;
        message.text = item.text;
        message.partial = item.clipped;
      }
    } catch (error) {
      tab.diagnostics = pushDiagnostic(tab, `正文读取失败：${describeError(error)}`);
    }
  }

  private async release(sessionId: SessionId): Promise<void> {
    try {
      await this.bridge.releaseSession(sessionId);
    } catch {
      // 释放失败不影响 UI：后端订阅表是会话级小表，计数为 0 时不再 emit。
    }
  }
}

function applyStream(tab: SessionTab, event: Extract<RuntimeEvent, { type: "stream" }>): void {
  const delta = deltaText(event.data);
  if (!delta) return;
  const last = tab.messages.at(-1);
  if (last && last.role === "assistant" && last.streaming) {
    last.text += delta;
    return;
  }
  const message: ChatMessage = {
    id: `live:${tab.runtime.generation}:${++liveSeq}`,
    ordinal: null,
    role: "assistant",
    text: delta,
    partial: false,
    streaming: true,
    source: "live",
    createdAt: null,
  };
  tab.messages.push(message);
}
