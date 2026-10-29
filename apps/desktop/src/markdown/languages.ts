/**
 * 代码块语言白名单与按需加载表（Issue #111 · V4-S1）。
 *
 * 两条硬约束：
 * 1. **只按需加载**：每种语言都是一条独立的 `import("shiki/langs/<id>.mjs")`。
 *    绝不能 `import("shiki")` 或 `shiki/bundle/*`——那会把 200+ 语言全部打进 bundle，
 *    V4 的性能预算（首屏 DOM/内存）直接作废。测试 `tests/markdown.test.ts` 会扫源码兜底。
 * 2. **白名单有界**：fence 上写了白名单外的语言时退回纯文本渲染，不下载语言包。
 *    这同时避免把消息里的任意字符串当成模块路径（语言名来自不可信内容）。
 *
 * canonical id 同时是 shiki 语言名与 `shiki/langs/<id>.mjs` 的文件名，
 * 因此别名表只做「常见写法 → canonical」的归一，不需要第二份映射。
 */

/** 白名单：只放会话里真的会出现的语言，多一个就多一个按需 chunk。 */
export const SUPPORTED_LANGUAGES = [
  "ts",
  "tsx",
  "js",
  "jsx",
  "json",
  "bash",
  "python",
  "rust",
  "go",
  "java",
  "c",
  "cpp",
  "html",
  "css",
  "scss",
  "markdown",
  "diff",
  "yaml",
  "toml",
  "ini",
  "sql",
  "xml",
  "dockerfile",
  "powershell",
  "http",
  "graphql",
] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

/** 常见 fence 写法 → canonical id（大小写不敏感，见 resolveLanguage）。 */
const LANGUAGE_ALIASES: Readonly<Record<string, SupportedLanguage>> = Object.freeze({
  javascript: "js",
  mjs: "js",
  cjs: "js",
  typescript: "ts",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  py: "python",
  python3: "python",
  rs: "rust",
  golang: "go",
  yml: "yaml",
  md: "markdown",
  patch: "diff",
  htm: "html",
  svg: "xml",
  xhtml: "xml",
  ps1: "powershell",
  pwsh: "powershell",
  docker: "dockerfile",
  jsonc: "json",
  "c++": "cpp",
  h: "c",
  hpp: "cpp",
  cc: "cpp",
});

/**
 * 语言加载器：每个条目就是一条独立的动态 import。
 * 写成显式字面量而不是模板拼接，打包器才能为每个语言切出独立 chunk。
 */
const LANGUAGE_LOADERS: Readonly<Record<SupportedLanguage, () => Promise<unknown>>> =
  Object.freeze({
    ts: () => import("shiki/langs/ts.mjs"),
    tsx: () => import("shiki/langs/tsx.mjs"),
    js: () => import("shiki/langs/js.mjs"),
    jsx: () => import("shiki/langs/jsx.mjs"),
    json: () => import("shiki/langs/json.mjs"),
    bash: () => import("shiki/langs/bash.mjs"),
    python: () => import("shiki/langs/python.mjs"),
    rust: () => import("shiki/langs/rust.mjs"),
    go: () => import("shiki/langs/go.mjs"),
    java: () => import("shiki/langs/java.mjs"),
    c: () => import("shiki/langs/c.mjs"),
    cpp: () => import("shiki/langs/cpp.mjs"),
    html: () => import("shiki/langs/html.mjs"),
    css: () => import("shiki/langs/css.mjs"),
    scss: () => import("shiki/langs/scss.mjs"),
    markdown: () => import("shiki/langs/markdown.mjs"),
    diff: () => import("shiki/langs/diff.mjs"),
    yaml: () => import("shiki/langs/yaml.mjs"),
    toml: () => import("shiki/langs/toml.mjs"),
    ini: () => import("shiki/langs/ini.mjs"),
    sql: () => import("shiki/langs/sql.mjs"),
    xml: () => import("shiki/langs/xml.mjs"),
    dockerfile: () => import("shiki/langs/dockerfile.mjs"),
    powershell: () => import("shiki/langs/powershell.mjs"),
    http: () => import("shiki/langs/http.mjs"),
    graphql: () => import("shiki/langs/graphql.mjs"),
  });

export function isSupportedLanguage(value: string): value is SupportedLanguage {
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(value);
}

/**
 * fence 的 info 字符串 → canonical 语言名；不认识就返回 null（调用方退回纯文本）。
 *
 * info 可能带额外参数（围栏后除语言名还有别的属性），这里只取第一个 token；
 * 空 info、纯空白同样返回 null，避免把空字符串当成合法语言。
 */
export function resolveLanguage(info: string | null | undefined): SupportedLanguage | null {
  const first = (info ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (!first) return null;
  if (isSupportedLanguage(first)) return first;
  return LANGUAGE_ALIASES[first] ?? null;
}

/** 取某个语言的按需加载器；未知语言返回 null，不触发任何 import。 */
export function loadLanguage(language: SupportedLanguage): Promise<unknown> {
  return LANGUAGE_LOADERS[language]();
}
