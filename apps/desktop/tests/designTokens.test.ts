/**
 * 回归测试：V4 设计 token（Issue #110）。
 *
 * 这里能在 Node 里确定验证的部分：
 * - 原型 style.css 的每个变量都被搬进 tokens.css，且字面量一字不差；
 * - 每个与主题相关的 token 都有浅色与深色两套值，两边确实不同；
 * - 与主题无关的 token（强调色 / 语义色 / 圆角 / 字号 / 缓动）在两套主题下取值一致；
 * - 每个 token 都在 Tailwind 的 @theme 里注册过（CSS-first，没有 tailwind.config）；
 * - 没有自引用变量（--x: var(--x) 会让计算值失效）；
 * - 没有偷偷引入 Preflight（那会顺带改掉既有 10 个组件的样式）。
 *
 * 真实浏览器里的计算值、深浅色切换的圆形扩散与「无布局跳动」由
 * apps/desktop/tests/harness/shoot-issue-110-tokens.mjs 采集，见
 * docs/development/evidence/issue-110-design-tokens/README.md。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

import { EASE_CLASSES, TOKEN_GROUPS, UTILITY_CLASSES } from "../src/styles/tokenCatalog.ts";

/** 读取仓库内文件；路径相对本测试文件，避免依赖工作目录。 */
async function readSource(relative: string): Promise<string> {
  return readFile(new URL(relative, import.meta.url), "utf8");
}

function stripCssComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "");
}

interface CssBlock {
  selector: string;
  body: string;
}

/** 极简块解析：tokens.css 只有一层规则，没有嵌套，够用且不会静默漏块。 */
function cssBlocks(source: string): CssBlock[] {
  const blocks: CssBlock[] = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    // 第一个块前面还挂着 @layer / @import 语句，它们没有花括号，会被一起吃进选择器；
    // 取最后一个分号之后的部分，选择器才是干净的。
    const raw = match[1] ?? "";
    const selector = raw.slice(raw.lastIndexOf(";") + 1).trim();
    blocks.push({ selector, body: match[2] ?? "" });
  }
  return blocks;
}

/** 把声明块解析成 变量名 → 值；值里可能含冒号，只按第一个冒号切。 */
function cssDeclarations(body: string): Map<string, string> {
  const declarations = new Map<string, string>();
  for (const raw of body.split(";")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const index = trimmed.indexOf(":");
    if (index < 0) continue;
    declarations.set(trimmed.slice(0, index).trim(), trimmed.slice(index + 1).trim());
  }
  return declarations;
}

/** 找到第一个选择器完全等于目标串的块；找不到直接失败，避免正则失效后测试假绿。 */
function requireBlock(blocks: CssBlock[], selector: string): Map<string, string> {
  const block = blocks.find((item) => item.selector === selector);
  assert.ok(block, "tokens.css 里没有找到选择器：" + selector);
  return cssDeclarations(block.body);
}

/** 找到选择器包含某个片段的块（例如 :root[data-theme="dark"] 与 .app-shell 同时挂的那一块）。 */
function requireBlockContaining(blocks: CssBlock[], fragment: string): Map<string, string> {
  const block = blocks.find((item) => item.selector.includes(fragment));
  assert.ok(block, "tokens.css 里没有找到包含 " + fragment + " 的块");
  return cssDeclarations(block.body);
}

/** 原型 F:\workplace\pi\soxu-prototype\style.css 前 120 行的变量值，逐条抄录。 */
const PROTOTYPE_STATIC = {
  "--fs-micro": "11.5px",
  "--fs-caption": "12.5px",
  "--fs-control": "13.5px",
  "--fs-body": "14.5px",
  "--fs-chat": "16px",
  "--fs-title": "16px",
  "--fs-heading": "20px",
  "--lh-chat": "1.68",
  "--r-sm": "7px",
  "--r-md": "9px",
  "--r-lg": "13px",
  "--r-full": "999px",
  "--ease": "cubic-bezier(0.2, 0, 0, 1)",
  "--ease-spring-value": "cubic-bezier(0.34, 1.42, 0.64, 1)",
  "--dur-fast": "140ms",
  "--dur-base": "200ms",
  "--dur-slow": "260ms",
  "--accent": "#3a83f7",
  "--accent-hover": "#2f70d8",
  "--ok": "#10a37f",
  "--warn": "#d97706",
  "--danger": "#dc2626",
  "--shadow-modal": "0 28px 72px rgb(0 0 0 / 30%)",
  "--sb-w": "272px",
  "--insp-w": "320px",
  "--icon-lg": "17px",
  "--icon-md": "15px",
  "--icon-sm": "13px",
  "--content-max": "768px",
} as const;

