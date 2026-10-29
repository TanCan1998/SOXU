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
 *
 * 文件超过 400 行的理由：Tab 生命周期、分页、实时流与搜索的状态机共享**同一份**
 * dispose / 关闭边界——把它们拆到别的类会立刻出现「定时器归谁清、迟到响应归谁丢」
 * 的双 owner 问题。纯函数部分已经拆出：映射规则在 `mapping.ts`，
 * 搜索展示（片段切片、码点长度）在 `search.ts`。
 */

import {
  HISTORY_PAGE_SIZE,
  MAX_MESSAGE_CHARS,
  SEARCH_DEBOUNCE_MS,
  SEARCH_HIT_LIMIT,
  SEARCH_QUERY_MAX_CHARS,
  createSearchState,
  createWorkspaceState,
  type ChatMessage,
  type EntryRef,
  type HistoryEntry,
  type HistoryPage,
  type ProjectId,
  type RuntimeEvent,
  type SendPromptOptions,
  type SessionId,
  type SearchOptions,
  type SessionMode,
  type SessionSearchResult,
  type SessionTab,
  type TabStatus,
  type WorktreeId,
  type WorkspaceBridge,
  type WorkspaceState,
} from "./types.ts";
import { charLength } from "./search.ts";
import {
  capText,
  deltaText,
  describeError,
  enforceMessageWindow,
  finalizeStreaming,
  mergeHistory,
  pushDiagnostic,
} from "./mapping.ts";

/** 单页最多补齐多少条正文；与服务端 `MAX_BATCH_TEXTS` 保持一致。 */
export const MAX_TEXT_HYDRATION = 40;
let liveSeq = 0;

/** 观察者收到的附加上下文（V4-S2b，Issue #117）。 */
export interface RuntimeEventContext {
  /**
   * 事件处理**之前**的 Tab 状态。
   *
   * 通知层靠它区分「这一轮是自己结束的」和「用户按了停止」：`settled` 到来时
   * Tab 状态已经被改成 `ready`，只有处理前的快照还记得当时正在取消。
   */
  previousStatus: TabStatus;
}

/**
 * 运行时事件观察者（V4-S2b，Issue #117）。
 *
 * 通知层需要同一条事件流，但不该另开一个 Tauri 监听器：
 * 这里在 generation gate **之后**把事件转给观察者，迟到事件因此同样不会
 * 触发通知。第二个参数是事件所属 Tab（观察者要拿标题做通知正文）。
 */
export type RuntimeEventObserver = (
  event: RuntimeEvent,
  tab: SessionTab,
  context: RuntimeEventContext,
) => void;

export interface SessionMeta {
  sessionId: SessionId;
  projectId: string;
  title: string;
  mode?: SessionMode;
  /** 会话所属工作树；只记录身份，不影响 Tab 的独立状态。 */
  worktreeId?: WorktreeId | null;
}

export function createTab(meta: SessionMeta): SessionTab {
  return {
    sessionId: meta.sessionId,
    projectId: meta.projectId,
    worktreeId: meta.worktreeId ?? null,
    title: meta.title,
    mode: meta.mode ?? "persistent",
    status: "idle",
    error: null,
    messages: [],
    history: { loaded: 0, total: 0, next: null, loading: false, evicted: 0, evictedLive: 0 },
    runtime: { runtimeId: null, generation: 0, state: "idle", exitReason: null, retry: null },
    draft: "",
    diagnostics: [],
    promoting: false,
    search: createSearchState(),
  };
}

export class WorkspaceSession {
  private readonly bridge: WorkspaceBridge;
  private readonly state: WorkspaceState;
  private readonly pageSize: number;
  private unlisten: (() => void) | null = null;
  private disposed = false;
  /** 每个会话至多一个待触发的防抖定时器：定时器由这里创建，也由这里清理。 */
  private readonly searchTimers = new Map<SessionId, ReturnType<typeof setTimeout>>();
  /** 事件观察者集合；订阅函数由添加者持有并在卸载时调用。 */
  private readonly observers = new Set<RuntimeEventObserver>();

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

  /**
   * 订阅运行时事件（已按 generation 过滤）。
   *
   * 返回取消订阅函数；`dispose` 之后注册的观察者不会收到任何事件，
   * 因此调用方不必自己判「是否已经销毁」。
   */
  onRuntimeEvent(observer: RuntimeEventObserver): () => void {
    if (this.disposed) return () => undefined;
    this.observers.add(observer);
    return () => {
      this.observers.delete(observer);
    };
  }

