/**
 * SOXU 工作区数据契约（Rust DTO 的 TypeScript 镜像）。
 *
 * 字段名与 `apps/desktop/src-tauri/src/dto/` 下同名领域模块的 camelCase 序列化保持一致；
 * 改动必须两侧同步，并在 `docs/development/multi-session-workspace.md` 记录。
 */

export type ProjectId = string;
export type SessionId = string;
export type WorktreeId = string;
export type SessionMode = "persistent" | "temporary";

export interface SessionSummary {
  id: SessionId;
  projectId: ProjectId;
  /** 会话所属工作树；切换/选择工作树不会改写它（身份来自会话目录）。 */
  worktreeId: WorktreeId;
  title: string;
  fileName: string;
  entryCount: number;
  updatedAtMs: number;
  missing: boolean;
  runtimeId: string | null;
  generation: number;
}

export interface ProjectSummary {
  id: ProjectId;
  name: string;
  root: string;
  worktreeCount: number;
  sessions: SessionSummary[];
}

export type EntryKind =
  | "session"
  | "message"
  | "compaction"
  | "branch_summary"
  | "context_edit"
  | "usage"
  | "custom"
  | "custom_message"
  | "label"
  | "session_info"
  | "model_change"
  | "thinking_level_change"
  | "unknown";

export type EntryRole =
  | "system"
  | "user"
  | "assistant"
  | "tool_result"
  | "custom"
  | "unknown";

/** 历史分页中的一条条目：正文只有有界预览，完整正文由 `fetchTexts` 补齐。 */
export interface HistoryEntry {
  ordinal: number;
  offset: number;
  length: number;
  kind: EntryKind;
  role: EntryRole | null;
  preview: string | null;
  timestamp: string | null;
  oversized: boolean;
  corrupt: boolean;
}

export interface HistoryPage {
  sessionId: SessionId;
  entries: HistoryEntry[];
  offset: number;
  total: number;
  next: number | null;
  bytesRead: number;
  clipped: boolean;
}

export interface EntryRef {
  ordinal: number;
  offset: number;
  length: number;
}

export interface EntryText {
  ordinal: number;
  role: string | null;
  text: string;
  clipped: boolean;
}

/**
 * 有界重试预算的只读快照（Rust `retry::RetryStatus` 的镜像）。
 *
 * `exhausted` 为真时后端不会再自动重试：只能人工处理网络/额度后再启动。
 * `costNotice` 由后端下发，界面必须原样展示——重试会再次产生模型费用。
 */
export interface RetryStatus {
  attempts: number;
  maxAttempts: number;
  remaining: number;
  exhausted: boolean;
  lastFailure: string | null;
  nextDelayMs: number | null;
  costNotice: string;
}

/**
 * 临时会话视图：只存在于 Rust 进程内存，重启后不存在，也不进入持久化历史。
 *
 * `bound` 为 false 时没有可持久化的内容，转正会被后端明确拒绝（不伪造成功）。
 */
export interface TemporarySessionView {
  sessionId: SessionId;
  projectId: ProjectId;
  worktreeId: WorktreeId;
  mode: SessionMode;
  /** 已绑定的 Pi 会话文件路径；未绑定时为 null。 */
  file: string | null;
  bound: boolean;
}

/**
 * 转正结果：`sessionId` 是**持久化**身份（Pi 会话头部的 id），不是 `ses_tmp_*`。
 * Tab 必须切到这个身份，否则后续分页仍指向已经消失的临时会话。
 */
export interface PromotedSession {
  sessionId: SessionId;
  project: ProjectSummary;
}

/** 会话内搜索的一条命中（Rust `SessionSearchHit` 的镜像）。 */
export interface SessionSearchHit {
  ordinal: number;
  kind: EntryKind;
  role: EntryRole | null;
  /** 命中位置前后各 40 个字符的片段。 */
  snippet: string;
  /** 片段内命中的起始**字符**偏移（后端给，前端不重新算）。 */
  matchStart: number;
  /** 片段内命中的结束字符偏移（左闭右开）。 */
  matchEnd: number;
  /** 该条目内的命中次数（后端上限 20）。 */
  totalMatches: number;
  /** 该条目正文被裁剪过（超长条目或缓存预算淘汰），片段不是全文。 */
  truncated: boolean;
}

