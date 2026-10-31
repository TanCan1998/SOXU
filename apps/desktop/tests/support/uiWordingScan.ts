/**
 * 界面文案扫描：找出「用户真的会看到」的字符串里混进来的开发术语。
 *
 * 为什么要区分注释与文案：代码注释里写 Issue 编号是正常的可追溯性，但同一句话
 * 漏进模板就变成用户读到的产品文案。不区分的话，扫描要么放过真问题（只扫文件全文
 * 又因为注释而必须加白名单），要么逼着所有人删掉有用的注释。
 *
 * 因此这里做的是「提取用户可见字符串」而不是「扫全文」：
 * - .vue：只取 <template> 里的文本节点、属性值（含 :bound="'字面量'"）与插值；
 *   HTML 注释整段排除，<script> / <style> 不在范围内。
 * - .ts：先抹掉注释（保留字符串字面量），再取出所有字符串字面量。
 * - .json（语言包）：取所有字符串值。
 *
 * 纯函数、无依赖，测试与脚本都能直接调用。
 */

/** 禁用词表：出现即判定失败。顺序与 Issue #143 的验收列表一致。 */
export const BANNED_WORDING: readonly string[] = Object.freeze([
  "切片",
  "Issue #",
  "占位",
  "演示",
  "V4-S",
  "后续切片",
  "TODO(",
]);

export interface WordingHit {
  /** 命中的禁用词。 */
  term: string;
  /** 命中处所在行（1 起）。 */
  line: number;
  /** 命中处上下文，便于直接定位。 */
  excerpt: string;
}

interface Fragment {
  text: string;
  /** 片段在原始文件里的起始下标，用于换算行号。 */
  index: number;
}

/** 把一段源码按长度抹成空格，保留换行，行号因此不会漂移。 */
function blankOut(source: string): string {
  return source.replace(/[^\n]/g, " ");
}

/** 抹掉 HTML 注释（保留换行与长度）。 */
function stripHtmlComments(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, (match) => blankOut(match));
}

/**
 * 取 <template> 块。用最后一个 </template> 收尾，因为内部还有 <template #slot> 片段。
 * 没有 <template> 的文件（纯逻辑组件）返回 null。
 */
function templateBlock(source: string): { body: string; offset: number } | null {
  const open = source.indexOf("<template>");
  const close = source.lastIndexOf("</template>");
  if (open < 0 || close < 0 || close < open) return null;
  const start = open + "<template>".length;
  return { body: source.slice(start, close), offset: start };
}

/** 模板里的文本节点：标签之间的非空白内容。 */
function textNodes(body: string): Fragment[] {
  const fragments: Fragment[] = [];
  const pattern = /(?<=>)([^<>]+)(?=<)/g;
  for (const match of body.matchAll(pattern)) {
    const text = match[1] ?? "";
    if (text.trim() === "") continue;
    fragments.push({ text, index: (match.index ?? 0) + 1 });
  }
  return fragments;
}

