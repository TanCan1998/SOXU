/**
 * Issue #118（TASK-026）的可复现证据脚本：搜索抽屉的三态、命中高亮与点击跳转。
 *
 * 用法（仓库任意位置）：
 *   node apps/desktop/tests/harness/shoot-issue-118-search.mjs
 *
 * 它自己拉起 Vite（默认 1426 端口）和一个独立 profile 的 headless Edge，
 * 通过 CDP（Node 26 自带 WebSocket）真实输入、点击并截图，最后把指标写进
 * docs/development/evidence/issue-118-search-drawer/metrics.json。
 * 不依赖 Playwright/Puppeteer，结束后回收两个子进程。
 *
 * 量到的是什么：夹具里的「后端」是 fakeSearch（固定 1 ms），因此 latencyMs 反映的是
 * 「防抖窗口 + 状态写回 + 一帧渲染」的端到端延迟；真实 IPC 的查询耗时实测 5–9 ms
 * （见 docs/development/session-search.md 第 8 节），两者相加仍低于验收的 250 ms。
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(HERE, "../..");
const REPO_ROOT = resolve(APP_ROOT, "../..");
const OUT_DIR = join(REPO_ROOT, "docs", "development", "evidence", "issue-118-search-drawer");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = Number(process.env.SOXU_HARNESS_PORT ?? 1426);
const DEBUG_PORT = Number(process.env.SOXU_CDP_PORT ?? 9458);
const BASE_URL = "http://127.0.0.1:" + PORT + "/tests/harness/search-drawer.html";
const VIEWPORT = { width: 1280, height: 720 };

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
  await sleep(120);
}

/** 真实键盘输入：走浏览器默认的 input 事件，等价于用户逐字打字。 */
async function typeText(cdp, text) {
  await cdp.send("Input.insertText", { text });
}

function isDark(color) {
  const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(color ?? "");
  if (!match) return false;
  const [r, g, b] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.4;
}

