import test from "node:test";
import assert from "node:assert/strict";
import {
  SESSION_HISTORY_LIMIT,
  createSessionHistory,
  currentSession,
  findTarget,
  moveTo,
  recordVisit,
} from "../src/workspace/sessionHistory.ts";

// Issue #96：顶栏后退 / 前进在已打开的会话之间导航，上限 50 条。

test("首次访问把游标落在唯一一条记录上", () => {
  const history = recordVisit(createSessionHistory(), "a");
  assert.deepEqual(history.entries, ["a"]);
  assert.equal(history.index, 0);
  assert.equal(currentSession(history), "a");
});

test("记录访问顺序并按最后一条停留", () => {
  let history = createSessionHistory();
  for (const id of ["a", "b", "c"]) history = recordVisit(history, id);
  assert.deepEqual(history.entries, ["a", "b", "c"]);
  assert.equal(currentSession(history), "c");
});

test("重复访问当前会话不新增条目，避免挤掉前进分支", () => {
  let history = createSessionHistory();
  for (const id of ["a", "b", "c"]) history = recordVisit(history, id);
  const back = findTarget(history, "back");
  assert.ok(back);
  const moved = moveTo(history, back.index);
  assert.deepEqual(moved.entries, ["a", "b", "c"]);
  assert.equal(moved.index, 1);

  // 后退之后 Vue 会再触发一次记录：与当前条目相同，必须原样返回。
  const again = recordVisit(moved, "b");
  assert.equal(again, moved, "同一会话的重复记录必须返回原状态（引用相等）");
  assert.equal(findTarget(again, "forward")?.sessionId, "c");
});

test("后退之后打开新会话会丢弃前进分支", () => {
  let history = createSessionHistory();
  for (const id of ["a", "b", "c"]) history = recordVisit(history, id);
  history = moveTo(history, 1);
  history = recordVisit(history, "d");
  assert.deepEqual(history.entries, ["a", "b", "d"]);
  assert.equal(currentSession(history), "d");
  assert.equal(findTarget(history, "forward"), null);
});

test(`历史条数上限为 ${SESSION_HISTORY_LIMIT}，超出丢最旧记录`, () => {
  let history = createSessionHistory();
  const total = SESSION_HISTORY_LIMIT + 10;
  for (let index = 0; index < total; index += 1) history = recordVisit(history, `s${index}`);
  assert.equal(history.entries.length, SESSION_HISTORY_LIMIT);
  assert.equal(history.entries[0], "s10", "越界时丢的是最旧的 10 条");
  assert.equal(currentSession(history), `s${total - 1}`);
  assert.equal(history.index, SESSION_HISTORY_LIMIT - 1);
});

test("两个方向的边界返回 null（对应按钮禁用态）", () => {
  const empty = createSessionHistory();
  assert.equal(findTarget(empty, "back"), null);
  assert.equal(findTarget(empty, "forward"), null);

  const single = recordVisit(createSessionHistory(), "a");
  assert.equal(findTarget(single, "back"), null);
  assert.equal(findTarget(single, "forward"), null);
});

test("跳过已关闭 Tab 的会话，且能连续后退到更早的记录", () => {
  let history = createSessionHistory();
  for (const id of ["a", "b", "c", "d"]) history = recordVisit(history, id);
  // c 的 Tab 已关闭：后退应直接落到 b，而不是切到一个空白面板。
  const closed = new Set(["c"]);
  const available = (id: string) => !closed.has(id);
  assert.deepEqual(findTarget(history, "back", available), { index: 1, sessionId: "b" });

  const moved = moveTo(history, 1);
  // 再后退一次跨过已关闭的 c，落到 a。
  assert.equal(findTarget(moved, "back", available)?.sessionId, "a");
  // 前进同样跳过 c，回到 d。
  assert.equal(findTarget(moved, "forward", available)?.sessionId, "d");
  assert.equal(findTarget(moveTo(history, 0), "back", available), null);
});

test("moveTo 把越界下标收敛到合法范围", () => {
  let history = createSessionHistory();
  for (const id of ["a", "b"]) history = recordVisit(history, id);
  assert.equal(moveTo(history, 99).index, 1);
  assert.equal(moveTo(history, -99).index, 0);
  assert.equal(moveTo(createSessionHistory(), 3).index, -1);
});
