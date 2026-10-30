/**
 * Git 抽屉核心（Issue #121 · TASK-029）：更改列表、单文件 diff、暂存/提交/推送/拉取。
 *
 * 与 WorktreeCatalog 一样不依赖 Vue：Pinia store 只做代理，
 * node:test 用假 bridge 直接驱动同一份逻辑。
 *
 * 五条规则：
 * 1. 只观察，不改写会话：Git 面板不触碰 Tab、消息或 activeSessionId；
 * 2. 迟到的响应一律丢弃：status 与 diff 各有一个递增序号，切项目/切文件后旧结果不写状态；
 * 3. 一次只展开一个文件 diff：抽屉宽度有限，多份补丁同时展开既读不清也占内存；
 * 4. 写操作串行：action 不为 idle 时拒绝第二次点击，避免并发写索引；
 * 5. 失败只写错误，列表与磁盘保持原样，可重新刷新后再试。
 */

import { allDirectoryPaths } from "./gitTree.ts";
import { describeError } from "./mapping.ts";
import {
  createGitState,
  type GitChangeFile,
  type GitLayout,
  type GitState,
  type GitStatusView,
  type ProjectId,
  type WorktreeId,
  type WorkspaceBridge,
  type WorkspaceState,
} from "./types.ts";

/** 提交说明的字符上限；与 Rust 侧 MAX_COMMIT_MESSAGE_CHARS 对齐。 */
export const MAX_COMMIT_MESSAGE_CHARS = 4000;

export class GitWorkspace {
  private readonly bridge: WorkspaceBridge;
  private readonly state: WorkspaceState;
  private disposed = false;
  /** 只允许最后一次 status 写清单：连续刷新时旧响应必须丢弃。 */
  private statusSeq = 0;
  /** 只允许最后一次 diff 写详情：快速切换文件时旧补丁必须丢弃。 */
  private diffSeq = 0;

  constructor(bridge: WorkspaceBridge, state: WorkspaceState) {
    this.bridge = bridge;
    this.state = state;
  }

