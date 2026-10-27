/**
 * 工作树工作区核心：枚举、选择、创建、Diff 预览与**受确认约束**的删除。
 *
 * 与 `sessionWorkspace.ts` 一样不依赖 Vue：Pinia store 只做代理，
 * node:test 用假 bridge 直接驱动同一份逻辑。
 *
 * 四条规则：
 * 1. 选择工作树是**纯 UI 动作**：不改写任何 Tab 的 `worktreeId`、消息或 active 会话。
 * 2. 删除必须「只读计划 → 令牌确认 → 执行」三步：没有计划或令牌为空时绝不调用后端。
 * 3. 任何 await 回来后先校验 `disposed` 与项目身份；切项目后旧结果直接丢弃。
 * 4. 失败只写错误：工作树清单、会话关联与磁盘状态都保持原样，可重新计划后再试。
 */

import { describeError } from "./mapping.ts";
import {
  createWorkspaceState,
  type CreateWorktreeInput,
  type ProjectId,
  type SessionSummary,
  type WorktreeDiffView,
  type WorktreeId,
  type WorktreeState,
  type WorktreeSummary,
  type WorkspaceBridge,
  type WorkspaceState,
} from "./types.ts";

/** 后端 blocker 标识 → 用户可读说明；未知标识原样展示，不猜测含义。 */
const BLOCKER_LABELS: Record<string, string> = {
  primary: "这是项目主工作树",
  path_missing: "工作树目录不在磁盘上，请改用清理失效记录",
  dirty: "存在未提交改动",
  conflicted: "存在未解决的合并冲突",
  index_locked: "索引被其他进程锁定",
  operation_in_progress: "有进行中的 Git 操作",
  git_locked: "工作树被 git lock 锁定",
  prunable: "Git 已标记该工作树失效",
  active_runtime: "仍有运行时挂载的会话",
  unmanaged: "该路径不是本仓库登记的工作树",
};

export function blockerLabel(code: string): string {
  return BLOCKER_LABELS[code] ?? code;
}

export interface WorktreeBadge {
  code: string;
  label: string;
  tone: "danger" | "warn" | "info";
}

/**
 * 视图徽标：只根据后端事实生成，顺序固定（危险 → 提示 → 信息）。
 * 列表与详情共用一份判断，避免两处说法不一致。
 */
export function worktreeBadges(summary: WorktreeSummary): WorktreeBadge[] {
  const badges: WorktreeBadge[] = [];
  if (summary.conflicts > 0) {
    badges.push({ code: "conflicted", label: `冲突 ${summary.conflicts}`, tone: "danger" });
  }
  if (summary.indexLocked) {
    badges.push({ code: "index_locked", label: "索引锁", tone: "danger" });
  }
  if (summary.operation) {
    badges.push({ code: "operation_in_progress", label: summary.operation, tone: "danger" });
  }
  if (summary.locked) {
    badges.push({ code: "locked", label: "Git 锁定", tone: "warn" });
  }
  if (summary.dirty) {
    badges.push({
      code: "dirty",
      label: `暂存 ${summary.staged} · 未暂存 ${summary.unstaged} · 未跟踪 ${summary.untracked}`,
      tone: "warn",
    });
  }
  if (summary.missing) {
    badges.push({ code: "missing", label: "目录缺失", tone: "warn" });
  }
  if (summary.primary) {
    badges.push({ code: "primary", label: "主工作树", tone: "info" });
  }
  return badges;
}

export class WorktreeCatalog {
  private readonly bridge: WorkspaceBridge;
  private readonly state: WorkspaceState;
  private disposed = false;
  /** 只允许最后一次枚举写清单：连续刷新时旧响应必须丢弃。 */
  private listSequence = 0;

  constructor(bridge: WorkspaceBridge, state: WorkspaceState = createWorkspaceState()) {
    this.bridge = bridge;
    this.state = state;
  }

