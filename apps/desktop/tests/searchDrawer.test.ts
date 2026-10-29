/**
 * Issue #118 · TASK-026：搜索抽屉（UI 切片）的契约。
 *
 * 能在 Node 里确定验证的部分：
 * 1. 三种状态（空态 / 搜索中 / 无结果）与结果态、错误态的判定边界；
 * 2. 命中按消息时间倒序，且不改写 tab.search.hits 本身；
 * 3. 点击命中按 ordinal 定位到历史消息（id 与 mapping.ts 同源）；
 * 4. 计数 / 截断 / 降级说明的口径，不隐瞒「只拿到最早的一批」；
 * 5. 防抖预算 ≤ 250 ms，且防抖只有一份（组件里不得自己起定时器）；
 * 6. 组件与外壳接线：Ctrl+F、关闭、跳转、高亮、定时器清理。
 *
 * 真实渲染、点击与键盘行为由 tests/harness/search-drawer.html +
 * tests/harness/shoot-issue-118-search.mjs 采集，见
 * docs/development/evidence/issue-118-search-drawer/README.md。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  HIT_HIGHLIGHT_MS,
  MAX_JUMP_PAGES,
  degradedNote,
  findMessageIndex,
  formatCount,
  hitMessageId,
  hitRoleLabel,
  hitSnippet,
  resolveJumpTarget,
  resultCountText,
  searchPanelStatus,
  sortHitsNewestFirst,
  truncationNote,
} from "../src/components/searchPanel.ts";
import { messageFromEntry } from "../src/workspace/mapping.ts";
import {
  SEARCH_DEBOUNCE_MS,
  createSearchState,
  type ChatMessage,
  type SearchState,
  type SessionSearchHit,
} from "../src/workspace/types.ts";

const SESSION = "ses_ui";

async function readSource(relative: string): Promise<string> {
  return readFile(new URL(relative, import.meta.url), "utf8");
}

function state(overrides: Partial<SearchState> = {}): SearchState {
  return { ...createSearchState(), ...overrides };
}

function hit(
  ordinal: number,
  snippet = "讨论扩散模型的采样步数",
  matchStart = 2,
  matchEnd = 4,
): SessionSearchHit {
  return {
    ordinal,
    kind: "message",
    role: "user",
    snippet,
    matchStart,
    matchEnd,
    totalMatches: 1,
    truncated: false,
  };
}

function message(id: string, ordinal: number | null): ChatMessage {
  return {
    id,
    ordinal,
    role: "user",
    text: "",
    partial: false,
    streaming: false,
    source: ordinal === null ? "live" : "history",
    createdAt: null,
  };
}

/* ── 1. 状态判定 ───────────────────────────────────────────── */

test("空态：输入为空或只有空白时，不显示任何结果或错误", () => {
  assert.equal(searchPanelStatus(state(), ""), "empty");
  assert.equal(searchPanelStatus(state(), "   "), "empty");
  // 上一次查询的结果还挂在状态里，也不该被当成「当前查询的结果」显示。
  assert.equal(searchPanelStatus(state({ query: "扩散", hits: [hit(7)] }), ""), "empty");
});

test("搜索中：输入已变但结果还没回来，显示搜索中而不是旧结果", () => {
  const stale = state({ query: "扩散", hits: [hit(7)], totalHits: 1 });
  assert.equal(searchPanelStatus(stale, "扩散模型"), "searching", "防抖待触发");
  assert.equal(searchPanelStatus(state({ query: "扩散", loading: true }), "扩散"), "searching");
});

test("无结果与结果态：按已返回的命中数区分", () => {
  assert.equal(searchPanelStatus(state({ query: "扩散", hits: [] }), "扩散"), "no-results");
  assert.equal(searchPanelStatus(state({ query: "扩散", hits: [hit(7)] }), "扩散"), "results");
  // 输入前后空白不该把状态打回 searching（查询已提交且未变）。
  assert.equal(searchPanelStatus(state({ query: "扩散", hits: [hit(7)] }), "  扩散  "), "results");
});

