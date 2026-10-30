/**
 * Issue #122（TASK-030）的可复现证据脚本：终端抽屉的渲染、交互与节流。
 *
 * 用法（仓库任意位置）：
 *   node apps/desktop/tests/harness/shoot-issue-122-terminal.mjs
 *
 * 它自己拉起 Vite（默认 1427 端口）和一个独立 profile 的 headless Edge，
 * 通过 CDP（Node 26 自带 WebSocket）真实输入、点击并截图，
 * 最后把指标写进 docs/development/evidence/issue-122-pty-terminal/metrics.json。
 * 不依赖 Playwright/Puppeteer，结束后回收两个子进程。
 *
 * 量到的是什么：夹具里的「后端」是 FakePty（按 16ms 批量投递，与 soxu-pty-service 的
 * FLUSH_INTERVAL 一致），因此 burst 用例量的是「合并后的批量输出 → xterm 渲染」的
 * 主线程表现；真实 PTY 的合并发生在 Rust 侧，见 crates/pty-service/tests/pty_lifecycle.rs。
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
const OUT_DIR = join(REPO_ROOT, "docs", "development", "evidence", "issue-122-pty-terminal");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = Number(process.env.SOXU_HARNESS_PORT ?? 1427);
const DEBUG_PORT = Number(process.env.SOXU_CDP_PORT ?? 9459);
const BASE_URL = "http://127.0.0.1:" + PORT + "/tests/harness/terminal.html";
const VIEWPORT = { width: 1280, height: 720 };
/** 大输出用例的行数：2000 行 ≈ 20 KiB，与 crates 侧集成测试同量级。 */
const BURST_LINES = 2000;

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

async function waitFor(label, probe, { timeout = 30_000, interval = 50 } = {}) {
  const started = Date.now();
  for (;;) {
    try {
      const value = await probe();
      if (value) return value;
    } catch {
      // 还没起来，继续等。
    }
    if (Date.now() - started > timeout) throw new Error("等待超时：" + label);
    await sleep(interval);
  }
}

function killTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    process.kill(-pid, "SIGKILL");
  }
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
      this.ws.onerror = (event) => fail(new Error("CDP 连接失败：" + (event?.message ?? "unknown")));
    });
    this.ws.onmessage = (event) => {
      const payload = JSON.parse(event.data);
      if (payload.id === undefined) {
        if (payload.method === "Runtime.exceptionThrown") {
          this.errors.push(
            payload.params.exceptionDetails.exception?.description ??
              payload.params.exceptionDetails.text,
          );
        } else if (payload.method === "Runtime.consoleAPICalled" && payload.params.type === "error") {
          this.errors.push(
            payload.params.args.map((arg) => arg.value ?? arg.description ?? "").join(" "),
          );
        }
        return;
      }
      const entry = this.pending.get(payload.id);
      if (!entry) return;
      this.pending.delete(payload.id);
      if (payload.error) entry.fail(new Error(payload.error.message));
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
  await writeFile(join(OUT_DIR, name), Buffer.from(shot.data, "base64"));
  return name;
}

async function click(cdp, selector) {
  const point = await cdp.evaluate(
    "(() => { const element = document.querySelector(" +
      JSON.stringify(selector) +
      "); if (!element) return null; const rect = element.getBoundingClientRect();" +
      " return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; })()",
  );
  if (!point) throw new Error("找不到可点击元素：" + selector);
  // 诊断：点击坐标与命中的元素（布局溢出时点击会落到视口外，必须能看出来）。
  const hit = await cdp.evaluate(
    "(() => { const el = document.elementFromPoint(" +
      point.x +
      ", " +
      point.y +
      "); return el ? el.tagName + '.' + String(el.className) : 'none'; })()",
  );
  console.log("click " + selector + " at " + Math.round(point.x) + "," + Math.round(point.y) + " -> " + hit);
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
  await sleep(120);
}

/**
 * 真实键盘输入：先试 Input.insertText（走 textarea 的 input 事件），
 * 若 xterm 没有把数据交给后端（writes 仍是 0），退回逐字符 keyDown。
 */