/** 一次会话内搜索的结果。 */
export interface SessionSearchResult {
  sessionId: SessionId;
  hits: SessionSearchHit[];
  /** 会话内命中条目总数，与 `limit` / 分页无关。 */
  totalHits: number;
  scannedEntries: number;
  /** 命中数超过 `limit`（还有下一页）。 */
  truncated: boolean;
  /** 缓存因预算丢弃了部分正文：结果可能不完整，界面必须如实说明。 */
  degraded: boolean;
  tookMs: number;
  /** 本次调用是否重建了缓存（验收用：追加不应触发重建）。 */
  rebuilt: boolean;
}

/** 搜索请求的可选参数：`afterOrdinal` 用于按时间序翻页。 */
export interface SearchOptions {
  limit?: number;
  afterOrdinal?: number | null;
}

export interface RuntimeStarted {
  sessionId: SessionId;
  runtimeId: string;
  generation: number;
  state: string;
  /** 本次启动的重试预算快照；旧后端可能不返回。 */
  retry?: RetryStatus | null;
}

export interface RuntimeStatus {
  sessionId: SessionId;
  runtimeId: string;
  generation: number;
  state: string;
  exit: { code: number | null; reason: string } | null;
  retry?: RetryStatus | null;
}

export type RuntimeEventBody =
  | { type: "state"; state: string }
  | { type: "stream"; event: string; data?: unknown }
  | { type: "settled" }
  | { type: "stderr"; line: string }
  | { type: "warning"; detail: string }
  | { type: "exit"; code?: number | null; reason: string };

/**
 * 每个运行时事件都带执行身份。前端按 `runtimeId + generation` 丢弃迟到事件，
 * 与服务端 `GenerationGate` 使用同一判定口径。
 */
export type RuntimeEvent = RuntimeEventBody & {
  sessionId: SessionId;
  runtimeId: string;
  generation: number;
};

/**
 * 一个 Git 工作树的视图（Rust `WorktreeSummary` 的镜像）。
 *
 * `token` 与 `removable` 由后端根据当前 Git 状态计算：状态一变令牌即失效，
 * 因此 UI 不能缓存令牌后隔很久再删除。
 */
export interface WorktreeSummary {
  id: WorktreeId;
  projectId: ProjectId;
  path: string;
  name: string;
  branch: string | null;
  head: string | null;
  /** 项目主工作树：永不允许删除。 */
  primary: boolean;
  /** 目录不存在或 Git 已标记 prunable（异常退出/手工删除后的残留）。 */
  missing: boolean;
  locked: string | null;
  prunable: string | null;
  dirty: boolean;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicts: number;
  /** 改动文件清单被上限裁剪；计数仍然完整。 */
  changesTruncated: boolean;
  indexLocked: boolean;
  /** 进行中的 Git 操作（merge/rebase/cherry-pick…）。 */
  operation: string | null;
  sessionIds: SessionId[];
  /** 仍有运行时挂载的会话；非空时后端拒绝删除。 */
  activeSessionIds: SessionId[];
  /** 阻止删除的稳定标识（见 soxu-git-worktree 的 RemovalBlocker）。 */
  blockers: string[];
  removable: boolean;
  /** 删除确认令牌，与当前状态绑定。 */
  token: string;
}

export interface WorktreeWorkspace {
  projectId: ProjectId;
  root: string;
  worktrees: WorktreeSummary[];
  /** Git 已标记 prunable 的工作树路径。 */
  stale: string[];
  pruneToken: string;
}

export interface CreateWorktreeInput {
  branch: string;
  /** true：新建分支；false：检出既有分支。 */
  newBranch: boolean;
  /** 新建分支的起点，默认 HEAD。 */
  base: string | null;
  /** 目标目录；省略时使用项目旁的 <项目名>-worktrees/<分支>。 */
  path: string | null;
}

export interface WorktreeDiffFile {
  status: string;
  path: string;
  added: number | null;
  removed: number | null;
  binary: boolean;
}

