/**
 * Issue #122 · TASK-030：终端抽屉（PTY）的契约。
 *
 * 能在 Node 里确定验证的部分：
 * 1. 尺寸口径（夹紧 / 兜底 / 去重）与后端限制一致；
 * 2. 输出事件的 seq 语义（重复与乱序一律丢弃，避免串屏）；
 * 3. 状态与关闭结论的文案口径（`exited: false` 不能写成「已回收」）；
 * 4. 组件与外壳接线：先订阅再创建、卸载即 close_pty、抽屉互斥、Ctrl+` 开关；
 * 5. 后端节流窗口确实是 16ms（跨语言断言，防止两边各改一半）。
 *
 * 真实渲染与按键行为需要 WebView，未在本测试内覆盖（见 docs/development/pty-terminal.md
 * 的「验证状态」）。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  TERMINAL_DEFAULT_COLS,
  TERMINAL_DEFAULT_ROWS,
  TERMINAL_MAX_COLS,
  TERMINAL_MAX_ROWS,
  TERMINAL_MIN_COLS,
  TERMINAL_MIN_ROWS,
  MAX_PENDING_CHARS,
  MAX_PENDING_EVENTS,
  TERMINAL_SCROLLBACK,
  clampSize,
  closeSummary,
  createOutputBuffer,
  createResizeGate,
  resolveInitialSize,
  sameSize,
  shouldAcceptOutput,
  terminalStatusText,
  type TerminalSize,
} from "../src/terminal/terminalPanel.ts";
import { PTY_OUTPUT_EVENT_NAME } from "../src/terminal/ptyClient.ts";

async function readSource(relative: string): Promise<string> {
  return readFile(new URL(relative, import.meta.url), "utf8");
}

/* ── 1. 尺寸口径 ───────────────────────────────────────────── */

test("尺寸夹紧：0、负数、NaN、超限都被收进合法区间", () => {
  assert.deepEqual(clampSize(0, 0), { cols: TERMINAL_MIN_COLS, rows: TERMINAL_MIN_ROWS });
  assert.deepEqual(clampSize(-40, -10), { cols: TERMINAL_MIN_COLS, rows: TERMINAL_MIN_ROWS });
  assert.deepEqual(clampSize(9999, 9999), { cols: TERMINAL_MAX_COLS, rows: TERMINAL_MAX_ROWS });
  assert.deepEqual(clampSize(Number.NaN, Number.NaN), {
    cols: TERMINAL_DEFAULT_COLS,
    rows: TERMINAL_DEFAULT_ROWS,
  });
  // 小数取整：xterm 与 ConPTY 都只接受整数。
  assert.deepEqual(clampSize(80.6, 24.4), { cols: 81, rows: 24 });
  assert.deepEqual(clampSize(120, 40), { cols: 120, rows: 40 });
});

test("上下限与后端 MAX_DIMENSION 同量级，不会先发一次必然被拒的请求", () => {
  assert.ok(TERMINAL_MIN_COLS >= 1 && TERMINAL_MIN_ROWS >= 1);
  assert.ok(TERMINAL_MAX_COLS <= 500, "后端上限是 500，前端不得超过它");
  assert.ok(TERMINAL_MAX_ROWS <= 500, "后端上限是 500，前端不得超过它");
});

test("容器还没布局（proposeDimensions 返回 undefined）时退回默认尺寸", () => {
  assert.deepEqual(resolveInitialSize(undefined), {
    cols: TERMINAL_DEFAULT_COLS,
    rows: TERMINAL_DEFAULT_ROWS,
  });
  assert.deepEqual(resolveInitialSize(null), {
    cols: TERMINAL_DEFAULT_COLS,
    rows: TERMINAL_DEFAULT_ROWS,
  });
  assert.deepEqual(resolveInitialSize({ cols: 132, rows: 43 }), { cols: 132, rows: 43 });
  // 测量结果离谱时同样被夹紧，不会把 0 列发给后端。
  assert.deepEqual(resolveInitialSize({ cols: 0, rows: 0 }), {
    cols: TERMINAL_MIN_COLS,
    rows: TERMINAL_MIN_ROWS,
  });
});

