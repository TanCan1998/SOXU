/**
 * diff 渲染：行号对齐 + 复用 S1 的 shiki 管线（Issue #121 · TASK-029）。
 *
 * 三层职责分开，方便单独测试：
 * 1. diffRows：把 git 的原始补丁切成行，并按 hunk 头算出旧/新行号；
 * 2. highlightDiffLines：调用 S1 的 highlightToHtml(patch, "diff")，按行返回 HTML；
 * 3. withHighlight：把两者按索引对齐（shiki 的行数与补丁行数一一对应）。
 *
 * 行号与内容必须来自同一份补丁：这里不做任何文本改写（只统一 CRLF），
 * 否则「界面看到的」和「git CLI 输出的」就会不一致。
 */

import { highlightToHtml } from "../markdown/highlighter.ts";

export type GitDiffLineKind = "meta" | "hunk" | "add" | "del" | "context" | "note";

export interface GitDiffRow {
  kind: GitDiffLineKind;
  /** 旧文件行号；新增行与文件头为 null。 */
  oldNumber: number | null;
  /** 新文件行号；删除行与文件头为 null。 */
  newNumber: number | null;
  /** 原始行文本（含 +/-/空格前缀）。 */
  text: string;
  /** 高亮后的 HTML；null 表示退回纯文本渲染。 */
  html: string | null;
}

/**
 * 最多渲染多少行 diff。
 *
 * 后端单文件补丁上限 512 KiB，极端情况下有几万行；一次性铺进 DOM 会让抽屉卡住。
 * 超出时界面明确提示「仅显示前 N 行」，不做静默截断。
 */
export const MAX_RENDERED_DIFF_ROWS = 1200;

/** hunk 头：@@ -旧起点,旧行数 +新起点,新行数 @@ 可选小节标题。 */
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** 统一换行符：git 输出是 LF，但粘贴/测试夹具可能带 CRLF。 */
export function normalizePatch(patch: string): string {
  return patch.replace(/\r\n/g, "\n");
}

/** 补丁 → 行列表（含旧/新行号）。 */
export function diffRows(patch: string): GitDiffRow[] {
  const lines = normalizePatch(patch).split("\n");
  // 末尾换行不是一行内容：去掉 split 产生的空尾行。
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const rows: GitDiffRow[] = [];
  let oldNumber = 0;
  let newNumber = 0;
  let inHunk = false;
  for (const text of lines) {
    const header = HUNK_HEADER.exec(text);
    if (header) {
      oldNumber = Number(header[1]);
      newNumber = Number(header[3]);
      inHunk = true;
      rows.push({ kind: "hunk", oldNumber: null, newNumber: null, text, html: null });
      continue;
    }
    if (!inHunk) {
      rows.push({ kind: "meta", oldNumber: null, newNumber: null, text, html: null });
      continue;
    }
    if (text.startsWith("+")) {
      rows.push({ kind: "add", oldNumber: null, newNumber: newNumber, text, html: null });
      newNumber += 1;
      continue;
    }
    if (text.startsWith("-")) {
      rows.push({ kind: "del", oldNumber: oldNumber, newNumber: null, text, html: null });
      oldNumber += 1;
      continue;
    }
    if (text.startsWith("\\")) {
      // "\ No newline at end of file"：不对应任何行，不推进行号。
      rows.push({ kind: "note", oldNumber: null, newNumber: null, text, html: null });
      continue;
    }
    // 上下文行以空格开头；异常行同样按上下文推进行号，避免整体错位。
    rows.push({ kind: "context", oldNumber: oldNumber, newNumber: newNumber, text, html: null });
    oldNumber += 1;
    newNumber += 1;
  }
  return rows;
}

/**
 * 用 S1 的 shiki 管线高亮整份补丁，返回按行切开的 HTML。
 *
 * 高亮失败（语言包缺失/着色异常）返回 null，界面退回纯文本——与 markdown 代码块一致。
 */
export async function highlightDiffLines(patch: string): Promise<string[] | null> {
  const normalized = normalizePatch(patch);
  if (!normalized.trim()) return null;
  const html = await highlightToHtml(normalized, "diff");
  return html ? html.split("\n") : null;
}

/** 把高亮行按索引贴到行上；数量不一致时多出来的行退回纯文本。 */
export function withHighlight(rows: readonly GitDiffRow[], lines: readonly string[] | null): GitDiffRow[] {
  if (!lines) return rows.map((row) => ({ ...row, html: null }));
  return rows.map((row, index) => ({ ...row, html: lines[index] ?? null }));
}

/** 只渲染前 MAX_RENDERED_DIFF_ROWS 行；hidden 是未渲染的行数。 */
export function visibleDiffRows(rows: readonly GitDiffRow[]): {
  rows: GitDiffRow[];
  hidden: number;
} {
  if (rows.length <= MAX_RENDERED_DIFF_ROWS) return { rows: [...rows], hidden: 0 };
  return { rows: rows.slice(0, MAX_RENDERED_DIFF_ROWS), hidden: rows.length - MAX_RENDERED_DIFF_ROWS };
}
