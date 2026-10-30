/**
 * 文件抽屉核心（Issue #120 / TASK-028）：懒加载目录树、排序、树形/平铺、只读预览与受约束的写操作。
 *
 * 与 `worktreeWorkspace.ts` 一样不依赖 Vue：Pinia store 只做代理，
 * node:test 用假 bridge 直接驱动同一份逻辑。
 *
 * 五条规则：
 * 1. **懒加载**：只有被展开的目录层才会发 `listDir`；打开抽屉只读根目录一层。
 * 2. **迟到响应一律丢弃**：目录、预览、搜索各自带序号，切项目或切文件后旧响应不写状态。
 * 3. **只读预览**：点文件只调 `readFile`，不写任何东西；二进制只回标记。
 * 4. **写操作要确认**：删除必须传入与目标名称完全一致的 `confirmName`，非空目录还要 `recursive`。
 * 5. **失败只写错误**：树、预览与磁盘保持原样，可以刷新后重试。
 */

import { resolveLanguage } from "../markdown/languages.ts";
import { describeError } from "./mapping.ts";
import {
  createFileState,
  createWorkspaceState,
  type DirListing,
  type FileBrowserState,
  type FileContent,
  type FileEntry,
  type FileRow,
  type FileSearchResult,
  type FileSortDirection,
  type FileSortKey,
  type FileViewMode,
  type ProjectId,
  type WorkspaceBridge,
  type WorkspaceState,
} from "./types.ts";

/** 根目录的相对路径：空字符串（与后端约定一致）。 */
export const ROOT_PATH = "";

/** 平铺视图最多渲染的行数：再长就不是「看文件」而是「刷列表」了。 */
export const MAX_FLAT_ROWS = 2_000;

/** 路径拼接：目录为空表示根目录。 */
export function joinPath(directory: string, name: string): string {
  return directory ? directory + "/" + name : name;
}

/** 取父目录（根目录的父目录仍是根目录，避免越界到 `..`）。 */
export function parentPath(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? ROOT_PATH : path.slice(0, index);
}

/** 取最后一段名称。 */
export function baseName(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? path : path.slice(index + 1);
}

/** 人类可读的大小（目录与未知大小显示为「—」）。 */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return bytes + " B";
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return (value >= 10 ? value.toFixed(0) : value.toFixed(1)) + " " + units[unit];
}

/** 文件扩展名 → shiki 语言 id（复用 S1 的语言白名单；不认识就返回 null = 纯文本）。 */
export function fileLanguage(name: string): string | null {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return null;
  return resolveLanguage(name.slice(dot + 1));
}

/**
 * 排序：目录永远在文件前面（这是文件管理器的通用预期），同组内按用户选键排序。
 *
 * 名称用 `localeCompare`（中文按拼音、大小写不敏感），时间与大小用数值。
 */
export function sortEntries(
  entries: readonly FileEntry[],
  sort: FileSortKey,
  direction: FileSortDirection,
): FileEntry[] {
  const factor = direction === "asc" ? 1 : -1;
  const compare = (left: FileEntry, right: FileEntry): number => {
    const leftDir = left.kind === "dir";
    const rightDir = right.kind === "dir";
    if (leftDir !== rightDir) return leftDir ? -1 : 1;
    if (sort === "name") return factor * left.name.localeCompare(right.name, "zh-Hans-CN");
    if (sort === "size") return factor * (left.size - right.size);
    const leftTime = left.modifiedAtMs ?? 0;
    const rightTime = right.modifiedAtMs ?? 0;
    return factor * (leftTime - rightTime);
  };
  return [...entries].sort(compare);
}

function visibleEntries(
  entries: readonly FileEntry[],
  showHidden: boolean,
): FileEntry[] {
  return showHidden ? [...entries] : entries.filter((entry) => !entry.hidden);
}

/**
 * 把已加载的目录层展开成渲染用的扁平行。
 *
 * - `tree`：从根目录深度优先，只进入已展开的目录；未加载的目录展开时由调用方补读。
 * - `flat`：所有**已加载**层里的条目平铺（不递归读盘，未展开的目录不会凭空出现）。
 */