test("错误态：同一查询的失败优先于「无结果」", () => {
  const failed = state({ query: "扩散", error: "E_SESSION_FILE_MISSING: 会话文件不存在" });
  assert.equal(searchPanelStatus(failed, "扩散"), "error");
  // 用户改了查询：新查询还没搜，错误属于旧查询，不能继续显示。
  assert.equal(searchPanelStatus(failed, "扩散模型"), "searching");
});

/* ── 2. 排序 ───────────────────────────────────────────────── */

test("命中按消息时间倒序，且不原地改写 tab.search.hits", () => {
  const hits = [hit(3), hit(40), hit(12)];
  const sorted = sortHitsNewestFirst(hits);
  assert.deepEqual(
    sorted.map((item) => item.ordinal),
    [40, 12, 3],
  );
  assert.deepEqual(
    hits.map((item) => item.ordinal),
    [3, 40, 12],
    "入参不能被排序改写：同一份状态还有别的消费者",
  );
});

/* ── 3. 定位 ───────────────────────────────────────────────── */

test("命中 id 与 mapping.ts 的历史消息 id 同源", () => {
  const entry = {
    ordinal: 12,
    offset: 0,
    length: 0,
    kind: "message" as const,
    role: "user" as const,
    preview: "讨论扩散模型",
    timestamp: null,
    oversized: false,
    corrupt: false,
  };
  assert.equal(hitMessageId(SESSION, entry.ordinal), messageFromEntry(SESSION, entry).id);
  assert.equal(hitMessageId(SESSION, 12), "ses_ui:h:12");
});

test("按 ordinal 在已加载窗口里定位，实时消息与未加载命中都定位不到", () => {
  const messages = [message("live:1:1", null), message("ses_ui:h:5", 5), message("ses_ui:h:9", 9)];
  assert.equal(findMessageIndex(messages, 9), 2);
  assert.equal(findMessageIndex(messages, 5), 1);
  assert.equal(findMessageIndex(messages, 6), -1, "未加载的命中必须返回 -1");
  assert.equal(findMessageIndex(messages, 0), -1, "实时消息 ordinal 为 null，不能被历史命中选中");
});

test("有界翻页上限是一个正数，避免为一个旧命中无限加载", () => {
  assert.ok(Number.isInteger(MAX_JUMP_PAGES) && MAX_JUMP_PAGES >= 1);
  assert.ok(MAX_JUMP_PAGES <= 5, "翻页上限过大就等于把整份历史读进内存");
});

/** 跳转夹具：一个会随 loadMore 增长的窗口 + 剩余页队列，等价于 store 的 loadMore。 */
function jumpFixture(options: {
  initial: ChatMessage[];
  pages: ChatMessage[][];
  isActive?: () => boolean;
}) {
  let messages = [...options.initial];
  const queue = [...options.pages];
  let loads = 0;
  return {
    loads: () => loads,
    messages: () => messages,
    hasMore: () => queue.length > 0,
    loadMore: async () => {
      loads += 1;
      messages = [...messages, ...(queue.shift() ?? [])];
    },
    isActive: options.isActive ?? (() => true),
  };
}

test("跳转：命中已在窗口里时直接返回 id，不加载任何历史", async () => {
  const fixture = jumpFixture({ initial: [message("ses_ui:h:5", 5)], pages: [] });
  const result = await resolveJumpTarget({
    sessionId: SESSION,
    ordinal: 5,
    messages: fixture.messages,
    hasMore: fixture.hasMore,
    loadMore: fixture.loadMore,
    isActive: fixture.isActive,
  });
  assert.deepEqual(result, { messageId: "ses_ui:h:5", pagesLoaded: 0, notice: null });
  assert.equal(fixture.loads(), 0);
});

test("跳转：命中在更早的历史里时有界翻页，加载到即停", async () => {
  const fixture = jumpFixture({
    initial: [message("ses_ui:h:30", 30)],
    pages: [[message("ses_ui:h:20", 20)], [message("ses_ui:h:7", 7)], [message("ses_ui:h:1", 1)]],
  });
  const result = await resolveJumpTarget({
    sessionId: SESSION,
    ordinal: 7,
    messages: fixture.messages,
    hasMore: fixture.hasMore,
    loadMore: fixture.loadMore,
    isActive: fixture.isActive,
  });
  assert.equal(result.messageId, "ses_ui:h:7");
  assert.equal(result.pagesLoaded, 2);
  assert.equal(result.notice, null);
  assert.equal(fixture.loads(), 2, "找到之后不能再继续翻页");
});