/** 模板里的属性值：静态值与 :bound / v-bind 值都收，绑定里的字符串字面量因此也被覆盖。 */
function attributeValues(body: string): Fragment[] {
  const fragments: Fragment[] = [];
  const tagPattern = /<([a-zA-Z][^\s/>]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  for (const tag of body.matchAll(tagPattern)) {
    const attributes = tag[2] ?? "";
    const base = (tag.index ?? 0) + 1 + tag[1].length;
    const attrPattern = /([:@#]?[\w.:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g;
    for (const attribute of attributes.matchAll(attrPattern)) {
      const value = attribute[3] ?? attribute[4] ?? attribute[5] ?? "";
      if (value.trim() === "") continue;
      // 只关心值本身的位置：用整段属性值的起点近似即可（同一行内定位足够）。
      fragments.push({ text: value, index: base + (attribute.index ?? 0) });
    }
  }
  return fragments;
}

/**
 * 抹掉注释，但完整保留字符串字面量。
 *
 * 手写状态机而不是正则：`//` 会出现在 URL 里（"https://…"），
 * 正则版本会把字符串后半截当成注释，反过来漏掉真正的文案。
 */
export function stripComments(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];
    if (char === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") {
        out += " ";
        i += 1;
      }
      continue;
    }
    if (char === "/" && next === "*") {
      out += "  ";
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        out += source[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      if (i < source.length) {
        out += "  ";
        i += 2;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      out += char;
      i += 1;
      while (i < source.length) {
        const current = source[i];
        if (current === "\\") {
          out += current + (source[i + 1] ?? "");
          i += 2;
          continue;
        }
        out += current;
        i += 1;
        if (current === quote) break;
      }
      continue;
    }
    out += char;
    i += 1;
  }
  return out;
}

/** 去掉注释后的字符串字面量（含模板字符串）。 */
function stringLiterals(source: string): Fragment[] {
  const stripped = stripComments(source);
  const fragments: Fragment[] = [];
  const pattern = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g;
  for (const match of stripped.matchAll(pattern)) {
    fragments.push({ text: match[0], index: match.index ?? 0 });
  }
  return fragments;
}

/** 语言包里的字符串值（键名不是文案，只取 value）。 */
function jsonValues(source: string): Fragment[] {
  const fragments: Fragment[] = [];
  const pattern = /"(?:[^"\\]|\\.)*"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  for (const match of source.matchAll(pattern)) {
    const value = match[1] ?? "";
    if (value.trim() === "") continue;
    const at = (match.index ?? 0) + match[0].lastIndexOf(value);
    fragments.push({ text: value, index: at });
  }
  return fragments;
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i += 1) {
    if (source[i] === "\n") line += 1;
  }
  return line;
}

function excerptOf(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 80 ? flat.slice(0, 80) + "…" : flat;
}

/**
 * 提取一个文件里的用户可见字符串片段。
 *
 * @param file 文件路径（只看扩展名决定提取方式）
 * @param source 文件内容
 */
export function visibleFragments(file: string, source: string): Fragment[] {
  if (file.endsWith(".vue")) {
    const block = templateBlock(source);
    if (!block) return [];
    const body = stripHtmlComments(block.body);
    return [...textNodes(body), ...attributeValues(body)].map((fragment) => ({
      text: fragment.text,
      index: block.offset + fragment.index,
    }));
  }
  if (file.endsWith(".json")) return jsonValues(source);
  if (file.endsWith(".ts")) return stringLiterals(source);
  return [];
}

/** 扫描一个文件，返回所有命中禁用词的片段。 */
export function scanWording(file: string, source: string): WordingHit[] {
  const hits: WordingHit[] = [];
  for (const fragment of visibleFragments(file, source)) {
    for (const term of BANNED_WORDING) {
      if (!fragment.text.includes(term)) continue;
      hits.push({
        term,
        line: lineOf(source, fragment.index),
        excerpt: excerptOf(fragment.text),
      });
    }
  }
  return hits;
}

/**
 * 扫描一段已经渲染出来的纯文本（DOM innerText）。
 *
 * 渲染结果里没有注释概念，整段都算用户文案——证据脚本用它复核「屏幕上到底写了什么」，
 * 而不是只信源码扫描。
 */
export function scanText(text: string): WordingHit[] {
  const hits: WordingHit[] = [];
  for (const term of BANNED_WORDING) {
    const at = text.indexOf(term);
    if (at < 0) continue;
    hits.push({
      term,
      line: lineOf(text, at),
      excerpt: excerptOf(text.slice(Math.max(0, at - 20), at + 40)),
    });
  }
  return hits;
}

/** 把命中结果格式化成一行可读报告。 */
export function formatHit(file: string, hit: WordingHit): string {
  return file + ":" + hit.line + " 出现「" + hit.term + "」→ " + hit.excerpt;
}
