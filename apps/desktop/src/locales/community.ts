/**
 * 社区语言包的校验（Issue #135）。
 *
 * 语言包是**纯 JSON 数据**：复制基准包 → 翻译 → 提交或导入。这里只做校验，
 * 不碰文件系统，也不认识 Tauri——落盘在后端命令，选择文件在设置页。
 *
 * 校验规则（每条都要给出可读原因，用户才知道怎么改）：
 * 1. 必须是合法 JSON 对象，键值都是字符串；
 * 2. key 必须来自基准包（**子集**允许，缺的键回退 zh-CN）；
 * 3. 值不能为空；
 * 4. 同一个 key 不能在文件里出现两次（JSON.parse 会静默取最后一个，必须自己扫）；
 * 5. 语言标签来自文件名 <tag>.json，不能覆盖内置语言。
 */

import { BASE_MESSAGES } from "./index.ts";
import { scanTopLevelKeys } from "./packScan.ts";
import { isBuiltinLocale, isLocaleTag } from "../settings/locale.ts";

/** 单个语言包的大小上限：一份完整基准包约 3 KiB，256 KiB 足够宽裕。 */
export const MAX_LOCALE_PACK_BYTES = 256 * 1024;

/** 一次最多列出几条问题：全列出来反而让人读不完。 */
const MAX_LISTED = 6;

export interface LocalePackAccepted {
  ok: true;
  tag: string;
  entries: Record<string, string>;
}

export interface LocalePackRejected {
  ok: false;
  problems: string[];
}

export type LocalePackValidation = LocalePackAccepted | LocalePackRejected;

// 顶层键扫描在 packScan.ts：那份实现同时被 CI 脚本复用，避免两处规则漂移。
export { scanTopLevelKeys } from "./packScan.ts";
export type { TopLevelKeyScan } from "./packScan.ts";

/** 文件名 → 语言标签；不是 .json 或没有主名时返回 null。 */
export function localePackTagFromFileName(fileName: string): string | null {
  const base = fileName.split(/[\\/]/u).pop() ?? "";
  if (!base.toLowerCase().endsWith(".json")) return null;
  const stem = base.slice(0, -".json".length).trim();
  return stem === "" ? null : stem;
}

export interface ValidateLocalePackOptions {
  /** 文件原文。 */
  raw: string;
  /** 语言标签；不给则从 fileName 推导。 */
  tag?: string;
  /** 用户选中的文件名（含路径也可以）。 */
  fileName?: string;
  /** 基准包允许的 key；默认取内置 zh-CN。 */
  baseKeys?: ReadonlySet<string>;
}

function reject(problems: string[]): LocalePackRejected {
  return { ok: false, problems };
}

function listProblems(label: string, values: string[]): string[] {
  if (values.length === 0) return [];
  const head = values.slice(0, MAX_LISTED).join("、");
  const rest = values.length > MAX_LISTED ? " 等 " + values.length + " 项" : "";
  return [label + "：" + head + rest];
}

export function validateLocalePack(options: ValidateLocalePackOptions): LocalePackValidation {
  const { raw } = options;
  const baseKeys = options.baseKeys ?? new Set(Object.keys(BASE_MESSAGES));

  if (typeof raw !== "string" || raw.trim() === "") return reject(["文件是空的"]);
  const bytes = new TextEncoder().encode(raw).length;
  if (bytes > MAX_LOCALE_PACK_BYTES) {
    return reject(["文件过大：" + bytes + " 字节，上限 " + MAX_LOCALE_PACK_BYTES + " 字节"]);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return reject(["不是合法的 JSON：" + (error as Error).message]);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return reject(['顶层必须是 { "key": "文案" } 对象']);
  }

  const problems: string[] = [];
  const scan = scanTopLevelKeys(raw);
  if (scan.error) problems.push(scan.error);
  problems.push(...listProblems("重复的 key", scan.duplicates));

  const entries: Record<string, string> = {};
  const unknown: string[] = [];
  const empty: string[] = [];
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!baseKeys.has(key)) {
      unknown.push(key);
      continue;
    }
    if (typeof value !== "string" || value.trim() === "") {
      empty.push(key);
      continue;
    }
    entries[key] = value;
  }
  problems.push(...listProblems("不是基准包的 key（子集之外的键不会被使用）", unknown));
  problems.push(...listProblems("文案为空", empty));

  const tag = options.tag ?? localePackTagFromFileName(options.fileName ?? "");
  if (!tag) {
    problems.push("无法确定语言标签：请把文件命名为 <tag>.json，例如 ja-JP.json");
  } else if (!isLocaleTag(tag)) {
    problems.push("语言标签不合法：" + tag + "（形如 ja-JP / pt-BR）");
  } else if (isBuiltinLocale(tag)) {
    problems.push("不能覆盖内置语言：" + tag + "，请换一个标签");
  }

  if (problems.length > 0) return reject(problems);
  if (Object.keys(entries).length === 0) return reject(["语言包里没有任何可用的文案"]);

  return { ok: true, tag: tag as string, entries };
}

/** 基准包的全部 key：导入校验与启动校验共用同一份集合。 */
export function baseLocaleKeys(): Set<string> {
  return new Set(Object.keys(BASE_MESSAGES));
}