test("resize 去重：同一尺寸只发一次，尺寸真的变了才发", () => {
  const sent: TerminalSize[] = [];
  const gate = createResizeGate((size) => sent.push(size));

  assert.equal(gate.request({ cols: 80, rows: 24 }), true, "第一次必须发");
  assert.equal(gate.request({ cols: 80, rows: 24 }), false, "同一尺寸不得重复发");
  assert.equal(gate.request({ cols: 100, rows: 24 }), true, "列数变化必须发");
  assert.equal(gate.request({ cols: 100, rows: 30 }), true, "行数变化必须发");
  // 夹紧之后相同也算同一尺寸：0 行会被夹成下限，与上一次的下限值相同。
  assert.equal(gate.request({ cols: 100, rows: 0 }), true, "夹紧后与上次不同，仍要发");
  assert.equal(gate.request({ cols: 100, rows: 0 }), false, "夹紧后与上次相同，不再发");

  assert.deepEqual(sent, [
    { cols: 80, rows: 24 },
    { cols: 100, rows: 24 },
    { cols: 100, rows: 30 },
    { cols: 100, rows: TERMINAL_MIN_ROWS },
  ]);
  assert.deepEqual(gate.last(), { cols: 100, rows: TERMINAL_MIN_ROWS });

  gate.reset();
  assert.equal(gate.request({ cols: 100, rows: TERMINAL_MIN_ROWS }), true, "reset 后重新发一次");
});

test("sameSize 对 null 的处理是显式的", () => {
  assert.equal(sameSize(null, null), true);
  assert.equal(sameSize(null, { cols: 80, rows: 24 }), false);
  assert.equal(sameSize({ cols: 80, rows: 24 }, null), false);
});

/* ── 2. 输出事件 ───────────────────────────────────────────── */

test("输出事件按 seq 单调放行：重复与乱序一律丢弃", () => {
  assert.equal(shouldAcceptOutput(0, 1), true);
  assert.equal(shouldAcceptOutput(1, 2), true);
  assert.equal(shouldAcceptOutput(2, 2), false, "重复事件会写重复内容");
  assert.equal(shouldAcceptOutput(5, 3), false, "乱序事件说明来自旧一代运行时");
  assert.equal(shouldAcceptOutput(0, Number.NaN), false);
});

test("创建前的输出缓冲：拿到 ptyId 后按到达顺序补写", () => {
  const buffer = createOutputBuffer();
  buffer.push({ ptyId: "pty_1", seq: 1, data: "SOXU " });
  buffer.push({ ptyId: "pty_1", seq: 2, data: "索序" });
  // 别的终端的输出不该混进来（切换会话时的旧一代事件）。
  buffer.push({ ptyId: "pty_0", seq: 1, data: "旧终端" });
  assert.equal(buffer.size(), 3);

  const flushed = buffer.take("pty_1");
  assert.deepEqual(
    flushed.map((event) => event.data),
    ["SOXU ", "索序"],
    "必须保持到达顺序",
  );
  assert.deepEqual(
    flushed.map((event) => event.seq),
    [1, 2],
  );
  assert.equal(buffer.size(), 0, "取走后必须清空，不能留着占内存");
  assert.deepEqual(buffer.take("pty_1"), []);
});

test("创建前的输出缓冲有界：超限丢最旧的并计数", () => {
  const buffer = createOutputBuffer({ events: 3, chars: 1000 });
  for (let index = 1; index <= 5; index += 1) {
    buffer.push({ ptyId: "pty_1", seq: index, data: "第" + index + "块" });
  }
  assert.equal(buffer.size(), 3, "事件数必须被上限卡住");
  assert.equal(buffer.dropped(), 2, "丢弃必须被计数，便于诊断");
  assert.deepEqual(
    buffer.take("pty_1").map((event) => event.seq),
    [3, 4, 5],
    "丢的是最旧的",
  );

  // 字符上限同样生效（即使事件数没超）。
  const chars = createOutputBuffer({ events: 100, chars: 10 });
  chars.push({ ptyId: "pty_1", seq: 1, data: "0123456789" });
  chars.push({ ptyId: "pty_1", seq: 2, data: "abc" });
  assert.ok(chars.size() <= 2);
  chars.clear();
  assert.equal(chars.size(), 0);
});

