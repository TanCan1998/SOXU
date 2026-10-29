import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Issue #100：三个互相独立的交互小修。这里断言的是源码结构（构建期事实），
// 视觉结果由 docs/development/evidence/issue-100-desktop-polish 的截图佐证。

const SRC_ROOT = fileURLToPath(new URL("../src", import.meta.url));
const APP = join(SRC_ROOT, "App.vue");
const INSPECTOR = join(SRC_ROOT, "components", "RuntimeInspector.vue");
const SIDEBAR = join(SRC_ROOT, "components", "ProjectSidebar.vue");

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

/** 取出一段源码；标记缺失直接失败，避免 indexOf 的 -1 被当成「已删除」蒙混过关。 */
function slice(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  assert.ok(from >= 0, `源码缺少起始标记：${start}`);
  const to = text.indexOf(end, from);
  assert.ok(to > from, `源码缺少结束标记：${end}`);
  return text.slice(from, to);
}

test("会话状态面板内不再有第二个关闭入口，顶栏 PanelRight 是唯一开关", async () => {
  const inspector = await readFile(INSPECTOR, "utf8");

  assert.ok(!inspector.includes("关闭会话状态面板"), "面板内不应再有「关闭会话状态面板」按钮");
  assert.ok(!inspector.includes("<X "), "X（关闭）图标不再渲染");
  assert.ok(!inspector.includes("emit(\"close\")"), "面板不再向上派发 close 事件");

  const emits = slice(inspector, "defineEmits<{", "}>();");
  assert.ok(!emits.includes('"close"'), "defineEmits 里不应再声明 close");

  const app = await readFile(APP, "utf8");
  assert.ok(
    !app.includes('@close="inspectorOpen = false"'),
    "App.vue 不应再监听面板的 close（否则等于保留第二条关闭路径）",
  );

  const header = slice(app, "<header", "</header>");
  assert.ok(header.includes("PanelRight"), "顶栏右侧保留 PanelRight 切换按钮");
  assert.ok(header.includes('aria-keyshortcuts="Control+I"'), "Ctrl+I 快捷键声明保留");
  assert.ok(
    header.includes("inspectorOpen = !inspectorOpen"),
    "顶栏按钮必须能开关面板",
  );
  assert.ok(
    app.includes("inspectorOpen.value = !inspectorOpen.value"),
    "Ctrl+I 键盘处理仍能开关面板",
  );
});

test("「添加项目」改为按钮：点击直接开系统目录选择器，没有手输路径输入框", async () => {
  const app = await readFile(APP, "utf8");
  const sidebar = await readFile(SIDEBAR, "utf8");

  for (const [name, text] of [
    ["App.vue", app],
    ["ProjectSidebar.vue", sidebar],
  ] as const) {
    assert.ok(!text.includes("例如 F:"), `${name} 不应再出现示例路径占位文案`);
    assert.ok(!text.includes("rootPath"), `${name} 不应再保留手输路径状态`);
    assert.ok(
      text.includes("useProjectDirectoryPick"),
      `${name} 的添加项目必须走同一个 composable`,
    );
    assert.ok(text.includes("pickError"), `${name} 必须保留选择器失败提示`);
  }

  const welcome = slice(app, '<section v-else class="welcome"', "</section>");
  assert.ok(!welcome.includes("<form"), "欢迎页不再有提交表单");
  assert.ok(welcome.includes('class="welcome-add"'), "欢迎页改为「添加项目」按钮");
  assert.ok(welcome.includes('@click="addProject"'), "点击按钮直接走选择器");
  assert.ok(welcome.includes("添加项目"), "按钮文案为「添加项目」");
  assert.ok(welcome.includes("<Plus"), "按钮带 + 图标");
  assert.ok(welcome.includes("pickProjectError"), "错误提示仍在欢迎页显示");

  const sidebarButton = slice(sidebar, 'class="add-project"', "</button>");
  assert.ok(sidebarButton.includes('@click="addProject"'), "侧栏入口同样是一次点击");
  assert.ok(sidebarButton.includes("添加项目目录"), "侧栏按钮文案保留「添加项目目录」");
  assert.ok(sidebarButton.includes("<Plus"), "侧栏按钮带 + 图标");
  assert.ok(sidebar.includes("pickError"), "侧栏保留选择器失败提示");

  // 取消必须无副作用：两个入口都只能在 pick 成功后才继续。
  const appHandler = slice(app, "async function addProject()", "\n}\n");
  assert.ok(appHandler.includes("await pickProjectDirectory()"), "主区入口调用系统选择器");
  assert.ok(appHandler.includes("if (!picked) return;"), "取消/不可用时直接返回");
  assert.ok(appHandler.indexOf("if (!picked) return;") < appHandler.indexOf("store.addProject"));
  assert.ok(appHandler.includes("store.addProject(picked)"), "选中的路径才进入登记流程");

  const sidebarHandler = slice(sidebar, "async function addProject()", "\n}\n");
  assert.ok(sidebarHandler.includes("await pick()"), "侧栏入口调用同一个 composable");
  assert.ok(sidebarHandler.includes("if (!picked) return;"), "取消/不可用时直接返回");
  assert.ok(
    sidebarHandler.indexOf("if (!picked) return;") <
      sidebarHandler.indexOf('emit("add-project"'),
    "未选中路径时不得 emit 登记",
  );
});

test("「临时会话」按钮换成虚线对话气泡图标，文案与快捷键提示不变", async () => {
  const sidebar = await readFile(SIDEBAR, "utf8");
  assert.ok(sidebar.includes("MessageSquareDashed"), "必须引入 MessageSquareDashed");

  const button = slice(sidebar, 'class="new-session"', "</button>");
  assert.ok(button.includes("<MessageSquareDashed"), "按钮图标换成虚线对话气泡");
  assert.ok(!button.includes("<Plus"), "按钮不再使用 Plus 图标");
  assert.ok(button.includes("临时会话"), "按钮文案保持不变");
  assert.ok(button.includes("Ctrl K"), "快捷键提示保持不变");
  assert.ok(button.includes("new-temporary"), "点击行为保持不变");
});

test("全量界面源码不再残留手输路径示例", async () => {
  const all = await sources();
  const offenders = all
    .filter((file) => file.text.includes("例如 F:") || file.text.includes("soxu-welcome-root"))
    .map((file) => file.path);
  assert.deepEqual(offenders, [], "添加项目只走系统目录选择器，手输路径示例必须归零");
});
