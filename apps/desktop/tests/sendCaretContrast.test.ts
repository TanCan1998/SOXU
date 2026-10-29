/**
 * 回归测试：强调色底上的前景（Issue #116 复审阻塞点）。
 *
 * 复审发现的事实：ComposerSendMenu 的 caret 把前景写死成 #fff，
 * 而色板里的青绿 / 蓝绿 / 玫红 / 琥珀是浅底，白字压上去只有 3.20 / 2.49 / 3.67 / 2.15 :1，
 * 其中蓝绿与琥珀低于 WCAG 1.4.11 对非文本图形的 3:1 要求。
 *
 * 这里锁住三件事，任一条被改回去都会失败：
 * 1. 发送区（主钮 + caret）的前景只能引用 --soxu-on-accent，不得出现白色字面量；
 * 2. 六个色板的 onAccent 与主色对比度都 ≥ 3:1（色板换色会在这里露馅）；
 * 3. caret 与主钮用同一个前景 token —— 它们拼成一整块，两侧前景不一致会露出拼接痕迹。
 *
 * 真实浏览器里的实测（六个色板 × 深浅两主题的计算值与对比度）见
 * docs/development/evidence/issue-116-v4-s2/README.md §3.7 与 send-caret-contrast.json。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ACCENT_OPTIONS } from "../src/theme/appearance.ts";

const SRC_ROOT = fileURLToPath(new URL("../src", import.meta.url));

/** WCAG 2.x 非文本对比度下限（图形与界面组件，1.4.11）。 */
const MIN_NON_TEXT_CONTRAST = 3;

async function readSource(relative: string): Promise<string> {
  return readFile(join(SRC_ROOT, relative), "utf8");
}

function stripCssComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** 取出某条选择器的声明块；找不到直接失败，避免正则静默失效后测试假绿。 */
function cssRule(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(source);
  assert.ok(match, `没有找到 ${selector} 的样式块`);
  return match[1] ?? "";
}

function declaration(block: string, property: string): string {
  const match = new RegExp(`${property}:\\s*([^;]+);`).exec(block);
  assert.ok(match, `没有找到 ${property} 的声明`);
  return (match[1] ?? "").trim();
}

function linearChannel(value: number): number {
  const channel = value / 255;
  return channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
}

function relativeLuminance(hex: string): number {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  assert.ok(match, `色值必须是 6 位十六进制：${hex}`);
  const value = Number.parseInt(match[1] ?? "0", 16);
  const [r, g, b] = [(value >> 16) & 255, (value >> 8) & 255, value & 255];
  return (
    0.2126 * linearChannel(r ?? 0) + 0.7152 * linearChannel(g ?? 0) + 0.0722 * linearChannel(b ?? 0)
  );
}

function contrastRatio(background: string, foreground: string): number {
  const high = Math.max(relativeLuminance(background), relativeLuminance(foreground));
  const low = Math.min(relativeLuminance(background), relativeLuminance(foreground));
  return (high + 0.05) / (low + 0.05);
}

/** 白色字面量的各种写法：任何一条出现在前景声明里都算回归。 */
const WHITE_LITERALS = [/#fff(?:fff)?\b/i, /rgb\(\s*255[\s,]+255[\s,]+255/i, /\bwhite\b/i];

function assertNoWhiteLiteral(text: string, where: string): void {
  for (const pattern of WHITE_LITERALS) {
    assert.doesNotMatch(text, pattern, `${where}出现了写死的白色前景：${pattern}`);
  }
}

test("caret 前景引用 --soxu-on-accent，不得写死白色", async () => {
  const source = stripCssComments(await readSource("components/ComposerSendMenu.vue"));
  const block = cssRule(source, ".send-caret");

  assert.equal(
    declaration(block, "color"),
    "var(--soxu-on-accent)",
    "caret 前景必须消费色板的 on-accent token",
  );
  assertNoWhiteLiteral(declaration(block, "color"), "caret 的 color");
});

test("caret 的分隔线跟随 on-accent，深墨前景不配白色分隔线", async () => {
  const source = stripCssComments(await readSource("components/ComposerSendMenu.vue"));
  const block = cssRule(source, ".send-caret");
  const border = declaration(block, "border-left");

  assert.match(
    border,
    /color-mix\(in srgb, var\(--soxu-on-accent\)/,
    "分隔线必须由 on-accent 推导；写死白色会在琥珀/蓝绿上留一条刺眼的白线",
  );
  assertNoWhiteLiteral(border, "caret 的 border-left");
});

test("发送主钮与 caret 使用同一个前景 token（拼成一整块）", async () => {
  const caret = stripCssComments(await readSource("components/ComposerSendMenu.vue"));
  const composer = stripCssComments(await readSource("components/ChatComposer.vue"));

  assert.equal(
    declaration(cssRule(composer, ".send-main"), "color"),
    declaration(cssRule(caret, ".send-caret"), "color"),
    "主钮与 caret 的前景必须同源，否则同色块上出现两种字色",
  );
});

test("六个色板的 on-accent 前景都达到非文本 3:1", () => {
  for (const option of ACCENT_OPTIONS) {
    const ratio = contrastRatio(option.hex, option.onAccent);
    assert.ok(
      ratio >= MIN_NON_TEXT_CONTRAST,
      `${option.label}（${option.value}）的前景 ${option.onAccent} 在 ${option.hex} 上只有 ` +
        `${ratio.toFixed(2)}:1，低于非文本 ${MIN_NON_TEXT_CONTRAST}:1`,
    );
  }
});

test("主钮前景同样消费 token（上一轮只改了主钮，caret 被漏掉）", async () => {
  const source = stripCssComments(await readSource("components/ChatComposer.vue"));
  const color = declaration(cssRule(source, ".send-main"), "color");

  assert.equal(color, "var(--soxu-on-accent)");
  assertNoWhiteLiteral(color, "主钮的 color");
});