export interface WorktreeDiffView {
  worktreeId: WorktreeId;
  staged: boolean;
  files: WorktreeDiffFile[];
  totalFiles: number;
  patch: string;
  /** 补丁或文件清单被上限裁剪（只读预览，不影响磁盘）。 */
  truncated: boolean;
  bytesRead: number;
}

export interface WorktreeRemovalView {
  projectId: ProjectId;
  worktreeId: WorktreeId;
  path: string;
  branch: string | null;
}

/**
 * 工作树面板状态：一次只观察一个项目。
 *
 * `pendingRemoval` 是**待确认的删除计划**（只读），不是已执行的动作；
 * 只有 `removable` 为真且令牌非空时 UI 才允许调用删除。
 */
export interface WorktreeState {
  projectId: ProjectId | null;
  root: string;
  loading: boolean;
  error: string | null;
  worktrees: WorktreeSummary[];
  stale: string[];
  pruneToken: string;
  selectedId: WorktreeId | null;
  diff: WorktreeDiffView | null;
  diffLoading: boolean;
  diffError: string | null;
  pendingRemoval: WorktreeSummary | null;
  pendingError: string | null;
  removing: boolean;
  creating: boolean;
  pruning: boolean;
}

/**
 * 发送投递方式（V4-S1，Issue #111）。
 *
 * 三个内部名沿用 PiDeck（`docs/design/UIUX/V4/interaction-decisions.md` 第一节）：
 * - steer：插入正在进行的回答（仅 agent 忙碌时有意义）；
 * - followUp：本轮结束后自动发送（总是可用）；
 * - parallel：独立会话后台处理，不打断当前输出。
 *
 * 本切片只做 UI 与参数管道：运行时语义（注入/排队/并行会话）由后续切片实现，
 * 后端目前接受参数但不改变行为。
 */
export type SendMode = "steer" | "followUp" | "parallel";

/** 思考强度（`send_prompt` 的可选参数，本切片同样只做管道）。 */
export type ThinkingLevel = "low" | "medium" | "high";

/** `send_prompt` 的可选参数；省略即后端默认行为。 */
export interface SendPromptOptions {
  mode?: SendMode;
  thinking?: ThinkingLevel;
}

/** 视图使用的最小白名单：Tauri 实现之外，测试与浏览器预览都可以替换它。 */
export interface WorkspaceBridge {
  listProjects(): Promise<ProjectSummary[]>;
  registerProject(root: string): Promise<ProjectSummary>;
  refreshProject(projectId: ProjectId): Promise<ProjectSummary>;
  fetchHistory(sessionId: SessionId, offset: number, limit: number): Promise<HistoryPage>;
  fetchTexts(sessionId: SessionId, refs: EntryRef[]): Promise<EntryText[]>;
  /** 会话内搜索：搜整份会话（不是已加载的一页）；空查询由调用方拦在前面。 */
  searchSession(
    sessionId: SessionId,
    query: string,
    options?: SearchOptions,
  ): Promise<SessionSearchResult>;
  startRuntime(sessionId: SessionId, mode: SessionMode): Promise<RuntimeStarted>;
  /** 分配一个临时会话：只在内存里，默认不进入历史。 */
  openTemporarySession(projectId: ProjectId): Promise<TemporarySessionView>;
  /** 显式绑定 Pi 会话文件；绑定期间该文件不进入普通历史。 */
  bindTemporaryFile(sessionId: SessionId, file: string): Promise<TemporarySessionView>;
  /** 显式转正；失败时后端保留临时会话并返回原因。 */
  promoteSession(sessionId: SessionId): Promise<PromotedSession>;
  /** 结束临时会话：幂等，不删除 Pi 的会话文件。返回是否命中。 */
  discardTemporarySession(sessionId: SessionId): Promise<boolean>;
  /** 发送一条消息；`options.mode` / `options.thinking` 由后端接收但暂不改变行为。 */
  sendPrompt(sessionId: SessionId, text: string, options?: SendPromptOptions): Promise<void>;
  cancelRuntime(sessionId: SessionId): Promise<void>;
  stopRuntime(sessionId: SessionId): Promise<void>;
  runtimeStatus(sessionId: SessionId): Promise<RuntimeStatus | null>;
  retainSession(sessionId: SessionId): Promise<void>;
  releaseSession(sessionId: SessionId): Promise<void>;
  listWorktrees(projectId: ProjectId): Promise<WorktreeWorkspace>;
  createWorktree(projectId: ProjectId, input: CreateWorktreeInput): Promise<WorktreeSummary>;
  /** 只读：重新计算删除计划与令牌，不修改磁盘。 */
  planWorktreeRemoval(projectId: ProjectId, worktreeId: WorktreeId): Promise<WorktreeSummary>;
  worktreeDiff(
    projectId: ProjectId,
    worktreeId: WorktreeId,
    staged: boolean,
  ): Promise<WorktreeDiffView>;
  /** 危险操作：必须携带后端刚下发的令牌；失败时磁盘保持不变。 */
  removeWorktree(
    projectId: ProjectId,
    worktreeId: WorktreeId,
    token: string,
  ): Promise<WorktreeRemovalView>;
  pruneWorktrees(projectId: ProjectId, token: string): Promise<number>;
  /** 返回取消订阅函数；组件卸载时必须调用。 */
  subscribe(handler: (event: RuntimeEvent) => void): () => void;
}

