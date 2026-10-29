/**
 * 把已渲染的代码块升级成高亮版本（Issue #111 · V4-S1）。
 *
 * markdown-it 是同步渲染，shiki 是异步加载，两者不能塞进同一次渲染。
 * 因此先同步产出「语言标签 + 纯文本代码」，再由这里异步替换 `<code>` 的内部。
 *
 * 三条边界：
 * 1. 只处理带 `data-highlight="pending"` 的块——白名单外的语言从一开始就不排队；
 * 2. 每个块先标记 `running`，避免同一块被重复排队（虚拟列表滚动会反复触发 update）；
 * 3. 组件卸载后不再写 DOM：`isAlive` 由调用方提供，返回 false 时立刻停止。
 */

import { highlightToHtml } from "./highlighter.ts";

export interface CodeBlockJob {
  element: HTMLElement;
  code: string;
  lang: string;
}

/** 收集待高亮的代码块（纯 DOM 查询，不触发任何加载）。 */
export function collectPendingCodeBlocks(root: ParentNode): CodeBlockJob[] {
  const blocks = root.querySelectorAll<HTMLElement>('.md-code[data-highlight="pending"]');
  const jobs: CodeBlockJob[] = [];
  for (const element of blocks) {
    const code = element.querySelector("code");
    const lang = element.dataset.lang ?? "";
    if (!code || !lang) continue;
    jobs.push({ element, code: code.textContent ?? "", lang });
  }
  return jobs;
}

/**
 * 依次高亮 root 内的待处理代码块，返回成功高亮的块数。
 * 失败（语言包缺失/语法异常）的块标记成 `plain`，不会反复重试。
 */
export async function highlightWithin(
  root: ParentNode,
  isAlive: () => boolean = () => true,
): Promise<number> {
  let highlighted = 0;
  for (const job of collectPendingCodeBlocks(root)) {
    job.element.dataset.highlight = "running";
    const html = await highlightToHtml(job.code, job.lang);
    if (!isAlive()) return highlighted;
    const code = job.element.querySelector("code");
    if (!html || !code) {
      job.element.dataset.highlight = "plain";
      continue;
    }
    code.innerHTML = html;
    job.element.dataset.highlight = "done";
    highlighted += 1;
  }
  return highlighted;
}