export function buildRows(state: FileBrowserState): FileRow[] {
  const rows: FileRow[] = [];
  const directory = state.directories[ROOT_PATH];
  if (!directory || !directory.loaded) return rows;

  if (state.view === "flat") {
    const collected: FileEntry[] = [];
    for (const layer of Object.values(state.directories)) {
      if (!layer.loaded) continue;
      collected.push(...visibleEntries(layer.entries, state.showHidden));
    }
    const sorted = sortEntries(collected, state.sort, state.direction);
    // 平铺视图用完整相对路径做标签：没有缩进层级，同名文件也不会分不清。
    return sorted
      .slice(0, MAX_FLAT_ROWS)
      .map((entry) => ({ ...rowOf(state, entry, 0), name: entry.path }));
  }

  const walk = (path: string, depth: number): void => {
    const layer = state.directories[path];
    if (!layer || !layer.loaded) return;
    for (const entry of sortEntries(
      visibleEntries(layer.entries, state.showHidden),
      state.sort,
      state.direction,
    )) {
      rows.push(rowOf(state, entry, depth));
      if (entry.kind === "dir" && state.expanded[entry.path]) {
        walk(entry.path, depth + 1);
      }
    }
  };
  walk(ROOT_PATH, 0);
  return rows;
}

function rowOf(state: FileBrowserState, entry: FileEntry, depth: number): FileRow {
  return {
    path: entry.path,
    name: entry.name,
    kind: entry.kind,
    depth,
    expanded: state.expanded[entry.path] === true,
    loaded: state.directories[entry.path]?.loaded === true,
    size: entry.size,
    modifiedAtMs: entry.modifiedAtMs,
    hidden: entry.hidden,
    symlink: entry.symlink,
  };
}

/** 文件抽屉的单一 owner：所有目录请求、预览请求与写操作都从这里发出。 */
export class FileBrowser {
  private readonly bridge: WorkspaceBridge;
  private readonly state: WorkspaceState;
  private disposed = false;
  /** 目录请求序号：切项目/刷新时旧响应必须丢弃。 */
  private directorySequence = 0;
  private previewSequence = 0;
  private searchSequence = 0;

  constructor(bridge: WorkspaceBridge, state: WorkspaceState = createWorkspaceState()) {
    this.bridge = bridge;
    this.state = state;
  }