export type ChatRole = "user" | "assistant" | "system" | "tool" | "other";
export type MessageSource = "history" | "live";

export interface ChatMessage {
  id: string;
  ordinal: number | null;
  role: ChatRole;
  text: string;
  /** 文本尚未补齐（只有预览或被截断）。 */
  partial: boolean;
  streaming: boolean;
  source: MessageSource;
  createdAt: string | null;
  /** 正文超过 `MAX_MESSAGE_CHARS`，已被有界截断（不是加载失败）。 */
  truncated?: boolean;
}

export type TabStatus =
  | "idle"
  | "loading"
  | "ready"
  | "running"
  | "cancelling"
  | "error";

/**
 * 历史分页游标。
 *
 * `loaded` 是**当前仍在内存里**的历史条数，不是累计加载过的条数：超过窗口上限后
 * 最旧的历史消息会被释放（见 `MAX_TAB_HISTORY_MESSAGES`），释放数量记在 `evicted`。
 * 这样长会话不会随着「加载更多」无限增长，UI 也能如实告诉用户释放了什么。
 */
export interface HistoryCursor {
  loaded: number;
  total: number;
  next: number | null;
  loading: boolean;
  /** 已从内存释放的更早历史条数（窗口滑动，不是数据丢失）。 */
  evicted: number;
  /**
   * 已从内存释放的更早**实时**条数（见 `MAX_TAB_LIVE_MESSAGES`）。
   *
   * 实时消息同样走有界窗口：连续多轮对话不会让 Tab 无限增长。释放的只是内存窗口，
   * Pi 已经写出的 JSONL 未受影响，重新加载历史仍可读到同一批内容。
   */
  evictedLive: number;
}

export interface TabRuntime {
  runtimeId: string | null;
  generation: number;
  state: string;
  exitReason: string | null;
  /** 最近一次启动的重试预算；停止后保留，便于查看用掉了几次重试。 */
  retry: RetryStatus | null;
}

/**
 * 单个 Tab 的搜索结果状态。
 *
 * `seq` 是请求序号：输入防抖 + 异步返回意味着响应可能乱序到达，
 * 只有序号匹配的结果才能写回状态（迟到响应整条丢弃）。
 */
export interface SearchState {
  query: string;
  loading: boolean;
  error: string | null;
  hits: SessionSearchHit[];
  totalHits: number;
  scannedEntries: number;
  truncated: boolean;
  degraded: boolean;
  tookMs: number;
  seq: number;
}

export interface SessionTab {
  sessionId: SessionId;
  projectId: ProjectId;
  /** 打开 Tab 时记录的工作树；工作树选择变化不会改写它。 */
  worktreeId: WorktreeId | null;
  title: string;
  mode: SessionMode;
  status: TabStatus;
  error: string | null;
  messages: ChatMessage[];
  history: HistoryCursor;
  runtime: TabRuntime;
  draft: string;
  diagnostics: string[];
  /** 转正请求正在进行：UI 必须等后端结果，不能先显示「已保存」。 */
  promoting: boolean;
  /** 会话内搜索状态；与消息窗口相互独立，只保留有界的一页命中。 */
  search: SearchState;
}