/** 原型 [data-theme="light"] 的完整取值。 */
const PROTOTYPE_LIGHT = {
  "--surface": "#ffffff",
  "--bg-sidebar": "#f7f7f8",
  "--bg-panel": "#ffffff",
  "--bg-raised": "#f2f2f3",
  "--bg-hover": "#ececed",
  "--bg-active": "#e3e3e5",
  "--border": "#e5e5e7",
  "--border-strong": "#d4d4d8",
  "--fg": "#1a1a1a",
  "--fg-muted": "#6b6b70",
  "--fg-subtle": "#9a9aa0",
  "--code-bg": "#f6f6f7",
  "--inset": "inset 0 1px 0 rgb(255 255 255 / 70%)",
  "--glass": "rgb(255 255 255 / 72%)",
  "--glass-border": "rgb(0 0 0 / 6%)",
  "--shadow-pop-value": "0 10px 28px rgb(0 0 0 / 12%), 0 1px 2px rgb(0 0 0 / 5%)",
} as const;

/** 原型 [data-theme="dark"] 的完整取值。 */
const PROTOTYPE_DARK = {
  "--surface": "#212121",
  "--bg-sidebar": "#191919",
  "--bg-panel": "#212121",
  "--bg-raised": "#2f2f2f",
  "--bg-hover": "#2a2a2a",
  "--bg-active": "#353535",
  "--border": "#383838",
  "--border-strong": "#4a4a4a",
  "--fg": "#ececec",
  "--fg-muted": "#a0a0a5",
  "--fg-subtle": "#6e6e73",
  "--code-bg": "#1a1a1a",
  "--inset": "inset 0 1px 0 rgb(255 255 255 / 4.5%)",
  "--glass": "rgb(28 28 28 / 68%)",
  "--glass-border": "rgb(255 255 255 / 7%)",
  "--shadow-pop-value": "0 10px 28px rgb(0 0 0 / 46%), 0 1px 2px rgb(0 0 0 / 30%)",
} as const;

/** 这些 token 名必须在 @theme 里有对应注册，否则 Tailwind 生成不出工具类。 */
const THEME_REGISTRATIONS: ReadonlyArray<readonly [string, string]> = [
  ["--color-surface", "--surface"],
  ["--color-bg-sidebar", "--bg-sidebar"],
  ["--color-bg-panel", "--bg-panel"],
  ["--color-bg-raised", "--bg-raised"],
  ["--color-bg-hover", "--bg-hover"],
  ["--color-bg-active", "--bg-active"],
  ["--color-border", "--border"],
  ["--color-border-strong", "--border-strong"],
  ["--color-fg", "--fg"],
  ["--color-fg-muted", "--fg-muted"],
  ["--color-fg-subtle", "--fg-subtle"],
  ["--color-accent", "--accent"],
  ["--color-accent-hover", "--accent-hover"],
  ["--color-accent-soft", "--accent-soft"],
  ["--color-ok", "--ok"],
  ["--color-warn", "--warn"],
  ["--color-danger", "--danger"],
  ["--color-code-bg", "--code-bg"],
  ["--radius-sm", "--r-sm"],
  ["--radius-md", "--r-md"],
  ["--radius-lg", "--r-lg"],
  ["--radius-full", "--r-full"],
  ["--text-micro", "--fs-micro"],
  ["--text-caption", "--fs-caption"],
  ["--text-control", "--fs-control"],
  ["--text-body", "--fs-body"],
  ["--text-chat", "--fs-chat"],
  ["--text-title", "--fs-title"],
  ["--text-heading", "--fs-heading"],
  ["--shadow-pop", "--shadow-pop-value"],
  ["--ease-spring", "--ease-spring-value"],
  ["--ease-standard", "--ease"],
  ["--font-sans", "--font-ui"],
  ["--font-mono", "--font-code"],
];

async function loadTokens() {
  const css = stripCssComments(await readSource("../src/styles/tokens.css"));
  const blocks = cssBlocks(css);
  return {
    css,
    blocks,
    static: requireBlock(blocks, ":root"),
    light: requireBlockContaining(blocks, ':root[data-theme="light"]'),
    dark: requireBlockContaining(blocks, ':root[data-theme="dark"]'),
    theme: requireBlockContaining(blocks, "@theme inline"),
  };
}

