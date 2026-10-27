/**
 * 测试用假 bridge：记录调用、按下发方式投递运行时事件，不启动任何进程。
 *
 * 只实现 `WorkspaceBridge` 契约，因此测试验证的是真实组件逻辑，
 * 而不是把实现替换成另一套假逻辑。
 */

import type {
  EntryRef,
  EntryText,
  HistoryPage,
  ProjectSummary,
  RuntimeEvent,
  RuntimeStarted,
  RuntimeStatus,
  SessionId,
  SessionMode,
  WorkspaceBridge,
} from "../../src/workspace/types.ts";

export interface BridgeCall {
  method: string;
  args: unknown[];
}

export function emptyPage(sessionId: SessionId, offset = 0, total = 0): HistoryPage {
  return {
    sessionId,
    entries: [],
    offset,
    total,
    next: null,
    bytesRead: 0,
    clipped: false,
  };
}

export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((settle) => {
    resolve = () => settle();
  });
  return { promise, resolve };
}

export class FakeBridge implements WorkspaceBridge {
  readonly calls: BridgeCall[] = [];
  readonly listeners = new Set<(event: RuntimeEvent) => void>();
  unlistenCount = 0;
  projects: ProjectSummary[] = [];
  pages = new Map<string, HistoryPage>();
  texts = new Map<number, EntryText>();
  startError: string | null = null;
  cancelError: string | null = null;
  historyGate: Promise<void> | null = null;
  status: RuntimeStatus | null = null;

  count(method: string): number {
    return this.calls.filter((call) => call.method === method).length;
  }

  callsOf(method: string): BridgeCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  /** 按顺序把一个历史页挂到某个会话的某个 offset 上。 */
  queuePage(page: HistoryPage): void {
    this.pages.set(`${page.sessionId}@${page.offset}`, page);
  }

  deliver(event: RuntimeEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  async listProjects(): Promise<ProjectSummary[]> {
    this.calls.push({ method: "listProjects", args: [] });
    return this.projects;
  }

  async registerProject(root: string): Promise<ProjectSummary> {
    this.calls.push({ method: "registerProject", args: [root] });
    const project: ProjectSummary = {
      id: `prj_${root}`,
      name: root,
      root,
      worktreeCount: 1,
      sessions: [],
    };
    this.projects = [...this.projects, project];
    return project;
  }

  async refreshProject(projectId: string): Promise<ProjectSummary> {
    this.calls.push({ method: "refreshProject", args: [projectId] });
    const project = this.projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new Error(`项目未注册：${projectId}`);
    return project;
  }

  async fetchHistory(sessionId: SessionId, offset: number, limit: number): Promise<HistoryPage> {
    this.calls.push({ method: "fetchHistory", args: [sessionId, offset, limit] });
    if (this.historyGate) await this.historyGate;
    return this.pages.get(`${sessionId}@${offset}`) ?? emptyPage(sessionId, offset);
  }

  async fetchTexts(sessionId: SessionId, refs: EntryRef[]): Promise<EntryText[]> {
    this.calls.push({ method: "fetchTexts", args: [sessionId, refs] });
    return refs
      .map((ref) => this.texts.get(ref.ordinal))
      .filter((item): item is EntryText => item !== undefined);
  }

  async startRuntime(sessionId: SessionId, mode: SessionMode): Promise<RuntimeStarted> {
    this.calls.push({ method: "startRuntime", args: [sessionId, mode] });
    if (this.startError) throw new Error(this.startError);
    const started: RuntimeStarted = {
      sessionId,
      runtimeId: `${sessionId}#1`,
      generation: 1,
      state: "idle",
    };
    this.status = { ...started, exit: null };
    return started;
  }

  async sendPrompt(sessionId: SessionId, text: string): Promise<void> {
    this.calls.push({ method: "sendPrompt", args: [sessionId, text] });
  }

  async cancelRuntime(sessionId: SessionId): Promise<void> {
    this.calls.push({ method: "cancelRuntime", args: [sessionId] });
    if (this.cancelError) throw new Error(this.cancelError);
  }

  async stopRuntime(sessionId: SessionId): Promise<void> {
    this.calls.push({ method: "stopRuntime", args: [sessionId] });
    this.status = null;
  }

  async runtimeStatus(): Promise<RuntimeStatus | null> {
    this.calls.push({ method: "runtimeStatus", args: [] });
    return this.status;
  }

  async retainSession(sessionId: SessionId): Promise<void> {
    this.calls.push({ method: "retainSession", args: [sessionId] });
  }

  async releaseSession(sessionId: SessionId): Promise<void> {
    this.calls.push({ method: "releaseSession", args: [sessionId] });
  }

  subscribe(handler: (event: RuntimeEvent) => void): () => void {
    this.calls.push({ method: "subscribe", args: [] });
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
      this.unlistenCount += 1;
    };
  }
}