test("跳转：翻到上限还没找到就停下并提示，不无限加载", async () => {
  const pages = Array.from({ length: MAX_JUMP_PAGES + 2 }, (_, index) => [
    message("ses_ui:h:" + String(900 + index), 900 + index),
  ]);
  const fixture = jumpFixture({ initial: [message("ses_ui:h:1", 1)], pages });
  const result = await resolveJumpTarget({
    sessionId: SESSION,
    ordinal: 424242,
    messages: fixture.messages,
    hasMore: fixture.hasMore,
    loadMore: fixture.loadMore,
    isActive: fixture.isActive,
  });
  assert.equal(result.messageId, null);
  assert.equal(result.pagesLoaded, MAX_JUMP_PAGES, "翻页次数必须被上限卡住");
  assert.match(result.notice ?? "", /加载更多历史/);
});

test("跳转：历史已到底仍找不到时，说明这条命中不在可加载的历史里", async () => {
  const fixture = jumpFixture({ initial: [message("ses_ui:h:1", 1)], pages: [] });
  const result = await resolveJumpTarget({
    sessionId: SESSION,
    ordinal: 9,
    messages: fixture.messages,
    hasMore: fixture.hasMore,
    loadMore: fixture.loadMore,
    isActive: fixture.isActive,
  });
  assert.equal(result.messageId, null);
  assert.equal(result.pagesLoaded, 0);
  assert.match(result.notice ?? "", /不在可加载的历史里/);
});

test("跳转：翻页途中切走会话就放弃，不写任何目标", async () => {
  const fixture = jumpFixture({
    initial: [message("ses_ui:h:30", 30)],
    pages: [[message("ses_ui:h:20", 20)]],
    isActive: () => false,
  });
  const result = await resolveJumpTarget({
    sessionId: SESSION,
    ordinal: 20,
    messages: fixture.messages,
    hasMore: fixture.hasMore,
    loadMore: fixture.loadMore,
    isActive: fixture.isActive,
  });
  assert.deepEqual(result, { messageId: null, pagesLoaded: 1, notice: null });
});

/* ── 4. 文案口径 ───────────────────────────────────────────── */

test("计数文案：命中数 + 扫描数，带千分位", () => {
  const ready = state({ query: "扩散", hits: [hit(7)], totalHits: 1235, scannedEntries: 50000 });
  assert.equal(resultCountText(ready, "扩散"), "1,235 条匹配 · 扫描 50,000 条");
  assert.equal(resultCountText(state(), ""), "", "空态不显示计数");
  assert.equal(resultCountText(state({ query: "扩散", loading: true }), "扩散"), "搜索中…");
  assert.equal(
    resultCountText(state({ query: "扩散", error: "boom" }), "扩散"),
    "搜索失败",
  );
});

test("截断时说明只拿到最早的一批，不假装结果完整", () => {
  const hits = Array.from({ length: 50 }, (_, index) => hit(index + 1));
  const truncated = state({
    query: "扩散",
    hits,
    totalHits: 206,
    scannedEntries: 1235,
    truncated: true,
  });
  assert.equal(
    resultCountText(truncated, "扩散"),
    "206 条匹配（已返回最早的 50 条） · 扫描 1,235 条",
  );
  assert.match(truncationNote(truncated) ?? "", /最早的 50 条/);
  assert.equal(truncationNote(state({ query: "扩散", hits })), null);
});

test("降级说明只在 degraded 时出现", () => {
  assert.equal(degradedNote(state({ degraded: true })), "部分旧正文因内存预算被释放，结果可能不完整。");
  assert.equal(degradedNote(state()), null);
});

test("千分位不依赖 locale", () => {
  assert.equal(formatCount(0), "0");
  assert.equal(formatCount(999), "999");
  assert.equal(formatCount(1000), "1,000");
  assert.equal(formatCount(1235), "1,235");
  assert.equal(formatCount(50000), "50,000");
  assert.equal(formatCount(-1234), "-1,234");
  assert.equal(formatCount(Number.NaN), "0");
  assert.equal(formatCount(12.7), "12");
});

