import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Issue #101：逐个确认「关闭 / 退出」语义的按钮都不是死按钮。
//
// 这里断言的是源码结构（构建期事实）：每个带关闭语义的按钮都必须有点击处理、
// 有无障碍名称、且不能是 disabled；每个声明了 close 事件的子组件都必须在 App.vue
// 里被接上。真实点击验证见 docs/development/evidence/issue-101-close-feedback。

const SRC_ROOT = fileURLToPath(new URL("../src", import.meta.url));
const CLOSE_SEMANTICS = /关闭|退出/;
const BUTTON_TAG = /<button\b[^>]*>/g;

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

/** 从 `<ComponentName` 起截到自闭合的 `/>`：App.vue 里每个子组件的属性块。 */
function componentTag(app: string, name: string): string {
  const start = app.indexOf(`<${name}`);
  assert.ok(start >= 0, `App.vue 必须渲染 <${name}>`);
  const end = app.indexOf("/>", start);
  assert.ok(end > start, `App.vue 的 <${name}> 必须以自闭合标签结束`);
  return app.slice(start, end);
}

test("每个关闭语义按钮都有点击处理，且不是 disabled", async () => {
  const all = await sources();
  const closeButtons: Array<{ path: string; tag: string }> = [];
  for (const file of all) {
    for (const tag of file.text.match(BUTTON_TAG) ?? []) {
      if (CLOSE_SEMANTICS.test(tag)) closeButtons.push({ path: file.path, tag });
    }
  }

  // 至少要有顶栏检查器、设置、工作树、会话状态面板、Tab 五处关闭入口；
  // 数量掉下来说明某处关闭入口被删了，而不是「刚好没写关闭二字」。
  assert.ok(closeButtons.length >= 5, `关闭语义按钮至少 5 个，实际 ${closeButtons.length}`);

  for (const { path, tag } of closeButtons) {
    assert.match(tag, /@click/, `${path} 的关闭按钮必须有 @click：${tag}`);
    assert.match(tag, /:?aria-label=/, `${path} 的关闭按钮必须有 aria-label：${tag}`);
    // disabled 的关闭按钮在浏览器里不派发点击，等价于死按钮。
    assert.doesNotMatch(tag, /:?disabled=/, `${path} 的关闭按钮不能是 disabled：${tag}`);
    // 表单内的按钮不写 type 会变成 submit，点下去提交表单而不是关闭。
    assert.match(tag, /type="button"/, `${path} 的关闭按钮必须显式 type="button"：${tag}`);
  }
});

test("声明了 close 事件的子组件都在 App.vue 里接上了", async () => {
  const app = await readFile(join(SRC_ROOT, "App.vue"), "utf8");
  const components = ["SessionTabs", "RuntimeInspector", "SettingsDialog", "WorktreeDialog"];

  for (const name of components) {
    const source = await readFile(join(SRC_ROOT, "components", `${name}.vue`), "utf8");
    // close 事件可以带载荷（SessionTabs 传 sessionId），所以只断言事件名。
    assert.match(
      source,
      /\(event:\s*"close"/,
      `${name} 必须声明 close 事件（关闭入口由上层统一处理）`,
    );
    assert.match(
      componentTag(app, name),
      /@close=/,
      `App.vue 必须处理 <${name}> 的 close 事件，否则关闭按钮点了没有任何效果`,
    );
  }
});

test("App.vue 的 close 处理真的改了状态，而不是空函数", async () => {
  const app = await readFile(join(SRC_ROOT, "App.vue"), "utf8");

  // 设置 / 工作树 / 会话状态面板 / Tab：四种关闭分别落到不同的状态上。
  assert.match(componentTag(app, "SettingsDialog"), /@close="settingsOpen = false"/);
  assert.match(componentTag(app, "WorktreeDialog"), /@close="closeWorktrees"/);
  assert.match(componentTag(app, "RuntimeInspector"), /@close="inspectorOpen = false"/);
  assert.match(componentTag(app, "SessionTabs"), /@close="closeTab"/);

  // 处理函数本身必须落到 store 或状态上，不能是空实现。
  assert.match(app, /function closeWorktrees\(\) \{\s*worktreeProjectId\.value = null;/);
  assert.match(app, /function closeTab\(sessionId: SessionId\) \{\s*void store\.closeTab\(sessionId\);/);
});

test("对话框除 × 之外还有遮罩点击与 Escape 两条关闭路径", async () => {
  for (const name of ["SettingsDialog", "WorktreeDialog"]) {
    const source = await readFile(join(SRC_ROOT, "components", `${name}.vue`), "utf8");
    assert.ok(source.includes("@click.self=\"emit('close')\""), `${name} 需要遮罩点击关闭`);
    // 写法有「等于才关」和「不等于就返回」两种，只断言真的在判 Escape。
    assert.match(source, /event\.key\s*[!=]==\s*"Escape"/, `${name} 需要 Escape 关闭`);
    assert.ok(source.includes('emit("close")'), `${name} 的 Escape 分支必须真的关闭`);
  }
});

test("Tab 的关闭按钮不会被拖拽排序吞掉", async () => {
  const tabs = await readFile(join(SRC_ROOT, "components", "SessionTabs.vue"), "utf8");
  assert.ok(
    tabs.includes('@click="emit(\'close\', tab.sessionId)"'),
    "Tab 关闭按钮必须直接派发 close",
  );
  // Delete 键是键盘用户的等价入口，也必须能关闭。
  assert.ok(tabs.includes('event.key === "Delete"'), "Tab 必须支持 Delete 关闭");

  const drag = await readFile(join(SRC_ROOT, "composables", "useTabDrag.ts"), "utf8");
  // 关闭按钮不是拖拽把手：不排除的话按下会先进入拖拽，随后的 click 被当成拖拽余波吞掉，
  // 表现就是「Tab 的 × 点了没反应」。
  assert.ok(
    drag.includes('.closest(".tab-close")'),
    "拖拽状态机必须排除 .tab-close，否则关闭按钮会被点击抑制吞掉",
  );
});
