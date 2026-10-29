/**
 * 回归测试：消息 markdown 渲染与按需代码高亮（Issue #111 · V4-S1）。
 *
 * 覆盖三件事：
 * 1. 渲染能力：代码块、行内 code、表格、引用都真的产出对应结构；
 * 2. XSS 边界：`html: false` 让正文里的原始 HTML 一律转义，`javascript:` 链接不被放行；
 * 3. 按需加载：语言白名单有界，源码里不存在 shiki 全量入口，未知语言不下载任何语言包。
 *
 * 真实高亮会加载一次 shiki（本地依赖、零外网），用于确认双主题 token 确实写进 HTML。
 * 视觉结果见 docs/development/evidence/issue-111-v4-s1/README.md。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  disposeHighlighter,
  escapeHtml,
  highlightToHtml,
  loadedLanguageCount,
  tokensToHtml,
} from "../src/markdown/highlighter.ts";
import { SUPPORTED_LANGUAGES, resolveLanguage } from "../src/markdown/languages.ts";
import { MAX_RENDER_CHARS, renderMarkdown } from "../src/markdown/markdownRenderer.ts";

const SRC_ROOT = fileURLToPath(new URL("../src", import.meta.url));

async function markdownSources(): Promise<Array<{ path: string; text: string }>> {
  const dir = join(SRC_ROOT, "markdown");
  const names = await readdir(dir);
  return Promise.all(
    names.map(async (name) => ({ path: name, text: await readFile(join(dir, name), "utf8") })),
  );
}

test("代码块：语言标签 + pre/code 包装，白名单语言排队高亮", () => {
  const html = renderMarkdown("```ts\nconst a = 1;\n```");

  assert.match(html, /class="md-code"/);
  assert.match(html, /data-lang="ts"/, "语言标签取 fence 的 info");
  assert.match(html, /data-highlight="pending"/, "白名单语言必须排队等高亮");
  assert.match(html, /<pre class="md-code-body"><code class="language-ts">/);
  assert.match(html, /const a = 1;/);
});

test("代码块：白名单外语言照常渲染，但不排队高亮（不下载语言包）", () => {
  const html = renderMarkdown("```zig\nconst x = 1;\n```");

  assert.match(html, /data-lang="zig"/);
  assert.ok(!html.includes("data-highlight"), "未知语言不得进入高亮队列");
  assert.match(html, /const x = 1;/);
});

test("代码块正文里的 HTML 被转义（不能借代码块注入标签）", () => {
  const html = renderMarkdown("```html\n<script>alert(1)</script>\n```");

  assert.ok(!html.includes("<script>"), "代码块内容必须转义");
  assert.match(html, /&lt;script&gt;/);
});

test("行内 code、表格、引用都产出对应结构", () => {
  const inline = renderMarkdown("行内 `soxu --help` 结束");
  assert.match(inline, /<code>soxu --help<\/code>/);

  const table = renderMarkdown("| 名称 | 值 |\n| --- | --- |\n| a | 1 |");
  assert.match(table, /<div class="md-table"><table>/, "表格必须包一层横向滚动容器");
  assert.match(table, /<th>名称<\/th>/);
  assert.match(table, /<td>1<\/td>/);
  assert.match(table, /<\/table><\/div>/);

  const quote = renderMarkdown("> 引用一句话");
  assert.match(quote, /<blockquote>/);
  assert.match(quote, /引用一句话/);
});

test("XSS：html:false 让原始 HTML 一律转义，javascript: 链接不被放行", () => {
  const html = renderMarkdown("<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>");

  assert.ok(!html.includes("<script>"), "原始 <script> 不得进入输出");
  assert.ok(!html.includes("<img"), "原始 <img> 不得进入输出");
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);

  const unsafe = renderMarkdown("[点我](javascript:alert(1))");
  assert.ok(!/href="javascript:/i.test(unsafe), "javascript: 协议必须被 markdown-it 拦掉");
});

test("链接：加 rel=noopener noreferrer 与 md-link 类，且不设 target（避免开出第二个 webview）", () => {
  const html = renderMarkdown("[示例](https://example.com/a)");

  assert.match(html, /href="https:\/\/example\.com\/a"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /class="md-link"/);
  assert.ok(!html.includes('target="_blank"'), "桌面端不设 target：新窗口会变成第二个 webview");
});

test("超长正文按 MAX_RENDER_CHARS 截断后再渲染（异常数据不拖住渲染）", () => {
  const long = "a".repeat(MAX_RENDER_CHARS + 5_000);
  const html = renderMarkdown(long);
  // 去掉标签与 markdown-it 补的换行后再比长度：正文本身不能超过上限。
  const visible = html.replace(/<[^>]+>/g, "").trim();

  assert.equal(visible.length, MAX_RENDER_CHARS, "渲染内容必须恰好截断到上限");
});

test("空正文渲染为空字符串（不产出空 <p>）", () => {
  assert.equal(renderMarkdown(""), "");
});

test("语言归一：别名、大小写、空值", () => {
  assert.equal(resolveLanguage("ts"), "ts");
  assert.equal(resolveLanguage("TS"), "ts");
  assert.equal(resolveLanguage("typescript"), "ts");
  assert.equal(resolveLanguage("sh"), "bash");
  assert.equal(resolveLanguage("python3"), "python");
  assert.equal(resolveLanguage("c++"), "cpp");
  assert.equal(resolveLanguage("yml"), "yaml");
  assert.equal(resolveLanguage("  ts  "), "ts");
  assert.equal(resolveLanguage(""), null);
  assert.equal(resolveLanguage(null), null);
  assert.equal(resolveLanguage(undefined), null);
  assert.equal(resolveLanguage("zig"), null, "白名单外语言必须返回 null");
});

test("白名单有界：不含 text/plain 之类的空语言，也不会无限增长", () => {
  assert.ok(SUPPORTED_LANGUAGES.length > 0);
  assert.ok(SUPPORTED_LANGUAGES.length <= 32, "白名单必须保持有界（每项一个按需 chunk）");
  assert.equal(new Set(SUPPORTED_LANGUAGES).size, SUPPORTED_LANGUAGES.length);
  for (const language of ["text", "plain", "console"]) {
    assert.ok(!(SUPPORTED_LANGUAGES as readonly string[]).includes(language), `${language} 不应进白名单`);
  }
});

test("按需加载：源码里没有 shiki 全量入口，每种语言都是独立动态 import", async () => {
  const sources = await markdownSources();
  const all = sources.map((file) => file.text).join("\n");

  for (const forbidden of [
    'from "shiki"',
    "from 'shiki'",
    'from "shiki/bundle',
    "shiki/bundle/full",
    "shiki/bundle/web",
    "from \"@shikijs/langs\"",
  ]) {
    assert.ok(!all.includes(forbidden), `不得出现全量入口：${forbidden}`);
  }

  const languages = sources.find((file) => file.path === "languages.ts");
  assert.ok(languages, "缺少 languages.ts");
  const dynamicImports = languages.text.match(/import\("shiki\/langs\/[a-z0-9]+\.mjs"\)/g) ?? [];
  assert.equal(
    dynamicImports.length,
    SUPPORTED_LANGUAGES.length,
    "白名单里的每个语言都必须有一条独立的动态 import",
  );
  // 主题同样按需：只加载用到的两个主题文件。
  const themeImports = all.match(/import\("shiki\/themes\/[a-z-]+\.mjs"\)/g) ?? [];
  assert.deepEqual(themeImports.length, 2, "只加载浅色/深色两个主题");
});

test("真实高亮：双主题 token 写进 HTML，且只加载被请求的语言", async () => {
  const html = await highlightToHtml("const a: number = 1;", "ts");

  assert.ok(html, "ts 必须能高亮");
  assert.match(html, /<span class="line">/);
  assert.match(html, /--shiki-dark:/, "深色配色必须同时写进 token（切换主题不重新着色）");
  assert.equal(loadedLanguageCount(), 1, "只加载了 ts 一个语言包");

  const unknown = await highlightToHtml("const x = 1;", "zig");
  assert.equal(unknown, null, "白名单外语言直接返回 null，不下载语言包");
  assert.equal(loadedLanguageCount(), 1, "未知语言不得触发加载");

  await disposeHighlighter();
  assert.equal(loadedLanguageCount(), 0, "释放后语言缓存清空（测试/热更新用）");
});

test("tokensToHtml：token 内容与样式都按不可信数据转义", () => {
  const html = tokensToHtml([[{ content: "<b>&", htmlStyle: { color: "#fff" } }]]);

  assert.match(html, /&lt;b&gt;&amp;/);
  assert.match(html, /style="color:#fff"/);
  assert.equal(escapeHtml('"\'&<>'), "&quot;&#39;&amp;&lt;&gt;");
});
