/**
 * Markdown 渲染（Issue #111 · V4-S1）。
 *
 * - `html: false`：正文里的原始 HTML 一律转义，这是 XSS 的第一道闸门；
 *   高亮后的 HTML 只由本模块与 highlighter 生成，不来自消息内容；
 * - `linkify: true`：裸 URL 也能点；`breaks: true`：单个换行即换行，符合聊天场景；
 * - 代码块由自定义 fence 规则产出统一包装（语言标签 + `<pre><code>`），
 *   高亮阶段只替换 `<code>` 的内部，DOM 结构与折叠/复制等后续能力都稳定；
 * - 表格包一层 `.md-table`，窄窗口下横向滚动，不把消息气泡撑破。
 */

import MarkdownIt from "markdown-it";

import { resolveLanguage } from "./languages.ts";

/** 与 Rust 侧 `MAX_MESSAGE_CHARS` 同一量级：超过这个长度的正文不再渲染（UI 已截断）。 */
export const MAX_RENDER_CHARS = 20_000;

function escape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** 返回类型由构造值推导（markdown-it 的类型导出只有值，没有同名类型）。 */
function createRenderer() {
  const md = new MarkdownIt({
    html: false,
    linkify: true,
    breaks: true,
    typographer: false,
  });

  md.renderer.rules.fence = (tokens, index) => {
    const token = tokens[index];
    if (!token) return "";
    const info = token.info.trim().split(/\s+/)[0] ?? "";
    const language = resolveLanguage(info);
    // 未识别的语言：标签照原样显示（用户知道写的是什么），但不触发语言包下载。
    const label = language ?? (info ? escape(info) : "text");
    const pending = language ? ' data-highlight="pending"' : "";
    return [
      `<div class="md-code" data-lang="${label}"${pending}>`,
      `<div class="md-code-head"><span class="md-code-lang">${label}</span></div>`,
      `<pre class="md-code-body"><code class="language-${label}">${escape(token.content)}</code></pre>`,
      "</div>",
    ].join("");
  };

  md.renderer.rules.table_open = () => '<div class="md-table"><table>';
  md.renderer.rules.table_close = () => "</table></div>";

  const defaultLinkOpen =
    md.renderer.rules.link_open ??
    ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options));

  md.renderer.rules.link_open = (tokens, index, options, env, self) => {
    const token = tokens[index];
    if (token) {
      // 不设 target：桌面端 webview 里新窗口会变成应用内的第二个 webview。
      // 链接的打开动作由 MarkdownContent 接管（当前切片先复制链接，见该组件注释）。
      token.attrSet("rel", "noopener noreferrer");
      token.attrJoin("class", "md-link");
    }
    return defaultLinkOpen(tokens, index, options, env, self);
  };

  return md;
}

const renderer = createRenderer();

/**
 * 渲染一条消息的 markdown 源。
 *
 * 超长正文截断后再渲染：单条消息上限已经由 Rust 侧与 UI 状态共同约束，
 * 这里再兜一层，避免异常数据把渲染线程拖住。
 */
export function renderMarkdown(text: string): string {
  const source = text.length > MAX_RENDER_CHARS ? text.slice(0, MAX_RENDER_CHARS) : text;
  return renderer.render(source);
}
