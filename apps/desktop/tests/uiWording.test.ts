import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Issue #89：界面文案不得暴露实现术语，只能展示使用者能理解的状态。
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
  assert.ok(app.includes("已连接"), "顶部栏仍需一眼可见的连接状态");

  const settings = await readFile(join(SRC_ROOT, "components", "SettingsDialog.vue"), "utf8");
  assert.ok(settings.includes("关于"), "版本信息收进「设置 → 关于」");
  assert.ok(settings.includes("appVersion"), "「关于」保留版本信息");
  assert.ok(settings.includes("连接状态"), "连接状态用状态表述，不写技术栈名词");
});
