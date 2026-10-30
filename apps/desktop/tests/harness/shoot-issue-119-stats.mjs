/**
 * Issue #119（TASK-027）的可复现证据脚本：上下文环配色、占位规则与统计浮窗。
 *
 * 用法（仓库任意位置）：
 *   node apps/desktop/tests/harness/shoot-issue-119-stats.mjs
 *
 * 它自己拉起 Vite（默认 1427 端口）和一个独立 profile 的 headless Edge，
 * 通过 CDP（Node 26 自带 WebSocket）读取真实计算样式、点击打开浮窗并截图，
 * 最后把指标写进 docs/development/evidence/issue-119-session-stats/metrics.json。
 * 不依赖 Playwright/Puppeteer，结束后回收两个子进程。
 *
 * 量到的是什么：圆环描边的**计算后颜色**（不是源码里的字符串）、四档 data-tone、
 * 空态统计行的每一项文本，以及浮窗里真实渲染出来的分组与数值。
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(HERE, "../..");
const REPO_ROOT = resolve(APP_ROOT, "../..");
const OUT_DIR = join(REPO_ROOT, "docs", "development", "evidence", "issue-119-session-stats");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = Number(process.env.SOXU_HARNESS_PORT ?? 1427);
const DEBUG_PORT = Number(process.env.SOXU_CDP_PORT ?? 9459);
const BASE_URL = "http://127.0.0.1:" + PORT + "/tests/harness/session-stats.html";
const VIEWPORT = { width: 720, height: 560 };

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
  await sleep(160);
}

/** 读取四组夹具的真实 DOM 状态：data-tone、计算后描边色、读屏标签与统计行文本。 */
const PROBE = `(() => {
  const cases = [...document.querySelectorAll('.harness-case')].map((section) => {
    const ring = section.querySelector('.stats-ring');
    const value = section.querySelector('.ring-value');
    const row = [...section.querySelectorAll('.stats-row .stat')].map((item) => ({
      label: item.querySelector('dt').textContent.trim(),
      value: item.querySelector('dd').textContent.trim(),
    }));
    return {
      key: section.dataset.case,
      tone: ring ? ring.dataset.tone : null,
      stroke: value ? getComputedStyle(value).stroke : null,
      ariaLabel: ring ? ring.getAttribute('aria-label') : null,
      row,
    };
  });
  return { cases };
})()`;

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), "soxu-119-edge-"));

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
      shots: [],
      checks: [],
      observed: null,
    };
    const check = (name, ok, actual) => report.checks.push({ name, ok, actual });

    await cdp.send("Page.navigate", { url: BASE_URL });
    await waitFor("夹具挂载", async () =>
      cdp.evaluate("Boolean(window.__soxuStats) && document.querySelectorAll('.harness-case').length === 4"),
    );
    await cdp.evaluate(
      "new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))",
    );

    const observed = await cdp.evaluate(PROBE);
    report.observed = observed;
    const byKey = Object.fromEntries(observed.cases.map((item) => [item.key, item]));

    check("四档 data-tone：accent / warn / danger / unknown", [
      byKey.accent?.tone,
      byKey.warn?.tone,
      byKey.danger?.tone,
      byKey.empty?.tone,
    ].join(",") === "accent,warn,danger,unknown", [
      byKey.accent?.tone,
      byKey.warn?.tone,
      byKey.danger?.tone,
      byKey.empty?.tone,
    ]);

    const strokes = [byKey.accent?.stroke, byKey.warn?.stroke, byKey.danger?.stroke];
    check("三档描边色互不相同", new Set(strokes).size === 3, strokes);
    check(
      "无窗口信息时不画弧（没有 ring-value）",
      byKey.empty?.stroke === null,
      byKey.empty?.stroke,
    );
    check(
      "圆环读屏标签写明占用率",
      typeof byKey.danger?.ariaLabel === "string" && byKey.danger.ariaLabel.includes("92.0%"),
      byKey.danger?.ariaLabel,
    );

    const emptyRow = byKey.empty?.row ?? [];
    check(
      "空态统计行每一项都是占位（不是 0）",
      emptyRow.length === 7 && emptyRow.every((item) => item.value.includes("—")),
      emptyRow,
    );

    const sampledRow = byKey.danger?.row ?? [];
    const rowText = sampledRow.map((item) => item.label + "=" + item.value).join(" | ");
    check(
      "有数据时统计行给出真实数值",
      sampledRow.some((item) => item.value === "2.40 s") &&
        sampledRow.some((item) => item.value === "80.0%") &&
        sampledRow.some((item) => item.value === "420 ms"),
      rowText,
    );

    report.shots.push(await screenshot(cdp, "stats-rings.png"));

    // 点开浮窗：验证四组指标与降级说明真的渲染出来。
    await click(cdp, '.harness-case[data-case="danger"] .stats-ring');
    await waitFor("统计浮窗", async () =>
      cdp.evaluate("Boolean(document.querySelector('.soxu-stats-popover'))"),
    );
    await cdp.evaluate(
      "new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))",
    );
    const popoverText = await cdp.evaluate(
      "document.querySelector('.soxu-stats-popover').innerText",
    );
    report.observed.popoverText = popoverText;
    // 浮窗必须是不透明的浮层：透明底会让下面的卡片透上来，读不清。
    const popoverStyle = await cdp.evaluate(
      `(() => { const el = document.querySelector('.soxu-stats-popover'); const cs = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return { background: cs.backgroundColor, fontSize: cs.fontSize, zIndex: cs.zIndex,
          rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) } }; })()`,
    );
    report.observed.popoverStyle = popoverStyle;
    check(
      "浮窗背景不透明",
      typeof popoverStyle.background === "string" &&
        popoverStyle.background !== "rgba(0, 0, 0, 0)" &&
        popoverStyle.background !== "transparent",
      popoverStyle.background,
    );
    check(
      "浮窗字号不超过 12px（浮层不是正文）",
      Number.parseFloat(popoverStyle.fontSize) <= 12,
      popoverStyle.fontSize,
    );
    for (const expected of ["上下文", "上一轮", "进程", "会话", "已用", "重试预算"]) {
      check("浮窗包含「" + expected + "」", popoverText.includes(expected), expected);
    }
    check(
      "浮窗展示 CPU 不可用的原因",
      popoverText.includes("不提供 CPU 占用"),
      popoverText.includes("不提供 CPU 占用"),
    );
    report.shots.push(await screenshot(cdp, "stats-popover.png"));

    check("页面没有脚本异常", cdp.errors.length === 0, cdp.errors);

    const failed = report.checks.filter((item) => !item.ok);
    report.passed = failed.length === 0;
    await writeFile(join(OUT_DIR, "metrics.json"), JSON.stringify(report, null, 2) + "\n");

    for (const item of report.checks) {
      console.log((item.ok ? "[PASS] " : "[FAIL] ") + item.name + " :: " + JSON.stringify(item.actual));
    }
    console.log("截图：" + report.shots.join(", "));
    if (!report.passed) {
      process.exitCode = 1;
    }
  } finally {
    cdp.close();
    killTree(edge?.pid);
    killTree(vite.pid);
  }
}

await main();
