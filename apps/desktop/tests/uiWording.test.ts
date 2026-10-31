import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BANNED_WORDING,
  formatHit,
  scanText,
  scanWording,
  stripComments,
  visibleFragments,
} from "./support/uiWordingScan.ts";

// 界面文案不得暴露实现术语，只能展示使用者能理解的状态。
const SRC_ROOT = fileURLToPath(new URL("../src", import.meta.url));
const INSPECTOR = join(SRC_ROOT, "components", "RuntimeInspector.vue");

async function collect(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return collect(full);
      return [full];
    }),
  );
  return files.flat();
}

async function sources(): Promise<Array<{ path: string; text: string }>> {
  const files = await collect(SRC_ROOT);
  return Promise.all(
    files.map(async (path) => ({ path, text: await readFile(path, "utf8") })),
  );
}

test("界面源码不出现技术栈名词与写死的版本行", async () => {
  const forbidden = ["Rust 运行时", "运行检查器", "SOXU 0.1.0"];
  const all = await sources();
  for (const term of forbidden) {
    const offenders = all.filter((file) => file.text.includes(term)).map((file) => file.path);
    assert.deepEqual(offenders, [], `文案只能用「已连接 / 未连接」描述状态，不得出现「${term}」`);
  }
});

test("会话状态面板不再展示版本行与「项目 / 会话 2 / 6」占位表述", async () => {
  const text = await readFile(INSPECTOR, "utf8");

  // 版本信息统一收进「设置 → 关于」，面板里不再重复。
  assert.ok(!text.includes("appVersion"), "面板不应渲染版本号");
  assert.ok(!text.includes("info.appName"), "面板不应渲染应用名");
  assert.ok(!text.includes("项目 / 会话"), "裸计数字段对使用者没有意义");

  // 计数保留，但必须带单位说明。
  assert.ok(text.includes("个项目 · "), "项目数需要带单位");
  assert.ok(text.includes("个会话"), "会话数需要带单位");
});

test("会话状态面板保留连接状态与排障信息", async () => {
  const text = await readFile(INSPECTOR, "utf8");

  for (const kept of [
    "会话状态",
    "已连接",
    "未连接",
    "当前会话",
    "generation",
    "历史条目",
    "重试预算",
    "诊断",
    "边界",
  ]) {
    assert.ok(text.includes(kept), `面板必须保留「${kept}」`);
  }

  // 无障碍名称与可见标题一致，避免读屏读到旧名字。
  assert.ok(text.includes('aria-label="会话状态"'), "面板 aria-label 需同步为「会话状态」");
});

test("版本与平台信息只保留在「设置 → 关于」，不在主界面重复", async () => {
  const app = await readFile(join(SRC_ROOT, "App.vue"), "utf8");
  assert.ok(!app.includes("appVersion"), "顶部栏不应渲染版本号");
  assert.ok(!app.includes("info.platform"), "顶部栏不应渲染平台名");
  // 连接状态文案自 Issue #135 起走语言包：源码里是 key，字面量在基准包里。
  assert.ok(app.includes('t("common.status.connected")'), "顶部栏仍需一眼可见的连接状态");
  assert.ok(app.includes('t("common.status.disconnected")'), "未连接状态同样走语言包");
  const common = JSON.parse(
    await readFile(join(SRC_ROOT, "locales", "zh-CN", "common.json"), "utf8"),
  ) as Record<string, string>;
  assert.equal(common["status.connected"], "已连接", "基准包必须提供连接状态文案");
  assert.equal(common["status.disconnected"], "未连接", "基准包必须提供未连接文案");

  // Issue #116 起「关于」在系统页（设置 → 系统 → 关于），外壳只保留标题与说明。
  const settings = await readFile(
    join(SRC_ROOT, "components", "settings", "SettingsSystem.vue"),
    "utf8",
  );
  // Issue #123 起行标题来自 settings/catalog.ts，这里按设置项 id 定位「关于」这一行。
  assert.ok(settings.includes('setting="system.about"'), "版本信息收进「设置 → 关于」");
  assert.ok(settings.includes("appVersion"), "「关于」保留版本信息");
  assert.ok(settings.includes("连接状态"), "连接状态用状态表述，不写技术栈名词");
});