/** WCAG 相对亮度；只用来卡"深色下不是近白色大面积背景"。 */
function relativeLuminance(hex: string): number {
  const value = hex.replace("#", "");
  const channels = [0, 2, 4].map((offset) => {
    const raw = Number.parseInt(value.slice(offset, offset + 2), 16) / 255;
    return raw <= 0.03928 ? raw / 12.92 : ((raw + 0.055) / 1.055) ** 2.4;
  });
  const [r, g, b] = channels as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

test("静态 token 与原型 style.css 一字不差", async () => {
  const { static: tokens } = await loadTokens();
  for (const [name, expected] of Object.entries(PROTOTYPE_STATIC)) {
    assert.equal(tokens.get(name), expected, name + " 与原型不一致");
  }
  // 字体栈只在 tokens.css 定义一次，两个都必须是完整栈（含 CJK 回退）
  assert.match(tokens.get("--font-ui") ?? "", /Microsoft YaHei/);
  assert.match(tokens.get("--font-code") ?? "", /JetBrains Mono/);
  // --ease-spring 转发到 -value，原型名与 Tailwind 命名空间因此可以共存
  assert.equal(tokens.get("--ease-spring"), "var(--ease-spring-value)");
});

test("浅色是默认值：:root 与 [data-theme=light] 给出同一套取值", async () => {
  const { light } = await loadTokens();
  for (const [name, expected] of Object.entries(PROTOTYPE_LIGHT)) {
    assert.equal(light.get(name), expected, name + " 的浅色值与原型不一致");
  }
  // 浅色块必须把 :root 一起列进去：没有 data-theme 的首帧也得是浅色
  const { blocks } = await loadTokens();
  const lightBlock = blocks.find((block) => block.selector.includes(':root[data-theme="light"]'));
  assert.ok(lightBlock);
  assert.match(lightBlock.selector, /(?:^|,)\s*:root\s*(?:,|$)/, "浅色块必须包含裸 :root");
});

test("深色 token 与原型一字不差，且不是近白色", async () => {
  const { dark } = await loadTokens();
  for (const [name, expected] of Object.entries(PROTOTYPE_DARK)) {
    assert.equal(dark.get(name), expected, name + " 的深色值与原型不一致");
  }
  for (const token of ["--surface", "--bg-sidebar", "--bg-panel", "--bg-raised"]) {
    const value = dark.get(token) ?? "";
    const luminance = relativeLuminance(value);
    assert.ok(luminance < 0.1, token + " 在深色下亮度 " + luminance.toFixed(3) + "，属于近白色大面积背景");
  }
});

test("每个与主题相关的 token 都有浅色与深色两套值且互不相同", async () => {
  const { light, dark } = await loadTokens();
  for (const name of Object.keys(PROTOTYPE_LIGHT)) {
    assert.ok(light.has(name), "浅色块缺少 " + name);
    assert.ok(dark.has(name), "深色块缺少 " + name);
    assert.notEqual(light.get(name), dark.get(name), name + " 在深浅色下取值相同，等于没有主题切换");
  }
});

test("与主题无关的 token 只定义一次（两套主题共用）", async () => {
  const { static: tokens, light, dark } = await loadTokens();
  for (const name of Object.keys(PROTOTYPE_STATIC)) {
    assert.ok(tokens.has(name), "静态块缺少 " + name);
    assert.ok(!light.has(name), name + " 不应该在浅色块里重复定义");
    assert.ok(!dark.has(name), name + " 不应该在深色块里重复定义");
  }
});

test("每个 token 都在 Tailwind @theme 里注册过（CSS-first，无 tailwind.config）", async () => {
  const { theme } = await loadTokens();
  for (const [registered, source] of THEME_REGISTRATIONS) {
    assert.equal(theme.get(registered), "var(" + source + ")", registered + " 没有注册成 var(" + source + ")");
  }
  // 会话正文的行高跟着 text-chat 一起给
  assert.equal(theme.get("--text-chat--line-height"), "var(--lh-chat)");

  // 不写 tailwind.config：Tailwind 4 的配置只有 @theme
  for (const candidate of [
    "../tailwind.config.ts",
    "../tailwind.config.js",
    "../tailwind.config.mjs",
    "../../../tailwind.config.ts",
  ]) {
    assert.equal(existsSync(new URL(candidate, import.meta.url)), false, "不允许引入 " + candidate);
  }
});

test("没有自引用变量：--x 不能定义成 var(--x)", async () => {
  const { css } = await loadTokens();
  const selfReferences = [...css.matchAll(/(--[a-z0-9-]+)\s*:\s*var\(\1\)/g)].map((match) => match[1]);
  assert.deepEqual(selfReferences, [], "自引用会让计算值失效：" + selfReferences.join(", "));
});

test("不引入 Preflight：既有 10 个组件的样式不能被 reset 影响", async () => {
  const { css } = await loadTokens();
  assert.doesNotMatch(css, /tailwindcss\/preflight/);
  assert.doesNotMatch(css, /@import\s+["']tailwindcss["']/);
  assert.match(css, /@import\s+"tailwindcss\/theme\.css"\s+layer\(theme\)/);
  assert.match(css, /@import\s+"tailwindcss\/utilities\.css"\s+layer\(utilities\)/);
});

test("构建链路真的接上了 Tailwind 插件，且 tokens.css 先于 base.css 加载", async () => {
  const vite = await readSource("../vite.config.ts");
  assert.match(vite, /@tailwindcss\/vite/);
  assert.match(vite, /tailwindcss\(\)/);

  const main = await readSource("../src/main.ts");
  const tokensAt = main.indexOf('import "./styles/tokens.css"');
  const baseAt = main.indexOf('import "./styles/base.css"');
  assert.ok(tokensAt >= 0, "main.ts 必须加载 tokens.css");
  assert.ok(baseAt >= 0, "main.ts 必须继续加载 base.css");
  assert.ok(tokensAt < baseAt, "tokens.css 必须先于 base.css，否则首帧拿不到 V4 变量");
});

test("色板样本覆盖所有看得见的 token，且不引用不存在的变量", async () => {
  const { static: staticTokens, light, dark, theme } = await loadTokens();
  const declared = new Set<string>([...staticTokens.keys(), ...light.keys(), ...dark.keys()]);
  const sampled = new Set(TOKEN_GROUPS.flatMap((group) => group.items.map((item) => item.token)));

  // 样本里出现的变量必须真的存在于 tokens.css，否则色板会显示「（未定义）」
  for (const token of sampled) {
    assert.ok(declared.has(token), "色板引用了 tokens.css 里不存在的变量：" + token);
  }
  // 与主题相关的 token 必须都有样本：它们正是「深浅色两套值」的可视证据
  for (const token of Object.keys(PROTOTYPE_LIGHT)) {
    const sample = token === "--shadow-pop-value" ? "--shadow-pop" : token;
    assert.ok(sampled.has(sample), "主题 token 缺少色板样本：" + sample);
  }
  // 与主题无关但看得见的 token 也要有样本
  for (const token of [
    "--accent",
    "--accent-hover",
    "--accent-soft",
    "--ok",
    "--warn",
    "--danger",
    "--r-sm",
    "--r-md",
    "--r-lg",
    "--r-full",
    "--fs-micro",
    "--fs-caption",
    "--fs-control",
    "--fs-body",
    "--fs-chat",
    "--fs-heading",
    "--shadow-modal",
    "--ease",
    "--ease-spring",
  ]) {
    assert.ok(sampled.has(token), "静态 token 缺少色板样本：" + token);
  }

  // @theme 注册过的别名也要被工具类自检块用到，否则注册等于没验证
  assert.match(UTILITY_CLASSES, /\bbg-bg-raised\b/);
  assert.match(UTILITY_CLASSES, /\btext-fg\b/);
  assert.match(UTILITY_CLASSES, /\bshadow-pop\b/);
  assert.match(UTILITY_CLASSES, /\btext-chat\b/);
  assert.deepEqual([...EASE_CLASSES], ["ease-spring", "ease-standard"]);
  assert.ok(theme.has("--ease-spring"));
});

test("没有引入新依赖：Tailwind 走的是已有 devDependencies", async () => {
  const pkg = JSON.parse(await readSource("../package.json")) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  assert.ok(pkg.devDependencies.tailwindcss, "tailwindcss 应已在 devDependencies 中");
  assert.ok(pkg.devDependencies["@tailwindcss/vite"], "@tailwindcss/vite 应已在 devDependencies 中");
  assert.equal(pkg.devDependencies.tailwindcss, pkg.devDependencies["@tailwindcss/vite"], "两个包版本必须一致");
  // 本切片不引入任何运行时依赖
  for (const name of ["tailwindcss", "@tailwindcss/vite"]) {
    assert.equal(pkg.dependencies[name], undefined, name + " 不应该是运行时依赖");
  }
});
