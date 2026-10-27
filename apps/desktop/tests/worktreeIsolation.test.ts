/**
 * 工作树集成回归测试：会话隔离、脏/锁工作树的删除拒绝、令牌失效后的恢复、
 * 创建失败与异常退出后的清理路径。
 *
 * 全部通过 `FakeBridge` 驱动真实的 `WorktreeCatalog` 与 `WorkspaceSession`，
 * 不启动 git、不写磁盘。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { reactive } from "vue";

import { WorkspaceSession } from "../src/workspace/sessionWorkspace.ts";
import { WorktreeCatalog, worktreeBadges } from "../src/workspace/worktreeWorkspace.ts";
import { createWorkspaceState, type ProjectSummary } from "../src/workspace/types.ts";
import { FakeBridge, deferred, sampleWorktree } from "./support/fakeBridge.ts";

function projectWithSessions(): ProjectSummary {
  return {
    id: "prj_1",
    name: "soxu",
    root: "F:/work/soxu",
    worktreeCount: 2,
    sessions: [
      {
        id: "ses_main",
        projectId: "prj_1",
        worktreeId: "wkt_main",
        title: "主工作树会话",
        fileName: "ses_main.jsonl",
        entryCount: 3,
        updatedAtMs: 2,
        missing: false,
        runtimeId: null,
        generation: 0,
      },
      {
        id: "ses_agent",
        projectId: "prj_1",
        worktreeId: "wkt_agent",
        title: "Agent 工作树会话",
        fileName: "ses_agent.jsonl",
        entryCount: 5,
        updatedAtMs: 1,
        missing: false,
        runtimeId: "ses_agent#1",
        generation: 1,
      },
    ],
  };
}

async function catalogWithBridge(): Promise<{
  bridge: FakeBridge;
  catalog: WorktreeCatalog;
  session: WorkspaceSession;
}> {
  const state = reactive(createWorkspaceState());
  const bridge = new FakeBridge();
  bridge.projects = [projectWithSessions()];
  bridge.worktreeList = [
    sampleWorktree({ id: "wkt_main", name: "soxu", branch: "main", primary: true, sessionIds: ["ses_main"] }),
    sampleWorktree({
      id: "wkt_agent",
      name: "issue-5",
      branch: "agent/issue-5",
      sessionIds: ["ses_agent"],
      activeSessionIds: ["ses_agent"],
      blockers: ["active_runtime"],
    }),
  ];
  const session = new WorkspaceSession(bridge, state);
  const catalog = new WorktreeCatalog(bridge, state);
  await session.loadProjects();
  return { bridge, catalog, session };
}

test("选择/刷新工作树不改写会话与 Tab 身份", async () => {
  const { bridge, catalog, session } = await catalogWithBridge();
  await session.openSession({
    sessionId: "ses_main",
    projectId: "prj_1",
    title: "主工作树会话",
    worktreeId: "wkt_main",
  });
  await session.openSession({
    sessionId: "ses_agent",
    projectId: "prj_1",
    title: "Agent 工作树会话",
    worktreeId: "wkt_agent",
  });
  await catalog.open("prj_1");
  assert.equal(catalog.view.selectedId, "wkt_main", "默认选中主工作树");
  catalog.select("wkt_agent");

  assert.equal(session.tab("ses_main")?.worktreeId, "wkt_main");
  assert.equal(session.tab("ses_agent")?.worktreeId, "wkt_agent");
  assert.equal(session.workspace.activeSessionId, "ses_agent", "active 会话只由 Tab 决定");
  assert.deepEqual(
    session.workspace.tabs.map((tab) => tab.sessionId),
    ["ses_main", "ses_agent"],
  );
  assert.equal(bridge.count("startRuntime"), 0, "选择工作树不得启动任何运行时");
  assert.equal(bridge.count("sendPrompt"), 0);
  assert.equal(bridge.count("removeWorktree"), 0);
  assert.deepEqual(
    catalog.sessionsFor("prj_1", "wkt_agent").map((item) => item.id),
    ["ses_agent"],
    "会话归属来自会话目录，不随选择漂移",
  );

  await session.dispose();
  catalog.dispose();
});

test("刷新后工作树消失只更新面板，不影响已打开的 Tab", async () => {
  const { bridge, catalog, session } = await catalogWithBridge();
  await session.openSession({
    sessionId: "ses_agent",
    projectId: "prj_1",
    title: "Agent 工作树会话",
    worktreeId: "wkt_agent",
  });
  await catalog.open("prj_1");
  catalog.select("wkt_agent");
  assert.equal(catalog.view.selectedId, "wkt_agent");

  bridge.worktreeList = [sampleWorktree({ id: "wkt_main", primary: true, branch: "main" })];
  await catalog.reload();

  assert.equal(catalog.view.selectedId, "wkt_main");
  assert.equal(session.tab("ses_agent")?.worktreeId, "wkt_agent");
  assert.equal(session.workspace.activeSessionId, "ses_agent");
  assert.equal(session.tab("ses_agent")?.status, "ready", "会话状态不因工作树消失而重置");

  await session.dispose();
  catalog.dispose();
});

test("脏工作树：计划被拒、确认不会调用删除、错误可读", async () => {
  const { bridge, catalog } = await catalogWithBridge();
  bridge.worktreeList = [
    sampleWorktree({
      id: "wkt_agent",
      dirty: true,
      staged: 1,
      unstaged: 2,
      untracked: 3,
      blockers: ["dirty"],
      removable: false,
    }),
  ];
  await catalog.open("prj_1");
  catalog.select("wkt_agent");

  const plan = await catalog.planRemoval("wkt_agent");
  assert.equal(plan?.removable, false);
  assert.deepEqual(plan?.blockers, ["dirty"]);
  assert.equal(await catalog.confirmRemoval(), false);
  assert.equal(bridge.count("removeWorktree"), 0, "脏工作树绝不能被删除");
  assert.match(catalog.view.pendingError ?? "", /dirty/);
  assert.match(catalog.view.pendingError ?? "", /未提交改动/);
  assert.equal(catalog.view.worktrees.length, 1, "拒绝后清单保持原样");

  catalog.dispose();
});

test("索引锁与冲突：徽标可见，删除被拦截", async () => {
  const { bridge, catalog } = await catalogWithBridge();
  const locked = sampleWorktree({
    id: "wkt_locked",
    conflicts: 2,
    indexLocked: true,
    operation: "merge",
    dirty: true,
    unstaged: 2,
    blockers: ["conflicted", "index_locked", "operation_in_progress"],
    removable: false,
  });
  bridge.worktreeList = [locked];
  await catalog.open("prj_1");
  catalog.select("wkt_locked");

  const codes = worktreeBadges(locked).map((badge) => badge.code);
  assert.deepEqual(codes.slice(0, 3), ["conflicted", "index_locked", "operation_in_progress"]);

  await catalog.planRemoval("wkt_locked");
  assert.equal(await catalog.confirmRemoval(), false);
  assert.equal(bridge.count("removeWorktree"), 0);
  assert.match(catalog.view.pendingError ?? "", /conflicted/);

  catalog.dispose();
});

test("无计划时确认删除不会触达后端（权限约束）", async () => {
  const { bridge, catalog } = await catalogWithBridge();
  await catalog.open("prj_1");

  assert.equal(await catalog.confirmRemoval(), false);
  assert.equal(bridge.count("removeWorktree"), 0);
  assert.match(catalog.view.pendingError ?? "", /E_GIT_CONFIRMATION_REQUIRED/);

  catalog.dispose();
});

test("干净工作树：令牌确认后删除，随后重新枚举", async () => {
  const { bridge, catalog } = await catalogWithBridge();
  await catalog.open("prj_1");
  catalog.select("wkt_agent");
  bridge.worktreeList = [sampleWorktree({ id: "wkt_agent" })];
  await catalog.reload();
  await catalog.planRemoval("wkt_agent");

  assert.equal(await catalog.confirmRemoval(), true);
  const call = bridge.callsOf("removeWorktree").at(-1);
  assert.deepEqual(call?.args, ["prj_1", "wkt_agent", "tok-wkt_agent"], "必须携带后端下发的令牌");
  assert.deepEqual(bridge.removed, ["wkt_agent"]);
  assert.equal(catalog.view.pendingRemoval, null);
  assert.equal(catalog.view.worktrees.length, 0, "删除后清单来自重新枚举");

  catalog.dispose();
});

test("令牌失效（并发状态变化）：删除失败但仍可重新计划并恢复", async () => {
  const { bridge, catalog } = await catalogWithBridge();
  await catalog.open("prj_1");
  catalog.select("wkt_agent");
  bridge.worktreeList = [sampleWorktree({ id: "wkt_agent" })];
  await catalog.reload();
  await catalog.planRemoval("wkt_agent");

  bridge.removeError = "E_GIT_CONFIRMATION_STALE: 工作树状态已变化，请重新确认";
  assert.equal(await catalog.confirmRemoval(), false);
  assert.match(catalog.view.pendingError ?? "", /E_GIT_CONFIRMATION_STALE/);
  assert.equal(catalog.view.worktrees.length, 1, "失败后不清空清单");
  assert.equal(bridge.removed.length, 0);

  // 恢复路径：重新计划拿到新令牌，再确认即成功。
  bridge.removeError = null;
  await catalog.planRemoval("wkt_agent");
  assert.equal(await catalog.confirmRemoval(), true);
  assert.deepEqual(bridge.removed, ["wkt_agent"]);

  catalog.dispose();
});

test("异常退出后的恢复：prune 需要令牌且只清理 prunable 记录", async () => {
  const { bridge, catalog } = await catalogWithBridge();
  bridge.staleWorktrees = ["F:/work/soxu-worktrees/dead"];
  await catalog.open("prj_1");

  assert.equal(catalog.view.stale.length, 1);
  bridge.pruneToken = "  ";
  await catalog.reload();
  assert.equal(await catalog.prune(), null);
  assert.equal(bridge.count("pruneWorktrees"), 0, "令牌为空时不得调用 prune");
  assert.match(catalog.view.error ?? "", /E_GIT_CONFIRMATION_REQUIRED/);

  bridge.pruneToken = "tok-prune";
  await catalog.reload();
  const removed = await catalog.prune();
  assert.equal(removed, 1);
  assert.deepEqual(bridge.callsOf("pruneWorktrees").at(-1)?.args, ["prj_1", "tok-prune"]);
  assert.equal(catalog.view.stale.length, 0);

  assert.equal(await catalog.prune(), null, "没有失效记录时不重复调用");
  assert.equal(bridge.count("pruneWorktrees"), 1);

  catalog.dispose();
});

test("创建失败只报错，不污染工作树清单与选择", async () => {
  const { bridge, catalog } = await catalogWithBridge();
  await catalog.open("prj_1");
  const selected = catalog.view.selectedId;
  const before = catalog.view.worktrees.length;

  bridge.createError = "E_GIT_BRANCH_EXISTS: 分支已存在";
  const created = await catalog.create({
    branch: "agent/issue-5",
    newBranch: true,
    base: null,
    path: null,
  });
  assert.equal(created, null);
  assert.equal(catalog.view.creating, false);
  assert.match(catalog.view.error ?? "", /E_GIT_BRANCH_EXISTS/);
  assert.equal(catalog.view.worktrees.length, before);
  assert.equal(catalog.view.selectedId, selected);

  catalog.dispose();
});

test("创建成功：重新枚举并选中新工作树", async () => {
  const { bridge, catalog } = await catalogWithBridge();
  await catalog.open("prj_1");

  const created = await catalog.create({
    branch: "agent/issue-7",
    newBranch: true,
    base: "main",
    path: null,
  });
  assert.equal(created?.branch, "agent/issue-7");
  assert.equal(catalog.view.selectedId, created?.id);
  assert.ok(catalog.view.worktrees.some((item) => item.id === created?.id));
  const call = bridge.callsOf("createWorktree").at(-1);
  assert.deepEqual(call?.args[1], {
    branch: "agent/issue-7",
    newBranch: true,
    base: "main",
    path: null,
  });

  catalog.dispose();
});

test("Diff 预览为只读：截断标记与错误都只写视图", async () => {
  const { bridge, catalog } = await catalogWithBridge();
  await catalog.open("prj_1");
  catalog.select("wkt_agent");
  bridge.diff = {
    worktreeId: "wkt_agent",
    staged: false,
    files: [{ status: "M", path: "src/lib.rs", added: 4, removed: 1, binary: false }],
    totalFiles: 900,
    patch: "@@ -1 +1 @@",
    truncated: true,
    bytesRead: 4096,
  };

  const diff = await catalog.previewDiff("wkt_agent", false);
  assert.equal(diff?.truncated, true, "截断必须如实上报");
  assert.equal(catalog.view.diff?.totalFiles, 900);
  assert.equal(bridge.count("removeWorktree"), 0, "预览不能触发任何写操作");

  bridge.diffError = "E_GIT_COMMAND_TIMEOUT: git diff 超时（20s）";
  assert.equal(await catalog.previewDiff("wkt_agent", true), null);
  assert.match(catalog.view.diffError ?? "", /E_GIT_COMMAND_TIMEOUT/);

  catalog.dispose();
});

test("面板卸载：在途枚举结果不再写状态", async () => {
  const { bridge, catalog } = await catalogWithBridge();
  const gate = deferred();
  bridge.worktreeListGate = gate.promise;
  const loading = catalog.open("prj_1");

  catalog.dispose();
  gate.resolve();
  await loading;

  assert.equal(catalog.view.loading, false);
  assert.equal(catalog.view.worktrees.length, 0, "卸载后旧响应必须被丢弃");
});
