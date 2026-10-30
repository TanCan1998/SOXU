/**
 * Issue #120 的 DOM 夹具：把真正的 FileDrawer 挂到浏览器里，用确定性假数据验证
 * 「目录树懒加载 + 排序 + 树形/平铺 + 只读预览 + 删除确认」的视觉与行为。
 *
 * 只在 pnpm dev 的本地开发服务器里使用，不参与生产构建，也不连接真实文件系统：
 * - 目录树是内存里的 3 层结构（根 / src / src/components），点开才「读」下一层；
 * - 「后端」是 FakeBridge：listDir/readFile 返回固定内容，写操作只记录调用；
 * - 交互逻辑全部走生产代码的 FileBrowser，夹具不重写被测逻辑。
 *
 * 截图脚本可以调用 window.__fileDrawer 上的方法驱动状态（见同目录 README）。
 */

import { createApp, h, reactive } from "vue";
import { TooltipProvider } from "reka-ui";

import "../../src/styles/tokens.css";
import "../../src/styles/base.css";
import FileDrawer from "../../src/components/FileDrawer.vue";
import { FileBrowser } from "../../src/workspace/filesWorkspace.ts";
import { createWorkspaceState } from "../../src/workspace/types.ts";
import { FakeBridge } from "../support/fakeBridge.ts";

function file(path: string, size: number, modifiedAtMs: number) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return { path, name, kind: "file" as const, size, modifiedAtMs, hidden: false, symlink: false };
}

function dir(path: string) {
  return {
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    kind: "dir" as const,
    size: 0,
    modifiedAtMs: 1,
    hidden: false,
    symlink: false,
  };
}

const bridge = new FakeBridge();
bridge.setDirectory("", [
  dir("src"),
  dir("docs"),
  file("README.md", 4821, 1_760_000_000_000),
  file("package.json", 1204, 1_759_900_000_000),
  { ...file(".env.example", 128, 1_759_800_000_000), hidden: true },
]);
bridge.setDirectory("src", [
  dir("src/components"),
  file("src/main.ts", 903, 1_760_100_000_000),
  file("src/App.vue", 29_543, 1_760_050_000_000),
]);
bridge.setDirectory("src/components", [file("src/components/FileDrawer.vue", 24_600, 1_760_200_000_000)]);
bridge.setDirectory("docs", [file("docs/prd.md", 9_800, 1_759_000_000_000)]);
bridge.fileContents.set(
  "src/main.ts",
  [
    "import { createApp } from \"vue\";",
    "import { createPinia } from \"pinia\";",
    "",
    "import App from \"./App.vue\";",
    "",
    "// 夹具里的示例文件：用来验证只读预览的语法高亮",
    "createApp(App).use(createPinia()).mount(\"#app\");",
    "",
  ].join("\n"),
);
bridge.fileContents.set("README.md", "# SOXU · 索序\n\n面向 Pi Agent 的轻量桌面工作台。\n");

const state = reactive(createWorkspaceState());
const browser = new FileBrowser(bridge, state);

const events = {
  close: () => undefined,
  refresh: () => void browser.refresh(),
  toggle: (path: string) => void browser.toggle(path),
  sort: (key: "name" | "time" | "size") => browser.setSort(key),
  view: (mode: "tree" | "flat") => browser.setView(mode),
  "show-hidden": (value: boolean) => browser.setShowHidden(value),
  select: (path: string) => void browser.select(path),
  "close-preview": () => browser.clearPreview(),
  search: (query: string) => void browser.search(query),
  "clear-search": () => browser.clearSearch(),
  create: (path: string) => void browser.createFile(path),
  rename: (from: string, to: string) => void browser.rename(from, to),
  remove: (path: string, options: { recursive: boolean; confirmName: string }) =>
    void browser.remove(path, options),
};

const app = createApp({
  setup() {
    return () =>
      h(TooltipProvider, { delayDuration: 400 }, () =>
        h("div", { class: "harness-stage" }, [
          h("main", { class: "harness-main" }, [
            h("h1", "SOXU · Issue #120 文件抽屉夹具"),
            h("p", "左侧是占位的会话区；右侧是被测的真实 FileDrawer 组件。"),
          ]),
          h(FileDrawer, {
            view: state.files,
            rows: browser.rows(),
            bridgeAvailable: true,
            projectName: "soxu",
            onClose: events.close,
            onRefresh: events.refresh,
            onToggle: events.toggle,
            onSort: events.sort,
            onView: events.view,
            onShowHidden: events["show-hidden"],
            onSelect: events.select,
            onClosePreview: events["close-preview"],
            onSearch: events.search,
            onClearSearch: events["clear-search"],
            onCreate: events.create,
            onRename: events.rename,
            onRemove: events.remove,
          }),
        ]),
      );
  },
});

app.mount("#app");
void browser.open("prj_harness");

/** 截图脚本用的钩子：只暴露夹具状态，不改变生产代码的行为。 */
Object.defineProperty(window, "__fileDrawer", {
  value: {
    browser,
    state,
    async openFile(path: string) {
      await browser.select(path);
    },
    async expand(path: string) {
      await browser.toggle(path);
    },
    setTheme(theme: "light" | "dark") {
      document.documentElement.dataset.theme = theme;
    },
  },
});