  get view(): GitState {
    return this.state.git;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** 打开（或切换）某个项目/工作树；身份变化时先清空，避免展示上一个仓库的改动。 */
  async open(projectId: ProjectId | null, worktreeId: WorktreeId | null): Promise<void> {
    if (this.disposed) return;
    const changed = this.view.projectId !== projectId || this.view.worktreeId !== worktreeId;
    if (changed) {
      this.statusSeq += 1;
      this.diffSeq += 1;
      // 布局是用户偏好，跨项目保留；其余状态属于上一个仓库，必须清空。
      this.state.git = { ...createGitState(), layout: this.view.layout };
    }
    this.view.projectId = projectId;
    this.view.worktreeId = worktreeId;
    if (!projectId) {
      this.view.loading = false;
      return;
    }
    await this.reload();
  }

  /** 重新读取更改列表（只读）。 */
  async reload(): Promise<void> {
    const projectId = this.view.projectId;
    if (this.disposed || !projectId) return;
    const ticket = ++this.statusSeq;
    this.view.loading = true;
    this.view.error = null;
    try {
      const status = await this.bridge.gitStatus(projectId, this.view.worktreeId);
      if (!this.accepts(ticket, projectId)) return;
      this.applyStatus(status);
    } catch (error) {
      if (this.accepts(ticket, projectId)) this.view.error = describeError(error);
    } finally {
      if (!this.disposed && this.view.projectId === projectId) this.view.loading = false;
    }
  }

  /**
   * 展开/收起某个文件的 diff。
   *
   * 再次点击同一文件、或传入 null，都会收起（「全部折叠」也用这条路径）。
   */
  async select(path: string | null): Promise<void> {
    if (this.disposed) return;
    if (!path || path === this.view.selectedPath) {
      this.collapse();
      return;
    }
    const file = this.view.status?.files.find((candidate) => candidate.path === path);
    if (!file) return;
    this.view.selectedPath = path;
    this.view.diff = null;
    this.view.diffError = null;
    await this.loadDiff(path, file);
  }

  /** 收起当前展开的 diff，并丢弃在途结果。 */
  collapse(): void {
    this.diffSeq += 1;
    this.view.selectedPath = null;
    this.view.diff = null;
    this.view.diffError = null;
    this.view.diffLoading = false;
  }

  /** 展开/收起一个目录（树形视图）。 */
  toggleDir(path: string): void {
    if (this.disposed) return;
    const collapsed = this.view.collapsedDirs;
    this.view.collapsedDirs = collapsed.includes(path)
      ? collapsed.filter((candidate) => candidate !== path)
      : [...collapsed, path];
  }

  /** 全部折叠：所有目录收起，同时收起已展开的 diff。 */
  collapseAll(): void {
    if (this.disposed) return;
    this.view.collapsedDirs = allDirectoryPaths(this.view.status?.files ?? []);
    this.collapse();
  }

  setLayout(layout: GitLayout): void {
    if (this.disposed) return;
    this.view.layout = layout;
  }

  /** 提交说明输入（由抽屉的 textarea 转发）。 */
  setCommitMessage(value: string): void {
    if (this.disposed) return;
    this.view.commitMessage = value;
  }

  /** 暂存全部改动；返回是否成功。 */
  async stageAll(): Promise<boolean> {
    const projectId = this.view.projectId;
    if (this.disposed || !projectId || this.view.action !== "idle") return false;
    this.view.action = "staging";
    this.view.actionError = null;
    this.view.actionNotice = null;
    try {
      const status = await this.bridge.gitStage(projectId, this.view.worktreeId, []);
      if (!this.alive(projectId)) return false;
      this.applyStatus(status);
      this.view.actionNotice = "已暂存全部改动";
      return true;
    } catch (error) {
      if (this.alive(projectId)) this.view.actionError = describeError(error);
      return false;
    } finally {
      if (!this.disposed) this.view.action = "idle";
    }
  }

  /** 提交已暂存内容；说明为空时本地先拦一层，不产生一次无意义的 IPC。 */
  async commit(): Promise<boolean> {
    const projectId = this.view.projectId;
    const message = this.view.commitMessage.trim();
    if (this.disposed || !projectId || this.view.action !== "idle") return false;
    if (!message) {
      this.view.actionError = "E_GIT_COMMIT_MESSAGE_INVALID: 提交说明不能为空";
      return false;
    }
    if (message.length > MAX_COMMIT_MESSAGE_CHARS) {
      this.view.actionError = "E_GIT_COMMIT_MESSAGE_INVALID: 提交说明过长";
      return false;
    }
    this.view.action = "committing";
    this.view.actionError = null;
    this.view.actionNotice = null;
    try {
      const result = await this.bridge.gitCommit(projectId, this.view.worktreeId, message);
      if (!this.alive(projectId)) return false;
      // applyStatus 会收起已失效的 diff（提交后文件清单必然变化）。
      this.applyStatus(result.status);
      this.view.commitMessage = "";
      this.view.actionNotice = "已提交 " + result.shortHash + " · " + result.subject;
      return true;
    } catch (error) {
      if (this.alive(projectId)) this.view.actionError = describeError(error);
      return false;
    } finally {
      if (!this.disposed) this.view.action = "idle";
    }
  }

  /** 推送当前分支；失败时错误里带 git 的原始原因。 */
  push(): Promise<boolean> {
    return this.remote("push");
  }

  /** 拉取（只快进）；失败时不产生合并提交。 */
  pull(): Promise<boolean> {
    return this.remote("pull");
  }

  /** 面板卸载：之后任何 await 回来的结果都不再写状态。 */
  dispose(): void {
    this.disposed = true;
    this.statusSeq += 1;
    this.diffSeq += 1;
    this.state.git = {
      ...this.view,
      loading: false,
      diffLoading: false,
      action: "idle",
    };
  }

  private async remote(operation: "push" | "pull"): Promise<boolean> {
    const projectId = this.view.projectId;
    if (this.disposed || !projectId || this.view.action !== "idle") return false;
    this.view.action = operation === "push" ? "pushing" : "pulling";
    this.view.actionError = null;
    this.view.actionNotice = null;
    try {
      const result =
        operation === "push"
          ? await this.bridge.gitPush(projectId, this.view.worktreeId)
          : await this.bridge.gitPull(projectId, this.view.worktreeId);
      if (!this.alive(projectId)) return false;
      this.applyStatus(result.status);
      const summary =
        (operation === "push" ? "推送成功" : "拉取成功") +
        "：领先 " +
        result.status.ahead +
        " · 落后 " +
        result.status.behind;
      this.view.actionNotice = result.output ? summary + "\n" + result.output : summary;
      return true;
    } catch (error) {
      if (this.alive(projectId)) this.view.actionError = describeError(error);
      return false;
    } finally {
      if (!this.disposed) this.view.action = "idle";
    }
  }

  private async loadDiff(path: string, file: GitChangeFile): Promise<void> {
    const projectId = this.view.projectId;
    if (this.disposed || !projectId) return;
    const ticket = ++this.diffSeq;
    // 只有暂存改动、没有未暂存改动时读暂存区：否则 git diff 会是空的。
    const staged = !file.unstaged && file.staged;
    this.view.diffLoading = true;
    try {
      const diff = await this.bridge.gitDiff(projectId, this.view.worktreeId, path, staged);
      if (!this.alive(projectId) || ticket !== this.diffSeq) return;
      if (this.view.selectedPath !== path) return;
      this.view.diff = diff;
    } catch (error) {
      if (this.alive(projectId) && ticket === this.diffSeq) {
        this.view.diffError = describeError(error);
      }
    } finally {
      if (!this.disposed && ticket === this.diffSeq) this.view.diffLoading = false;
    }
  }

  /**
   * 应用最新状态。
   *
   * 展开的 diff 只在「仍然有效」时保留：文件消失、或暂存/未暂存标记变化
   * （例如刚点了全部暂存）都必须收起——否则界面会继续展示上一份补丁，
   * 与列表里的徽章自相矛盾。
   */
  private applyStatus(status: GitStatusView): void {
    const selected = this.view.selectedPath;
    const previous = selected
      ? this.view.status?.files.find((candidate) => candidate.path === selected)
      : undefined;
    const next = selected
      ? status.files.find((candidate) => candidate.path === selected)
      : undefined;
    const stillValid =
      previous !== undefined &&
      next !== undefined &&
      previous.staged === next.staged &&
      previous.unstaged === next.unstaged &&
      previous.status === next.status;

    this.view.status = status;
    this.view.root = status.root;
    if (!stillValid) this.collapse();
  }

  private alive(projectId: ProjectId): boolean {
    return !this.disposed && this.view.projectId === projectId;
  }

  private accepts(ticket: number, projectId: ProjectId): boolean {
    return this.alive(projectId) && ticket === this.statusSeq;
  }
}
