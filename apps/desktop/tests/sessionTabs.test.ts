/**
 * Issue #99：会话 Tab 栏等宽布局 + 拖拽排序。
 *
 * 分两层验证：
 * 1. 纯逻辑（`tabStripLayout.ts` 与 `WorkspaceSession.moveTab`）用确定性用例覆盖，
 *    包括阈值、落位、上下限与「只改顺序不改 active」。
 * 2. 组件结构断言守的是构建期事实：指针事件由本组件手写、listener 与 ResizeObserver
 *    在同一处释放、reduced-motion 下没有平移动画。
 *    真实浏览器里的观感与截图证据见 docs/development/evidence/issue-99-tab-width-drag/。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DRAG_THRESHOLD_PX,
  TAB_GAP,
  TAB_MAX_WIDTH,
  TAB_MIN_WIDTH,
  dropIndex,
  exceedsDragThreshold,
  overflows,
  slotShift,
  tabWidth,
} from "../src/composables/tabStripLayout.ts";
import { WorkspaceSession } from "../src/workspace/sessionWorkspace.ts";
import { createWorkspaceState } from "../src/workspace/types.ts";
import { FakeBridge } from "./support/fakeBridge.ts";

const SRC_ROOT = fileURLToPath(new URL("../src", import.meta.url));
const TABS_COMPONENT = join(SRC_ROOT, "components", "SessionTabs.vue");
const TAB_DRAG = join(SRC_ROOT, "composables", "useTabDrag.ts");

async function openTabs(count: number): Promise<WorkspaceSession> {
  const session = new WorkspaceSession(new FakeBridge());
  for (let index = 0; index < count; index += 1) {
    await session.openSession({
      sessionId: `ses_${index}`,
      projectId: "prj_1",
      title: `会话 ${index}`,
    });
  }
  return session;
}

function order(session: WorkspaceSession): string[] {
  return session.workspace.tabs.map((tab) => tab.sessionId);
}

// ---------------------------------------------------------------- 等宽

test("等宽随数量变化，并夹在 96~220 的上下限内", () => {
  const available = 640;
  const one = tabWidth(1, available);
  const three = tabWidth(3, available);
  const eight = tabWidth(8, available);

  assert.equal(one, TAB_MAX_WIDTH, "1 个 Tab 时不应超过上限");
  assert.ok(three < one && eight < three, "数量越多越窄：1 > 3 > 8");
  assert.ok(eight >= TAB_MIN_WIDTH, "8 个 Tab 仍在最小宽度之上");
  assert.equal(tabWidth(40, available), TAB_MIN_WIDTH, "放不下时夹到下限，交给横向滚动");
  assert.equal(tabWidth(3, 0), TAB_MIN_WIDTH, "宽度未知时按最小宽度处理，避免 0 宽闪烁");
  assert.equal(tabWidth(0, available), TAB_MAX_WIDTH, "没有 Tab 时不产生 NaN");
});

test("等宽只按数量与容器宽度决定，与具体 Tab 无关", () => {
  // 同一个 (count, width) 只会得到一个值：组件把它写进 CSS 变量，所有 Tab 共享。
  const widths = new Set(Array.from({ length: 5 }, () => tabWidth(4, 900)));
  assert.deepEqual([...widths], [tabWidth(4, 900)]);
});

test("等宽 + 间距不超过容器，避免 1px 假溢出", () => {
  for (const count of [1, 2, 3, 5, 8, 12]) {
    for (const available of [320, 640, 1000, 1440]) {
      const width = tabWidth(count, available);
      const need = width * count + TAB_GAP * (count - 1);
      const atMax = width === TAB_MAX_WIDTH || width === TAB_MIN_WIDTH;
      if (!atMax) assert.ok(need <= available, `${count} 个 Tab 在 ${available}px 下不应溢出`);
    }
  }
  assert.equal(overflows(8, 700), true, "8 × 96 + 7 gap 超过 700px，进入横向滚动");
  assert.equal(overflows(8, 1000), false, "容器够宽时没有滚动条");
  assert.equal(overflows(3, 1000), false, "3 个 Tab 在 1000px 内不该滚动");
  assert.equal(overflows(0, 1000), false, "空栏没有滚动");
});

// ---------------------------------------------------------------- 拖拽

test("拖拽阈值至少 6px，阈值内仍算点击", () => {
  assert.ok(DRAG_THRESHOLD_PX >= 6, "阈值不得小于 6px，否则轻点会误触排序");
  assert.equal(exceedsDragThreshold(5), false);
  assert.equal(exceedsDragThreshold(DRAG_THRESHOLD_PX), true);
  assert.equal(exceedsDragThreshold(-DRAG_THRESHOLD_PX), true, "向左拖同样算越阈值");
});

test("落位判定按中心点跨过计算，左右移动不需要分方向特判", () => {
  // 三个等宽 Tab，中心分别在 100 / 200 / 300。
  const centers = [100, 200, 300];
  assert.equal(dropIndex(centers, 0, 90), 0, "指针在原位左侧：不动");
  assert.equal(dropIndex(centers, 0, 150), 0, "未跨过第二个中心：不动");
  assert.equal(dropIndex(centers, 0, 210), 1, "跨过第二个中心：落到第 1 位");
  assert.equal(dropIndex(centers, 0, 320), 2, "拖到最右：落到末位");
  assert.equal(dropIndex(centers, 2, 90), 0, "从末尾拖到最左");
  assert.equal(dropIndex(centers, 2, 190), 1, "从末尾拖到中间");
  assert.equal(dropIndex(centers, 1, 999), 2, "越界钳到末位");
  assert.equal(dropIndex(centers, 1, -50), 0, "越界钳到首位");
  assert.equal(dropIndex([], 0, 100), 0, "空栏不会产生负数下标");
});

test("让位方向与落位一致：其它 Tab 各让一个槽位", () => {
  // 0 → 2：1、2 左移一格，其余不动。
  assert.deepEqual([0, 1, 2, 3].map((index) => slotShift(index, 0, 2)), [0, -1, -1, 0]);
  // 3 → 1：1、2 右移一格。
  assert.deepEqual([0, 1, 2, 3].map((index) => slotShift(index, 3, 1)), [0, 1, 1, 0]);
  // 原地不动。
  assert.deepEqual([0, 1, 2].map((index) => slotShift(index, 1, 1)), [0, 0, 0]);
});

// ---------------------------------------------------------------- 顺序写回

test("moveTab 只重排顺序，不动 activeSessionId", async () => {
  const session = await openTabs(3);
  session.setActive("ses_0");
  const before = session.workspace.tabs.map((tab) => tab.sessionId);

  assert.equal(session.moveTab(0, 1), true);
  assert.deepEqual(order(session), [before[1], before[0], before[2]]);
  assert.equal(session.workspace.activeSessionId, "ses_0", "拖 Tab 是整理栏位，不是切换会话");

  assert.equal(session.moveTab(2, 0), true, "从末位拖到首位");
  assert.deepEqual(order(session), ["ses_2", "ses_1", "ses_0"]);
  assert.equal(session.workspace.activeSessionId, "ses_0");
});

test("moveTab 原样搬运 Tab 对象：消息窗口、运行时与草稿不重建", async () => {
  const session = await openTabs(2);
  const tabA = session.tab("ses_0");
  assert.ok(tabA);
  tabA.draft = "还没发出去的内容";
  tabA.runtime.generation = 7;

  session.moveTab(0, 1);

  const moved = session.workspace.tabs[1];
  assert.equal(moved, tabA, "重排后仍是同一个 Tab 对象（响应式代理不变）");
  assert.equal(moved?.draft, "还没发出去的内容");
  assert.equal(moved?.runtime.generation, 7);
});

test("moveTab 对越界、原地与非法下标都返回 false 且不改状态", async () => {
  const session = await openTabs(3);
  const before = order(session);

  assert.equal(session.moveTab(1, 1), false, "原地移动是无操作");
  assert.equal(session.moveTab(-1, 0), false, "起点越界");
  assert.equal(session.moveTab(3, 0), false, "起点越界（等于长度）");
  assert.equal(session.moveTab(0.5, 1), false, "非整数下标");
  assert.equal(session.moveTab(0, Number.NaN), false, "NaN 下标");
  assert.deepEqual(order(session), before, "非法调用不得改动顺序");

  // 终点越界按末位处理：拖到栏尾之外等价于拖到最后一个位置。
  assert.equal(session.moveTab(0, 9), true);
  assert.deepEqual(order(session), ["ses_1", "ses_2", "ses_0"], "终点越界钳到末位");
});

test("moveTab 在 dispose 之后不再写状态", async () => {
  const session = await openTabs(2);
  await session.dispose();
  assert.equal(session.moveTab(0, 1), false);
});

test("重排在 Vue 响应式状态下可被观察到", async () => {
  const { reactive, watch, nextTick } = await import("vue");
  const state = reactive(createWorkspaceState());
  const session = new WorkspaceSession(new FakeBridge(), state);
  await session.openSession({ sessionId: "ses_a", projectId: "prj_1", title: "A" });
  await session.openSession({ sessionId: "ses_b", projectId: "prj_1", title: "B" });

  const seen: string[][] = [];
  watch(
    () => state.tabs.map((tab) => tab.sessionId).join(","),
    (value) => {
      if (value) seen.push(value.split(","));
    },
  );

  session.moveTab(0, 1);
  await nextTick();
  assert.deepEqual(seen.at(-1), ["ses_b", "ses_a"], "顺序写回必须触发重渲染");
});

// ---------------------------------------------------------------- 组件结构

test("拖拽由本组件手写的指针事件实现，不引入拖拽库", async () => {
  const component = await readFile(TABS_COMPONENT, "utf8");
  const drag = await readFile(TAB_DRAG, "utf8");
  const both = component + drag;

  for (const required of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) {
    assert.ok(both.includes(required), `缺少 ${required}：触屏与鼠标必须走同一套指针事件`);
  }
  assert.ok(
    drag.includes('window.addEventListener("pointermove"'),
    "pointermove 必须挂在 window 上，指针移出 Tab 仍能收到",
  );
  assert.ok(
    drag.includes('window.removeEventListener("pointermove"'),
    "window 级 listener 必须在加它的同一模块释放",
  );
  assert.ok(
    component.includes("from \"../composables/tabStripLayout.ts\""),
    "等宽判定必须走可测的纯函数模块",
  );
  assert.ok(
    drag.includes("from \"./tabStripLayout.ts\""),
    "阈值与落位必须走同一份纯函数，不能各写一套",
  );

  // 依赖面不动：只允许 vue / @lucide/vue / 相对路径。
  for (const source of [component, drag]) {
    const specifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
    const external = specifiers.filter((spec) => !spec.startsWith("."));
    assert.deepEqual(
      external.filter((spec) => spec !== "vue" && spec !== "@lucide/vue"),
      [],
      "拖拽排序不得引入新的运行时依赖",
    );
  }
});

test("拖拽按 DOM 顺序取元素，不依赖 v-for 的 ref 数组", async () => {
  // 回归：函数式 ref 数组在关闭一个 Tab 之后会留下空洞/错位，
  // 用下标对元素做落位判定会整体偏一格，浏览器实测表现为「关掉一个 Tab 后拖不动」。
  const drag = await readFile(TAB_DRAG, "utf8");
  assert.ok(drag.includes("querySelectorAll"), "元素必须按 DOM 顺序查出来");
  assert.ok(
    !drag.includes("items:"),
    "不要再把 v-for 的 ref 数组传进来，它的下标不保证等于视觉顺序",
  );
});

test("等宽通过 CSS 变量统一施加，单个 Tab 不再自带 min/max 宽度", async () => {
  const text = await readFile(TABS_COMPONENT, "utf8");
  assert.ok(text.includes("tabWidth(props.tabs.length"), "宽度必须由数量与容器宽度算出");
  assert.ok(text.includes("--soxu-tab-width"), "等宽要写进 CSS 变量，由所有 Tab 共享");
  assert.ok(text.includes("width: var(--soxu-tab-width"), ".tab-item 的宽度只能来自该变量");
  assert.ok(!/max-width:\s*240px/.test(text), "旧的写死上限已删除");
  assert.ok(!/\.tab-title \{[^}]*max-width/.test(text), "标题截断改为 flex + ellipsis，不再写死 max-width");
});

test("横向滚动、插入指示与 reduced-motion 退化都在组件内", async () => {
  const text = await readFile(TABS_COMPONENT, "utf8");
  assert.ok(text.includes("overflow-x: auto"), "超出上限后进入横向滚动");
  assert.ok(text.includes("drop-marker"), "拖动中要有插入位置指示");
  assert.ok(text.includes("touch-action: pan-y"), "触屏拖动排序不能被浏览器横向滚动抢走");

  const reduce = text.slice(text.indexOf("@media (prefers-reduced-motion: reduce)"));
  assert.ok(reduce.includes("transition: none"), "reduced-motion 下平移动画必须退化");
});

test("拖拽不拦截键盘导航：方向键/Home/End/Delete 仍由同一处理器响应", async () => {
  const text = await readFile(TABS_COMPONENT, "utf8");
  assert.ok(text.includes('@keydown="onKeydown($event, index)"'), "键盘处理仍挂在 Tab 按钮上");
  for (const key of ["ArrowRight", "ArrowLeft", "Home", "End", "Delete"]) {
    assert.ok(text.includes(`"${key}"`), `键盘导航缺少 ${key}`);
  }
  assert.ok(
    !/addEventListener\("keydown"/.test(text + (await readFile(TAB_DRAG, "utf8"))),
    "拖拽不得额外抢占 keydown，否则方向键语义会分叉",
  );
  assert.ok(
    !text.includes('role="tab"') || text.includes('role="tablist"'),
    "tablist/tab 语义必须保留",
  );
});
