/**
 * 回归测试：界面字号与字体族（Issue #98）。
 *
 * Node 里能确定验证的部分：
 * - 偏好以 soxu.appearance 存成 JSON，逐字段容错，默认值 = 改动前的现状；
 * - <html data-font-size data-font-family> 是唯一的应用方式，脏值退回默认档；
 * - base.css 的字号档位是「相对标准档的倍率」，标准档必须恰好是 1（回归零）；
 * - 字体栈只在 base.css 定义，组件一律引用 token，等宽档不碰正文 token；
 * - 组件里不再有 px 字号，rem 全部落在 2 的幂分母上（无亚像素舍入）。
 *
 * 真实像素与四档截图见 docs/development/evidence/issue-98-appearance/README.md。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { nextTick } from "vue";

import { useAppearance } from "../src/composables/useAppearance.ts";
import {
  ACCENT_OPTIONS,
  APPEARANCE_STORAGE_KEY,
  CODE_FONT_OPTIONS,
  CONTENT_WIDTH_OPTIONS,
  DEFAULT_APPEARANCE,
  FONT_FAMILY_OPTIONS,
  FONT_SIZE_OPTIONS,
  applyDocumentAppearance,
  isAccentName,
  isCodeFontName,
  isContentWidthName,
  isFontFamilyName,
  isFontSizeName,
  persistAppearance,
  readStoredAppearance,
  resolveInitialAppearance,
  type Appearance,
  type AppearanceStorageLike,
} from "../src/theme/appearance.ts";

const SRC_ROOT = fileURLToPath(new URL("../src", import.meta.url));

class FakeStorage implements AppearanceStorageLike {
  readonly entries = new Map<string, string>();
  failOnGet = false;
  failOnSet = false;

  getItem(key: string): string | null {
    if (this.failOnGet) throw new Error("SecurityError: localStorage 被禁用");
    return this.entries.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failOnSet) throw new Error("QuotaExceededError: 配额已满");
    this.entries.set(key, value);
  }
}

function applyTo(appearance: Appearance, dataset: Record<string, string | undefined>) {
  applyDocumentAppearance(appearance, { documentElement: { dataset } });
  return dataset;
}

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

/** 读某条声明里的值，例如 token("--soxu-font-scale")。 */
function declaration(block: string, property: string): string {
  const match = new RegExp(`${property}:\\s*([^;]+);`).exec(block);
  assert.ok(match, `没有找到 ${property} 的声明`);
  return (match[1] ?? "").trim();
}

/** WCAG 2.x 的相对亮度与对比度：色板前景靠它验证，而不是靠肉眼「看着还行」。 */
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

async function collectStyles(): Promise<Array<{ path: string; text: string }>> {
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/\.(vue|css)$/.test(entry.name)) {
        files.push(full);
      }
    }
  };
  await walk(SRC_ROOT);
  return Promise.all(
    files.map(async (path) => ({ path, text: await readFile(path, "utf8") })),
  );
}

