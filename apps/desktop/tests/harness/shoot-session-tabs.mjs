/**
 * Issue #99 的可复现证据脚本：等宽（1/3/8 个 Tab）、拖拽排序（鼠标 + 触屏）、
 * 键盘导航回归、reduced-motion 退化，一次跑完并落盘截图与原始数值。
 *
 * 用法（仓库任意位置）：
 *   node apps/desktop/tests/harness/shoot-session-tabs.mjs
 *
 * 它自己拉起 Vite（默认 1423 端口）和一个独立 profile 的 headless Edge，
 * 通过 CDP（Node 26 自带 WebSocket）派发真实的鼠标/触屏/键盘事件，
 * 结束后回收两个子进程，不依赖 Playwright/Puppeteer。
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(HERE, "../..");
const REPO_ROOT = resolve(APP_ROOT, "../..");
const OUT_DIR = join(REPO_ROOT, "docs", "development", "evidence", "issue-99-tab-width-drag");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = Number(process.env.SOXU_HARNESS_PORT ?? 1423);
const DEBUG_PORT = Number(process.env.SOXU_CDP_PORT ?? 9455);
const BASE_URL = `http://127.0.0.1:${PORT}/tests/harness/session-tabs.html`;
const VIEWPORT = { width: 1280, height: 720 };

/** 页面侧异常/错误日志；夹具失败时一并打印，避免无头环境里只能看到「等待超时」。 */
let pageErrors = [];

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

async function waitFor(label, probe, { timeout = 30_000, interval = 250 } = {}) {
  const started = Date.now();
  for (;;) {
    try {
      const value = await probe();
      if (value) return value;
    } catch {
      // 还没起来，继续等。
    }
    if (Date.now() - started > timeout) throw new Error(`等待超时：${label}`);
    await sleep(interval);
  }
}

function killTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
  else process.kill(-pid, "SIGKILL");
}

class Cdp {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.sequence = 0;
    this.pending = new Map();
    this.errors = [];
  }

  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((done, fail) => {
      this.ws.onopen = () => done();
      this.ws.onerror = (event) => fail(new Error(`CDP 连接失败：${event?.message ?? "unknown"}`));
    });
    this.ws.onmessage = (event) => {
      const payload = JSON.parse(event.data);
      if (payload.id === undefined) {
        // 页面异常/日志留档：夹具报错时这是唯一能直接看到的线索。
        if (payload.method === "Runtime.exceptionThrown") {
          this.errors.push(payload.params.exceptionDetails.exception?.description ?? payload.params.exceptionDetails.text);
        } else if (payload.method === "Runtime.consoleAPICalled") {
          const text = payload.params.args.map((arg) => arg.value ?? arg.description ?? "").join(" ");
          if (payload.params.type === "error" || payload.params.type === "warning") this.errors.push(text);
        }
        return;
      }
      const entry = this.pending.get(payload.id);
      if (!entry) return;
      this.pending.delete(payload.id);
      if (payload.error) entry.fail(new Error(`${payload.error.message}`));
      else entry.done(payload.result);
    };
  }

  send(method, params = {}) {
    this.sequence += 1;
    const id = this.sequence;
    return new Promise((done, fail) => {
      this.pending.set(id, { done, fail });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? "页面脚本异常");
    }
    return result.result.value;
  }

  close() {
    this.ws?.close();
    this.ws = null;
  }
}

async function screenshot(cdp, name) {
  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  const file = join(OUT_DIR, name);
  await writeFile(file, Buffer.from(shot.data, "base64"));
  return name;
}