export interface WorkspaceState {
  tabs: SessionTab[];
  activeSessionId: SessionId | null;
  projects: ProjectSummary[];
  projectsLoading: boolean;
  projectsError: string | null;
  bridgeAvailable: boolean;
  /** 工作树面板；与 Tab 状态相互独立。 */
  worktrees: WorktreeState;
}

export const HISTORY_PAGE_SIZE = 40;
export const MAX_DIAGNOSTICS = 20;

/**
 * 单个 Tab 保留的历史消息条数上限（窗口化缓存）。
 *
 * 服务端分页本身有界（`MAX_PAGE_ENTRIES` + `MAX_PAGE_BYTES`），但「加载更多」会一直
 * 往 Tab 里追加，50,000 条事件的会话迟早会把整份历史读进 Vue 状态。这里给前端再设一道
 * 硬上限：超出后释放**最旧**的历史消息（用户已经读过、可重新加载），并累加 `evicted`。
 */
export const MAX_TAB_HISTORY_MESSAGES = 240;

/**
 * 单个 Tab 保留的实时消息上限；同样释放最旧的，绝不释放正在流式的最后一条。
 *
 * 这条上限**同时作用于两条路径**：合并历史后的窗口收敛，以及实时追加（用户发问、
 * 新的流式回复）之后的窗口收敛。否则连续多轮对话会绕过窗口，让「有界缓存」只对
 * 历史成立——见 `docs/development/long-session-virtual-list.md` 第 2 节。
 */
export const MAX_TAB_LIVE_MESSAGES = 120;

/**
 * 单个 Tab 保留的历史正文字符预算（按 UTF-16 码元计数，约 4 MB）。
 *
 * 只限条数不够：一条 20,000 字符的工具输出占的空间远大于 100 条短消息，
 * 因此同时限制总字符数，保证内存边界与「消息多长」无关。
 */
export const MAX_TAB_HISTORY_CHARS = 2_000_000;

/** 单条消息在 UI 状态里的字符上限；与 Rust `entry_text::MAX_TEXT_CHARS` 对齐。 */
export const MAX_MESSAGE_CHARS = 20_000;

/**
 * 搜索输入的防抖窗口（毫秒）：快速输入只发一次请求。
 *
 * 为什么是 200 而不是 250（Issue #118 的验收写着「输入后 250 ms 内出结果」）：
 * 防抖窗口本身就是「从最后一次输入到发请求」的延迟，取 250 会把这 250 ms 全部用光，
 * IPC 往返与渲染再占掉一点，用户就永远看不到「250 ms 内出结果」。
 * 200 ms 的停顿对输入手感已经不可感知，同时给请求留出 50 ms 预算
 * （大会话查询实测 5–9 ms，见 docs/development/session-search.md 第 8 节）。
 */
export const SEARCH_DEBOUNCE_MS = 200;
/** 查询字符上限；与 Rust `MAX_QUERY_CHARS` 对齐。 */
export const SEARCH_QUERY_MAX_CHARS = 200;
/** 单次搜索返回的命中上限；与 Rust `DEFAULT_SEARCH_HITS` 对齐。 */
export const SEARCH_HIT_LIMIT = 50;

export function createSearchState(): SearchState {
  return {
    query: "",
    loading: false,
    error: null,
    hits: [],
    totalHits: 0,
    scannedEntries: 0,
    truncated: false,
    degraded: false,
    tookMs: 0,
    seq: 0,
  };
}

export function createWorktreeState(): WorktreeState {
  return {
    projectId: null,
    root: "",
    loading: false,
    error: null,
    worktrees: [],
    stale: [],
    pruneToken: "",
    selectedId: null,
    diff: null,
    diffLoading: false,
    diffError: null,
    pendingRemoval: null,
    pendingError: null,
    removing: false,
    creating: false,
    pruning: false,
  };
}

export function createWorkspaceState(): WorkspaceState {
  return {
    tabs: [],
    activeSessionId: null,
    projects: [],
    projectsLoading: false,
    projectsError: null,
    bridgeAvailable: true,
    worktrees: createWorktreeState(),
  };
}
