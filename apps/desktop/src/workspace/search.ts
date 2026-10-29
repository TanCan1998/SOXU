/**
 * 搜索结果展示辅助（Issue #109）。
 *
 * 命中位置由后端给出（`matchStart`/`matchEnd` 是片段内的**字符**偏移），
 * 前端只负责切片高亮，**绝不重新计算**匹配位置：两套算法一定会漂移，
 * 一旦漂移就会出现「高亮错位」或「高亮到别的词上」。
 */

/** 片段切成的三段：命中前、命中词、命中后。 */
export interface SnippetParts {
  before: string;
  match: string;
  after: string;
}

/**
 * 按码点长度计数。
 *
 * 后端按字符（Unicode 标量）计数，JS 的 `length` 是 UTF-16 码元：
 * emoji 与部分生僻字会差一位，所以查询长度校验必须用码点数。
 */
export function charLength(text: string): number {
  return Array.from(text).length;
}

/**
 * 把片段按字符偏移切成三段。
 *
 * 偏移越界时夹到边界而不是抛错：IPC 边界上的一颗坏数据不该让整块面板崩掉，
 * 高亮退化成「整段不命中」比崩溃更容易被用户理解和接受。
 */
export function splitSnippet(
  snippet: string,
  matchStart: number,
  matchEnd: number,
): SnippetParts {
  const chars = Array.from(snippet);
  const start = clamp(Math.trunc(matchStart), 0, chars.length);
  const end = clamp(Math.trunc(matchEnd), start, chars.length);
  return {
    before: chars.slice(0, start).join(""),
    match: chars.slice(start, end).join(""),
    after: chars.slice(end).join(""),
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}