/** 读取当前 Tab 栏的几何与状态：宽度是否统一、是否进入横向滚动、选中项与顺序。 */
const MEASURE = `(() => {
  const items = Array.from(document.querySelectorAll(".tab-item"));
  const scroll = document.querySelector(".tabs-scroll");
  const widths = items.map((item) => Math.round(item.getBoundingClientRect().width * 100) / 100);
  const lefts = items.map((item) => Math.round(item.getBoundingClientRect().left));
  const titles = items.map((item) => item.querySelector(".tab-title"));
  return {
    count: items.length,
    widths,
    uniform: widths.every((width) => width === widths[0]),
    lefts,
    gaps: lefts.slice(1).map((left, index) => left - (lefts[index] + widths[index])),
    truncated: titles.map((title) => ({
      client: title?.clientWidth ?? 0,
      scroll: title?.scrollWidth ?? 0,
      ellipsis: title ? getComputedStyle(title).textOverflow : null,
    })),
    selected: items.map((item) => item.querySelector(".tab")?.getAttribute("aria-selected")),
    scrollWidth: scroll ? scroll.scrollWidth : null,
    clientWidth: scroll ? scroll.clientWidth : null,
    scrollable: scroll ? scroll.scrollWidth > scroll.clientWidth + 1 && getComputedStyle(scroll).overflowX === "auto" : false,
    tabWidthVar: scroll ? getComputedStyle(scroll).getPropertyValue("--soxu-tab-width").trim() : null,
    transitionProperty: items[0] ? getComputedStyle(items[0]).transitionProperty : null,
    order: window.__soxuTabs.order(),
    active: window.__soxuTabs.active(),
  };
})()`;

function centerOf(rect) {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

async function itemRects(cdp) {
  return cdp.evaluate(
    `Array.from(document.querySelectorAll(".tab-item")).map((item) => { const rect = item.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }; })`,
  );
}

async function openPage(cdp, count) {
  await cdp.send("Page.navigate", { url: `${BASE_URL}?count=${count}` });
  try {
    await waitFor(`count=${count} 的 Tab 栏`, async () =>
      (await cdp.evaluate(
        `document.querySelectorAll(".tab-item").length === ${count} && Boolean(window.__soxuTabs)`,
      )),
    );
  } catch (error) {
    // 等待失败时把页面现状一起带出来，否则无头环境只能看到一句超时。
    const info = await cdp.evaluate(
      `({ href: location.href, readyState: document.readyState, title: document.title, tabs: document.querySelectorAll(".tab-item").length, html: document.body.innerHTML.slice(0, 300) })`,
    );
    throw new Error(`${error.message} :: ${JSON.stringify(info)}`);
  }
  // 等两帧，确保 ResizeObserver 已经量过宽度、字体也已生效。
  await cdp.evaluate("new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))");
  await sleep(120);
}

async function measure(cdp, count) {
  await openPage(cdp, count);
  return cdp.evaluate(MEASURE);
}

async function setViewport(cdp, width) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width,
    height: VIEWPORT.height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(120);
}

async function mouseDrag(cdp, points, { release = true } = {}) {
  const [first, ...rest] = points;
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: first.x,
    y: first.y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  for (const point of rest) {
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: point.x,
      y: point.y,
      button: "left",
      buttons: 1,
    });
    await sleep(16);
  }
  if (!release) return;
  const last = points.at(-1);
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: last.x,
    y: last.y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
  await sleep(180);
}

function line(from, to, steps = 12) {
  return Array.from({ length: steps + 1 }, (_, index) => ({
    x: from.x + ((to.x - from.x) * index) / steps,
    y: from.y + ((to.y - from.y) * index) / steps,
  }));
}

async function touchDrag(cdp, points) {
  const [first, ...rest] = points;
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: first.x, y: first.y, id: 1 }],
  });
  for (const point of rest) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: point.x, y: point.y, id: 1 }],
    });
    await sleep(16);
  }
  const last = points.at(-1);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await sleep(220);
  return last;
}