test("档位名的合法性：脏值不算偏好", () => {
  for (const value of ["small", "standard", "large", "xlarge"]) {
    assert.equal(isFontSizeName(value), true, `${value} 应该是合法字号档`);
  }
  for (const value of ["medium", "XL", "", null, undefined, 1, "16px"]) {
    assert.equal(isFontSizeName(value), false, `${String(value)} 不应被当成字号档`);
  }

  // 衬线档由 Issue #116 加入（原型 UI_FONT 也有这一档）
  for (const value of ["system", "sans", "serif", "mono"]) {
    assert.equal(isFontFamilyName(value), true, `${value} 应该是合法字体档`);
  }
  for (const value of ["Serif", "inter", "", null, undefined, 0]) {
    assert.equal(isFontFamilyName(value), false, `${String(value)} 不应被当成字体档`);
  }

  for (const value of ["blue", "green", "teal", "violet", "rose", "amber"]) {
    assert.equal(isAccentName(value), true, `${value} 应该是合法强调色`);
  }
  for (const value of ["Blue", "red", "#3a83f7", "", null, undefined, 1]) {
    assert.equal(isAccentName(value), false, `${String(value)} 不应被当成强调色`);
  }

  for (const value of ["system", "jetbrains", "fira"]) {
    assert.equal(isCodeFontName(value), true, `${value} 应该是合法代码字体档`);
  }
  for (const value of ["JetBrains", "fira-code", "", null, undefined, 0]) {
    assert.equal(isCodeFontName(value), false, `${String(value)} 不应被当成代码字体档`);
  }

  for (const value of ["fixed", "fluid"]) {
    assert.equal(isContentWidthName(value), true, `${value} 应该是合法宽度档`);
  }
  for (const value of ["Fixed", "auto", "", null, undefined, 768]) {
    assert.equal(isContentWidthName(value), false, `${String(value)} 不应被当成宽度档`);
  }
});

