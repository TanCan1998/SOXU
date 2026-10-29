import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TOOLTIP_DELAY_MS, TOOLTIP_SKIP_DELAY_MS } from "../src/components/tooltipConfig.ts";

// Issue #96：顶栏重构与交互基建。这里断言的是源码结构（构建期事实），
// 视觉与 hover 观感由 docs/development/evidence/issue-96-header-tooltip 的截图佐证。

const SRC_ROOT = fileURLToPath(new URL("../src", import.meta.url));

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
  return Promise.all(files.map(async (path) => ({ path, text: await readFile(path, "utf8") })));
}

function componentSection(app: string, tag = "header"): string {
  const start = app.indexOf(`<${tag}`);
  const end = app.indexOf(`</${tag}>`, start);
  assert.ok(start >= 0 && end > start, `App.vue 缺少 <${tag}> 区块`);
  return app.slice(start, end);
}

test("不再使用原生 title 属性，全部换成统一 tooltip", async () => {
  const all = await sources();
  const offenders = all
    .filter((file) => /(^|\s|:)title=/m.test(file.text))
    .map((file) => file.path);
  assert.deepEqual(offenders, [], "title= 必须归零：所有提示都走 AppTooltip");
});

test("需要悬浮提示的位置都接了 AppTooltip", async () => {
  const required = [
    "App.vue",
    join("components", "SessionTabs.vue"),
    join("components", "ProjectSidebar.vue"),
    join("components", "RuntimeInspector.vue"),
    join("components", "ChatPanel.vue"),
    join("components", "ChatComposer.vue"),
    join("components", "SettingsDialog.vue"),
    join("components", "WorktreeDialog.vue"),
  ];
  for (const relative of required) {
    const text = await readFile(join(SRC_ROOT, relative), "utf8");
    assert.ok(text.includes("AppTooltip"), `${relative} 应使用 AppTooltip 提供悬浮说明`);
  }
});

test("tooltip 延迟约 400ms，且 provider 只配置一次", async () => {
  assert.equal(TOOLTIP_DELAY_MS, 400);
  assert.ok(TOOLTIP_SKIP_DELAY_MS > 0 && TOOLTIP_SKIP_DELAY_MS <= TOOLTIP_DELAY_MS);

  const main = await readFile(join(SRC_ROOT, "main.ts"), "utf8");
  assert.ok(main.includes("TooltipProvider"), "TooltipProvider 必须在根节点提供上下文");
  assert.ok(main.includes("TOOLTIP_DELAY_MS"), "延迟参数只能来自 tooltipConfig.ts");

  const tooltip = await readFile(join(SRC_ROOT, "components", "AppTooltip.vue"), "utf8");
  assert.ok(tooltip.includes("TooltipTrigger"), "触发器必须是真实可聚焦元素（as-child）");
  assert.ok(tooltip.includes("as-child"), "asChild 保证 aria-describedby 落在真实按钮上");
  assert.ok(tooltip.includes("TooltipPortal"), "内容必须 portal 到 body，避免被 overflow 裁掉");

  const css = await readFile(join(SRC_ROOT, "styles", "base.css"), "utf8");
  assert.ok(css.includes(".soxu-tooltip"), "tooltip 呈现层样式必须走全局 token");
  assert.ok(
    css.includes("prefers-reduced-motion"),
    "prefers-reduced-motion 下必须关闭提示的入场动画",
  );
});

test("顶栏去掉品牌文案，最左是折叠按钮，其后是后退/前进", async () => {
  const app = await readFile(join(SRC_ROOT, "App.vue"), "utf8");
  const header = componentSection(app);

  assert.ok(!app.includes("多会话工作区"), "顶栏不应再出现「多会话工作区」");
  assert.ok(!app.includes("location-name"), "整块 .location 品牌区应删除");

  const sidebar = header.indexOf("PanelLeft");
  const back = header.indexOf("ChevronLeft");
  const forward = header.indexOf("ChevronRight");
  const inspector = header.indexOf("PanelRight");
  assert.ok(sidebar >= 0 && back > sidebar, "折叠按钮必须排在后退之前");
  assert.ok(forward > back, "后退在前、前进在后");
  assert.ok(inspector > forward, "检查器按钮仍在顶栏右侧");

  // 键盘可达性不回退：icon-button 一律保留 aria-label，禁用态由 disabled 表达。
  const labels = header.match(/aria-label=/g) ?? [];
  assert.ok(labels.length >= 4, "顶栏四个 icon-button 都必须有 aria-label");
  assert.ok(header.includes(':disabled="!backTarget"'), "历史为空时后退必须禁用");
  assert.ok(header.includes(':disabled="!forwardTarget"'), "前进到头时必须禁用");
  // 浏览器不给 disabled 按钮派发指针事件：提示必须挂在容器上，否则禁用态永远没有说明。
  assert.ok(header.includes("icon-button-frame"), "后退/前进的提示要挂在容器而不是 disabled 按钮上");
});

test("顶栏背景与页面同色，只保留 1px 分隔线", async () => {
  const app = await readFile(join(SRC_ROOT, "App.vue"), "utf8");
  const start = app.indexOf(".app-header {");
  assert.ok(start >= 0, "App.vue 必须定义 .app-header");
  const block = app.slice(start, app.indexOf("}", start));
  assert.ok(block.includes("background: var(--soxu-bg)"), "顶栏背景必须是 --soxu-bg（与 body 一致）");
  assert.ok(!block.includes("--soxu-sidebar"), "顶栏不得使用侧栏独立底色");
  assert.ok(block.includes("border-bottom: 1px solid var(--soxu-border)"), "只靠 1px 分隔线区分");
});

test("界面文本不可拖选，输入框与正文仍可复制", async () => {
  const css = await readFile(join(SRC_ROOT, "styles", "base.css"), "utf8");
  const shell = css.slice(css.indexOf(".app-shell {"));
  const shellBlock = shell.slice(0, shell.indexOf("}"));
  assert.ok(shellBlock.includes("user-select: none"), "整窗必须禁止拖选");

  for (const selector of ["textarea", "input", "pre", "code", ".soxu-selectable"]) {
    assert.ok(css.includes(selector), `可复制例外必须包含 ${selector}`);
  }

  const messages = await readFile(join(SRC_ROOT, "components", "MessageList.vue"), "utf8");
  assert.ok(messages.includes("soxu-selectable"), "会话正文容器必须显式放开选中");

  const all = await sources();
  const dragRegion = all.filter((file) => file.text.includes("data-tauri-drag-region"));
  assert.deepEqual(dragRegion.map((file) => file.path), [], "不允许把拖拽区域挂到非标题栏元素");
});

test("hover 动效统一走 token，并在 reduced-motion 下退化为纯颜色变化", async () => {
  const css = await readFile(join(SRC_ROOT, "styles", "base.css"), "utf8");
  for (const token of [
    "--soxu-motion-fast",
    "--soxu-motion-base",
    "--soxu-motion-ease",
    "--soxu-hover-scale",
  ]) {
    assert.ok(css.includes(token), `缺少动效 token ${token}`);
  }

  assert.ok(
    css.includes("transform: scale(var(--soxu-hover-scale))"),
    "icon-button 的 hover 缩放必须引用 token",
  );
  assert.ok(
    css.includes("text-decoration-color: currentColor"),
    "link-button hover 必须下划线渐现",
  );

  const reduce = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
  assert.ok(reduce.includes("--soxu-hover-scale: 1"), "reduced-motion 下缩放必须退化为 1");
});