test("命中角色标签与消息列表口径一致", () => {
  assert.equal(hitRoleLabel("user"), "你");
  assert.equal(hitRoleLabel("assistant"), "Agent");
  assert.equal(hitRoleLabel("tool_result"), "工具输出");
  assert.equal(hitRoleLabel("system"), "系统");
  assert.equal(hitRoleLabel("custom"), "自定义");
  assert.equal(hitRoleLabel("unknown"), "事件");
  assert.equal(hitRoleLabel(null), "事件");
});

test("片段高亮只切后端给的字符偏移（含代理对）", () => {
  assert.deepEqual(hitSnippet(hit(7, "讨论扩散模型", 2, 4)), {
    before: "讨论",
    match: "扩散",
    after: "模型",
  });
  const emoji = hitSnippet(hit(8, "🙂扩散🙂", 1, 3));
  assert.equal(emoji.before, "🙂");
  assert.equal(emoji.match, "扩散");
  assert.equal(emoji.after, "🙂");
});

/* ── 5. 防抖预算与单一 owner ───────────────────────────────── */

test("防抖窗口不超过验收的 250 ms（为 IPC 留出预算）", () => {
  assert.ok(SEARCH_DEBOUNCE_MS > 0, "防抖必须存在，否则每敲一个字符发一次请求");
  assert.ok(
    SEARCH_DEBOUNCE_MS <= 250,
    "防抖必须 ≤ 250 ms：验收要求输入后 250 ms 内出结果，窗口本身不能把这 250 ms 用光",
  );
});

test("抽屉组件不自带定时器：防抖只有 store 一份", async () => {
  const drawer = await readSource("../src/components/SearchDrawer.vue");
  assert.ok(!drawer.includes("setTimeout("), "组件里不得再起一份防抖定时器");
  assert.ok(!drawer.includes("clearTimeout("), "没有定时器就没有定时器要清理");
  assert.ok(drawer.includes('emit("query"'), "输入变化必须冒泡给上层，由 store 决定何时发请求");
});

/* ── 6. 组件与外壳接线 ─────────────────────────────────────── */

test("抽屉结构：搜索框 + 结果数 + 三态 + 高亮片段", async () => {
  const drawer = await readSource("../src/components/SearchDrawer.vue");

  assert.ok(drawer.includes('aria-label="会话搜索"'), "抽屉必须有可读名称");
  assert.ok(drawer.includes('type="search"'), "搜索框用 type=search（读屏与移动端键盘都认这个语义）");
  assert.ok(drawer.includes('aria-label="搜索本会话"'), "搜索框必须有 aria-label");
  assert.ok(drawer.includes("Ctrl"), "需要展示快捷键提示");
  assert.ok(drawer.includes('role="status"'), "结果数变化必须通过 live region 播报");
  assert.ok(drawer.includes("<mark"), "命中片段必须高亮");

  for (const keyword of ["搜索中", "没有匹配的消息", "输入关键词"]) {
    assert.ok(drawer.includes(keyword), "缺少状态文案：" + keyword);
  }
  // 模板里的调用写作 emit('jump', row.hit)；脚本里的声明是 (event: "jump")，两种都要有。
  assert.match(drawer, /@click="emit\('jump', row\.hit\)"/, "点击命中必须冒泡 jump");
  assert.ok(drawer.includes('(event: "jump", hit: SessionSearchHit)'), "必须声明 jump 事件");
  assert.match(drawer, /@click="emit\('close'\)"/, "必须有 close 入口");
  assert.ok(drawer.includes('(event: "close"): void'), "必须声明 close 事件");
});

