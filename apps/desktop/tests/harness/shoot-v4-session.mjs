/**
 * Issue #111（V4-S1）的可复现证据脚本：markdown 渲染 + 发送三选 + 消息操作的视觉与状态。
 *
 * 用法（仓库任意位置）：
 *   node apps/desktop/tests/harness/shoot-v4-session.mjs
 *
 * 它自己拉起 Vite（默认 1424 端口）和一个独立 profile 的 headless Edge，
 * 通过 CDP（Node 26 自带 WebSocket）点击真实的发送选项菜单，
 * 截图并落盘指标（高亮块数、菜单项、置灰项、模式横条文案）。
 * 结束后回收两个子进程，不依赖 Playwright/Puppeteer。
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
const OUT_DIR = join(REPO_ROOT, "docs", "development", "evidence", "issue-111-v4-s1");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = Number(process.env.SOXU_HARNESS_PORT ?? 1424);
const DEBUG_PORT = Number(process.env.SOXU_CDP_PORT ?? 9456);
const BASE_URL = `http://127.0.0.1:${PORT}/tests/harness/v4-session.html`;
const VIEWPORT = { width: 1280, height: 720 };

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

async function waitFor(label, probe, { timeout = 30_000, interval = 200 } = {}) {
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
      this.ws.onerror = (event) => fail(new Error(`CDP 连接失败：${event?.message ?? "unknown"}`));
    });
    this.ws.onmessage = (event) => {
      const payload = JSON.parse(event.data);
      if (payload.id === undefined) {
        if (payload.method === "Runtime.exceptionThrown") {
          this.errors.push(
            payload.params.exceptionDetails.exception?.description ?? payload.params.exceptionDetails.text,
          );
        } else if (payload.method === "Runtime.consoleAPICalled") {
          const text = payload.params.args.map((arg) => arg.value ?? arg.description ?? "").join(" ");
          if (payload.params.type === "error") this.errors.push(text);
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

async function centerOf(cdp, selector) {
  return cdp.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  })()`);
}

async function click(cdp, selector) {
  const point = await centerOf(cdp, selector);
  if (!point) throw new Error(`找不到可点击元素：${selector}`);
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
  await sleep(220);
}

async function pressEscape(cdp) {
  await cdp.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
  });
  await sleep(220);
}

/** 菜单项状态：文案 + 是否置灰（reka 在 disabled 项上写 data-disabled）。 */
const MENU_STATE = `Array.from(document.querySelectorAll('.send-menu-item')).map((item) => ({
  mode: item.dataset.mode,
  label: item.querySelector('.mi-label')?.textContent ?? '',
  description: item.querySelector('.mi-desc')?.textContent ?? '',
  disabled: item.hasAttribute('data-disabled'),
}))`;

