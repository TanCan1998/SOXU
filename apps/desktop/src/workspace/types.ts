/**
 * SOXU 工作区数据契约（Rust DTO 的 TypeScript 镜像）。
 *
 * 字段名与 `apps/desktop/src-tauri/src/dto.rs` 的 camelCase 序列化保持一致；
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

/** 视图使用的最小白名单：Tauri 实现之外，测试与浏览器预览都可以替换它。 */
export interface WorkspaceBridge {
  listProjects(): Promise<ProjectSummary[]>;
  registerProject(root: string): Promise<ProjectSummary>;
  refreshProject(projectId: ProjectId): Promise<ProjectSummary>;
  fetchHistory(sessionId: SessionId, offset: number, limit: number): Promise<HistoryPage>;
  fetchTexts(sessionId: SessionId, refs: EntryRef[]): Promise<EntryText[]>;
  startRuntime(sessionId: SessionId, mode: SessionMode): Promise<RuntimeStarted>;
  sendPrompt(sessionId: SessionId, text: string): Promise<void>;
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
}

export type TabStatus =
  | "idle"
  | "loading"
  | "ready"
  | "running"
  | "cancelling"
  | "error";

export interface HistoryCursor {
  loaded: number;
  total: number;
  next: number | null;
  loading: boolean;
}

export interface TabRuntime {
  runtimeId: string | null;
  generation: number;
  state: string;
  exitReason: string | null;
  /** 最近一次启动的重试预算；停止后保留，便于查看用掉了几次重试。 */
  retry: RetryStatus | null;
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