  get view(): WorktreeState {
    return this.state.worktrees;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  summary(worktreeId: WorktreeId): WorktreeSummary | undefined {
    return this.view.worktrees.find((candidate) => candidate.id === worktreeId);
  }

  selected(): WorktreeSummary | undefined {
    const id = this.view.selectedId;
    return id ? this.summary(id) : undefined;
  }

  /** 某个工作树下的会话摘要（来自会话目录快照，不是本地推断）。 */
  sessionsFor(projectId: ProjectId, worktreeId: WorktreeId): SessionSummary[] {
    const project = this.state.projects.find((candidate) => candidate.id === projectId);
    if (!project) return [];
    return project.sessions.filter((session) => session.worktreeId === worktreeId);
  }

  /** 打开（或刷新）某个项目的工作树面板；只读。 */
  async open(projectId: ProjectId): Promise<void> {
    if (this.disposed || !projectId) return;
    if (this.view.projectId !== projectId) {
      // 切项目先清空：宁可短暂空白，也不展示上一个项目的工作树。
      this.state.worktrees = {
        ...this.view,
        projectId,
        root: "",
        worktrees: [],
        stale: [],
        pruneToken: "",
        selectedId: null,
        diff: null,
        diffError: null,
        pendingRemoval: null,
        pendingError: null,
        error: null,
      };
    }
    await this.reload();
  }

  async reload(): Promise<void> {
    const projectId = this.view.projectId;
    if (this.disposed || !projectId) return;
    const ticket = ++this.listSequence;
    this.view.loading = true;
    this.view.error = null;
    try {
      const workspace = await this.bridge.listWorktrees(projectId);
      if (!this.accepts(ticket, projectId)) return;
      this.view.root = workspace.root;
      this.view.worktrees = workspace.worktrees;
      this.view.stale = workspace.stale;
      this.view.pruneToken = workspace.pruneToken;
      const selected = this.view.selectedId;
      const stillThere = workspace.worktrees.some((candidate) => candidate.id === selected);
      this.view.selectedId = stillThere
        ? selected
        : (workspace.worktrees.find((candidate) => candidate.primary) ?? workspace.worktrees[0])
            ?.id ?? null;
      // 计划必须跟随最新事实：工作树消失或状态变化后，旧令牌不再可信。
      const pending = this.view.pendingRemoval;
      this.view.pendingRemoval = pending
        ? (workspace.worktrees.find((candidate) => candidate.id === pending.id) ?? null)
        : null;
      this.view.diff = null;
      this.view.diffError = null;
    } catch (error) {
      if (this.accepts(ticket, projectId)) this.view.error = describeError(error);
    } finally {
      if (!this.disposed && this.view.projectId === projectId) this.view.loading = false;
    }
  }

  /**
   * 选择工作树：只影响面板视图与 Diff，不触碰 Tab、消息或 activeSessionId。
   * 这是「切换工作树不会串会话」的实现位置。
   */
  select(worktreeId: WorktreeId | null): void {
    if (this.disposed || this.view.selectedId === worktreeId) return;
    this.view.selectedId = worktreeId;
    this.view.diff = null;
    this.view.diffError = null;
    this.view.pendingRemoval = null;
    this.view.pendingError = null;
  }

  /** 创建附加工作树；成功后重新枚举并把新工作树设为选中。 */
  async create(input: CreateWorktreeInput): Promise<WorktreeSummary | null> {
    const projectId = this.view.projectId;
    if (this.disposed) return null;
    if (!projectId) {
      this.view.error = "E_PROJECT_UNKNOWN: 尚未打开项目的工作树";
      return null;
    }
    const branch = input.branch.trim();
    if (!branch) {
      this.view.error = "E_GIT_BRANCH_INVALID: 分支名不能为空";
      return null;
    }
    this.view.creating = true;
    this.view.error = null;
    try {
      const created = await this.bridge.createWorktree(projectId, {
        branch,
        newBranch: input.newBranch,
        base: input.base?.trim() || null,
        path: input.path?.trim() || null,
      });
      if (!this.alive(projectId)) return null;
      await this.reload();
      if (this.alive(projectId)) this.view.selectedId = created.id;
      return created;
    } catch (error) {
      if (this.alive(projectId)) this.view.error = describeError(error);
      return null;
    } finally {
      if (!this.disposed) this.view.creating = false;
    }
  }

  /** Diff 预览：只读且有界；truncated 由后端标记，前端不裁剪。 */
  async previewDiff(
    worktreeId: WorktreeId | null = this.view.selectedId,
    staged = false,
  ): Promise<WorktreeDiffView | null> {
    const projectId = this.view.projectId;
    if (this.disposed || !projectId || !worktreeId) return null;
    const target = worktreeId;
    this.view.diffLoading = true;
    this.view.diffError = null;
    try {
      const diff = await this.bridge.worktreeDiff(projectId, target, staged);
      if (!this.alive(projectId) || this.view.selectedId !== target) return null;
      this.view.diff = diff;
      return diff;
    } catch (error) {
      if (this.alive(projectId)) this.view.diffError = describeError(error);
      return null;
    } finally {
      if (!this.disposed) this.view.diffLoading = false;
    }
  }

  /**
   * 生成（刷新）删除计划：只读，返回带 blocker 与令牌的最新汇总。
   * 这一步不删除任何东西，因此可以在列表里随时调用。
   */
  async planRemoval(worktreeId: WorktreeId): Promise<WorktreeSummary | null> {
    const projectId = this.view.projectId;
    if (this.disposed || !projectId) return null;
    this.view.pendingError = null;
    try {
      const plan = await this.bridge.planWorktreeRemoval(projectId, worktreeId);
      if (!this.alive(projectId)) return null;
      this.view.worktrees = this.view.worktrees.map((candidate) =>
        candidate.id === plan.id ? plan : candidate,
      );
      this.view.pendingRemoval = plan;
      this.view.selectedId = plan.id;
      return plan;
    } catch (error) {
      if (this.alive(projectId)) {
        this.view.pendingRemoval = null;
        this.view.pendingError = describeError(error);
      }
      return null;
    }
  }

  /**
   * 确认删除：唯一会修改磁盘的入口。
   *
   * 拒绝条件（本地先挡一层，后端仍会再校验）：没有计划、计划不可删、令牌为空。
   * 失败时保留计划与错误信息，磁盘不变，可以重新计划后再试。
   */
  async confirmRemoval(): Promise<boolean> {
    const projectId = this.view.projectId;
    const plan = this.view.pendingRemoval;
    if (this.disposed || !projectId) return false;
    if (!plan) {
      this.view.pendingError = "E_GIT_CONFIRMATION_REQUIRED: 请先生成删除计划并确认";
      return false;
    }
    if (!plan.removable) {
      const blocker = plan.blockers[0];
      this.view.pendingError = blocker
        ? `${blocker}: ${blockerLabel(blocker)}`
        : "E_GIT_WORKTREE_UNKNOWN: 该工作树当前不可删除";
      return false;
    }
    const token = plan.token.trim();
    if (!token) {
      this.view.pendingError = "E_GIT_CONFIRMATION_REQUIRED: 删除需要显式确认令牌";
      return false;
    }
    this.view.removing = true;
    this.view.pendingError = null;
    try {
      await this.bridge.removeWorktree(projectId, plan.id, token);
      if (!this.alive(projectId)) return false;
      this.view.pendingRemoval = null;
      this.view.diff = null;
      await this.reload();
      return this.alive(projectId);
    } catch (error) {
      if (this.alive(projectId)) this.view.pendingError = describeError(error);
      return false;
    } finally {
      if (!this.disposed) this.view.removing = false;
    }
  }

  cancelRemoval(): void {
    this.view.pendingRemoval = null;
    this.view.pendingError = null;
  }

  /**
   * 清理 Git 已标记 prunable 的管理记录（异常退出/手工删目录后的恢复路径）。
   * 需要显式令牌；没有失效记录时不发请求。
   */
  async prune(): Promise<number | null> {
    const projectId = this.view.projectId;
    if (this.disposed || !projectId) return null;
    if (this.view.stale.length === 0) {
      this.view.error = "E_GIT_WORKTREE_UNKNOWN: 没有需要清理的失效记录";
      return null;
    }
    const token = this.view.pruneToken.trim();
    if (!token) {
      this.view.error = "E_GIT_CONFIRMATION_REQUIRED: 清理失效记录需要显式确认令牌";
      return null;
    }
    this.view.pruning = true;
    this.view.error = null;
    try {
      const removed = await this.bridge.pruneWorktrees(projectId, token);
      if (!this.alive(projectId)) return null;
      await this.reload();
      return removed;
    } catch (error) {
      if (this.alive(projectId)) this.view.error = describeError(error);
      return null;
    } finally {
      if (!this.disposed) this.view.pruning = false;
    }
  }

  /** 面板卸载：之后任何 await 回来的结果都不再写状态。 */
  dispose(): void {
    this.disposed = true;
    this.listSequence += 1;
    this.state.worktrees = {
      ...this.view,
      loading: false,
      diffLoading: false,
      creating: false,
      removing: false,
      pruning: false,
      pendingRemoval: null,
      pendingError: null,
    };
  }

  private alive(projectId: ProjectId): boolean {
    return !this.disposed && this.view.projectId === projectId;
  }

  private accepts(ticket: number, projectId: ProjectId): boolean {
    return this.alive(projectId) && ticket === this.listSequence;
  }
}