  setActive(sessionId: SessionId | null): void {
    this.state.activeSessionId = sessionId;
  }

  setDraft(sessionId: SessionId, draft: string): void {
    const tab = this.tab(sessionId);
    if (tab) tab.draft = draft;
  }

  /**
   * 改变 Tab 的排列顺序（Issue #99 的拖拽排序）。
   *
   * 只重排数组、不碰 `activeSessionId`：拖 Tab 是整理栏位，不是切换会话。
   * 越界、原地移动、非整数索引一律返回 false，调用方（拖拽组件）不必自己判边界；
   * Tab 对象本身原样搬运，因此消息窗口、运行时状态与草稿都不会因为重排而重建。
   */
  moveTab(fromIndex: number, toIndex: number): boolean {
    if (this.disposed) return false;
    const total = this.state.tabs.length;
    if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex)) return false;
    if (fromIndex < 0 || fromIndex >= total) return false;
    const target = Math.min(Math.max(toIndex, 0), total - 1);
    if (target === fromIndex) return false;
    const next = this.state.tabs.slice();
    const [moved] = next.splice(fromIndex, 1);
    if (!moved) return false;
    next.splice(target, 0, moved);
    this.state.tabs = next;
    return true;
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
    // 临时会话还没有落盘，后端索引里不存在这个 id：不要订阅事件、也不要拉历史，
    // 否则 open_session_history 会返回 E_SESSION_UNKNOWN，界面直接进错误态。
    // 它的内容由 startRuntime 之后的实时事件填充。
    if (meta.mode === "temporary") {
      tab.status = "ready";
      tab.history = { ...tab.history, loading: false, loaded: 0, total: 0, next: null };
      return;
    }
    try {
      await this.bridge.retainSession(meta.sessionId);
    } catch (error) {
      if (!this.disposed) tab.diagnostics = pushDiagnostic(tab, describeError(error));
    }
    // 临时会话默认没有持久化历史：不请求分页（否则会把「会话未登记」显示成错误）。
    if (tab.mode === "temporary") {
      tab.status = "ready";
      return;
    }
    await this.loadPage(tab, 0);
  }

  /**
   * 新建临时会话：身份由后端分配（只存在于内存，重启后不存在）。
   *
   * 后端不可用（浏览器预览）时退回本地 `ses_tmp_*` 身份，并在诊断里写清
   * 「不会持久化」，而不是假装已经和后端登记成功。
   */
  async openTemporary(projectId: ProjectId | null): Promise<void> {
    if (this.disposed) return;
    let sessionId: SessionId | null = null;
    let worktreeId: WorktreeId | null = null;
    let project: ProjectId | null = projectId;
    if (this.state.bridgeAvailable && project) {
      try {
        const temporary = await this.bridge.openTemporarySession(project);
        if (this.disposed) return;
        sessionId = temporary.sessionId;
        worktreeId = temporary.worktreeId;
        project = temporary.projectId;
      } catch (error) {
        if (this.disposed) return;
        this.state.projectsError = `临时会话分配失败：${describeError(error)}`;
      }
    }
    await this.openSession({
      sessionId: sessionId ?? `ses_tmp_${Date.now().toString(36)}`,
      projectId: project ?? "prj_memory",
      title: "临时会话",
      mode: "temporary",
      worktreeId,
    });
  }

  /**
   * 显式把临时会话转为普通会话。
   *
   * 成功：Tab 切到持久化身份、侧栏用后端返回的项目摘要刷新、按普通会话加载历史。
   * 失败：保持临时会话与内容，显示后端给出的原因——绝不提前显示「已保存」。
   */
  async promoteSession(sessionId: SessionId): Promise<void> {
    const tab = this.tab(sessionId);
    if (!tab || this.disposed || tab.mode !== "temporary" || tab.promoting) return;
    // 运行中的会话不允许转存：后端只登记已写出的内容，避免把半轮对话当成完整历史。
    if (tab.status === "running" || tab.status === "cancelling" || tab.status === "loading") return;
    // 只要还有活运行时（含 idle）就拒绝：旧 Pi 进程仍持有该会话文件的可写权，
    // 转正后它会失去 owner（停止变成 no-op 假成功），再次启动就会双写同一 JSONL。
    if (tab.runtime.runtimeId) {
      tab.error = "请先停止 Pi 运行时再转为普通会话：运行中的进程仍持有会话文件";
      tab.diagnostics = pushDiagnostic(
        tab,
        `转存被拒：仍有活运行时 ${tab.runtime.runtimeId}#${tab.runtime.generation}`,
      );
      return;
    }
    tab.promoting = true;
    const previousId = tab.sessionId;
    const liveMessages = [...tab.messages];
    try {
      const promoted = await this.bridge.promoteSession(previousId);
      if (this.disposed) return;
      // 侧栏必须反映真实历史：用后端返回的项目摘要替换本地缓存（不在缓存里则补上）。
      const known = this.state.projects.some(
        (candidate) => candidate.id === promoted.project.id,
      );
      this.state.projects = known
        ? this.state.projects.map((candidate) =>
            candidate.id === promoted.project.id ? promoted.project : candidate,
          )
        : [...this.state.projects, promoted.project];
      // 身份从 ses_tmp_* 换成 Pi 会话的持久化 id，否则后续分页仍指向已消失的会话。
      tab.sessionId = promoted.sessionId;
      tab.mode = "persistent";
      // 转正要求没有活运行时；这里再显式清空，避免残留一个已无 owner 的 runtimeId。
      tab.runtime = {
        runtimeId: null,
        generation: tab.runtime.generation,
        state: "idle",
        exitReason: null,
        retry: tab.runtime.retry,
      };
      tab.title =
        promoted.project.sessions.find((item) => item.id === promoted.sessionId)?.title ??
        tab.title;
      tab.error = null;
      tab.status = "ready";
      if (this.state.activeSessionId === previousId) {
        this.state.activeSessionId = promoted.sessionId;
      }
      // 转正后以持久化历史为准：先清掉实时回显，避免同一句话出现两次。
      tab.messages = [];
      tab.history = { loaded: 0, total: 0, next: null, loading: false, evicted: 0, evictedLive: 0 };
      // 身份变了：旧的搜索结果属于 ses_tmp_*，不能挂在新身份下面。
      tab.search = createSearchState();
      await this.bridge.retainSession(promoted.sessionId);
      await this.release(previousId);
      await this.loadPage(tab, 0);
      // 历史加载失败时 loadPage 会把状态置为 error：此时保留用户刚看到的实时内容，
      // 错误已经显示在界面上，不能因为一次读取失败就把对话从视图里抹掉。
      if (this.tab(promoted.sessionId)?.status === "error") {
        tab.messages = liveMessages;
      }
    } catch (error) {
      if (this.disposed) return;
      const reason = describeError(error);
      tab.error = `转存失败：${reason}`;
      tab.diagnostics = pushDiagnostic(tab, `转存失败：${reason}`);
    } finally {
      if (!this.disposed) tab.promoting = false;
    }
  }

  /**
   * 会话内搜索：一次调用发一次请求，结果写进 `tab.search`。
   *
   * 搜的是**整份会话**（后端走本地文本缓存 + 线性扫描），不是已加载的一页；
   * 空查询不发请求（清空输入框不该产生一次 10 MiB 扫描）。
   */
  async search(
    sessionId: SessionId,
    query: string,
    options: SearchOptions = {},
  ): Promise<SessionSearchResult | null> {
    const tab = this.tab(sessionId);
    if (!tab || this.disposed) return null;
    const trimmed = query.trim();
    const seq = tab.search.seq + 1;
    if (charLength(trimmed) > SEARCH_QUERY_MAX_CHARS) {
      // 与后端同一个上限：前端先拦，避免把注定失败的请求发出去。
      tab.search = {
        ...createSearchState(),
        query: trimmed,
        error: `查询超过 ${SEARCH_QUERY_MAX_CHARS} 字符，请缩短后重试`,
        seq,
      };
      return null;
    }
    if (!trimmed) {
      tab.search = {
        ...createSearchState(),
        query: "",
        // 保留序号：清空输入框会让在途响应作废，不能让它把结果写回来。
        seq,
      };
      return null;
    }
    tab.search = { ...tab.search, query: trimmed, loading: true, error: null, seq };
    try {
      const result = await this.bridge.searchSession(tab.sessionId, trimmed, {
        limit: options.limit ?? SEARCH_HIT_LIMIT,
        afterOrdinal: options.afterOrdinal ?? null,
      });
      // 迟到的旧响应（用户已经改了查询）整条丢弃，绝不覆盖新结果。
      if (this.disposed || tab.search.seq !== seq) return null;
      tab.search = {
        ...tab.search,
        loading: false,
        error: null,
        hits: result.hits,
        totalHits: result.totalHits,
        scannedEntries: result.scannedEntries,
        truncated: result.truncated,
        degraded: result.degraded,
        tookMs: result.tookMs,
      };
      if (result.degraded) {
        // 预算淘汰导致结果可能不完整：必须让用户看到，而不是静默少几条。
        tab.diagnostics = pushDiagnostic(
          tab,
          "搜索缓存因内存预算丢弃了部分旧正文，结果可能不完整",
        );
      }
      return result;
    } catch (error) {
      if (this.disposed || tab.search.seq !== seq) return null;
      tab.search = {
        ...tab.search,
        loading: false,
        error: describeError(error),
        hits: [],
        totalHits: 0,
        scannedEntries: 0,
        truncated: false,
        degraded: false,
        tookMs: 0,
      };
      return null;
    }
  }

  /**
   * 输入防抖：200 ms 内的连续输入只发一次请求（只保留最后一次查询）。
   *
   * 定时器按会话登记，关闭 Tab / dispose 时显式清理——否则组件卸载后
   * 还会再发一次请求，并把结果写进已经销毁的 Tab。
   */
  scheduleSearch(sessionId: SessionId, query: string, options: SearchOptions = {}): void {
    if (this.disposed) return;
    this.cancelScheduledSearch(sessionId);
    const timer = setTimeout(() => {
      this.searchTimers.delete(sessionId);
      void this.search(sessionId, query, options);
    }, SEARCH_DEBOUNCE_MS);
    this.searchTimers.set(sessionId, timer);
  }

  /** 取消待触发的防抖；不传 sessionId 时清理全部（dispose 用）。 */
  cancelScheduledSearch(sessionId?: SessionId): void {
    if (sessionId === undefined) {
      for (const timer of this.searchTimers.values()) clearTimeout(timer);
      this.searchTimers.clear();
      return;
    }
    const timer = this.searchTimers.get(sessionId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.searchTimers.delete(sessionId);
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
        // 预算来自后端持久化记录：重启或多入口启动都不会被重置。
        retry: started.retry ?? null,
      };
      tab.error = null;
      if (tab.status === "idle" || tab.status === "error") tab.status = "ready";
    } catch (error) {
      if (this.disposed) return;
      tab.status = "error";
      tab.error = describeError(error);
    }
  }

  /**
   * 发送一条消息。
   *
   * `options.mode` / `options.thinking` 只作为参数管道透传给后端（V4-S1）：
   * 后端目前接受并校验这两个字段，但不改变投递行为——注入/排队/并行会话
   * 属于后续切片，这里不能提前把「忙碌时发送」当成已生效。
   * 因此忙碌（running/cancelling/loading）时仍然直接返回，草稿保留在 Tab 上。
   */
  async sendPrompt(
    sessionId: SessionId,
    text: string,
    options?: SendPromptOptions,
  ): Promise<void> {
    const tab = this.tab(sessionId);
    const content = text.trim();
    if (!tab || this.disposed || !content) return;
    if (tab.status === "running" || tab.status === "cancelling" || tab.status === "loading") return;
    if (!tab.runtime.runtimeId) {
      await this.startRuntime(sessionId);
      if (!tab.runtime.runtimeId) return; // 启动失败：保留草稿，由 UI 展示错误
    }
    tab.draft = "";
    const prompt = capText(content);
    tab.messages.push({
      id: `live:${tab.runtime.generation}:${++liveSeq}`,
      ordinal: null,
      role: "user",
      text: prompt.text,
      partial: false,
      streaming: false,
      source: "live",
      createdAt: new Date().toISOString(),
      ...(prompt.truncated ? { truncated: true } : {}),
    });
    // 实时追加同样受窗口约束：连续多轮对话不能绕开 MAX_TAB_LIVE_MESSAGES 无限增长。
    enforceMessageWindow(tab);
    tab.status = "running";
    tab.error = null;
    try {
      await this.bridge.sendPrompt(tab.sessionId, content, options);
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
      retry: tab.runtime.retry,
    };
    tab.status = "idle";
    finalizeStreaming(tab);
  }

  /** 关闭 Tab：释放订阅，但不停止 Agent（重新打开时从 JSONL 历史恢复）。 */
  async closeTab(sessionId: SessionId): Promise<void> {
    const tab = this.tab(sessionId);
    if (!tab) return;
    // 关掉 Tab 就不能再有在途搜索：定时器与在途响应都不该写回已移除的 Tab。
    this.cancelScheduledSearch(sessionId);
    const temporary = tab.mode === "temporary";
    this.state.tabs = this.state.tabs.filter((candidate) => candidate.sessionId !== sessionId);
    if (this.state.activeSessionId === sessionId) {
      this.state.activeSessionId = this.state.tabs.at(-1)?.sessionId ?? null;
    }
    // 临时会话不持久化：关闭 Tab 就是结束它。必须先停掉运行时再清内存登记，
    // 否则后端会拒绝清登记（进程仍是 owner），或者更糟——登记消失后进程失去 owner，
    // 文件被下一次扫描当成普通会话，形成幽灵历史。
    if (temporary) {
      await this.stopAgent(sessionId);
      await this.discard(sessionId);
    }
    await this.release(sessionId);
  }

  /** 组件卸载：先摘掉监听器，再逐个释放订阅；之后不再写任何状态。 */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelScheduledSearch();
    const unlisten = this.unlisten;
    this.unlisten = null;
    unlisten?.();
    this.observers.clear();
    const sessions = this.state.tabs.map((tab) => tab.sessionId);
    const temporary = this.state.tabs
      .filter((tab) => tab.mode === "temporary")
      .map((tab) => tab.sessionId);
    this.state.tabs = [];
    this.state.activeSessionId = null;
    // 临时会话随进程结束：先停运行时（否则后端拒绝清登记），再清内存登记（尽力而为）。
    if (temporary.length > 0) {
      await Promise.allSettled(temporary.map((sessionId) => this.bridge.stopRuntime(sessionId)));
    }
    await Promise.allSettled([
      ...sessions.map((sessionId) => this.bridge.releaseSession(sessionId)),
      ...temporary.map((sessionId) => this.bridge.discardTemporarySession(sessionId)),
    ]);
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
    // 观察者需要处理前的状态（见 RuntimeEventContext）：下面的分支会改写 status。
    const previousStatus = tab.status;
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
          retry: tab.runtime.retry,
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
    this.publish(event, tab, { previousStatus });
  }

  /**
   * 把已通过 gate 的事件转给观察者。
   *
   * 观察者抛错不能影响会话状态：通知是旁路功能，坏了也不能让 Tab 停在错误状态，
   * 所以逐个 try/catch，并且遍历快照（观察者可能在回调里取消订阅）。
   */
  private publish(event: RuntimeEvent, tab: SessionTab, context: RuntimeEventContext): void {
    if (this.observers.size === 0) return;
    for (const observer of [...this.observers]) {
      try {
        observer(event, tab, context);
      } catch {
        // 旁路订阅者的异常一律吞掉：主链路的 Tab 状态已经写完了。
      }
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
        // 窗口可能已经把这条历史释放掉：迟到正文不写状态，也不新建消息。
        if (!message) continue;
        const capped = capText(item.text);
        message.text = capped.text;
        message.partial = item.clipped;
        if (capped.truncated) message.truncated = true;
      }
    } catch (error) {
      tab.diagnostics = pushDiagnostic(tab, `正文读取失败：${describeError(error)}`);
    }
  }

  /** 停掉后端运行时（不依赖 Tab 是否还在）：关闭临时会话时 Tab 已经先被移除。 */
  private async stopAgent(sessionId: SessionId): Promise<void> {
    try {
      await this.bridge.stopRuntime(sessionId);
    } catch {
      // 停止失败不阻断关闭：清登记会被后端拒绝，临时会话与文件都原样保留。
    }
  }

  private async discard(sessionId: SessionId): Promise<void> {
    try {
      await this.bridge.discardTemporarySession(sessionId);
    } catch {
      // 结束临时会话是尽力而为：后端登记表随进程消失，失败不影响 UI。
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
    // 有界追加：一条超长流式输出（例如整份文件）不能无上限地长在内存里。
    // 到顶后直接丢弃后续增量，避免每个 token 都重新切片一次 20k 字符。
    if (last.text.length >= MAX_MESSAGE_CHARS) {
      last.truncated = true;
      return;
    }
    const merged = last.text + delta;
    if (merged.length > MAX_MESSAGE_CHARS) {
      last.text = capText(merged).text;
      last.truncated = true;
      return;
    }
    last.text = merged;
    return;
  }
  const capped = capText(delta);
  const message: ChatMessage = {
    id: `live:${tab.runtime.generation}:${++liveSeq}`,
    ordinal: null,
    role: "assistant",
    text: capped.text,
    partial: false,
    streaming: true,
    source: "live",
    createdAt: null,
    ...(capped.truncated ? { truncated: true } : {}),
  };
  tab.messages.push(message);
  // 只在「新消息」边界收敛窗口，不在每个 token 上重复扫描；
  // 刚 push 的这条正在流式，enforceMessageWindow 保证它不会被释放。
  enforceMessageWindow(tab);
}