function descending(values) {
  return values.every((value, index) => index === 0 || values[index - 1] > value);
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), "soxu-118-edge-"));

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
      const response = await fetch(
        "http://127.0.0.1:" + DEBUG_PORT + "/json/new?about:blank",
        { method: "PUT" },
      );
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
    };

    const check = (name, ok, actual) => report.checks.push({ name, ok, actual });

    await cdp.send("Page.navigate", { url: BASE_URL });
    await waitFor("夹具挂载", async () =>
      cdp.evaluate("Boolean(window.__soxuSearch) && Boolean(document.querySelector('.sx-field'))"),
    );
    await cdp.evaluate(
      "new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))",
    );

    // ── 1. 空态
    const empty = await cdp.evaluate("window.__soxuSearch.state()");
    report.empty = empty;
    report.shots.push(await screenshot(cdp, "01-light-empty.png"));
    check("empty-state", empty.status === "empty" && empty.count === "", empty);

    // ── 2. 输入 → 结果（量防抖 + 渲染延迟）
    await click(cdp, ".sx-field");
    await typeText(cdp, "扩散");
    await waitFor("搜索结果", async () =>
      cdp.evaluate("document.querySelectorAll('.sx-item').length > 0"),
    );
    const timing = await cdp.evaluate("window.__soxuSearch.timing()");
    const results = await cdp.evaluate("window.__soxuSearch.state()");
    report.timing = timing;
    report.results = results;
    report.shots.push(await screenshot(cdp, "02-light-results.png"));

    check("debounce-budget", timing.debounceMs > 0 && timing.debounceMs <= 250, timing);
    check(
      "latency-within-250ms",
      typeof timing.latencyMs === "number" && timing.latencyMs <= 250,
      timing.latencyMs,
    );
    check("hits-rendered", results.hits === 6, results.hits);
    check(
      "newest-first",
      results.ordinals[0] === 54 && descending(results.ordinals),
      results.ordinals,
    );
    check(
      "match-highlight",
      results.marks >= 1 && results.markText === "扩散",
      { marks: results.marks, markText: results.markText },
    );
    check("count-text", results.count === "6 条匹配 · 扫描 60 条", results.count);

    // ── 3. 点击第一条 → 定位到对应消息并高亮
    await click(cdp, ".sx-item");
    await waitFor("命中消息高亮", async () =>
      cdp.evaluate("document.querySelector('.message[data-highlight=\"true\"]') !== null"),
    );
    const highlight = await cdp.evaluate("window.__soxuSearch.highlight()");
    report.jump = highlight;
    report.shots.push(await screenshot(cdp, "03-light-jumped.png"));
    check(
      "jump-highlight",
      highlight.present && highlight.text.includes("第 54 条"),
      highlight,
    );

    // ── 4. 搜索中
    await cdp.evaluate("window.__soxuSearch.patch({ loading: true })");
    const searching = await cdp.evaluate("window.__soxuSearch.state()");
    report.searching = searching;
    report.shots.push(await screenshot(cdp, "04-light-searching.png"));
    check(
      "searching-state",
      searching.status === "searching" && searching.count === "搜索中…",
      searching,
    );

    // ── 5. 无结果
    await cdp.evaluate("window.__soxuSearch.patch({ loading: false })");
    await cdp.evaluate("window.__soxuSearch.type('不存在的关键词')");
    await waitFor("无结果态", async () =>
      cdp.evaluate("Boolean(document.querySelector('.sx-empty-note'))"),
    );
    const noResults = await cdp.evaluate("window.__soxuSearch.state()");
    report.noResults = noResults;
    report.shots.push(await screenshot(cdp, "05-light-no-results.png"));
    check("no-results-state", noResults.status === "no-results", noResults);

    // ── 6. 错误态
    await cdp.evaluate("window.__soxuSearch.type('扩散')");
    await waitFor("搜索结果", async () =>
      cdp.evaluate("document.querySelectorAll('.sx-item').length > 0"),
    );
    await cdp.evaluate(
      "window.__soxuSearch.patch({ error: 'E_SESSION_FILE_MISSING: 会话文件不存在', hits: [], totalHits: 0 })",
    );
    const failure = await cdp.evaluate("window.__soxuSearch.state()");
    report.error = failure;
    report.shots.push(await screenshot(cdp, "06-light-error.png"));
    check("error-state", failure.status === "error" && failure.count === "搜索失败", failure);

    // ── 7. 截断说明（命中超过 limit 时只拿到最早的一批）
    await cdp.evaluate("window.__soxuSearch.patch({ error: null })");
    await cdp.evaluate("window.__soxuSearch.type('扩散')");
    await waitFor("搜索结果", async () =>
      cdp.evaluate("document.querySelectorAll('.sx-item').length > 0"),
    );
    await cdp.evaluate("window.__soxuSearch.patch({ truncated: true, totalHits: 206 })");
    const truncated = await cdp.evaluate("window.__soxuSearch.state()");
    report.truncated = truncated;
    report.shots.push(await screenshot(cdp, "07-light-truncated.png"));
    check(
      "truncated-notice",
      truncated.count.includes("最早的 6 条") && (truncated.notice ?? "").includes("最早的 6 条"),
      truncated,
    );

    // ── 8. 深色主题下的结果列表
    await cdp.evaluate("window.__soxuSearch.patch({ truncated: false, totalHits: 6 })");
    await cdp.evaluate("window.__soxuSearch.setTheme('dark')");
    await sleep(120);
    const darkBackground = await cdp.evaluate("window.__soxuSearch.drawerBackground()");
    report.dark = { background: darkBackground };
    report.shots.push(await screenshot(cdp, "08-dark-results.png"));
    check("dark-drawer", isDark(darkBackground), darkBackground);
    await cdp.evaluate("window.__soxuSearch.setTheme('light')");

    // ── 9. 无障碍语义
    const a11y = await cdp.evaluate(
      "({ inputLabel: document.querySelector('.sx-field')?.getAttribute('aria-label') ?? null," +
        " metaRole: document.querySelector('.sx-meta')?.getAttribute('role') ?? null," +
        " closeLabel: Array.from(document.querySelectorAll('button'))" +
        ".map((b) => b.getAttribute('aria-label'))" +
        ".find((label) => label === '关闭搜索') ?? null," +
        " drawerLabel: document.querySelector('.search-drawer')?.getAttribute('aria-label') ?? null })",
    );
    report.a11y = a11y;
    check(
      "a11y",
      a11y.inputLabel === "搜索本会话" &&
        a11y.metaRole === "status" &&
        a11y.closeLabel === "关闭搜索" &&
        a11y.drawerLabel === "会话搜索",
      a11y,
    );

    check("no-page-errors", cdp.errors.length === 0, cdp.errors);
    report.ok = report.checks.every((item) => item.ok);

    await writeFile(join(OUT_DIR, "metrics.json"), JSON.stringify(report, null, 2) + "\n", "utf8");

    for (const item of report.checks) {
      console.log((item.ok ? "PASS " : "FAIL ") + item.name + " → " + JSON.stringify(item.actual));
    }
    console.log("shots: " + report.shots.join(", "));
    if (!report.ok) process.exitCode = 1;
  } finally {
    cdp.close();
    killTree(edge?.pid);
    killTree(vite.pid);
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}

await main();
