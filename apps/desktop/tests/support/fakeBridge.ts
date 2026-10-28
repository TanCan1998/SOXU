/**
 * 测试用假 bridge：记录调用、按下发方式投递运行时事件，不启动任何进程。
 *
 * 只实现 `WorkspaceBridge` 契约，因此测试验证的是真实组件逻辑，
 * 而不是把实现替换成另一套假逻辑。
 */

import type {
  CreateWorktreeInput,
  EntryRef,
  EntryText,
  HistoryPage,
  ProjectId,
  ProjectSummary,
  RetryStatus,
  RuntimeEvent,
  RuntimeStarted,
  RuntimeStatus,
  SessionId,
  SessionMode,
  WorktreeDiffView,
  WorktreeId,
  WorktreeRemovalView,
  WorktreeSummary,
  WorktreeWorkspace,
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

/** 一份"干净、可删除"的附加工作树；用例按需覆盖字段。 */
export function sampleWorktree(overrides: Partial<WorktreeSummary> = {}): WorktreeSummary {
  const id = overrides.id ?? "wkt_agent_issue_5";
  return {
    id,
    projectId: overrides.projectId ?? "prj_1",
    path: overrides.path ?? `F:/work/${id}`,
    name: overrides.name ?? id.replace("wkt_", ""),
    branch: overrides.branch ?? "agent/issue-5",
    head: overrides.head ?? "0123456789abcdef0123456789abcdef01234567",
    primary: overrides.primary ?? false,
    missing: overrides.missing ?? false,
    locked: overrides.locked ?? null,
    prunable: overrides.prunable ?? null,
    dirty: overrides.dirty ?? false,
    staged: overrides.staged ?? 0,
    unstaged: overrides.unstaged ?? 0,
    untracked: overrides.untracked ?? 0,
    conflicts: overrides.conflicts ?? 0,
    changesTruncated: overrides.changesTruncated ?? false,
    indexLocked: overrides.indexLocked ?? false,
    operation: overrides.operation ?? null,
    sessionIds: overrides.sessionIds ?? [],
    activeSessionIds: overrides.activeSessionIds ?? [],
    blockers: overrides.blockers ?? [],
    removable: overrides.removable ?? (overrides.blockers?.length ?? 0) === 0,
    token: overrides.token ?? `tok-${id}`,
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
  /** 后端下发的重试预算快照；测试按需注入，默认没有（旧后端行为）。 */
  retry: RetryStatus | null = null;
  worktreeRoot = "F:/work/project";
  worktreeList: WorktreeSummary[] = [];
  staleWorktrees: string[] = [];
  pruneToken = "tok-prune";
  worktreeListError: string | null = null;
  worktreeListGate: Promise<void> | null = null;
  createError: string | null = null;
  createGate: Promise<void> | null = null;
  planError: string | null = null;
  planOverride: WorktreeSummary | null = null;
  diffError: string | null = null;
  diff: WorktreeDiffView | null = null;
  removeError: string | null = null;
  removeGate: Promise<void> | null = null;
  pruneError: string | null = null;
  /** 每次删除成功后从 worktreeList 里移除的工作树 id。 */
  readonly removed: WorktreeId[] = [];

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
      retry: this.retry,
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

  async listWorktrees(projectId: ProjectId): Promise<WorktreeWorkspace> {
    this.calls.push({ method: "listWorktrees", args: [projectId] });
    if (this.worktreeListGate) await this.worktreeListGate;
    if (this.worktreeListError) throw new Error(this.worktreeListError);
    return {
      projectId,
      root: this.worktreeRoot,
      worktrees: this.worktreeList.map((item) => ({ ...item })),
      stale: [...this.staleWorktrees],
      pruneToken: this.pruneToken,
    };
  }

  async createWorktree(
    projectId: ProjectId,
    input: CreateWorktreeInput,
  ): Promise<WorktreeSummary> {
    this.calls.push({ method: "createWorktree", args: [projectId, input] });
    if (this.createGate) await this.createGate;
    if (this.createError) throw new Error(this.createError);
    const created = sampleWorktree({
      id: `wkt_${input.branch.replace(/[^a-z0-9]+/gi, "_")}`,
      projectId,
      path: `${this.worktreeRoot}-worktrees/${input.branch}`,
      name: input.branch,
      branch: input.branch,
    });
    this.worktreeList = [...this.worktreeList, created];
    return created;
  }

  async planWorktreeRemoval(
    projectId: ProjectId,
    worktreeId: WorktreeId,
  ): Promise<WorktreeSummary> {
    this.calls.push({ method: "planWorktreeRemoval", args: [projectId, worktreeId] });
    if (this.planError) throw new Error(this.planError);
    if (this.planOverride) return { ...this.planOverride };
    const found = this.worktreeList.find((item) => item.id === worktreeId);
    if (!found) throw new Error("E_GIT_WORKTREE_UNKNOWN: 工作树未登记");
    return { ...found };
  }

  async worktreeDiff(
    projectId: ProjectId,
    worktreeId: WorktreeId,
    staged: boolean,
  ): Promise<WorktreeDiffView> {
    this.calls.push({ method: "worktreeDiff", args: [projectId, worktreeId, staged] });
    if (this.diffError) throw new Error(this.diffError);
    return (
      this.diff ?? {
        worktreeId,
        staged,
        files: [],
        totalFiles: 0,
        patch: "",
        truncated: false,
        bytesRead: 0,
      }
    );
  }

  async removeWorktree(
    projectId: ProjectId,
    worktreeId: WorktreeId,
    token: string,
  ): Promise<WorktreeRemovalView> {
    this.calls.push({ method: "removeWorktree", args: [projectId, worktreeId, token] });
    if (this.removeGate) await this.removeGate;
    if (this.removeError) throw new Error(this.removeError);
    const removed = this.worktreeList.find((item) => item.id === worktreeId);
    this.worktreeList = this.worktreeList.filter((item) => item.id !== worktreeId);
    this.removed.push(worktreeId);
    return {
      projectId,
      worktreeId,
      path: removed?.path ?? "",
      branch: removed?.branch ?? null,
    };
  }

  async pruneWorktrees(projectId: ProjectId, token: string): Promise<number> {
    this.calls.push({ method: "pruneWorktrees", args: [projectId, token] });
    if (this.pruneError) throw new Error(this.pruneError);
    const count = this.staleWorktrees.length;
    this.staleWorktrees = [];
    return count;
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