async function typeIntoTerminal(cdp, text) {
  await cdp.evaluate(
    "(() => { const area = document.querySelector('.xterm-helper-textarea');" +
      " if (area instanceof HTMLTextAreaElement) area.focus(); })()",
  );
  await cdp.send("Input.insertText", { text });
  await sleep(250);
  const writes = await cdp.evaluate("window.__soxuTerminal.state().writes");
  if (writes > 0) return "insertText";
  for (const character of text) {
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      text: character,
      unmodifiedText: character,
      key: character,
    });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: character });
  }
  await sleep(250);
  return "keyDown";
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), "soxu-122-edge-"));

  const vite = spawn(
    process.platform === "win32" ? "pnpm.cmd" : "pnpm",
    ["exec", "vite", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"],
    { cwd: APP_ROOT, shell: process.platform === "win32", stdio: "ignore" },
  );
  let edge = null;
  const cdp = new Cdp("");
  try {
    await waitFor("Vite 开发服务器", async () => {
      const response = await fetch("http://127.0.0.1:" + PORT + "/", { method: "HEAD" });
      return response.ok;
    });

    edge = spawn(
      EDGE,
      [
        "--headless=new",
        "--remote-debugging-port=" + DEBUG_PORT,
        "--user-data-dir=" + profile,
        "--no-first-run",
        "--disable-extensions",
        "--hide-scrollbars",
        "--disable-gpu",
        "about:blank",
      ],
      { stdio: "ignore" },
    );

    const target = await waitFor("Chromium CDP", async () => {
      const response = await fetch("http://127.0.0.1:" + DEBUG_PORT + "/json/new?about:blank", {
        method: "PUT",
      });
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

    const report = {
      generatedAt: new Date().toISOString(),
      viewport: VIEWPORT,
      browser: await cdp.send("Browser.getVersion").then((info) => info.product),
      burstLines: BURST_LINES,
      shots: [],
      checks: [],
    };
    // 边跑边打印：中途失败时也能看到已经通过的项。
    const check = (name, ok, actual) => {
      report.checks.push({ name, ok, actual });
      console.log((ok ? "OK   " : "FAIL ") + name + " " + JSON.stringify(actual));
    };

    await cdp.send("Page.navigate", { url: BASE_URL });
    await waitFor("夹具挂载", async () =>
      cdp.evaluate(
        "Boolean(window.__soxuTerminal) && document.querySelectorAll('.xterm-rows > div').length > 0",
      ),
    );
    await waitFor("终端就绪", async () =>
      cdp.evaluate("window.__soxuTerminal.state().status === '已连接'"),
    );
    await cdp.evaluate(
      "new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))",
    );

    // ── 1. 首屏：输出真的画到了终端里，且 CJK 没有变成替换字符
    const banner = await cdp.evaluate("window.__soxuTerminal.state()");
    report.banner = {
      rows: banner.rows,
      shell: banner.shell,
      status: banner.status,
      firstLine: banner.text.slice(0, 40),
    };
    report.shots.push(await screenshot(cdp, "01-light-terminal.png"));
    check(
      "banner-rendered",
      banner.text.includes("SOXU 索序终端夹具") && banner.text.includes("pty-service"),
      banner.text.slice(0, 80),
    );
    check(
      "cjk-no-mojibake",
      banner.text.includes("索序") && !banner.text.includes("\uFFFD"),
      banner.text.includes("\uFFFD") ? "出现替换字符" : "CJK 完整",
    );
    check("shell-reported", banner.shell === "harness-shell", banner.shell);

    // ── 2. 键盘输入 → onData → write_pty → 回显
    const inputMode = await typeIntoTerminal(cdp, "echo soxu-pty-ok");
    const echoed = await waitFor("输入回显", async () => {
      const state = await cdp.evaluate("window.__soxuTerminal.state()");
      return state.text.includes("echo soxu-pty-ok") ? state : null;
    });
    report.input = { mode: inputMode, writes: echoed.writes };
    check("typed-input-echoed", echoed.writes > 0 && echoed.text.includes("echo soxu-pty-ok"), report.input);

    // ── 3. 大输出：量主线程有没有被卡住（rAF 间隔）
    const burst = await cdp.evaluate(
      "new Promise((done) => {" +
        " const gaps = []; let last = performance.now(); const start = last;" +
        " window.__soxuTerminal.burst(" + BURST_LINES + ");" +
        " function frame(now) {" +
        "   gaps.push(now - last); last = now;" +
        "   const finished = window.__soxuTerminal.hasLine(" + BURST_LINES + ");" +
        "   if ((finished && gaps.length > 2) || performance.now() - start > 30000) {" +
        "     done({ elapsedMs: performance.now() - start, maxGapMs: Math.max(...gaps)," +
        "            frames: gaps.length, finished });" +
        "     return;" +
        "   }" +
        "   requestAnimationFrame(frame);" +
        " }" +
        " requestAnimationFrame(frame);" +
        "})",
    );
    const afterBurst = await cdp.evaluate("window.__soxuTerminal.state()");
    report.burst = { ...burst, lastLine: afterBurst.text.includes("第 " + BURST_LINES + " 行") };
    report.shots.push(await screenshot(cdp, "02-light-burst.png"));
    check(
      "burst-completes",
      burst.finished && report.burst.lastLine,
      { elapsedMs: Math.round(burst.elapsedMs), frames: burst.frames },
    );
    check(
      "burst-keeps-ui-responsive",
      burst.maxGapMs < 100,
      { maxGapMs: Number(burst.maxGapMs.toFixed(1)) },
    );

    // ── 4. 尺寸变化 → resize_pty
    const beforeResize = await cdp.evaluate("window.__soxuTerminal.state()");
    await cdp.evaluate("window.__soxuTerminal.setWidth(520)");
    const resized = await waitFor("尺寸变化触发 resize", async () => {
      const state = await cdp.evaluate("window.__soxuTerminal.state()");
      return state.resizes > beforeResize.resizes ? state : null;
    });
    report.resize = { before: beforeResize.lastSize, after: resized.lastSize };
    check(
      "resize-on-container-change",
      resized.resizes > beforeResize.resizes && resized.lastSize !== null,
      report.resize,
    );

    // ── 5. 深色主题：配色跟着 token 走
    await cdp.evaluate("window.__soxuTerminal.setTheme('dark')");
    await sleep(200);
    const darkBackground = await cdp.evaluate("window.__soxuTerminal.drawerBackground()");
    report.shots.push(await screenshot(cdp, "03-dark-terminal.png"));
    check(
      "dark-theme-applied",
      darkBackground === "rgb(33, 33, 33)",
      darkBackground,
    );

    // ── 6. 关闭：close_pty 被调用一次，组件向上冒泡 close
    await click(cdp, ".terminal-drawer .icon-button");
    await sleep(200);
    const closed = await cdp.evaluate("window.__soxuTerminal.state()");
    report.close = { closes: closed.closes, closeClicks: closed.closeClicks };
    check("close-reclaims-pty", closed.closes === 1, report.close);
    check("close-bubbles-up", closed.closeClicks === 1, report.close);

    report.consoleErrors = cdp.errors;
    check("no-console-errors", cdp.errors.length === 0, cdp.errors.slice(0, 3));

    report.passed = report.checks.filter((item) => item.ok).length;
    report.failed = report.checks.filter((item) => !item.ok).length;
    await writeFile(join(OUT_DIR, "metrics.json"), JSON.stringify(report, null, 2) + "\n");

    console.log("shots: " + report.shots.join(", "));
    console.log("checks: " + report.passed + " passed, " + report.failed + " failed");
    if (report.failed > 0) process.exitCode = 1;
  } finally {
    cdp.close();
    killTree(edge?.pid);
    killTree(vite?.pid);
    // Edge 退出后再删 profile：提前删会让浏览器写回一堆错误。
    await sleep(500);
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }
}

await main();