test("缓冲上限是正数且远小于「一次会话的全部输出」", () => {
  assert.ok(MAX_PENDING_EVENTS >= 1 && MAX_PENDING_EVENTS <= 1024);
  assert.ok(MAX_PENDING_CHARS >= 64 * 1024 && MAX_PENDING_CHARS <= 4 * 1024 * 1024);
});

/* ── 3. 文案口径 ───────────────────────────────────────────── */

test("状态文案覆盖四种状态且不暴露实现术语", () => {
  const texts = (["starting", "ready", "closed", "error"] as const).map(terminalStatusText);
  assert.deepEqual(texts, ["正在打开终端…", "已连接", "终端已关闭", "终端不可用"]);
  for (const text of texts) {
    assert.ok(!/PTY|ConPTY|portable|pty_/.test(text), "界面文案不得出现实现术语：" + text);
  }
});

test("关闭结论：等待超时时如实提示可能有残留进程", () => {
  assert.equal(closeSummary({ existed: true, exited: true }), "终端已关闭，进程已回收");
  assert.match(closeSummary({ existed: true, exited: false }), /可能仍在运行/);
  assert.equal(closeSummary({ existed: false, exited: true }), "终端已关闭");
});

test("回滚行数有界：不把整份输出留在内存里", () => {
  assert.ok(TERMINAL_SCROLLBACK > 0);
  assert.ok(TERMINAL_SCROLLBACK <= 20000, "回滚行数过大会让终端成为内存黑洞");
});

/* ── 4. 前后端契约 ─────────────────────────────────────────── */

test("IPC 名称与 Rust 命令一一对应", async () => {
  const client = await readSource("../src/terminal/ptyClient.ts");
  for (const command of ["create_pty", "write_pty", "resize_pty", "close_pty"]) {
    assert.ok(client.includes('"' + command + '"'), "ptyClient 缺少命令：" + command);
  }
  const rust = await readSource("../../../apps/desktop/src-tauri/src/commands/pty.rs");
  for (const command of ["create_pty", "write_pty", "resize_pty", "close_pty"]) {
    assert.ok(rust.includes("pub async fn " + command), "后端缺少命令：" + command);
  }
});

test("输出事件名两侧一致", async () => {
  assert.equal(PTY_OUTPUT_EVENT_NAME, "soxu://pty-output");
  const rust = await readSource("../../../apps/desktop/src-tauri/src/pty.rs");
  assert.ok(
    rust.includes('"' + PTY_OUTPUT_EVENT_NAME + '"'),
    "后端事件名必须与前端常量一致",
  );
});

test("后端节流窗口是 16ms（验收要求），前端不再叠加第二层节流", async () => {
  const output = await readSource("../../../crates/pty-service/src/output.rs");
  assert.match(
    output,
    /pub const FLUSH_INTERVAL: Duration = Duration::from_millis\(16\)/,
    "输出合并窗口必须保持 16ms",
  );
  const component = await readSource("../src/components/TerminalDrawer.vue");
  assert.ok(
    !component.includes("setTimeout("),
    "组件不得再起一份输出节流定时器（会与后端窗口叠加成可见延迟）",
  );
});

/* ── 5. 组件与外壳接线 ─────────────────────────────────────── */

test("终端组件：先订阅输出再创建 PTY，卸载时取消订阅并 close_pty", async () => {
  const component = await readSource("../src/components/TerminalDrawer.vue");

  const subscribeAt = component.indexOf("await client.onOutput(");
  const createAt = component.indexOf("await client.create(");
  assert.ok(subscribeAt > 0, "必须先订阅输出");
  assert.ok(createAt > subscribeAt, "订阅必须早于创建：否则会丢掉首屏输出");

  assert.ok(component.includes("unsubscribe()"), "卸载时必须取消订阅");
  assert.ok(component.includes("observer.disconnect()"), "ResizeObserver 必须断开");
  assert.ok(component.includes("cancelAnimationFrame(resizeFrame)"), "待执行的帧必须取消");
  assert.ok(component.includes("term.dispose()"), "xterm 必须释放");
  assert.ok(component.includes("await client.close(closing)"), "卸载时必须 close_pty 回收子进程");
  assert.ok(
    component.includes("outputBuffer.push(event)"),
    "创建返回前的输出必须进缓冲，否则首屏会丢",
  );
  assert.ok(
    component.includes("outputBuffer.take(view.ptyId)"),
    "拿到 ptyId 后必须补写缓冲",
  );
  assert.ok(component.includes("onBeforeUnmount("), "清理必须挂在卸载钩子上");
  assert.ok(
    component.includes("onMounted(") && component.includes("ResizeObserver"),
    "尺寸变化必须由 ResizeObserver 驱动",
  );
  assert.ok(
    component.includes("terminal.onResize("),
    "xterm 的 onResize 必须接到 resize_pty",
  );
});

