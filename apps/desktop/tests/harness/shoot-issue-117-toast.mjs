/**
 * Issue #117（V4-S2b）的可复现证据脚本：右下角 Toast、悬停暂停、常驻、
 * 通知历史抽屉、深色主题与 Web Audio 试听。
 *
 * 用法（仓库任意位置）：
 *   node apps/desktop/tests/harness/shoot-issue-117-toast.mjs
 *
 * 它自己拉起 Vite（默认 1425 端口）和一个独立 profile 的 headless Edge，
 * 通过 CDP（Node 26 自带 WebSocket）派发真实的鼠标/键盘事件，
 * 截图并落盘指标（可见条数、排队条数、悬停暂停、淡出时刻、抽屉行数、焦点位置）。
 * 结束后回收两个子进程，不依赖 Playwright/Puppeteer。
 *
 * 夹具挂的是真实组件与真实 store，所以这里量到的就是生产代码的行为。
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
const OUT_DIR = join(REPO_ROOT, "docs", "development", "evidence", "issue-117-v4-s2b-toast");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = Number(process.env.SOXU_HARNESS_PORT ?? 1425);
const DEBUG_PORT = Number(process.env.SOXU_CDP_PORT ?? 9457);
const BASE_URL = `http://127.0.0.1:${PORT}/tests/harness/notification-toasts.html`;
const VIEWPORT = { width: 1280, height: 800 };

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

async function waitFor(label, probe, { timeout = 30_000, interval = 150 } = {}) {
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
            payload.params.exceptionDetails.exception?.description ??
              payload.params.exceptionDetails.text,
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

async function moveMouse(cdp, x, y) {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
}

async function pressKey(cdp, key, code, virtualKeyCode) {
  // 必须是 keyDown（不是 rawKeyDown）：rawKeyDown 不会派发 DOM keydown，
  // Vue 的 @keydown.escape 就收不到，Escape 关闭看起来像"没实现"。
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
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
  await sleep(220);
}

async function click(cdp, selector) {
  const point = await centerOf(cdp, selector);
  if (!point) throw new Error(`找不到可点击元素：${selector}`);
  await moveMouse(cdp, point.x, point.y);
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
  await sleep(240);
}

/** 每个场景都从干净页面开始：刷新后 store 重新创建，历史与队列清零。 */
async function reset(cdp) {
  await cdp.send("Page.navigate", { url: BASE_URL });
  await waitFor("夹具挂载", async () => cdp.evaluate("Boolean(window.__soxuToast)"));
  await cdp.evaluate(
    "new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))",
  );
  await moveMouse(cdp, 4, 4);
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), "soxu-117-edge-"));

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
        "--autoplay-policy=no-user-gesture-required",
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
      scenarios: {},
    };

    // ── 场景 1：三类事件各自一条，右下角堆叠 ──────────────────────────────
    await reset(cdp);
    await cdp.evaluate("window.__soxuToast.pushAll()");
    await waitFor("三条 toast", async () => cdp.evaluate("window.__soxuToast.visible() === 3"));
    report.scenarios.stack = {
      ...(await cdp.evaluate("window.__soxuToast.stackMetrics()")),
      titles: await cdp.evaluate("window.__soxuToast.titles()"),
      history: await cdp.evaluate("window.__soxuToast.history()"),
      unread: await cdp.evaluate("window.__soxuToast.unread()"),
    };
    report.shots.push(await screenshot(cdp, "01-toasts-stack-light.png"));

    // ── 场景 2：超过 4 条排队，关一条补一条 ──────────────────────────────
    await reset(cdp);
    await cdp.evaluate("window.__soxuToast.pushMany(6)");
    await waitFor("队列形成", async () => cdp.evaluate("window.__soxuToast.queued() === 2"));
    const overflowBefore = {
      visible: await cdp.evaluate("window.__soxuToast.visible()"),
      queued: await cdp.evaluate("window.__soxuToast.queued()"),
      cards: await cdp.evaluate("document.querySelectorAll('.toast').length"),
    };
    report.shots.push(await screenshot(cdp, "02-toasts-overflow-4-visible.png"));
    await click(cdp, ".toast .toast-close");
    const overflowAfter = {
      visible: await cdp.evaluate("window.__soxuToast.visible()"),
      queued: await cdp.evaluate("window.__soxuToast.queued()"),
      cards: await cdp.evaluate("document.querySelectorAll('.toast').length"),
    };
    report.scenarios.overflow = { before: overflowBefore, after: overflowAfter };

    // ── 场景 3：悬停暂停倒计时（5 秒时长，悬停超过 6 秒仍不消失）──────────
    await reset(cdp);
    await cdp.evaluate("window.__soxuToast.setDuration(5000)");
    await cdp.evaluate("window.__soxuToast.push('sessionCompleted')");
    await waitFor("一条 toast", async () => cdp.evaluate("window.__soxuToast.visible() === 1"));
    const card = await centerOf(cdp, ".toast");
    await moveMouse(cdp, card.x, card.y);
    await sleep(6200);
    const hovered = {
      visible: await cdp.evaluate("window.__soxuToast.visible()"),
      fading: await cdp.evaluate("window.__soxuToast.fading()"),
    };
    report.shots.push(await screenshot(cdp, "03-toast-hover-paused.png"));
    await moveMouse(cdp, 4, 4);
    await waitFor("离开后按剩余时长消失", async () =>
      cdp.evaluate("window.__soxuToast.visible() === 0"),
    );
    report.scenarios.hoverPause = { hovered, removedAfterLeave: true };

    // ── 场景 4：消失前先淡出（5 秒时长，4.8 秒时处于 fading）─────────────
    await reset(cdp);
    await cdp.evaluate("window.__soxuToast.setDuration(5000)");
    // 用「会话完成」而不是「会话出错」：错误类不跟随全局时长（10 秒），
    // 拿它测淡出时刻会一直等不到。错误类不受全局时长影响本身由单测覆盖。
    await cdp.evaluate("window.__soxuToast.push('sessionCompleted')");
    await waitFor("一条 toast", async () => cdp.evaluate("window.__soxuToast.visible() === 1"));
    await sleep(4800);
    const fading = {
      visible: await cdp.evaluate("window.__soxuToast.visible()"),
      fading: await cdp.evaluate("window.__soxuToast.fading()"),
      opacity: await cdp.evaluate(
        "Number(getComputedStyle(document.querySelector('.toast')).opacity)",
      ),
    };
    report.shots.push(await screenshot(cdp, "04-toast-fading-before-removal.png"));
    await waitFor("到期后移除", async () => cdp.evaluate("window.__soxuToast.visible() === 0"));
    report.scenarios.fadeBeforeRemoval = fading;

    // ── 场景 5：常驻模式（不自动关闭）────────────────────────────────────
    await reset(cdp);
    await cdp.evaluate("window.__soxuToast.setDuration('persistent')");
    await cdp.evaluate("window.__soxuToast.push('sessionCompleted')");
    await waitFor("一条常驻 toast", async () => cdp.evaluate("window.__soxuToast.visible() === 1"));
    await sleep(2500);
    report.scenarios.persistent = {
      visibleAfter2500ms: await cdp.evaluate("window.__soxuToast.visible()"),
      fading: await cdp.evaluate("window.__soxuToast.fading()"),
    };
    report.shots.push(await screenshot(cdp, "05-toast-persistent.png"));

    // ── 场景 6：通知历史抽屉（倒序、可清空、焦点在抽屉内）───────────────
    await reset(cdp);
    await cdp.evaluate("window.__soxuToast.setDuration(10000)");
    await cdp.evaluate("window.__soxuToast.pushAll()");
    await cdp.evaluate("window.__soxuToast.pushMany(3)");
    await cdp.evaluate("window.__soxuToast.openDrawer()");
    await waitFor("抽屉打开", async () => cdp.evaluate("Boolean(document.querySelector('.drawer-panel'))"));
    await sleep(320);
    report.scenarios.drawer = {
      ...(await cdp.evaluate("window.__soxuToast.drawerMetrics()")),
      history: await cdp.evaluate("window.__soxuToast.history()"),
      unreadAfterOpen: await cdp.evaluate("window.__soxuToast.unread()"),
      titles: await cdp.evaluate("window.__soxuToast.titles()"),
    };
    report.shots.push(await screenshot(cdp, "06-history-drawer-light.png"));

    // Escape 关闭
    await pressKey(cdp, "Escape", "Escape", 27);
    report.scenarios.drawer.escapeClosed = await cdp.evaluate(
      "!document.querySelector('.drawer-panel')",
    );

    // 再打开并清空
    await cdp.evaluate("window.__soxuToast.openDrawer()");
    await waitFor("抽屉再次打开", async () =>
      cdp.evaluate("Boolean(document.querySelector('.drawer-panel'))"),
    );
    await click(cdp, ".drawer-clear");
    await waitFor("历史清空", async () => cdp.evaluate("window.__soxuToast.history() === 0"));
    report.scenarios.drawer.cleared = await cdp.evaluate("window.__soxuToast.drawerMetrics()");
    report.shots.push(await screenshot(cdp, "07-history-drawer-empty.png"));
    await cdp.evaluate("window.__soxuToast.closeDrawer()");

    // ── 场景 7：深色主题 ────────────────────────────────────────────────
    await reset(cdp);
    await cdp.evaluate("window.__soxuToast.setTheme('dark')");
    await cdp.evaluate("window.__soxuToast.pushAll()");
    await waitFor("深色三条 toast", async () => cdp.evaluate("window.__soxuToast.visible() === 3"));
    report.scenarios.dark = await cdp.evaluate("window.__soxuToast.stackMetrics()");
    report.shots.push(await screenshot(cdp, "08-toasts-stack-dark.png"));

    // ── 场景 8：设置持久化（刷新后仍是 30 秒）───────────────────────────
    await reset(cdp);
    await cdp.evaluate("window.__soxuToast.setDuration(30000)");
    await sleep(120);
    await reset(cdp);
    report.scenarios.persistence = {
      durationAfterReload: (await cdp.evaluate("window.__soxuToast.settings()")).duration,
    };
    await cdp.evaluate("window.__soxuToast.setDuration(10000)");

    // ── 场景 9：Web Audio 试听（真实 AudioContext 调度）─────────────────
    await reset(cdp);
    report.scenarios.sound = {
      previewPlayed: await cdp.evaluate("window.__soxuToast.preview()"),
      audioContextState: await cdp.evaluate("window.__soxuToast.audioState()"),
    };

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