  get view(): FileBrowserState {
    return this.state.files;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** 渲染用的扁平行（树形或平铺）。 */
  rows(): FileRow[] {
    return buildRows(this.view);
  }

  /** 打开面板：只读根目录一层；同一项目重复打开不重复请求。 */
  async open(projectId: ProjectId | null): Promise<void> {
    if (this.disposed) return;
    if (!projectId) {
      this.view.projectId = null;
      this.view.error = "E_FILES_ROOT_UNKNOWN: 尚未选择项目";
      return;
    }
    if (this.view.projectId !== projectId) {
      // 切项目先清空：宁可短暂空白，也不展示上一个项目的目录树。
      this.state.files = { ...createFileState(), projectId };
    }
    if (this.view.directories[ROOT_PATH]?.loaded) return;
    await this.loadDirectory(ROOT_PATH);
  }

  /** 刷新一层目录（默认根目录），保留其它已加载层。 */
  async refresh(path: string = ROOT_PATH): Promise<void> {
    await this.loadDirectory(path, true);
  }

  /** 展开/收起目录；展开未加载的目录时才发请求（懒加载的唯一触发点）。 */
  async toggle(path: string): Promise<void> {
    if (this.disposed) return;
    if (this.view.expanded[path]) {
      this.view.expanded[path] = false;
      return;
    }
    this.view.expanded[path] = true;
    if (!this.view.directories[path]?.loaded) await this.loadDirectory(path);
  }

  async expand(path: string): Promise<void> {
    if (this.disposed || this.view.expanded[path]) return;
    this.view.expanded[path] = true;
    if (!this.view.directories[path]?.loaded) await this.loadDirectory(path);
  }

  collapse(path: string): void {
    this.view.expanded[path] = false;
  }

  collapseAll(): void {
    this.view.expanded = {};
  }

  setSort(sort: FileSortKey): void {
    if (this.view.sort === sort) {
      // 再点同一个键就翻转方向：与文件管理器一致，不需要第二个控件。
      this.view.direction = this.view.direction === "asc" ? "desc" : "asc";
      return;
    }
    this.view.sort = sort;
    this.view.direction = "asc";
  }

  setView(view: FileViewMode): void {
    this.view.view = view;
  }

  setShowHidden(show: boolean): void {
    this.view.showHidden = show;
  }

  /** 点击文件：只读预览（不写盘），迟到的响应按序号丢弃。 */
  async select(path: string): Promise<FileContent | null> {
    const projectId = this.view.projectId;
    if (this.disposed || !projectId) return null;
    const seq = ++this.previewSequence;
    this.view.selectedPath = path;
    this.view.preview = { path, loading: true, error: null, content: null, seq };
    try {
      const content = await this.bridge.readFile(projectId, path);
      if (!this.acceptsPreview(seq, path)) return null;
      this.view.preview = { path, loading: false, error: null, content, seq };
      return content;
    } catch (error) {
      if (this.acceptsPreview(seq, path)) {
        this.view.preview = {
          path,
          loading: false,
          error: describeError(error),
          content: null,
          seq,
        };
      }
      return null;
    }
  }

  clearPreview(): void {
    this.previewSequence += 1;
    this.view.selectedPath = null;
    this.view.preview = null;
  }

  /** 新建文件（内容可选）；成功后刷新父目录并选中新文件。 */
  async createFile(path: string, content?: string): Promise<boolean> {
    const projectId = this.view.projectId;
    if (this.disposed || !projectId) return false;
    const target = path.trim();
    if (!target) {
      this.view.error = "E_FILES_PATH_INVALID: 文件名不能为空";
      return false;
    }
    this.view.mutating = true;
    this.view.error = null;
    try {
      await this.bridge.createFile(projectId, target, content ?? null);
      if (!this.alive(projectId)) return false;
      await this.loadDirectory(parentPath(target), true);
      if (!this.alive(projectId)) return false;
      // 新建的文件要看得见：把它的父目录展开（已展开时是 no-op）。
      await this.expand(parentPath(target));
      return true;
    } catch (error) {
      if (this.alive(projectId)) this.view.error = describeError(error);
      return false;
    } finally {
      if (!this.disposed) this.view.mutating = false;
    }
  }

  /** 重命名/移动；成功后同时刷新源与目标的父目录。 */
  async rename(from: string, to: string): Promise<boolean> {
    const projectId = this.view.projectId;
    if (this.disposed || !projectId) return false;
    const target = to.trim();
    if (!target) {
      this.view.error = "E_FILES_PATH_INVALID: 新名称不能为空";
      return false;
    }
    this.view.mutating = true;
    this.view.error = null;
    try {
      await this.bridge.renamePath(projectId, from, target);
      if (!this.alive(projectId)) return false;
      await this.loadDirectory(parentPath(from), true);
      if (parentPath(target) !== parentPath(from)) {
        await this.loadDirectory(parentPath(target), true);
      }
      if (!this.alive(projectId)) return false;
      if (this.view.selectedPath === from) this.clearPreview();
      return true;
    } catch (error) {
      if (this.alive(projectId)) this.view.error = describeError(error);
      return false;
    } finally {
      if (!this.disposed) this.view.mutating = false;
    }
  }

  /**
   * 删除：`confirmName` 必须与目标名称完全一致（后端还会再校验一次）。
   * 目录非空时必须显式传 `recursive`，否则后端拒绝——这里不替用户猜。
   */
  async remove(
    path: string,
    options: { recursive?: boolean; confirmName: string },
  ): Promise<boolean> {
    const projectId = this.view.projectId;
    if (this.disposed || !projectId) return false;
    if (options.confirmName !== baseName(path)) {
      this.view.error =
        "E_FILES_CONFIRM_MISMATCH: 请输入「" + baseName(path) + "」以确认删除";
      return false;
    }
    this.view.mutating = true;
    this.view.error = null;
    try {
      await this.bridge.deletePath(projectId, path, {
        recursive: options.recursive ?? false,
        confirmName: options.confirmName,
      });
      if (!this.alive(projectId)) return false;
      if (this.view.selectedPath === path) this.clearPreview();
      delete this.view.expanded[path];
      await this.loadDirectory(parentPath(path), true);
      return this.alive(projectId);
    } catch (error) {
      if (this.alive(projectId)) this.view.error = describeError(error);
      return false;
    } finally {
      if (!this.disposed) this.view.mutating = false;
    }
  }

  /** 文件内搜索：空查询直接清空结果，不发请求。 */
  async search(query: string): Promise<FileSearchResult | null> {
    const projectId = this.view.projectId;
    if (this.disposed || !projectId) return null;
    const trimmed = query.trim();
    if (!trimmed) {
      this.searchSequence += 1;
      this.view.search = null;
      return null;
    }
    const seq = ++this.searchSequence;
    this.view.search = { query: trimmed, loading: true, error: null, result: null, seq };
    try {
      const result = await this.bridge.searchFiles(projectId, trimmed);
      if (!this.acceptsSearch(seq)) return null;
      this.view.search = { query: trimmed, loading: false, error: null, result, seq };
      return result;
    } catch (error) {
      if (this.acceptsSearch(seq)) {
        this.view.search = {
          query: trimmed,
          loading: false,
          error: describeError(error),
          result: null,
          seq,
        };
      }
      return null;
    }
  }

  clearSearch(): void {
    this.searchSequence += 1;
    this.view.search = null;
  }

  /** 面板关闭/卸载：之后任何 await 回来的结果都不再写状态。 */
  dispose(): void {
    this.disposed = true;
    this.directorySequence += 1;
    this.previewSequence += 1;
    this.searchSequence += 1;
    this.state.files = {
      ...this.view,
      loading: false,
      mutating: false,
      preview: null,
      search: null,
      error: null,
    };
  }

  private async loadDirectory(path: string, force = false): Promise<void> {
    const projectId = this.view.projectId;
    if (this.disposed || !projectId) return;
    const existing = this.view.directories[path];
    if (existing?.loaded && !force) return;
    const seq = ++this.directorySequence;
    this.view.loading = true;
    this.view.error = null;
    this.view.directories[path] = {
      path,
      entries: existing?.entries ?? [],
      total: existing?.total ?? 0,
      truncated: existing?.truncated ?? false,
      loaded: existing?.loaded ?? false,
      loading: true,
      error: null,
    };
    try {
      const listing: DirListing = await this.bridge.listDir(projectId, path);
      if (!this.acceptsDirectory(seq, projectId, path)) return;
      this.view.directories[path] = {
        path,
        entries: listing.entries,
        total: listing.total,
        truncated: listing.truncated,
        loaded: true,
        loading: false,
        error: null,
      };
    } catch (error) {
      if (!this.acceptsDirectory(seq, projectId, path)) return;
      this.view.directories[path] = {
        path,
        entries: existing?.entries ?? [],
        total: existing?.total ?? 0,
        truncated: existing?.truncated ?? false,
        loaded: false,
        loading: false,
        error: describeError(error),
      };
      this.view.error = describeError(error);
    } finally {
      if (!this.disposed && this.view.projectId === projectId) {
        const layer = this.view.directories[path];
        if (layer) layer.loading = false;
        this.view.loading = Object.values(this.view.directories).some((item) => item.loading);
      }
    }
  }

  private alive(projectId: ProjectId): boolean {
    return !this.disposed && this.view.projectId === projectId;
  }

  private acceptsDirectory(seq: number, projectId: ProjectId, path: string): boolean {
    return this.alive(projectId) && seq === this.directorySequence && Boolean(this.view.directories[path]);
  }

  private acceptsPreview(seq: number, path: string): boolean {
    return !this.disposed && seq === this.previewSequence && this.view.selectedPath === path;
  }

  private acceptsSearch(seq: number): boolean {
    return !this.disposed && seq === this.searchSequence;
  }
}