test("终端组件：可访问性与 token 约定", async () => {
  const component = await readSource("../src/components/TerminalDrawer.vue");

  assert.ok(component.includes('aria-label="终端"'), "抽屉必须有可读名称");
  assert.ok(component.includes('aria-label="关闭终端"'), "关闭按钮必须有 aria-label");
  assert.ok(component.includes('type="button"'), "关闭按钮必须是 type=button");
  assert.ok(component.includes('role="status"'), "状态变化必须通过 live region 播报");
  assert.ok(component.includes('role="alert"'), "错误必须通过 alert 播报");
  assert.ok(component.includes("AppTooltip"), "悬浮说明统一走 AppTooltip");

  for (const token of ["var(--bg-panel)", "var(--border)", "var(--fg)", "var(--code-bg)"]) {
    assert.ok(component.includes(token), "缺少 token：" + token);
  }
  // 只看样式段，且先去掉注释：注释里的 Issue 编号不是颜色。
  const style = component.slice(component.indexOf("<style")).replace(/\/\*[\s\S]*?\*\//g, "");
  const hex = style.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
  assert.deepEqual(hex, [], "组件样式里不允许写死颜色");

  // Escape 是终端里的真实按键（vim / less / 菜单）：抽屉不能抢。
  assert.ok(
    !component.includes('@keydown.esc'),
    "不得绑定 Escape 关闭，否则终端里按 Esc 会被抽屉吞掉",
  );
});

test("App.vue 接线：顶栏按钮、Ctrl+` 快捷键、抽屉互斥与卸载回收", async () => {
  const app = await readSource("../src/App.vue");

  assert.ok(app.includes("SquareTerminal"), "顶栏必须有终端入口图标");
  assert.ok(app.includes('aria-keyshortcuts="Control+`"'), "顶栏按钮必须声明 Ctrl+`");
  // 用 code 而不是 key 判定：非美式键盘上反引号键位不同，key 会变。
  const shortcutAt = app.indexOf('event.code === "Backquote"');
  assert.ok(shortcutAt > 0, "Ctrl+` 快捷键必须按 event.code 判定");
  assert.ok(
    app.indexOf("toggleTerminal();", shortcutAt) > shortcutAt,
    "Ctrl+` 必须开关终端",
  );
  assert.match(
    app,
    /function openTerminal\(\)[\s\S]{0,400}terminalDrawer\.value\?\.focus\(\)/,
    "打开后焦点必须进到终端",
  );

  // 三块右侧面板互斥：打开任何一个都要收起另外两个。
  assert.match(app, /function openTerminal\(\)[\s\S]{0,300}inspectorOpen\.value = false/);
  assert.match(app, /function openTerminal\(\)[\s\S]{0,300}searchOpen\.value = false/);
  assert.match(app, /function openSearch\(\)[\s\S]{0,300}terminalOpen\.value = false/);
  assert.match(
    app,
    /watch\(inspectorOpen, \(open\) => \{\s*if \(open\) searchOpen\.value = false;\s*if \(open\) terminalOpen\.value = false;/,
    "打开会话状态面板时必须收起终端",
  );

  // key 绑定会话：切换会话就重建终端（旧的 unmount 会 close_pty）。
  assert.ok(
    app.includes(':key="activeTab?.sessionId'),
    "终端组件必须以 sessionId 为 key，否则切换会话会复用旧 PTY",
  );
  assert.ok(app.includes(':session-id="activeTab?.sessionId ?? null"'), "必须绑定当前会话");
  assert.ok(app.includes('@close="closeTerminal"'), "抽屉的关闭事件必须真的关掉面板");
});
