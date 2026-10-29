/**
 * 回归测试：主题偏好、启动初始值、原生窗口标题栏同步，以及顶部栏配色只能走 token。
 *
 * 对应 Issue #86 的验收点里能在 Node 里确定验证的部分：
 * 浅/深切换后 html 的 data-theme 与深色 token 生效、header 只用 --soxu-* token、
 * 深色大面积背景不是近白色、窗口 setTheme 失败（Linux/浏览器预览）不打断主题切换。
 *
 * 真实像素（顶部栏实际背景、原生标题栏）需要实机截图，见
 * docs/development/evidence/issue-86-header-theme/README.md。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  THEME_STORAGE_KEY,
  applyDocumentTheme,
  isThemeName,
  persistTheme,
  prefersDarkScheme,
  readStoredTheme,
  resolveInitialTheme,
  syncWindowTheme,
  type ThemeName,
  type ThemeStorageLike,
  type ThemeWindowTarget,
} from "../src/theme/theme.ts";

class FakeStorage implements ThemeStorageLike {
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

function matchMediaStub(dark: boolean) {
  const queries: string[] = [];
  const matchMedia = (query: string) => {
    queries.push(query);
    return { matches: dark };
  };
  return { matchMedia, queries };
}

test("只有 light/dark 是合法主题名，脏值不算偏好", () => {
  assert.equal(isThemeName("dark"), true);
  assert.equal(isThemeName("light"), true);
  for (const value of ["Dark", "", "system", null, undefined, 1]) {
    assert.equal(isThemeName(value), false, `${String(value)} 不应被当成主题名`);
  }

  const storage = new FakeStorage();
  storage.entries.set(THEME_STORAGE_KEY, "sepia");
  assert.equal(readStoredTheme(storage), null);
});

test("读持久化主题：命中返回、缺失返回 null、存储抛错按无偏好处理", () => {
  const storage = new FakeStorage();
  assert.equal(readStoredTheme(storage), null);

  storage.entries.set(THEME_STORAGE_KEY, "dark");
  assert.equal(readStoredTheme(storage), "dark");

  const broken = new FakeStorage();
  broken.entries.set(THEME_STORAGE_KEY, "dark");
  broken.failOnGet = true;
  assert.equal(readStoredTheme(broken), null);
  // 没有 localStorage（Node / 服务端渲染）
  assert.equal(readStoredTheme(null), null);
});

test("初始主题：用户显式选择优先于系统偏好", () => {
  const stored = new FakeStorage();
  stored.entries.set(THEME_STORAGE_KEY, "light");
  const darkSystem = matchMediaStub(true);
  assert.equal(resolveInitialTheme({ storage: stored, matchMedia: darkSystem.matchMedia }), "light");
  // 有偏好时不应该再去问系统
  assert.deepEqual(darkSystem.queries, []);

  const storedDark = new FakeStorage();
  storedDark.entries.set(THEME_STORAGE_KEY, "dark");
  assert.equal(
    resolveInitialTheme({ storage: storedDark, matchMedia: matchMediaStub(false).matchMedia }),
    "dark",
  );
});

test("初始主题：没有持久化值时跟随系统，查询串必须带 prefers-color-scheme", () => {
  const light = matchMediaStub(false);
  assert.equal(resolveInitialTheme({ storage: new FakeStorage(), matchMedia: light.matchMedia }), "light");
  assert.deepEqual(light.queries, ["(prefers-color-scheme: dark)"]);

  const dark = matchMediaStub(true);
  assert.equal(resolveInitialTheme({ storage: new FakeStorage(), matchMedia: dark.matchMedia }), "dark");

  // 没有 matchMedia 的环境按浅色处理
  assert.equal(prefersDarkScheme(null), false);
  assert.equal(resolveInitialTheme({ storage: null, matchMedia: null }), "light");
});

test("持久化主题：写入同一个键，失败不抛错", () => {
  const storage = new FakeStorage();
  assert.equal(persistTheme("dark", storage), true);
  assert.equal(storage.entries.get(THEME_STORAGE_KEY), "dark");

  const broken = new FakeStorage();
  broken.failOnSet = true;
  assert.equal(persistTheme("dark", broken), false);
  assert.equal(persistTheme("dark", null), false);
});

test("applyDocumentTheme 把主题写到 <html data-theme>，没有 document 时不报错", () => {
  const doc = { documentElement: { dataset: {} as Record<string, string | undefined> } };
  applyDocumentTheme("dark", doc);
  assert.equal(doc.documentElement.dataset.theme, "dark");
  applyDocumentTheme("light", doc);
  assert.equal(doc.documentElement.dataset.theme, "light");

  // 主题值不会被写成字符串化的非主题值
  applyDocumentTheme("dark" as ThemeName, doc);
  assert.equal(doc.documentElement.dataset.theme, "dark");

  assert.doesNotThrow(() => applyDocumentTheme("dark", null));
});

test("窗口主题同步：成功记为 applied，平台不支持/预览环境只跳过不抛错", async () => {
  const calls: ThemeName[] = [];
  const target: ThemeWindowTarget = {
    setTheme: async (theme) => {
      calls.push(theme);
    },
  };

  assert.equal(await syncWindowTheme("dark", target), "applied");
  assert.equal(await syncWindowTheme("light", target), "applied");
  assert.deepEqual(calls, ["dark", "light"]);

  const unsupported: ThemeWindowTarget = {
    setTheme: async () => {
      throw new Error("window.set_theme is not supported on this platform");
    },
  };
  assert.equal(await syncWindowTheme("dark", unsupported), "failed");
  // 浏览器预览：没有原生窗口
  assert.equal(await syncWindowTheme("dark", null), "skipped");
});

/** 读取仓库内文件；路径相对本测试文件，避免依赖工作目录。 */
async function readSource(relative: string): Promise<string> {
  return readFile(new URL(relative, import.meta.url), "utf8");
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

test("顶部栏背景与文字只能引用 --soxu-* token，不得新增硬编码色值", async () => {
  const app = await readSource("../src/App.vue");
  const block = stripCssComments(cssRule(app, ".app-header"));

  assert.match(
    block,
    /background:\s*var\(--soxu-[a-z-]+\)/,
    "顶部栏必须显式引用 token 背景，否则深色下会透出窗口的浅色 backgroundColor",
  );
  assert.match(block, /color:\s*var\(--soxu-[a-z-]+\)/);
  assert.match(block, /border-bottom:\s*1px solid var\(--soxu-[a-z-]+\)/);

  for (const forbidden of [/#[0-9a-fA-F]{3,8}\b/, /\brgba?\(/, /\bhsla?\(/, /\b(?:white|black)\b/]) {
    assert.doesNotMatch(block, forbidden, `顶部栏样式里出现了硬编码色值：${forbidden}`);
  }
});

test("深色 token 同时挂在 html 与 .app-shell 上，且不是近白色", async () => {
  const css = stripCssComments(await readSource("../src/styles/base.css"));
  assert.match(
    css,
    /:root\[data-theme="dark"\]\s*,\s*\.app-shell\[data-theme="dark"\]\s*\{/,
    "深色 token 必须同时覆盖 :root（html 级 color-scheme/body 背景）和 .app-shell",
  );

  const darkBlock = cssRule(css, ':root[data-theme="dark"],\n.app-shell[data-theme="dark"]');
  const surfaces = [
    "--soxu-bg",
    "--soxu-sidebar",
    "--soxu-panel",
    "--soxu-soft",
    "--soxu-input",
    "--soxu-hover",
    "--soxu-selected",
    "--soxu-accent-soft",
  ];
  for (const token of surfaces) {
    const match = new RegExp(`${token}:\\s*(#[0-9a-fA-F]{6})`).exec(darkBlock);
    assert.ok(match, `深色块缺少 ${token}`);
    const luminance = relativeLuminance(match[1] as string);
    assert.ok(luminance < 0.2, `${token} 在深色下亮度 ${luminance.toFixed(3)}，属于近白色大面积背景`);
  }

  // 顶部栏用的 token 在深色下必须真的有深色值，否则等于没改
  assert.match(darkBlock, /--soxu-sidebar:\s*#222020/);
});

/** WCAG 相对亮度；只用来卡"近白色大面积背景"，不做对比度断言。 */
function relativeLuminance(hex: string): number {
  const value = hex.replace("#", "");
  const channels = [0, 2, 4].map((offset) => {
    const raw = Number.parseInt(value.slice(offset, offset + 2), 16) / 255;
    return raw <= 0.03928 ? raw / 12.92 : ((raw + 0.055) / 1.055) ** 2.4;
  });
  const [r, g, b] = channels as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