test("抽屉用 reka-ui 原语 + S0 token，不写死颜色", async () => {
  const drawer = await readSource("../src/components/SearchDrawer.vue");
  assert.ok(drawer.includes('from "reka-ui"'), "滚动区域用 reka-ui 的 ScrollArea 原语");
  assert.ok(drawer.includes("ScrollAreaRoot"), "结果列表必须走 ScrollArea");
  assert.ok(drawer.includes("AppTooltip"), "悬浮说明统一走 AppTooltip（reka-ui Tooltip）");

  for (const token of ["var(--accent)", "var(--border)", "var(--fg-subtle)", "var(--fs-caption)"]) {
    assert.ok(drawer.includes(token), "缺少 S0 token：" + token);
  }
  // 只看样式段，且先去掉注释：注释里的 Issue 编号（#118 / #109）不是颜色。
  const style = drawer.slice(drawer.indexOf("<style")).replace(/\/\*[\s\S]*?\*\//g, "");
  const hex = style.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
  assert.deepEqual(hex, [], "组件里不允许写死颜色，颜色只能来自 token");
});

test("高亮持续时间是正数且在合理区间", () => {
  assert.ok(HIT_HIGHLIGHT_MS >= 800, "太短用户看不清跳到了哪一条");
  assert.ok(HIT_HIGHLIGHT_MS <= 5000, "太长会一直亮着干扰阅读");
});

test("App.vue 接线：Ctrl+F 打开、关闭、输入、跳转都落到状态或 store", async () => {
  const app = await readSource("../src/App.vue");

  assert.ok(app.includes('aria-keyshortcuts="Control+F"'), "顶栏按钮必须声明 Ctrl+F");
  assert.match(app, /key === "f"[\s\S]{0,200}openSearch\(\)/, "Ctrl+F 必须打开搜索抽屉");
  assert.match(app, /function openSearch\(\)[\s\S]{0,400}searchDrawer\.value\?\.focus\(\)/, "打开后焦点进搜索框");
  assert.ok(app.includes('@close="closeSearch"'), "抽屉的关闭事件必须真的关掉面板");
  assert.ok(app.includes('@query="onSearchQuery"'), "输入事件必须接到搜索请求上");
  assert.ok(app.includes("store.scheduleSearch("), "防抖请求必须走 store（不要在组件里各起一份）");
  assert.ok(app.includes("store.cancelSearch("), "清空输入框要取消待触发的请求");
  assert.ok(app.includes('@jump="onSearchJump"'), "点击命中必须接到跳转处理");
  assert.ok(app.includes("store.loadMore("), "命中不在窗口里时要能翻页定位");
  assert.ok(
    app.includes(":focus-message-id=\"focusMessageId\"") &&
      app.includes(":focus-nonce=\"focusNonce\""),
    "跳转目标必须透传到会话面板",
  );
  assert.match(app, /watch\(inspectorOpen, \(open\) => \{\s*if \(open\) searchOpen\.value = false;/);
});

test("消息列表：跳转用虚拟列表滚动 + 高亮，定时器在卸载时清理", async () => {
  const list = await readSource("../src/components/MessageList.vue");

  assert.ok(list.includes("scrollToIndex("), "必须用虚拟列表的 scrollToIndex 定位，不能改 scrollTop 硬算");
  assert.ok(list.includes('data-highlight='), "命中消息必须能被高亮");
  assert.ok(list.includes("onUnmounted(clearHighlightTimer)"), "高亮定时器必须由本组件清理");
  assert.ok(list.includes("clearTimeout(highlightTimer)"), "卸载/重复跳转都要清掉上一个定时器");
  assert.match(list, /const index = props\.messages\.findIndex/, "跳转前必须在当前窗口里确认目标存在");
});

test("store 只暴露一条搜索入口（防抖），UI 不直接 new WorkspaceSession", async () => {
  const store = await readSource("../src/stores/workspace.ts");
  for (const method of ["function scheduleSearch(", "function cancelSearch("]) {
    assert.ok(store.includes(method), "store 缺少：" + method);
  }
  for (const exported of ["scheduleSearch,", "cancelSearch,"]) {
    assert.ok(store.includes(exported), "store 的返回值缺少：" + exported);
  }
  // 不提供「绕过防抖立刻搜一次」的第二条路径：两条路径的请求序号语义迟早分叉。
  assert.ok(!store.includes("function search("), "store 不应再暴露第二套搜索入口");

  const app = await readSource("../src/App.vue");
  assert.ok(!app.includes("new WorkspaceSession"), "UI 只能通过 store 访问工作区逻辑");
});
