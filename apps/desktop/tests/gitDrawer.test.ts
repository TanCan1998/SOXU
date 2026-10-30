/**
 * Git 抽屉回归测试（Issue #121 · TASK-029）。
 *
 * 全部通过 FakeBridge 驱动真实的 GitWorkspace，不启动 git、不写磁盘。
 * 覆盖：更改列表加载与迟到响应丢弃、单文件 diff 的暂存区选择、
 * 暂存/提交/推送/拉取的错误路径、树形分组、diff 行号对齐与 shiki 管线复用。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { reactive } from "vue";

import {
  MAX_RENDERED_DIFF_ROWS,
  diffRows,
  highlightDiffLines,
  visibleDiffRows,
  withHighlight,
} from "../src/components/gitDiff.ts";
import { GitWorkspace } from "../src/workspace/gitWorkspace.ts";
import {
  allDirectoryPaths,
  buildGitTree,
  flatRows,
  treeRows,
} from "../src/workspace/gitTree.ts";
import { createWorkspaceState, type GitChangeFile } from "../src/workspace/types.ts";
import {
  FakeBridge,
  deferred,
  sampleGitChange,
  sampleGitStatus,
} from "./support/fakeBridge.ts";

const SRC_ROOT = new URL("../src/", import.meta.url);

async function source(relative: string): Promise<string> {
  return readFile(new URL(relative, SRC_ROOT), "utf8");
}

function harness(): { bridge: FakeBridge; git: GitWorkspace; state: ReturnType<typeof createWorkspaceState> } {
  const state = reactive(createWorkspaceState());
  const bridge = new FakeBridge();
  return { bridge, git: new GitWorkspace(bridge, state), state };
}

const PATCH = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,3 @@",
  " const keep = 1;",
  "-const old = 2;",
  "+const fresh = 2;",
  " export {};",
  "",
].join("\n");

test("打开面板读取更改列表，并保留用户选择的布局", async () => {
  const { bridge, git, state } = harness();
  bridge.gitStatusView = sampleGitStatus({
    files: [
      sampleGitChange({ path: "src/a.ts" }),
      sampleGitChange({ path: "docs/b.md", status: "A", untracked: true, added: null, removed: null }),
    ],
  });

  await git.open("prj_1", null);
  assert.equal(bridge.count("gitStatus"), 1);
  assert.deepEqual(bridge.callsOf("gitStatus")[0]?.args, ["prj_1", null]);
  assert.equal(state.git.status?.files.length, 2);
  assert.equal(state.git.root, "F:/work/project");
  assert.equal(state.git.loading, false);

  git.setLayout("flat");
  // 切换项目时清空旧仓库的改动，但布局属于用户偏好，跨项目保留。
  await git.open("prj_2", "wkt_2");
  assert.equal(state.git.projectId, "prj_2");
  assert.equal(state.git.worktreeId, "wkt_2");
  assert.equal(state.git.layout, "flat");
  assert.deepEqual(bridge.callsOf("gitStatus")[1]?.args, ["prj_2", "wkt_2"]);
});

test("切换项目后，旧项目的迟到响应不会写回状态", async () => {
  const { bridge, git, state } = harness();
  const gate = deferred();
  bridge.gitStatusGate = gate.promise;

  const first = git.open("prj_1", null);
  const second = git.open("prj_2", null);
  gate.resolve();
  await Promise.all([first, second]);

  assert.equal(state.git.projectId, "prj_2", "只保留最后一次请求的结果");
  assert.equal(state.git.status?.projectId, "prj_2");
  assert.equal(state.git.loading, false);
});

test("点击文件展开 diff；再次点击收起", async () => {
  const { bridge, git, state } = harness();
  bridge.gitStatusView = sampleGitStatus({ files: [sampleGitChange({ path: "src/a.ts" })] });
  bridge.gitDiffs.set("src/a.ts", {
    path: "src/a.ts",
    staged: false,
    patch: PATCH,
    truncated: false,
    bytesRead: PATCH.length,
    added: 1,
    removed: 1,
    binary: false,
  });

  await git.open("prj_1", null);
  await git.select("src/a.ts");
  assert.equal(state.git.selectedPath, "src/a.ts");
  assert.equal(state.git.diff?.path, "src/a.ts");
  assert.equal(state.git.diffLoading, false);
  assert.deepEqual(bridge.callsOf("gitDiff")[0]?.args, ["prj_1", null, "src/a.ts", false]);

  await git.select("src/a.ts");
  assert.equal(state.git.selectedPath, null);
  assert.equal(state.git.diff, null);
  assert.equal(bridge.count("gitDiff"), 1, "收起不会重新请求 diff");
});

test("只有暂存改动的文件读取暂存区 diff", async () => {
  const { bridge, git, state } = harness();
  bridge.gitStatusView = sampleGitStatus({
    files: [sampleGitChange({ path: "src/a.ts", staged: true, unstaged: false })],
  });
  await git.open("prj_1", null);
  await git.select("src/a.ts");

  assert.deepEqual(bridge.callsOf("gitDiff")[0]?.args, ["prj_1", null, "src/a.ts", true]);
  assert.equal(state.git.diff?.staged, true);
});

test("收起或切换文件后，在途的 diff 结果被丢弃", async () => {
  const { bridge, git, state } = harness();
  bridge.gitStatusView = sampleGitStatus({
    files: [sampleGitChange({ path: "src/a.ts" }), sampleGitChange({ path: "src/b.ts" })],
  });
  await git.open("prj_1", null);

  const gate = deferred();
  bridge.gitDiffGate = gate.promise;
  const pending = git.select("src/a.ts");
  git.collapse();
  gate.resolve();
  await pending;

  assert.equal(state.git.selectedPath, null);
  assert.equal(state.git.diff, null, "迟到的补丁不得重新展开");
  assert.equal(state.git.diffLoading, false);
});

test("刷新后选中的文件消失时自动收起 diff", async () => {
  const { bridge, git, state } = harness();
  bridge.gitStatusView = sampleGitStatus({ files: [sampleGitChange({ path: "src/a.ts" })] });
  await git.open("prj_1", null);
  await git.select("src/a.ts");
  assert.ok(state.git.selectedPath);

  bridge.gitStatusView = sampleGitStatus({ files: [] });
  await git.reload();
  assert.equal(state.git.selectedPath, null);
  assert.equal(state.git.diff, null);
});

test("暂存后标记变化，已展开的 diff 自动收起", async () => {
  const { bridge, git, state } = harness();
  bridge.gitStatusView = sampleGitStatus({ files: [sampleGitChange({ path: "src/a.ts" })] });
  await git.open("prj_1", null);
  await git.select("src/a.ts");
  assert.equal(state.git.selectedPath, "src/a.ts");

  await git.stageAll();
  assert.equal(state.git.selectedPath, null, "暂存后补丁内容已变，必须收起");
  assert.equal(state.git.diff, null);
});

test("刷新但文件标记未变时保留已展开的 diff", async () => {
  const { bridge, git, state } = harness();
  bridge.gitStatusView = sampleGitStatus({ files: [sampleGitChange({ path: "src/a.ts" })] });
  await git.open("prj_1", null);
  await git.select("src/a.ts");

  await git.reload();
  assert.equal(state.git.selectedPath, "src/a.ts", "只是刷新列表不应该把补丁关掉");
  assert.ok(state.git.diff);
});

test("全部折叠收起所有目录与已展开的 diff", async () => {
  const { bridge, git, state } = harness();
  bridge.gitStatusView = sampleGitStatus({
    files: [
      sampleGitChange({ path: "src/a.ts" }),
      sampleGitChange({ path: "src/nested/b.ts" }),
    ],
  });
  await git.open("prj_1", null);
  await git.select("src/a.ts");

  assert.equal(treeRows(state.git.status?.files ?? [], []).length, 4, "目录 + 文件全部展开");
  git.collapseAll();
  assert.deepEqual(state.git.collapsedDirs.sort(), ["src", "src/nested"]);
  assert.equal(treeRows(state.git.status?.files ?? [], state.git.collapsedDirs).length, 1);
  assert.equal(state.git.selectedPath, null);
});

test("暂存全部：成功后写入最新状态并提示", async () => {
  const { bridge, git, state } = harness();
  bridge.gitStatusView = sampleGitStatus({ files: [sampleGitChange({ path: "src/a.ts" })] });
  await git.open("prj_1", null);

  assert.equal(await git.stageAll(), true);
  assert.deepEqual(bridge.callsOf("gitStage")[0]?.args, ["prj_1", null, []]);
  assert.equal(state.git.status?.files[0]?.staged, true);
  assert.equal(state.git.action, "idle");
  assert.match(state.git.actionNotice ?? "", /已暂存/);

  bridge.gitStageError = "E_GIT_INDEX_LOCKED: 索引被锁定";
  assert.equal(await git.stageAll(), false);
  assert.match(state.git.actionError ?? "", /E_GIT_INDEX_LOCKED/);
  assert.equal(state.git.action, "idle");
});

test("提交：空说明本地拦截，成功后清空输入并收起 diff", async () => {
  const { bridge, git, state } = harness();
  bridge.gitStatusView = sampleGitStatus({ files: [sampleGitChange({ path: "src/a.ts" })] });
  await git.open("prj_1", null);
  await git.select("src/a.ts");

  assert.equal(await git.commit(), false);
  assert.equal(bridge.count("gitCommit"), 0, "空说明不产生一次 IPC");
  assert.match(state.git.actionError ?? "", /E_GIT_COMMIT_MESSAGE_INVALID/);

  git.setCommitMessage("  feat: 抽屉  ");
  assert.equal(await git.commit(), true);
  assert.deepEqual(bridge.callsOf("gitCommit")[0]?.args, ["prj_1", null, "feat: 抽屉"]);
  assert.equal(state.git.commitMessage, "");
  assert.equal(state.git.selectedPath, null);
  assert.equal(state.git.status?.files.length, 0);
  assert.match(state.git.actionNotice ?? "", /0000000/);

  bridge.gitCommitError = "E_GIT_COMMAND_FAILED: 提交失败 (nothing to commit)";
  git.setCommitMessage("feat: 再来一次");
  assert.equal(await git.commit(), false);
  assert.match(state.git.actionError ?? "", /nothing to commit/);
  assert.equal(state.git.commitMessage, "feat: 再来一次", "失败时保留用户输入");
});

test("推送/拉取：成功后刷新领先落后，失败给出错误", async () => {
  const { bridge, git, state } = harness();
  bridge.gitStatusView = sampleGitStatus({ ahead: 2, behind: 1 });
  bridge.gitRemoteOutput = "To F:/remote.git\n   abc..def  main -> main";
  await git.open("prj_1", null);

  assert.equal(await git.push(), true);
  assert.equal(state.git.status?.ahead, 0);
  assert.match(state.git.actionNotice ?? "", /推送成功/);
  assert.match(state.git.actionNotice ?? "", /abc\.\.def/);

  assert.equal(await git.pull(), true);
  assert.equal(state.git.status?.behind, 0);
  assert.match(state.git.actionNotice ?? "", /拉取成功/);

  bridge.gitPushError = "E_GIT_COMMAND_FAILED: 推送失败 (fatal: no upstream branch)";
  assert.equal(await git.push(), false);
  assert.match(state.git.actionError ?? "", /推送失败/);
  assert.match(state.git.actionError ?? "", /no upstream/);
  assert.equal(state.git.action, "idle");
});

test("面板卸载后不再写状态", async () => {
  const { bridge, git, state } = harness();
  const gate = deferred();
  bridge.gitStatusGate = gate.promise;
  const pending = git.open("prj_1", null);
  git.dispose();
  gate.resolve();
  await pending;

  assert.equal(state.git.status, null);
  assert.equal(state.git.loading, false);
});

test("树形分组：目录在前、文件在后，目录汇总行数", () => {
  const files: GitChangeFile[] = [
    sampleGitChange({ path: "src/b.ts", added: 3, removed: 1 }),
    sampleGitChange({ path: "src/a.ts", added: 1, removed: 2 }),
    sampleGitChange({ path: "src/nested/c.ts", added: 5, removed: 0 }),
    sampleGitChange({ path: "README.md", status: "A", untracked: true, added: null, removed: null }),
  ];

  const rows = treeRows(files, []);
  assert.deepEqual(
    rows.map((row) => row.name),
    ["src", "nested", "c.ts", "a.ts", "b.ts", "README.md"],
  );
  const src = rows[0];
  assert.equal(src?.isDir, true);
  assert.equal(src?.count, 3);
  assert.equal(src?.added, 9);
  assert.equal(src?.removed, 3);
  assert.equal(rows[1]?.depth, 1);
  assert.equal(rows[3]?.depth, 1);

  const flat = flatRows(files);
  assert.deepEqual(
    flat.map((row) => row.name),
    ["src/b.ts", "src/a.ts", "src/nested/c.ts", "README.md"],
  );
  assert.equal(flat.every((row) => row.isDir === false), true);

  assert.deepEqual(allDirectoryPaths(files), ["src", "src/nested"]);
  assert.equal(treeRows(files, ["src"]).length, 2, "折叠 src 后只剩 src 与 README");
});

test("树形分组：顶层文件与深层目录混排时不丢行", () => {
  const files = [sampleGitChange({ path: "a/b/c/d.ts" })];
  const tree = buildGitTree(files);
  assert.equal(tree.length, 1);
  assert.equal(tree[0]?.name, "a");
  assert.equal(treeRows(files, []).length, 4, "a/b/c/d.ts = 3 层目录 + 1 个文件");
});

test("diff 行号与 git 补丁逐行对齐", () => {
  const rows = diffRows(PATCH);
  assert.deepEqual(
    rows.map((row) => row.kind),
    ["meta", "meta", "meta", "meta", "hunk", "context", "del", "add", "context"],
  );
  assert.deepEqual(
    rows.map((row) => [row.oldNumber, row.newNumber]),
    [
      [null, null],
      [null, null],
      [null, null],
      [null, null],
      [null, null],
      [1, 1],
      [2, null],
      [null, 2],
      [3, 3],
    ],
  );
  assert.equal(rows[6]?.text, "-const old = 2;");
  assert.equal(rows[7]?.text, "+const fresh = 2;");
});

test("diff 行号：多个 hunk 各自重置，无换行标记不推进行号", () => {
  const patch = [
    "@@ -1,1 +1,1 @@",
    "-a",
    "+b",
    "\\ No newline at end of file",
    "@@ -10,1 +10,1 @@",
    "-x",
    "+y",
  ].join("\n");
  const rows = diffRows(patch);
  assert.deepEqual(
    rows.map((row) => [row.kind, row.oldNumber, row.newNumber]),
    [
      ["hunk", null, null],
      ["del", 1, null],
      ["add", null, 1],
      ["note", null, null],
      ["hunk", null, null],
      ["del", 10, null],
      ["add", null, 10],
    ],
  );
});

test("diff 行号：CRLF 补丁不会错位", () => {
  const crlf = PATCH.replace(/\n/g, "\r\n");
  assert.deepEqual(diffRows(crlf), diffRows(PATCH));
});

test("高亮复用 S1 的 shiki 管线，行数与补丁一致", async () => {
  const lines = await highlightDiffLines(PATCH);
  assert.ok(lines, "diff 语言在白名单内，必须能高亮");
  assert.equal(lines.length, PATCH.split("\n").length, "shiki 行数与补丁行数一一对应");

  const rows = withHighlight(diffRows(PATCH), lines);
  assert.equal(rows.length, PATCH.split("\n").length - 1, "末尾换行不是一行");
  for (const [index, row] of rows.entries()) {
    assert.equal(row.html, lines[index], "第 " + index + " 行必须贴同一索引的高亮 HTML");
    assert.ok(row.html?.includes("<span"), "高亮结果应当是 shiki 的 span");
  }
  // 高亮失败时退回纯文本：html 为 null，但行号与文本仍然完整。
  const plain = withHighlight(diffRows(PATCH), null);
  assert.equal(plain.every((row) => row.html === null), true);
  assert.equal(plain.length, rows.length);
});

test("超大补丁只渲染前 N 行并如实报告剩余行数", () => {
  const rows = diffRows(PATCH);
  const many = Array.from({ length: MAX_RENDERED_DIFF_ROWS + 5 }, (_, index) => ({
    kind: "context" as const,
    oldNumber: index + 1,
    newNumber: index + 1,
    text: "line " + index,
    html: null,
  }));
  const visible = visibleDiffRows(many);
  assert.equal(visible.rows.length, MAX_RENDERED_DIFF_ROWS);
  assert.equal(visible.hidden, 5);
  assert.deepEqual(visibleDiffRows(rows), { rows, hidden: 0 });
});

test("抽屉复用 S1 高亮管线，且无障碍语义完整", async () => {
  const drawer = await source("components/GitDrawer.vue");
  assert.match(drawer, /from "\.\/GitDiffPanel\.vue"/, "抽屉必须把 diff 交给独立面板组件");
  assert.ok(!/from "shiki/.test(drawer), "抽屉不得自己加载 shiki（复用 S1 管线）");
  assert.ok(!/import\("shiki/.test(drawer), "抽屉不得动态 import shiki");
  for (const marker of ['aria-label="Git 面板"', "aria-expanded", 'role="alert"', "aria-busy"]) {
    assert.ok(drawer.includes(marker), "缺少无障碍语义：" + marker);
  }
  // 一次只展开一个文件 diff：展开状态来自 view.selectedPath，而不是每个文件各自一份。
  assert.ok(drawer.includes("isSelected(row.path)"));

  const diffModule = await source("components/gitDiff.ts");
  assert.match(diffModule, /from "\.\.\/markdown\/highlighter\.ts"/);
  assert.ok(!diffModule.includes('import("shiki'), "不得绕过 S1 直接 import shiki");

  // 单文件 diff 面板是唯一持有高亮状态的地方：只依赖 gitDiff.ts，不自己加载 shiki。
  const panel = await source("components/GitDiffPanel.vue");
  assert.match(panel, /from "\.\/gitDiff\.ts"/, "diff 面板必须复用共享模块");
  assert.ok(!/from "shiki/.test(panel), "diff 面板不得自己加载 shiki");
  assert.match(panel, /onUnmounted/, "异步高亮必须在卸载时作废");
  assert.match(panel, /aria-label="\{\{|:aria-label=/, "diff 区域需要有可读名称");
});

test("bridge 暴露全部 8 个 Git 命令", async () => {
  const bridge = await source("workspace/bridge.ts");
  for (const command of [
    "git_status",
    "git_diff",
    "git_log",
    "git_stage",
    "git_commit",
    "git_push",
    "git_pull",
    "git_branches",
  ]) {
    assert.ok(bridge.includes('"' + command + '"'), "bridge 缺少命令：" + command);
  }
});