test("设置面板的选项表就是档位唯一来源：字号 / 界面字体 / 代码字体 / 宽度 / 强调色", () => {
  assert.deepEqual(
    FONT_SIZE_OPTIONS.map((option) => option.value),
    ["small", "standard", "large", "xlarge"],
  );
  assert.deepEqual(
    FONT_SIZE_OPTIONS.map((option) => option.label),
    ["小", "标准", "大", "特大"],
  );
  // Issue #116 的三档（Inter / 系统栈 / 衬线）+ 保留既有的等宽档
  assert.deepEqual(
    FONT_FAMILY_OPTIONS.map((option) => option.value),
    ["system", "sans", "serif", "mono"],
  );
  assert.deepEqual(
    FONT_FAMILY_OPTIONS.map((option) => option.label),
    ["Inter", "系统栈", "衬线", "等宽"],
  );
  assert.deepEqual(
    CODE_FONT_OPTIONS.map((option) => option.value),
    ["system", "jetbrains", "fira"],
  );
  assert.deepEqual(
    CONTENT_WIDTH_OPTIONS.map((option) => option.label),
    ["固定 768", "自适应"],
  );
  // 六色板，默认色排第一且与 base.css 的 :root 取值一致
  assert.deepEqual(
    ACCENT_OPTIONS.map((option) => option.value),
    ["blue", "green", "teal", "violet", "rose", "amber"],
  );
  assert.deepEqual(
    ACCENT_OPTIONS.map((option) => option.label),
    ["索序蓝", "青绿", "蓝绿", "紫罗兰", "玫红", "琥珀"],
  );
  assert.equal(ACCENT_OPTIONS[0]?.hex, "#3a83f7");
  assert.equal(ACCENT_OPTIONS[0]?.onAccent, "#ffffff", "默认色沿用改动前的白色前景");
  for (const option of ACCENT_OPTIONS) {
    assert.match(option.onAccent, /^#[0-9a-f]{6}$/, option.value + " 的前景必须是十六进制色值");
  }

  // 默认值必须能在选项表里选出来，否则设置面板一打开就"没有选中项"。
  assert.ok(FONT_SIZE_OPTIONS.some((option) => option.value === DEFAULT_APPEARANCE.fontSize));
  assert.ok(FONT_FAMILY_OPTIONS.some((option) => option.value === DEFAULT_APPEARANCE.fontFamily));
  assert.ok(CODE_FONT_OPTIONS.some((option) => option.value === DEFAULT_APPEARANCE.codeFont));
  assert.ok(
    CONTENT_WIDTH_OPTIONS.some((option) => option.value === DEFAULT_APPEARANCE.contentWidth),
  );
  assert.ok(ACCENT_OPTIONS.some((option) => option.value === DEFAULT_APPEARANCE.accent));
});

test("色板前景色经过对比度校验：主色底上的图标/勾选不低于 3:1", () => {
  // 复审教训（Issue #116）：新色板上直接沿用白字时，蓝绿只有 2.49:1、琥珀 2.15:1，
  // 发送钮图标与色板勾选几乎看不见。这条用例把「每个色板用白还是用墨」钉在实测值上，
  // 而不是让下一个人凭感觉选。
  const WHITE = "#ffffff";
  const INK = "#191717";

  for (const option of ACCENT_OPTIONS) {
    const ratio = contrastRatio(option.hex, option.onAccent);
    // 发送钮是纯图标、色板勾选是 12px 描边图形：适用 WCAG 1.4.11 的非文本对比度 3:1。
    assert.ok(
      ratio >= 3,
      `${option.value} 的前景 ${option.onAccent} 在 ${option.hex} 上只有 ${ratio.toFixed(2)}:1`,
    );

    if (option.value === "blue") {
      // 默认色是既有基线：沿用改动前的白字（3.64:1），改它等于改默认观感。
      assert.equal(option.onAccent, WHITE, "默认索序蓝必须保持白色前景");
      continue;
    }

    // 其余五色取白/墨中对比度更高的一侧，避免出现「白字在亮色上糊掉」。
    const better = contrastRatio(option.hex, WHITE) >= contrastRatio(option.hex, INK) ? WHITE : INK;
    assert.equal(option.onAccent, better, `${option.value} 应取白/墨中对比度更高的一侧`);
  }

  // 至少有一档必须换深墨色，否则这条规则等于没生效（蓝绿/琥珀就是这两档）。
  assert.ok(
    ACCENT_OPTIONS.some((option) => option.onAccent === INK),
    "亮色板必须有用深墨色前景的档位",
  );
});

test("默认外观 = 现状：标准字号 + 系统字体 + 系统等宽 + 固定宽度 + 索序蓝", () => {
  assert.equal(APPEARANCE_STORAGE_KEY, "soxu.appearance");
  assert.deepEqual(DEFAULT_APPEARANCE, {
    fontSize: "standard",
    fontFamily: "system",
    codeFont: "system",
    contentWidth: "fixed",
    accent: "blue",
  });
  assert.deepEqual(readStoredAppearance(new FakeStorage()), { ...DEFAULT_APPEARANCE });
  // 没有 localStorage（Node / 服务端渲染）时同样是默认值
  assert.deepEqual(readStoredAppearance(null), { ...DEFAULT_APPEARANCE });
  assert.deepEqual(resolveInitialAppearance({ storage: null }), { ...DEFAULT_APPEARANCE });
});

test("持久化与读取：同一个键往返，脏数据逐字段回退", () => {
  const storage = new FakeStorage();
  const chosen: Appearance = {
    fontSize: "xlarge",
    fontFamily: "mono",
    codeFont: "fira",
    contentWidth: "fluid",
    accent: "violet",
  };
  assert.equal(persistAppearance(chosen, storage), true);
  assert.deepEqual(readStoredAppearance(storage), chosen);
  assert.deepEqual(resolveInitialAppearance({ storage }), chosen);

  // 存了非 JSON / 非对象：整体回退默认
  for (const raw of ["not json", "null", "42", '"large"']) {
    const broken = new FakeStorage();
    broken.entries.set(APPEARANCE_STORAGE_KEY, raw);
    assert.deepEqual(readStoredAppearance(broken), { ...DEFAULT_APPEARANCE }, raw);
  }

  // 只坏一个字段：其他项仍然保留用户的选择
  const partial = new FakeStorage();
  partial.entries.set(APPEARANCE_STORAGE_KEY, JSON.stringify({ fontSize: "large", fontFamily: 7 }));
  assert.deepEqual(readStoredAppearance(partial), {
    ...DEFAULT_APPEARANCE,
    fontSize: "large",
  });

  const partialSize = new FakeStorage();
  partialSize.entries.set(APPEARANCE_STORAGE_KEY, JSON.stringify({ fontFamily: "sans" }));
  assert.deepEqual(readStoredAppearance(partialSize), {
    ...DEFAULT_APPEARANCE,
    fontFamily: "sans",
  });

  // Issue #98 时期存下来的两字段 JSON：新字段自动补默认值，不丢用户已有的选择
  const legacy = new FakeStorage();
  legacy.entries.set(APPEARANCE_STORAGE_KEY, JSON.stringify({ fontSize: "large", fontFamily: "mono" }));
  assert.deepEqual(readStoredAppearance(legacy), {
    ...DEFAULT_APPEARANCE,
    fontSize: "large",
    fontFamily: "mono",
  });

  // 新字段的脏值同样逐项回退
  const dirtyNew = new FakeStorage();
  dirtyNew.entries.set(
    APPEARANCE_STORAGE_KEY,
    JSON.stringify({ codeFont: "comic", contentWidth: "auto", accent: "#fff" }),
  );
  assert.deepEqual(readStoredAppearance(dirtyNew), { ...DEFAULT_APPEARANCE });
});

test("存储不可用（隐私模式 / 配额满）不抛错，只是回到默认值", () => {
  const broken = new FakeStorage();
  broken.failOnGet = true;
  assert.deepEqual(readStoredAppearance(broken), { ...DEFAULT_APPEARANCE });

  const chosen: Appearance = { ...DEFAULT_APPEARANCE, fontSize: "large", fontFamily: "sans" };
  const full = new FakeStorage();
  full.failOnSet = true;
  assert.equal(persistAppearance(chosen, full), false);
  assert.equal(persistAppearance(chosen, null), false);
});

test("持久化只写已知字段，不回写脏值", () => {
  const storage = new FakeStorage();
  const dirty = {
    fontSize: "huge",
    fontFamily: "comic",
    codeFont: "comic",
    contentWidth: 768,
    accent: "red",
  } as unknown as Appearance;
  assert.equal(persistAppearance(dirty, storage), true);
  assert.equal(
    storage.entries.get(APPEARANCE_STORAGE_KEY),
    JSON.stringify({ ...DEFAULT_APPEARANCE }),
  );
});

test("applyDocumentAppearance 写满五个 data-* 属性，脏值退回默认档", () => {
  const chosen: Appearance = {
    fontSize: "large",
    fontFamily: "serif",
    codeFont: "fira",
    contentWidth: "fluid",
    accent: "rose",
  };
  const dataset = applyTo(chosen, {});
  assert.deepEqual(dataset, {
    fontSize: "large",
    fontFamily: "serif",
    codeFont: "fira",
    contentWidth: "fluid",
    accent: "rose",
  });

  const back = applyTo({ ...DEFAULT_APPEARANCE }, dataset);
  assert.deepEqual(back, { ...DEFAULT_APPEARANCE });

  // 脏值不会写进 DOM（CSS 侧没有对应选择器，写进去等于静默失效）
  const guarded = applyTo(
    { fontSize: "medium", fontFamily: "inter", codeFont: "comic", contentWidth: 1, accent: "red" } as never,
    {},
  );
  assert.deepEqual(guarded, { ...DEFAULT_APPEARANCE });

  assert.doesNotThrow(() => applyDocumentAppearance(DEFAULT_APPEARANCE, null));
});

test("base.css：字号档位是相对倍率，标准档恰好为 1（默认零变化）", async () => {
  const css = stripCssComments(await readSource("styles/base.css"));

  const root = cssRule(css, ":root");
  assert.equal(declaration(root, "--soxu-font-scale"), "1", "标准档必须是 1，否则默认观感就变了");

  // root 字号由倍率推导：1rem 在 :root 上指字体初始值，系统默认字号设置仍然生效
  const html = cssRule(css, "html");
  assert.equal(declaration(html, "font-size"), "calc(1rem * var(--soxu-font-scale))");

  const scale = (selector: string) =>
    Number.parseFloat(declaration(cssRule(css, `:root[data-font-size="${selector}"]`), "--soxu-font-scale"));

  const small = scale("small");
  const large = scale("large");
  const xlarge = scale("xlarge");
  assert.ok(small < 1 && large > 1 && xlarge > large, "档位必须单调递增：小 < 标准 < 大 < 特大");

  // 与 Issue 的 13 / 14 / 15 / 16.5px 等比例对应（以 14px 为基准）
  const reference = (px: number) => px / 14;
  assert.ok(Math.abs(small - reference(13)) < 0.005, `小档 ${small} 应接近 13/14`);
  assert.ok(Math.abs(large - reference(15)) < 0.005, `大档 ${large} 应接近 15/14`);
  assert.ok(Math.abs(xlarge - reference(16.5)) < 0.005, `特大档 ${xlarge} 应接近 16.5/14`);
});

test("base.css：字体栈只在 token 里定义，等宽档不影响正文 token", async () => {
  const css = stripCssComments(await readSource("styles/base.css"));
  const root = cssRule(css, ":root");

  const ui = declaration(root, "--soxu-font-family-ui");
  const body = declaration(root, "--soxu-font-family-body");
  const mono = declaration(root, "--soxu-font-family-mono");

  // 正文与界面在默认档上完全一致：改动前 body 的字体栈原样保留，回归零。
  assert.equal(ui, body);
  assert.match(ui, /^Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif$/);
  assert.match(mono, /monospace$/);

  // body 只认界面 token，不再写死字体栈
  assert.equal(declaration(cssRule(css, "body"), "font-family"), "var(--soxu-font-family-ui)");

  // 系统默认档不需要任何覆盖；写出来反而会变成第二份配置
  assert.ok(
    !/:root\[data-font-family="system"\]/.test(css),
    "system 是默认值，不应该再有覆盖规则",
  );

  const sans = cssRule(css, ':root[data-font-family="sans"]');
  assert.ok(declaration(sans, "--soxu-font-family-ui").length > 0);
  assert.doesNotMatch(sans, /--soxu-font-family-body/, "无衬线档不应该动正文 token");

  const monoBlock = cssRule(css, ':root[data-font-family="mono"]');
  assert.equal(declaration(monoBlock, "--soxu-font-family-ui"), "var(--soxu-font-family-mono)");
  assert.doesNotMatch(
    monoBlock,
    /--soxu-font-family-body/,
    "等宽档必须让正文 token 保持原值，正文不能被改成等宽（Issue #98 约束）",
  );
});

test("会话正文跟随全局字号，代码/工具输出走等宽 token", async () => {
  const messages = stripCssComments(await readSource("components/MessageList.vue"));
  const bubble = cssRule(messages, ".bubble");
  assert.equal(declaration(bubble, "font-family"), "var(--soxu-font-family-body)");
  // 字号必须是 rem，才会跟随 --soxu-font-scale（0.875rem = 改动前的 14px）
  assert.equal(declaration(bubble, "font-size"), "0.875rem");

  const toolBubble = cssRule(
    messages,
    '.message[data-role="tool"] .bubble,\n.message[data-role="other"] .bubble',
  );
  assert.equal(declaration(toolBubble, "font-family"), "var(--soxu-font-family-mono)");
  assert.equal(declaration(cssRule(messages, ".tool-block"), "font-family"), "var(--soxu-font-family-mono)");

  const composer = stripCssComments(await readSource("components/ChatComposer.vue"));
  assert.equal(
    declaration(cssRule(composer, ".composer textarea"), "font-family"),
    "var(--soxu-font-family-body)",
    "输入框写的是正文，不应跟着「等宽」界面档变成等宽",
  );
});

test("组件不得再写死 font-family，所有字号都是基 16px 的 rem", async () => {
  const styles = await collectStyles();
  const pxOffenders: string[] = [];
  const hardcodedFamily: string[] = [];
  const inexact: string[] = [];

  for (const { path, text } of styles) {
    const relative = path.slice(SRC_ROOT.length + 1).replaceAll("\\", "/");
    const css = stripCssComments(text);

    for (const match of css.matchAll(/font-size:\s*([0-9.]+)px/g)) {
      pxOffenders.push(`${relative}: ${match[1]}px`);
    }
    // 逐条取声明值判断：只认可 --soxu-font-family-* token（inherit 是继承语义，不是字体栈）。
    for (const match of css.matchAll(/font-family:\s*([^;]+);/g)) {
      const value = (match[1] ?? "").trim();
      if (value === "inherit") continue;
      if (!value.startsWith("var(--soxu-font-family-")) {
        hardcodedFamily.push(`${relative}: ${value}`);
      }
    }
    for (const match of css.matchAll(/font-size:\s*([0-9.]+)rem/g)) {
      const value = Number(match[1]);
      // 1/32rem = 0.5px 的整数倍：倍率换算不会引入亚像素舍入，标准档与改动前逐像素一致
      if (!Number.isInteger(Number((value * 32).toFixed(6)))) {
        inexact.push(`${relative}: ${value}rem`);
      }
    }
  }

  assert.deepEqual(pxOffenders, [], "字号必须用 rem 写，px 不会跟随字号档位");
  assert.deepEqual(inexact, [], "rem 字号必须是 0.5px 的整数倍，否则标准档会有亚像素差异");
  assert.deepEqual(
    hardcodedFamily,
    [],
    "字体栈只能来自 base.css 的 --soxu-font-family-* token",
  );
});

test("useAppearance：改动当帧写进 <html>，只有用户改动才写 localStorage", async () => {
  const storage = new FakeStorage();
  const doc = { documentElement: { dataset: {} as Record<string, string | undefined> } };
  const define = (name: string, value: unknown) =>
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  define("localStorage", storage);
  define("document", doc);

  try {
    const { appearance, setFontSize, setFontFamily, setAccent, setCodeFont, setContentWidth } =
      useAppearance();

    // immediate：接管启动后的第一次落地（挂载前那一次在 main.ts）
    assert.equal(doc.documentElement.dataset.fontSize, "standard");
    assert.equal(doc.documentElement.dataset.fontFamily, "system");
    assert.equal(doc.documentElement.dataset.codeFont, "system");
    assert.equal(doc.documentElement.dataset.contentWidth, "fixed");
    assert.equal(doc.documentElement.dataset.accent, "blue");
    assert.equal(storage.entries.size, 0, "启动时不写存储，否则会把默认值当成用户偏好");

    setFontSize("xlarge");
    setFontFamily("mono");
    setAccent("teal");
    setCodeFont("jetbrains");
    setContentWidth("fluid");
    assert.deepEqual(appearance.value, {
      fontSize: "xlarge",
      fontFamily: "mono",
      codeFont: "jetbrains",
      contentWidth: "fluid",
      accent: "teal",
    });
    assert.equal(doc.documentElement.dataset.fontSize, "xlarge", "改档位必须当帧落地，不能等下一帧");
    assert.equal(doc.documentElement.dataset.fontFamily, "mono");
    assert.equal(doc.documentElement.dataset.accent, "teal", "强调色必须当帧落地");
    assert.equal(doc.documentElement.dataset.codeFont, "jetbrains");
    assert.equal(doc.documentElement.dataset.contentWidth, "fluid");

    await nextTick();
    assert.equal(
      storage.entries.get(APPEARANCE_STORAGE_KEY),
      JSON.stringify({
        fontSize: "xlarge",
        fontFamily: "mono",
        codeFont: "jetbrains",
        contentWidth: "fluid",
        accent: "teal",
      }),
    );

    // 重复选同一档不产生写入（幂等，也避免无意义的存储抖动）
    storage.entries.set(APPEARANCE_STORAGE_KEY, "sentinel");
    setFontSize("xlarge");
    setFontFamily("mono");
    setAccent("teal");
    setCodeFont("jetbrains");
    setContentWidth("fluid");
    await nextTick();
    assert.equal(storage.entries.get(APPEARANCE_STORAGE_KEY), "sentinel");
  } finally {
    Reflect.deleteProperty(globalThis, "localStorage");
    Reflect.deleteProperty(globalThis, "document");
  }
});

test("设置面板文案与真实作用域一致：等宽档说的是「界面字体」，代码块恒等宽、正文不变", async () => {
  // 复审教训：上一版面板写「「等宽」只影响代码块与工具输出」，而 CSS 实际改的是界面字体
  // （代码块本来就恒等宽），用户看到的界面观感与文案相反。这条测试把两者的说法钉在一起：
  // 文案必须点到「界面」与「正文」，且不得再出现「只影响代码块」这类与 base.css 矛盾的措辞。
  // Issue #116 起外观页单独成组件，文案跟着字段一起搬过去了。
  const source = await readSource("components/settings/SettingsAppearance.vue");
  const withoutComments = source.replace(/<!--[\s\S]*?-->/g, "");

  // Issue #123 起行标题由 settings/catalog.ts 提供，锚点改成设置项 id。
  const fieldStart = withoutComments.indexOf('setting="appearance.fontFamily"');
  assert.ok(fieldStart > 0, "外观页里应该有界面字体字段");

  // 说明文案写在该字段的 <template #note> 里；取到这一行的 </SettingsRow> 为止。
  const rowEnd = withoutComments.indexOf("</SettingsRow>", fieldStart);
  assert.ok(rowEnd > fieldStart, "界面字体字段应该是一个完整的设置行");
  const noteSource = withoutComments.slice(fieldStart, rowEnd);
  assert.ok(
    noteSource.includes('t("settings.note.appearance.font.family")'),
    "说明文案自 Issue #145 起走语言包",
  );

  // 文案内容在基准包里：仍然要求它点到「界面」与「正文」。
  const zh = JSON.parse(await readSource("locales/zh-CN/settings.json")) as Record<string, string>;
  const note = zh["note.appearance.font.family"] ?? "";
  assert.match(note, /界面/, "文案必须说明这一项改的是界面字体");
  assert.match(note, /正文/, "文案必须说明会话正文不受影响");
  assert.doesNotMatch(
    note,
    /只影响代码块/,
    "代码块与工具输出本来就恒等宽，写「只影响代码块」与 base.css 的实际作用域矛盾",
  );

  // 与 base.css 对照：等宽档唯一改动的 token 就是界面字体，文案里的两句话才对得上。
  const css = stripCssComments(await readSource("styles/base.css"));
  const monoBlock = cssRule(css, ':root[data-font-family="mono"]');
  const changedTokens = [...monoBlock.matchAll(/(--soxu-font-family-[a-z]+)\s*:/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(changedTokens, ["--soxu-font-family-ui"], "等宽档只能改界面字体 token");
});

test("App.vue 与 main.ts 把外观接到 DOM：挂载前落地、面板双向绑定", async () => {
  const main = await readSource("main.ts");
  assert.match(main, /applyDocumentAppearance\(resolveInitialAppearance\(\)\)/);
  assert.ok(
    main.indexOf("applyDocumentAppearance") < main.indexOf(".mount("),
    "外观必须在挂载前写进 <html>，否则启动会先闪一帧基准字号",
  );

  const app = await readSource("App.vue");
  assert.match(app, /const \{ appearance, patchAppearance \} = useAppearance\(\)/);
  // Issue #116：外观是一个整体对象（五项一起传），设置面板冒泡整份外观再统一落地
  assert.match(app, /:appearance="appearance"/);
  assert.match(app, /@update:appearance="\(value: Appearance\) => patchAppearance\(value\)"/);
});
