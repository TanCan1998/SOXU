/**
 * Shiki 高亮（Issue #111 · V4-S1）。
 *
 * 设计要点：
 * - 只用 `shiki/core`：主题与语言都由本模块显式加载，不引入 shiki 的「全量 bundle」入口；
 * - 引擎用 JavaScript 正则引擎（`createJavaScriptRegexEngine`）而不是 oniguruma wasm：
 *   省掉一个约 1MB 的 wasm chunk，桌面端首屏更快；`forgiving: true` 让个别语法不支持时
 *   退化为「不染色」而不是抛错（代码块照常可读）；
 * - 双主题：一次着色同时写入浅色 `color` 与深色 `--shiki-dark`，主题切换不需要重新着色
 *   （深色覆盖规则在 base.css 的 `[data-theme="dark"] .md-code` 里）；
 * - 高亮器是模块级单例，没有定时器、没有事件监听：创建一次，进程内复用。
 *   失败（语言包加载失败/语法异常）只让这一个代码块退回纯文本，不影响整条消息。
 */

import type { HighlighterCore } from "shiki/core";

import { loadLanguage, resolveLanguage, type SupportedLanguage } from "./languages.ts";

/** 与 base.css 的深色覆盖规则一一对应，改这里要同步改那边的选择器。 */
export const LIGHT_THEME = "github-light";
export const DARK_THEME = "github-dark";

/** shiki 的 token 结构里我们只需要这两个字段（content 是原文，htmlStyle 是颜色）。 */
interface HighlightToken {
  content: string;
  htmlStyle?: Record<string, string>;
}

let highlighter: HighlighterCore | null = null;
let pending: Promise<HighlighterCore> | null = null;
/** 已经加载进高亮器的语言：重复加载会让 shiki 抛错，这里先挡住。 */
const loadedLanguages = new Set<SupportedLanguage>();

/**
 * 创建高亮器。
 *
 * shiki 的核心与引擎也是动态 import：没有代码块的消息（绝大多数首屏）
 * 完全不会下载高亮器代码，主 chunk 里只有 markdown-it 与渲染规则。
 */
async function createHighlighter(): Promise<HighlighterCore> {
  const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
    import("shiki/core"),
    import("shiki/engine/javascript"),
  ]);
  return createHighlighterCore({
    themes: [import("shiki/themes/github-light.mjs"), import("shiki/themes/github-dark.mjs")],
    langs: [],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  });
}

function getHighlighter(): Promise<HighlighterCore> {
  if (highlighter) return Promise.resolve(highlighter);
  pending ??= createHighlighter()
    .then((instance) => {
      highlighter = instance;
      return instance;
    })
    .catch((error: unknown) => {
      // 创建失败不能缓存成「永远失败」：下次代码块出现时允许重试。
      pending = null;
      throw error;
    });
  return pending;
}

async function ensureLanguage(instance: HighlighterCore, language: SupportedLanguage) {
  if (loadedLanguages.has(language)) return;
  // 先登记再 await：两个代码块同时请求同一语言时只会真正 import 一次。
  loadedLanguages.add(language);
  try {
    await instance.loadLanguage((await loadLanguage(language)) as never);
  } catch (error) {
    loadedLanguages.delete(language);
    throw error;
  }
}

/** 转义 HTML 文本节点：token 内容来自消息正文，必须当成不可信数据。 */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function styleAttribute(style: Record<string, string> | undefined): string {
  if (!style) return "";
  const declarations = Object.entries(style)
    .map(([property, value]) => `${property}:${value}`)
    .join(";");
  return declarations ? ` style="${escapeHtml(declarations)}"` : "";
}

/**
 * token 行 → HTML。行容器用 `span.line`（不是 `<div>`），才能整块塞进已有的
 * `<code>` 里而不破坏 markdown-it 生成的 DOM 结构。
 */
export function tokensToHtml(tokens: readonly (readonly HighlightToken[])[]): string {
  return tokens
    .map(
      (line) =>
        `<span class="line">${line
          .map(
            (token) =>
              `<span${styleAttribute(token.htmlStyle)}>${escapeHtml(token.content)}</span>`,
          )
          .join("")}</span>`,
    )
    .join("\n");
}

/**
 * 高亮一段代码；语言不在白名单 / 加载失败 / 着色异常都返回 null。
 * 调用方拿到 null 时保留纯文本渲染，不显示错误横幅——代码本身仍然可读可复制。
 */
export async function highlightToHtml(
  code: string,
  info: string | null | undefined,
): Promise<string | null> {
  const language = resolveLanguage(info);
  if (!language) return null;
  try {
    const instance = await getHighlighter();
    await ensureLanguage(instance, language);
    const { tokens } = instance.codeToTokens(code, {
      lang: language,
      themes: { light: LIGHT_THEME, dark: DARK_THEME },
    });
    return tokensToHtml(tokens as unknown as HighlightToken[][]);
  } catch (error) {
    console.warn("SOXU: 代码高亮失败，退回纯文本", error);
    return null;
  }
}

/** 已加载语言（只读快照，供测试断言「按需加载」确实生效）。 */
export function loadedLanguageCount(): number {
  return loadedLanguages.size;
}

/** 释放高亮器：只用于测试与开发期热更新，正常运行时单例一直存在。 */
export async function disposeHighlighter(): Promise<void> {
  const instance = highlighter ?? (await pending?.catch(() => null)) ?? null;
  highlighter = null;
  pending = null;
  loadedLanguages.clear();
  instance?.dispose();
}