// ──────────────────────────────────────────────────────────────
// 文案扫描器：用户可见字符串不得出现开发术语
// ──────────────────────────────────────────────────────────────

test("禁用词表与验收要求一致", () => {
  assert.deepEqual([...BANNED_WORDING], [
    "切片",
    "Issue #",
    "占位",
    "演示",
    "V4-S",
    "后续切片",
    "TODO(",
  ]);
});

test("扫描器自检：.vue 只扫模板文案，注释与脚本块不算", () => {
  const sample = [
    '<script setup lang="ts">',
    "// 本切片只是演示：注释里的开发术语不是用户文案",
    'const label = "占位";',
    "</script>",
    "<template>",
    "  <!-- 本切片是演示 -->",
    "  <p>本切片是演示</p>",
    '  <button aria-label="Issue #143">x</button>',
    "  <AppTooltip :text=\"'后续切片'\" />",
    "</template>",
  ].join("\n");

  const hits = scanWording("Sample.vue", sample);
  assert.deepEqual(
    hits.map((hit) => hit.term).sort(),
    ["Issue #", "后续切片", "切片", "切片", "演示"].sort(),
    "模板文本与属性值要扫到，HTML 注释与 <script> 里的字面量不能算",
  );
  // 行号必须落在模板里那一行，否则报告无法定位
  assert.deepEqual(
    hits.filter((hit) => hit.term === "演示").map((hit) => hit.line),
    [7],
  );
  assert.deepEqual(
    hits.filter((hit) => hit.term === "Issue #").map((hit) => hit.line),
    [8],
  );
});

test("扫描器自检：.ts 抹掉注释但保留字符串，URL 里的 // 不会截断", () => {
  const sample = [
    "/** 本切片只是占位。 */",
    "// Issue #143 的演示注释",
    'export const label = "演示标题";',
    'export const url = "https://example.com/a//b";',
    "export const other = 'TODO(V4-S7)';",
  ].join("\n");

  const hits = scanWording("sample.ts", sample);
  assert.deepEqual(
    hits.map((hit) => hit.term),
    ["演示", "V4-S", "TODO("],
    "只有字符串字面量算文案：注释里的术语一条都不该命中",
  );
  const fragments = visibleFragments("sample.ts", sample).map((fragment) => fragment.text);
  assert.ok(
    fragments.some((text) => text.includes("https://example.com/a//b")),
    "字符串里的 // 不能被当成注释，否则后面的文案会被整段漏掉",
  );
  assert.ok(
    !stripComments(sample).includes("本切片"),
    "注释必须真的被抹掉，而不是靠白名单绕过",
  );

  // 渲染后的纯文本没有注释概念：整段都按文案算，证据脚本用它复核屏幕内容。
  assert.deepEqual(
    scanText("本切片是演示").map((hit) => hit.term),
    ["切片", "演示"],
  );
});

test("界面文案扫描：apps/desktop/src 的用户可见字符串没有开发术语", async () => {
  const violations: string[] = [];
  const fragments: string[] = [];
  for (const file of await collect(SRC_ROOT)) {
    if (!/\.(vue|ts|json)$/u.test(file)) continue;
    const text = await readFile(file, "utf8");
    const label = relative(SRC_ROOT, file).replaceAll("\\", "/");
    fragments.push(...visibleFragments(file, text).map((fragment) => fragment.text));
    for (const hit of scanWording(file, text)) violations.push(formatHit(label, hit));
  }

  // 反假绿：扫描器如果提取不到东西，上面那条断言会永远通过。
  // 这里钉住「真的读到了模板文案」，否则提取逻辑一坏，门禁就形同虚设。
  assert.ok(
    fragments.length > 300,
    "只提取到 " + fragments.length + " 段用户可见字符串，提取逻辑可能已经失效",
  );
  assert.ok(
    fragments.some((text) => text.includes("临时会话")),
    "侧栏按钮文案必须被提取到，否则说明模板扫描没生效",
  );
  assert.deepEqual(
    violations,
    [],
    "用户可见字符串里出现了开发术语，改成面向用户的功能说明，或把这句话移回注释：\n"
      + violations.join("\n"),
  );
});