const RENDER_STATE = `({
  codeBlocks: document.querySelectorAll('.md-code').length,
  highlighted: document.querySelectorAll('.md-code[data-highlight="done"]').length,
  pending: document.querySelectorAll('.md-code[data-highlight="pending"]').length,
  codeLang: document.querySelector('.md-code-lang')?.textContent ?? null,
  shikiSpans: document.querySelectorAll('.md-code .line span[style]').length,
  tables: document.querySelectorAll('.md-table table').length,
  quotes: document.querySelectorAll('blockquote').length,
  inlineCode: document.querySelectorAll('.md-body code:not(.md-code-body code)').length,
  foldedTools: document.querySelectorAll('.tool-block').length,
  messageActions: document.querySelectorAll('.message-actions').length,
  modeBar: document.querySelector('.send-mode-bar')?.textContent?.replace(/\\s+/g, ' ').trim() ?? null,
})`;

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), "soxu-111-edge-"));

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

    edge = spawn(
      EDGE,
      [
        "--headless=new",
        `--remote-debugging-port=${DEBUG_PORT}`,
        `--user-data-dir=${profile}`,
        "--no-first-run",
        "--disable-extensions",
        "--hide-scrollbars",
        "--disable-gpu",
        "about:blank",
      ],
      { stdio: "ignore" },
    );

    const target = await waitFor("Chromium CDP", async () => {
      const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?about:blank`, {
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
    };

    await cdp.send("Page.navigate", { url: BASE_URL });
    await waitFor("夹具挂载", async () =>
      cdp.evaluate("Boolean(window.__soxuV4) && document.querySelectorAll('.message').length >= 3"),
    );
    // 等 shiki 语言包加载完（按需加载是异步的）。
    await waitFor("代码块高亮完成", async () => cdp.evaluate("window.__soxuV4.highlighted() >= 1"));
    await cdp.evaluate(
      "new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))",
    );

    report.render = await cdp.evaluate(RENDER_STATE);
    report.shots.push(await screenshot(cdp, "01-light-messages.png"));

    // ---- 空闲状态打开三选菜单：加入当前应置灰
    await click(cdp, ".send-mode-trigger");
    await waitFor("发送选项菜单", async () =>
      cdp.evaluate("document.querySelectorAll('.send-menu-item').length === 3"),
    );
    report.idleMenu = await cdp.evaluate(MENU_STATE);
    report.shots.push(await screenshot(cdp, "02-light-send-menu-idle.png"));
    await pressEscape(cdp);

    // ---- 忙碌状态打开三选菜单：加入当前可用
    await cdp.evaluate("window.__soxuV4.busy(true)");
    await sleep(200);
    await click(cdp, ".send-mode-trigger");
    await waitFor("忙碌态菜单", async () =>
      cdp.evaluate("document.querySelectorAll('.send-menu-item').length === 3"),
    );
    report.busyMenu = await cdp.evaluate(MENU_STATE);
    report.shots.push(await screenshot(cdp, "03-light-send-menu-busy.png"));

    // ---- 选「并行发送」：composer 上方出现模式横条
    await click(cdp, '.send-menu-item[data-mode="parallel"]');
    await waitFor("模式横条", async () => cdp.evaluate("Boolean(document.querySelector('.send-mode-bar'))"));
    report.modeBar = await cdp.evaluate(RENDER_STATE);
    report.shots.push(await screenshot(cdp, "04-light-mode-bar.png"));

    // ---- 深色主题：代码高亮走 --shiki-dark，模式横条跟随 token
    await cdp.evaluate("window.__soxuV4.setTheme('dark')");
    await sleep(260);
    report.dark = await cdp.evaluate(`({
      theme: document.documentElement.dataset.theme,
      codeColor: getComputedStyle(document.querySelector('.md-code .line span[style]')).color,
      modeBarBg: getComputedStyle(document.querySelector('.send-mode-bar')).backgroundColor,
    })`);
    report.shots.push(await screenshot(cdp, "05-dark-mode-bar.png"));

    // ---- 悬停 agent 消息：三个操作出现（复制 / 重试 / 回退）
    await cdp.evaluate("window.__soxuV4.setTheme('light')");
    const assistant = await centerOf(cdp, '.message[data-role="assistant"] .bubble');
    if (assistant) {
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: assistant.x,
        y: assistant.y,
        buttons: 0,
      });
      await sleep(260);
    }
    report.actions = await cdp.evaluate(`({
      visible: (() => {
        const actions = document.querySelector('.message[data-role="assistant"] .message-actions');
        return actions ? Number(getComputedStyle(actions).opacity) : null;
      })(),
      buttons: Array.from(
        document.querySelectorAll('.message[data-role="assistant"] .message-actions .action'),
      ).map((button) => ({
        label: button.getAttribute('aria-label'),
        disabled: button.hasAttribute('disabled'),
      })),
    })`);
    report.shots.push(await screenshot(cdp, "06-light-message-actions.png"));

    report.pageErrors = cdp.errors;
    await writeFile(join(OUT_DIR, "metrics.json"), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    cdp.close();
    killTree(edge?.pid);
    killTree(vite.pid);
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
