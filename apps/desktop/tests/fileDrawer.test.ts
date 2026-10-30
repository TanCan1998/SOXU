/**
 * 文件抽屉回归测试（Issue #120 / TASK-028）：懒加载、排序、树形/平铺、只读预览与写操作确认。
 *
 * 全部通过 `FakeBridge` 驱动真实的 `FileBrowser`：不启动 Tauri、不写磁盘，
 * 断言的是「界面会看到什么」与「什么时候真的发请求」。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { reactive } from "vue";

import {
  FileBrowser,
  buildRows,
  fileLanguage,
  formatFileSize,
  joinPath,
  parentPath,
  sortEntries,
} from "../src/workspace/filesWorkspace.ts";
import {
  createWorkspaceState,
  type FileBrowserState,
  type FileEntry,
  type WorkspaceState,
} from "../src/workspace/types.ts";
import { FakeBridge, deferred } from "./support/fakeBridge.ts";

function entry(path: string, overrides: Partial<FileEntry> = {}): FileEntry {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return {
    path,
    name,
    kind: "file",
    size: 0,
    modifiedAtMs: 1,
    hidden: false,
    symlink: false,
    ...overrides,
  };
}

function dir(path: string): FileEntry {
  return entry(path, { kind: "dir" });
}

function fixture(): { bridge: FakeBridge; browser: FileBrowser; state: WorkspaceState } {
  const state = reactive(createWorkspaceState()) as WorkspaceState;
  const bridge = new FakeBridge();
  bridge.setDirectory("", [
    dir("src"),
    entry("README.md", { size: 1200, modifiedAtMs: 30 }),
    entry("a.md", { size: 10, modifiedAtMs: 10 }),
    entry(".env.example", { hidden: true, size: 5 }),
  ]);
  bridge.setDirectory("src", [
    entry("src/main.ts", { size: 900, modifiedAtMs: 20 }),
    dir("src/deep"),
  ]);
  bridge.setDirectory("src/deep", [entry("src/deep/x.ts", { size: 1 })]);
  bridge.fileContents.set("README.md", "# 项目\n");
  const browser = new FileBrowser(bridge, state);
  return { bridge, browser, state };
}

test("打开面板只读根目录一层，子目录要展开才读", async () => {
  const { bridge, browser } = fixture();
  await browser.open("prj_1");

  assert.equal(bridge.count("listDir"), 1, "打开抽屉只发一次目录请求");
  assert.deepEqual(bridge.callsOf("listDir")[0].args, ["prj_1", ""]);
  assert.equal(bridge.count("readFile"), 0, "打开抽屉不读任何文件内容");

  // 根层里能看到 src，但 src 的子层还没读。
  const rows = browser.rows();
  assert.deepEqual(
    rows.map((row) => row.path),
    [".env.example", "src", "a.md", "README.md"].filter((path) => path !== ".env.example"),
    "隐藏项默认不显示；目录排在文件前面",
  );

  // 展开 src：此时才发第二次请求。
  await browser.toggle("src");
  assert.equal(bridge.count("listDir"), 2);
  assert.deepEqual(bridge.callsOf("listDir")[1].args, ["prj_1", "src"]);
  const expandedRows = browser.rows();
  assert.deepEqual(
    expandedRows.map((row) => row.path),
    ["src", "src/deep", "src/main.ts", "a.md", "README.md"],
  );

  // 收起再展开不重复请求（已加载的层不再发）。
  browser.collapse("src");
  await browser.toggle("src");
  assert.equal(bridge.count("listDir"), 2, "已加载的目录层不会重复请求");

  // 未展开的孙目录不会被读取：整棵树只读了 2 层。
  assert.equal(bridge.count("listDir"), 2, "懒加载：不一次性读全盘");
});

test("排序按名称/时间/大小，目录永远在前", () => {
  const entries = [
    entry("b.md", { size: 200, modifiedAtMs: 5 }),
    dir("zdir"),
    entry("a.md", { size: 100, modifiedAtMs: 9 }),
    dir("adir"),
  ];
  assert.deepEqual(
    sortEntries(entries, "name", "asc").map((item) => item.name),
    ["adir", "zdir", "a.md", "b.md"],
  );
  assert.deepEqual(
    sortEntries(entries, "name", "desc").map((item) => item.name),
    ["zdir", "adir", "b.md", "a.md"],
    "降序时目录仍然在前，只是目录组内部也倒序",
  );
  // 目录之间同键相等时保持原有相对顺序（稳定排序），不额外打乱。
  assert.deepEqual(
    sortEntries(entries, "size", "asc").map((item) => item.name),
    ["zdir", "adir", "a.md", "b.md"],
  );
  assert.deepEqual(
    sortEntries(entries, "time", "desc").map((item) => item.name),
    ["zdir", "adir", "a.md", "b.md"],
  );
});

test("再次点击同一个排序键翻转方向，切换键回到升序", () => {
  const { browser } = fixture();
  assert.equal(browser.view.sort, "name");
  assert.equal(browser.view.direction, "asc");
  browser.setSort("name");
  assert.equal(browser.view.direction, "desc", "再点同一个键翻转方向");
  browser.setSort("size");
  assert.equal(browser.view.sort, "size");
  assert.equal(browser.view.direction, "asc", "换键回到升序");
});

test("平铺视图只展示已加载的条目，不凭空读盘", async () => {
  const { bridge, browser } = fixture();
  await browser.open("prj_1");
  browser.setView("flat");
  assert.deepEqual(
    browser.rows().map((row) => row.path),
    ["src", "a.md", "README.md"],
    "未展开的 src 子层不会出现在平铺里",
  );
  await browser.toggle("src");
  const flat = browser.rows();
  assert.ok(
    flat.some((row) => row.path === "src/main.ts"),
    "展开后才进入平铺列表",
  );
  const nested = flat.find((row) => row.path === "src/main.ts");
  assert.equal(nested?.name, "src/main.ts", "平铺用完整相对路径做标签，不靠缩进层级");
  assert.equal(nested?.depth, 0, "平铺没有层级缩进");
  assert.equal(bridge.count("listDir"), 2);
});

test("点击文件只读预览，迟到响应按序号丢弃", async () => {
  const { bridge, browser } = fixture();
  await browser.open("prj_1");

  const gate = deferred();
  bridge.fileReadGate = gate.promise;
  const first = browser.select("README.md");
  // 还没返回就切到另一个文件：第一个响应必须被丢弃。
  bridge.fileReadGate = null;
  bridge.fileContents.set("a.md", "a 内容\n");
  await browser.select("a.md");
  gate.resolve();
  await first;

  assert.equal(browser.view.selectedPath, "a.md");
  assert.equal(browser.view.preview?.content?.text, "a 内容\n");
  assert.equal(browser.view.preview?.error, null);
  assert.equal(bridge.count("readFile"), 2);
  assert.equal(bridge.count("writeFile"), 0, "预览绝不写盘");
  assert.equal(bridge.count("createFile"), 0);
});

test("预览失败只写错误，不污染树与选中之外的层", async () => {
  const { bridge, browser } = fixture();
  await browser.open("prj_1");
  bridge.fileReadError = "E_FILES_PATH_MISSING: 路径不存在或不可访问";
  await browser.select("README.md");
  assert.match(browser.view.preview?.error ?? "", /E_FILES_PATH_MISSING/);
  assert.equal(browser.view.preview?.content, null);
  assert.ok(browser.rows().length > 0, "目录树保持原样");
});

test("新建文件后刷新父目录并展开它", async () => {
  const { bridge, browser } = fixture();
  await browser.open("prj_1");
  await browser.createFile("src/new.ts");
  assert.deepEqual(bridge.callsOf("createFile")[0].args, ["prj_1", "src/new.ts", null]);
  assert.equal(browser.view.expanded["src"], true, "新建后展开目标目录");
  assert.equal(bridge.count("listDir"), 2, "只重读被改动的 src 一层");
});

test("重命名刷新源与目标的父目录，并清掉旧预览", async () => {
  const { bridge, browser } = fixture();
  await browser.open("prj_1");
  await browser.select("README.md");
  await browser.rename("README.md", "docs/README.md");
  assert.deepEqual(bridge.callsOf("renamePath")[0].args, ["prj_1", "README.md", "docs/README.md"]);
  assert.equal(browser.view.selectedPath, null, "旧路径的预览必须清掉");
  assert.equal(browser.view.preview, null);
  const refreshed = bridge.callsOf("listDir").map((call) => call.args[1]);
  assert.ok(refreshed.includes(""), "刷新源父目录");
  assert.ok(refreshed.includes("docs"), "刷新目标父目录");
});

test("删除必须传入与目标同名的确认串", async () => {
  const { bridge, browser } = fixture();
  await browser.open("prj_1");

  const rejected = await browser.remove("README.md", { confirmName: "" });
  assert.equal(rejected, false);
  assert.equal(bridge.count("deletePath"), 0, "确认串不匹配时不发请求");
  assert.match(browser.view.error ?? "", /E_FILES_CONFIRM_MISMATCH/);

  const ok = await browser.remove("README.md", { confirmName: "README.md" });
  assert.equal(ok, true);
  assert.deepEqual(bridge.callsOf("deletePath")[0].args, [
    "prj_1",
    "README.md",
    { recursive: false, confirmName: "README.md" },
  ]);
  assert.deepEqual(bridge.deletedPaths, ["README.md"]);
});

test("写操作进行中会置 mutating，结束后复位", async () => {
  const { bridge, browser } = fixture();
  await browser.open("prj_1");
  const gate = deferred();
  bridge.fileMutationGate = gate.promise;
  const pending = browser.remove("README.md", { confirmName: "README.md" });
  assert.equal(browser.view.mutating, true);
  gate.resolve();
  await pending;
  assert.equal(browser.view.mutating, false);
});

test("搜索：空查询清空结果不发请求，有结果时写回状态", async () => {
  const { bridge, browser } = fixture();
  await browser.open("prj_1");
  await browser.search("   ");
  assert.equal(bridge.count("searchFiles"), 0);
  assert.equal(browser.view.search, null);

  const result = await browser.search("项目");
  assert.equal(bridge.count("searchFiles"), 1);
  assert.equal(result?.hits.length, 1);
  assert.equal(browser.view.search?.result?.hits[0].path, "README.md");
});

test("切项目清空旧树，卸载后不再写状态", async () => {
  const { bridge, browser, state } = fixture();
  await browser.open("prj_1");
  assert.ok(browser.rows().length > 0);

  // 换项目时后端内容也不同：新项目的根目录是空的。
  bridge.directories.clear();
  await browser.open("prj_2");
  assert.equal(browser.view.projectId, "prj_2");
  assert.deepEqual(browser.view.directories[""]?.entries, [], "切项目后不展示上一个项目的条目");
  assert.equal(bridge.count("listDir"), 2, "切项目会重新读一次根目录");

  browser.dispose();
  assert.equal(browser.isDisposed, true);
  assert.equal(state.files.preview, null);
  await browser.toggle("src");
  assert.equal(browser.view.expanded["src"], undefined, "卸载后 toggle 不再改状态");
});

test("路径工具与语言识别", () => {
  assert.equal(joinPath("", "a.md"), "a.md");
  assert.equal(joinPath("src", "a.md"), "src/a.md");
  assert.equal(parentPath("src/a.md"), "src");
  assert.equal(parentPath("a.md"), "", "根目录的父目录仍是根目录");
  assert.equal(fileLanguage("main.ts"), "ts");
  assert.equal(fileLanguage("README.md"), "markdown");
  assert.equal(fileLanguage("Makefile"), null, "没有扩展名就是纯文本");
  assert.equal(fileLanguage("weird.zzz"), null, "白名单外的扩展名不加载语言包");
  assert.equal(formatFileSize(0), "0 B");
  assert.equal(formatFileSize(2048), "2.0 KB");
  assert.equal(formatFileSize(1024 * 1024 * 3), "3.0 MB");
});

test("隐藏项开关只影响渲染，不重新请求", async () => {
  const { bridge, browser } = fixture();
  await browser.open("prj_1");
  const before = browser.rows().length;
  browser.setShowHidden(true);
  assert.equal(browser.rows().length, before + 1);
  assert.equal(bridge.count("listDir"), 1, "显示隐藏项不需要重新读盘");
});

test("buildRows 对未加载的根目录返回空列表", () => {
  const empty: FileBrowserState = {
    ...createWorkspaceState().files,
  };
  assert.deepEqual(buildRows(empty), []);
});