async function pressKey(cdp, key, code, virtualKeyCode) {
  await cdp.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key,
    code,
    windowsVirtualKeyCode: virtualKeyCode,
    nativeVirtualKeyCode: virtualKeyCode,
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key,
    code,
    windowsVirtualKeyCode: virtualKeyCode,
    nativeVirtualKeyCode: virtualKeyCode,
  });
  await sleep(120);
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), "soxu-99-edge-"));

  const vite = spawn(
    process.platform === "win32" ? "pnpm.cmd" : "pnpm",
    ["exec", "vite", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"],
    { cwd: APP_ROOT, shell: process.platform === "win32", stdio: "ignore" },
  );
  let edge = null;
  const cdp = new Cdp("");
  try {
    await waitFor("Vite 开发服务器", async () => {
      const response = await fetch(`http://127.0.0.1:${PORT}/`, { method: "HEAD" });
      return response.ok;
    });

    edge = spawn(EDGE, [
      "--headless=new",
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--disable-extensions",
      "--hide-scrollbars",
      "--disable-gpu",
      "about:blank",
    ], { stdio: "ignore" });

    const target = await waitFor("Chromium CDP", async () => {
      const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?about:blank`, { method: "PUT" });
      const created = await response.json();
      return created?.webSocketDebuggerUrl ? created : null;
    });

    cdp.url = target.webSocketDebuggerUrl;
    await cdp.connect();
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      deviceScaleFactor: 1,
      mobile: false,
    });

    const report = { generatedAt: new Date().toISOString(), viewport: VIEWPORT, browser: await cdp.send("Browser.getVersion").then((info) => info.product) };

    // ---- 1/3/8 个 Tab 的等宽与截图
    report.widths = {};
    for (const count of [1, 3, 8]) {
      const measured = await measure(cdp, count);
      report.widths[count] = measured;
      await screenshot(cdp, `0${[1, 3, 8].indexOf(count) + 1}-tabs-${count}.png`);
    }

    // ---- 窄窗口：等宽被下限夹住时进入横向滚动（3 个 Tab 仍未到上限，宽度继续随数量变化）
    await setViewport(cdp, 620);
    report.narrow = {};
    report.narrow["3"] = await measure(cdp, 3);
    await screenshot(cdp, "07-tabs-3-narrow-620.png");
    report.narrow["8"] = await measure(cdp, 8);
    await screenshot(cdp, "08-tabs-8-narrow-620.png");
    report.narrow["8"].scrolledBy = await cdp.evaluate(`(() => {
      const scroll = document.querySelector(".tabs-scroll");
      if (!scroll) return null;
      scroll.scrollLeft = scroll.scrollWidth;
      return scroll.scrollLeft;
    })()`);
    await sleep(160);
    await screenshot(cdp, "09-tabs-8-narrow-scrolled-end.png");
    await setViewport(cdp, VIEWPORT.width);

    // ---- 鼠标拖拽：8 个 Tab 时把第 1 个拖过第 4 个 Tab 的中心（落位到第 4 个位置）
    await openPage(cdp, 8);
    let rects = await itemRects(cdp);
    const mouseStart = centerOf(rects[0]);
    const mouseTarget = { x: centerOf(rects[3]).x + 40, y: centerOf(rects[3]).y };
    await mouseDrag(cdp, line(mouseStart, mouseTarget), { release: false });
    report.mouseDragMid = await cdp.evaluate(MEASURE);
    report.mouseDragMid.markers = await cdp.evaluate(
      `document.querySelectorAll(".drop-marker").length`,
    );
    report.mouseDragMid.tooltips = await cdp.evaluate(
      `Array.from(document.querySelectorAll(".soxu-tooltip")).map((node) => ({ text: node.textContent?.trim(), state: node.getAttribute("data-state"), display: getComputedStyle(node).display }))`,
    );
    await screenshot(cdp, "04-drag-mid-mouse-8tabs.png");
    const lastMouse = line(mouseStart, mouseTarget).at(-1);
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: lastMouse.x,
      y: lastMouse.y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
    await sleep(220);
    report.mouseDragAfter = await cdp.evaluate(MEASURE);

    // ---- 触屏拖拽：把第 1 个拖回第 3 个位置
    await openPage(cdp, 8);
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
    rects = await itemRects(cdp);
    const touchStart = centerOf(rects[0]);
    const touchTarget = centerOf(rects[2]);
    const touchPoints = line(touchStart, touchTarget);
    // 先按住并移动到一半，截图证明触屏同样进入拖动状态。
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: touchPoints[0].x, y: touchPoints[0].y, id: 1 }],
    });
    for (const point of touchPoints.slice(1, 8)) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: point.x, y: point.y, id: 1 }],
      });
      await sleep(16);
    }
    report.touchDragMid = await cdp.evaluate(MEASURE);
    await screenshot(cdp, "05-drag-mid-touch-8tabs.png");
    for (const point of touchPoints.slice(8)) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: point.x, y: point.y, id: 1 }],
      });
      await sleep(16);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await sleep(240);
    report.touchDragAfter = await cdp.evaluate(MEASURE);
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });

    // ---- 阈值：小于 6px 的移动必须退化为点击（不排序，但点击照常切换会话）
    await openPage(cdp, 8);
    rects = await itemRects(cdp);
    const tiny = centerOf(rects[2]);
    await mouseDrag(cdp, line(tiny, { x: tiny.x + 3, y: tiny.y }, 3));
    report.belowThreshold = await cdp.evaluate(MEASURE);

    // ---- 关闭一个 Tab 之后再拖：ref 数组可能残留旧元素，落位不能整体偏一格
    await openPage(cdp, 8);
    const closeRect = await cdp.evaluate(
      `(() => { const rect = document.querySelectorAll(".tab-close")[1]?.getBoundingClientRect(); return rect ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : null; })()`,
    );
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: closeRect.x, y: closeRect.y, button: "left", buttons: 1, clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: closeRect.x, y: closeRect.y, button: "left", buttons: 0, clickCount: 1 });
    await sleep(240);
    rects = await itemRects(cdp);
    const afterCloseStart = centerOf(rects[0]);
    const afterCloseTarget = { x: centerOf(rects[3]).x + 40, y: centerOf(rects[3]).y };
    const afterCloseLine = line(afterCloseStart, afterCloseTarget);
    await mouseDrag(cdp, afterCloseLine, { release: false });
    report.closeThenDragMid = {
      markers: await cdp.evaluate(`document.querySelectorAll(".drop-marker").length`),
      dragging: await cdp.evaluate(`document.querySelectorAll(".tab-item.dragging").length`),
      rectCount: rects.length,
    };
    const afterCloseLast = afterCloseLine.at(-1);
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: afterCloseLast.x,
      y: afterCloseLast.y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
    await sleep(220);
    report.closeThenDrag = await cdp.evaluate(MEASURE);

    // ---- 键盘导航回归：方向键切换 + 焦点跟随
    await openPage(cdp, 3);
    await cdp.evaluate(`document.querySelectorAll(".tab")[0]?.focus()`);
    await pressKey(cdp, "ArrowRight", "ArrowRight", 39);
    const afterRight = await cdp.evaluate(`({
      active: window.__soxuTabs.active(),
      focusedId: document.activeElement?.id ?? null,
      selected: Array.from(document.querySelectorAll(".tab")).map((tab) => tab.getAttribute("aria-selected")),
    })`);
    await pressKey(cdp, "ArrowLeft", "ArrowLeft", 37);
    const afterLeft = await cdp.evaluate(`({
      active: window.__soxuTabs.active(),
      focusedId: document.activeElement?.id ?? null,
      selected: Array.from(document.querySelectorAll(".tab")).map((tab) => tab.getAttribute("aria-selected")),
    })`);
    await pressKey(cdp, "Delete", "Delete", 46);
    const afterDelete = await cdp.evaluate(`({
      count: window.__soxuTabs.count(),
      active: window.__soxuTabs.active(),
    })`);
    report.keyboard = { afterRight, afterLeft, afterDelete };

    // ---- reduced-motion：平移动画退化为瞬时
    await cdp.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    await openPage(cdp, 8);
    rects = await itemRects(cdp);
    const reduceStart = centerOf(rects[0]);
    const reduceTarget = centerOf(rects[3]);
    await mouseDrag(cdp, line(reduceStart, reduceTarget), { release: false });
    report.reducedMotion = await cdp.evaluate(MEASURE);
    await screenshot(cdp, "06-reduced-motion-drag-8tabs.png");
    const reduceLast = line(reduceStart, reduceTarget).at(-1);
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: reduceLast.x,
      y: reduceLast.y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
    await sleep(200);
    report.reducedMotionAfter = await cdp.evaluate(MEASURE);
    await cdp.send("Emulation.setEmulatedMedia", { features: [] });

    // ---- AppTooltip 改成受控开关后，普通气泡仍要照常出现（回归 issue #96 的行为）
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/` });
    await waitFor("应用外壳", async () => (await cdp.evaluate(`Boolean(document.querySelector(".app-shell"))`)));
    const sidebarButton = await cdp.evaluate(
      `(() => { const button = document.querySelector('[aria-label="收起侧栏"]') ?? document.querySelector(".icon-button"); if (!button) return null; const rect = button.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; })()`,
    );
    if (sidebarButton) {
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 4, y: 200 });
      await sleep(120);
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: sidebarButton.x, y: sidebarButton.y });
      await sleep(900);
      report.appTooltip = await cdp.evaluate(
        `Array.from(document.querySelectorAll(".soxu-tooltip")).map((node) => ({ text: node.textContent?.trim(), state: node.getAttribute("data-state") }))`,
      );
      await screenshot(cdp, "10-app-tooltip-regression.png");
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 4, y: 400 });
      await sleep(700);
      report.appTooltipAfterLeave = await cdp.evaluate(`document.querySelectorAll(".soxu-tooltip").length`);
    }

    await writeFile(join(OUT_DIR, "screens.json"), JSON.stringify(report, null, 2), "utf8");
    console.log(JSON.stringify({
      widths: Object.fromEntries(
        Object.entries(report.widths).map(([count, value]) => [count, {
          widths: value.widths,
          gaps: value.gaps,
          uniform: value.uniform,
          tabWidthVar: value.tabWidthVar,
          scrollable: value.scrollable,
          scrollWidth: value.scrollWidth,
          clientWidth: value.clientWidth,
        }]),
      ),
      narrow: Object.fromEntries(
        Object.entries(report.narrow).map(([count, value]) => [count, {
          widths: value.widths,
          tabWidthVar: value.tabWidthVar,
          scrollable: value.scrollable,
          scrollWidth: value.scrollWidth,
          clientWidth: value.clientWidth,
          scrolledBy: value.scrolledBy ?? null,
        }]),
      ),
      drag: {
        mouseOrderAfter: report.mouseDragAfter.order,
        mouseActiveAfter: report.mouseDragAfter.active,
        mouseMarkerCount: report.mouseDragMid.markers,
        touchOrderAfter: report.touchDragAfter.order,
        belowThresholdOrder: report.belowThreshold.order,
        belowThresholdActive: report.belowThreshold.active,
        afterCloseOrder: report.closeThenDrag.order,
        afterCloseCount: report.closeThenDrag.count,
        afterCloseDragEngaged: report.closeThenDragMid,
      },
      keyboard: report.keyboard,
      reducedMotionTransition: report.reducedMotion.transitionProperty,
      appTooltip: report.appTooltip,
      appTooltipAfterLeave: report.appTooltipAfterLeave,
    }, null, 2));
  } finally {
    pageErrors = cdp.errors;
    cdp.close();
    killTree(edge?.pid);
    killTree(vite.pid);
    // 临时 profile 也由脚本负责清掉：跑一次就留一堆目录会让 %TEMP% 慢慢变大。
    // 个别文件可能仍被系统句柄占着，删不掉就忽略（下次手动清理）。
    await rm(profile, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  console.error(`页面错误：${JSON.stringify(pageErrors, null, 2)}`);
  process.exitCode = 1;
});
