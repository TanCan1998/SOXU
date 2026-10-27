/**
 * SOXU 工作区数据契约（Rust DTO 的 TypeScript 镜像）。
 *
 * 字段名与 `apps/desktop/src-tauri/src/dto.rs` 的 camelCase 序列化保持一致；
 * 改动必须两侧同步，并在 `docs/development/multi-session-workspace.md` 记录。
 */

export type ProjectId = string;
export type SessionId = string;
export type SessionMode = "persistent" | "temporary";

export interface SessionSummary {
  id: SessionId;
  projectId: ProjectId;
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

export interface RuntimeStarted {
  sessionId: SessionId;
  runtimeId: string;
  generation: number;
  state: string;
}

export interface RuntimeStatus {
  sessionId: SessionId;
  runtimeId: string;
  generation: number;
  state: string;
  exit: { code: number | null; reason: string } | null;
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
}

export interface SessionTab {
  sessionId: SessionId;
  projectId: ProjectId;
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
}

export const HISTORY_PAGE_SIZE = 40;
export const MAX_DIAGNOSTICS = 20;

export function createWorkspaceState(): WorkspaceState {
  return {
    tabs: [],
    activeSessionId: null,
    projects: [],
    projectsLoading: false,
    projectsError: null,
    bridgeAvailable: true,
  };
}
