/**
 * 更改列表的树形分组（Issue #121 · TASK-029）。
 *
 * 纯函数：输入后端下发的文件清单，输出可直接渲染的行；不读 DOM、不依赖 Vue。
 * 排序固定为「目录在前、文件在后，同类按名字」，与操作系统/语言环境无关，
 * 这样同一个仓库在任何平台上的顺序都一致（也便于测试断言）。
 */

import type { GitChangeFile } from "./types.ts";

/** 树/平铺共用的渲染行。 */
export interface GitRow {
  /** 目录为目录路径，文件为完整文件路径；可作列表 key。 */
  path: string;
  /** 显示名：目录名或文件名。 */
  name: string;
  depth: number;
  isDir: boolean;
  /** 目录行为 null。 */
  file: GitChangeFile | null;
  /** 目录下的文件数；文件行为 1。 */
  count: number;
  /** 目录下已知的增删行数合计（未知行数不计）。 */
  added: number;
  removed: number;
}

interface GitTreeNode extends GitRow {
  children: GitTreeNode[];
}

interface DirBuilder {
  name: string;
  path: string;
  dirs: Map<string, DirBuilder>;
  files: GitChangeFile[];
}

function byName(left: { name: string }, right: { name: string }): number {
  if (left.name === right.name) return 0;
  return left.name < right.name ? -1 : 1;
}

function fileName(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? path : path.slice(index + 1);
}

/** 目录汇总：文件数与已知增删行数都来自子行，不重新读 git。 */
function summarize(children: GitTreeNode[], base: Omit<GitTreeNode, "count" | "added" | "removed" | "children">): GitTreeNode {
  return {
    ...base,
    children,
    count: children.reduce((total, row) => total + row.count, 0),
    added: children.reduce((total, row) => total + row.added, 0),
    removed: children.reduce((total, row) => total + row.removed, 0),
  };
}

function childrenOf(builder: DirBuilder, depth: number): GitTreeNode[] {
  const dirs: GitTreeNode[] = [...builder.dirs.values()].sort(byName).map((child) =>
    summarize(childrenOf(child, depth + 1), {
      path: child.path,
      name: child.name,
      depth,
      isDir: true,
      file: null,
    }),
  );
  const files: GitTreeNode[] = builder.files
    .map((file) => ({
      path: file.path,
      name: fileName(file.path),
      depth,
      isDir: false,
      file,
      children: [],
      count: 1,
      added: file.added ?? 0,
      removed: file.removed ?? 0,
    }))
    .sort(byName);
  return [...dirs, ...files];
}

/** 把文件清单分组成树；返回顶层行，子行在 children 里。 */
export function buildGitTree(files: readonly GitChangeFile[]): GitTreeNode[] {
  const root: DirBuilder = { name: "", path: "", dirs: new Map(), files: [] };
  for (const file of files) {
    const segments = file.path.split("/").filter((segment) => segment.length > 0);
    let cursor = root;
    for (const segment of segments.slice(0, -1)) {
      const path = cursor.path ? cursor.path + "/" + segment : segment;
      let next = cursor.dirs.get(segment);
      if (!next) {
        next = { name: segment, path, dirs: new Map(), files: [] };
        cursor.dirs.set(segment, next);
      }
      cursor = next;
    }
    cursor.files.push(file);
  }
  return childrenOf(root, 0);
}

/** 树形视图：展开为行列表；collapsed 里的目录不展开其子行。 */
export function treeRows(
  files: readonly GitChangeFile[],
  collapsed: readonly string[],
): GitRow[] {
  const hidden = new Set(collapsed);
  const rows: GitRow[] = [];
  const walk = (list: readonly GitTreeNode[]) => {
    for (const node of list) {
      const { children, ...row } = node;
      rows.push(row);
      if (node.isDir && !hidden.has(node.path)) walk(children);
    }
  };
  walk(buildGitTree(files));
  return rows;
}

/** 平铺视图：一行一个文件，显示完整路径。 */
export function flatRows(files: readonly GitChangeFile[]): GitRow[] {
  return files.map((file) => ({
    path: file.path,
    name: file.path,
    depth: 0,
    isDir: false,
    file,
    count: 1,
    added: file.added ?? 0,
    removed: file.removed ?? 0,
  }));
}

/** 所有目录路径：用于「全部折叠」。 */
export function allDirectoryPaths(files: readonly GitChangeFile[]): string[] {
  const paths: string[] = [];
  const walk = (list: readonly GitTreeNode[]) => {
    for (const node of list) {
      if (!node.isDir) continue;
      paths.push(node.path);
      walk(node.children);
    }
  };
  walk(buildGitTree(files));
  return paths;
}
