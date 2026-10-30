/**
 * 界面语言偏好（Issue #135）。
 *
 * 只负责三件纯逻辑：标签校验、系统语言探测、偏好读写。
 * 语言包的加载与回退在 locales/index.ts，落盘位置由后端命令决定。
 *
 * 为什么不复用 settings/storage.ts 的 readStoredRecord：那边存的是 JSON 对象，
 * 这里存的是一个短字符串；用一个对象去包一层字符串只会让存储格式更难排查。
 */

import { defaultStorage, type KeyValueStorage } from "./storage.ts";

/** 存储键：与其它偏好并列，改名前先确认没有别处读它。 */
export const LOCALE_STORAGE_KEY = "soxu.locale";

/**
 * 语言标签形如 zh-CN / en-US / pt-BR：主语言 2-3 位小写，可选子标签。
 * 只用 ASCII 字母数字与「-」：这个值会进后端文件名，绝不允许出现路径分隔符。
 */
const LOCALE_TAG = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u;

/** 无法识别或读不到偏好时的回退语言。 */
export const FALLBACK_LOCALE = "zh-CN";

/** 内置语言：即使没有导入任何语言包也能直接切换。 */
export const BUILTIN_LOCALES = Object.freeze([
  { tag: "zh-CN", label: "简体中文" },
  { tag: "en-US", label: "English" },
] as const);

export type BuiltinLocaleTag = (typeof BUILTIN_LOCALES)[number]["tag"];

export function isLocaleTag(value: unknown): value is string {
  return typeof value === "string" && value.length <= 32 && LOCALE_TAG.test(value);
}

export function isBuiltinLocale(tag: string): tag is BuiltinLocaleTag {
  return BUILTIN_LOCALES.some((entry) => entry.tag === tag);
}

/** 内置语言的显示名；导入的语言包没有显示名，直接用标签本身。 */
export function localeLabel(tag: string): string {
  return BUILTIN_LOCALES.find((entry) => entry.tag === tag)?.label ?? tag;
}

/**
 * 系统语言 → 内置语言的映射。
 *
 * 只看主语言子标签：zh-Hant-TW / zh_CN / zh 都落到 zh-CN，en-GB 落到 en-US。
 * 没有命中就回退 zh-CN（产品的主语言），而不是抛错或留空。
 */
export function detectLocale(candidates: readonly string[]): BuiltinLocaleTag {
  for (const candidate of candidates) {
    const primary = candidate.toLowerCase().replace(/_/gu, "-").split("-")[0];
    if (primary === "zh") return "zh-CN";
    if (primary === "en") return "en-US";
  }
  return "zh-CN";
}

/** 运行环境的语言列表；Node 测试里可以显式传数组，不读全局。 */
export function navigatorLanguages(): string[] {
  const nav = (globalThis as { navigator?: { languages?: readonly string[]; language?: string } })
    .navigator;
  if (!nav) return [];
  if (Array.isArray(nav.languages) && nav.languages.length > 0) return [...nav.languages];
  return nav.language ? [nav.language] : [];
}

/** 读偏好；脏值（不是合法标签）当作没有偏好，交给系统语言探测。 */
export function readLocalePreference(
  storage: KeyValueStorage | null | undefined = defaultStorage(),
): string | null {
  if (!storage) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    return null;
  }
  return isLocaleTag(raw) ? raw : null;
}

/** 写偏好；失败（配额、隐私模式）返回 false，调用方不把它当错误。 */
export function persistLocalePreference(
  tag: string,
  storage: KeyValueStorage | null | undefined = defaultStorage(),
): boolean {
  if (!storage || !isLocaleTag(tag)) return false;
  try {
    storage.setItem(LOCALE_STORAGE_KEY, tag);
    return true;
  } catch {
    return false;
  }
}
