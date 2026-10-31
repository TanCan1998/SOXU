/**
 * TASK-033（Issue #143）的可复现证据脚本：产品净化后的界面走查。
 *
 * 用法（仓库任意位置）：
 *   node apps/desktop/tests/harness/shoot-issue-143-wording.mjs
 *
 * 它自己拉起 Vite（默认 1426 端口）和一个独立 profile 的 headless Edge，通过 CDP
 * 走查设置 → 扩展页：浅色与深色各截一张，并断言页面上
 * - 没有任何 [role=switch]（假开关已删除）；
 * - 没有 .item-tag（「已启用 / 未连接 / N 个工具」这类假状态徽章已删除）；
 * - 渲染出来的文字里没有禁用词（切片 / Issue # / 占位 / 演示 / V4-S / TODO( ）。
 *
 * 发送菜单的「三项可见但全部置灰」由单元测试覆盖（tests/sendModes.test.ts 断言
 * SEND_MODES_READY 关闭时三项一律不可用、原因写「即将支持」），这里不再重复截图。
 *
 * 走查结论与截图一起落在 docs/development/evidence/issue-143-wording/，
 * 脚本本身是证据：任何一条断言不成立就以非 0 退出。结束后回收 Vite 与浏览器子进程。
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { formatHit, scanText } from "../support/uiWordingScan.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(HERE, "../..");
const REPO_ROOT = resolve(APP_ROOT, "../..");
const OUT_DIR = join(REPO_ROOT, "docs", "development", "evidence", "issue-143-wording");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = Number(process.env.SOXU_HARNESS_PORT ?? 1426);
const DEBUG_PORT = Number(process.env.SOXU_CDP_PORT ?? 9458);
const BASE_URL = "http://127.0.0.1:" + PORT;
const VIEWPORT = { width: 1280, height: 800 };

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function waitFor(label, probe, { timeout = 30_000, interval = 200 } = {}) {
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

/** 极简 CDP 客户端：只需要 evaluate / 截图 / 派发鼠标事件。 */
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

const bySelector = (selector) => "document.querySelector(" + JSON.stringify(selector) + ")";
const byRoleText = (role, text) =>
  "Array.from(document.querySelectorAll('[role=\"" + role + "\"]')).find((el) =>" +
  " el.textContent.replace(/\\s+/g, ' ').trim() === " + JSON.stringify(text) + ")";

/** 用元素表达式（返回 element）算出中心点，再派发一次真实鼠标点击。 */
async function clickElement(cdp, expression) {
  const point = await cdp.evaluate(
    "(() => { const element = " + expression + "; if (!element) return null;" +
      " const rect = element.getBoundingClientRect();" +
      " return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; })()",
  );
  if (!point) throw new Error("找不到可点击元素：" + expression);
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
  await sleep(280);
}

/** 断言结果逐条落盘：脚本本身就是证据，量到什么必须和期望值一起写下来。 */
const checks = [];
function check(name, ok, detail = {}) {
  checks.push({ name, ok: Boolean(ok), ...detail });
}

const EXTENSIONS_PANEL_STATE =
  "(() => {" +
  " const dialog = document.querySelector('[role=\"dialog\"]');" +
  " if (!dialog) return null;" +
  " return {" +
  "   switches: dialog.querySelectorAll('[role=\"switch\"]').length," +
  "   badges: dialog.querySelectorAll('.item-tag').length," +
  "   items: dialog.querySelectorAll('.item').length," +
  "   buttons: Array.from(dialog.querySelectorAll('button')).map((el) => el.textContent.trim())," +
  "   text: dialog.innerText," +
  " };" +
  "})()";

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), "soxu-143-edge-"));

  const vite = spawn(
    process.platform === "win32" ? "pnpm.cmd" : "pnpm",
    ["exec", "vite", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"],
    { cwd: APP_ROOT, shell: process.platform === "win32", stdio: "ignore" },
  );
  let edge = null;
  const cdp = new Cdp("");
  try {
    await waitFor("Vite 开发服务器", async () => {
      const response = await fetch(BASE_URL + "/", { method: "HEAD" });
      return response.ok;
    });

    edge = spawn(
      EDGE,
      [
        "--headless=new",
        "--remote-debugging-port=" + DEBUG_PORT,
        "--user-data-dir=" + profile,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-gpu",
        "--hide-scrollbars",
        "about:blank",
      ],
      { stdio: "ignore" },
    );

    const target = await waitFor("CDP 目标", async () => {
      const list = await fetch("http://127.0.0.1:" + DEBUG_PORT + "/json/list").then((res) =>
        res.json(),
      );
      return list.find((item) => item.type === "page" && item.webSocketDebuggerUrl) ?? null;
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
      checks,
    };

    // ── 1. 设置 → 扩展页（浅色）
    await cdp.send("Page.navigate", { url: BASE_URL + "/tests/harness/settings.html" });
    await waitFor("设置夹具挂载", async () =>
      cdp.evaluate("Boolean(window.__soxu116) && Boolean(document.querySelector('#harness-open'))"),
    );
    await clickElement(cdp, bySelector("#harness-open"));
    await waitFor("设置弹窗", async () =>
      cdp.evaluate("Boolean(document.querySelector('[role=\"dialog\"]'))"),
    );
    await clickElement(cdp, byRoleText("tab", "扩展"));
    await waitFor("扩展列表", async () =>
      cdp.evaluate("document.querySelectorAll('.item').length >= 12"),
    );

    const light = await cdp.evaluate(EXTENSIONS_PANEL_STATE);
    report.extensionsLight = {
      switches: light.switches,
      badges: light.badges,
      items: light.items,
      buttons: light.buttons,
    };
    check("扩展页没有任何开关", light.switches === 0, { switches: light.switches });
    check("扩展页没有状态徽章", light.badges === 0, { badges: light.badges });
    check("扩展页仍然列出 12 个扩展（只读展示不缩水）", light.items >= 12, {
      items: light.items,
    });
    const lightHits = scanText(light.text).map((hit) => formatHit("扩展页(浅色)", hit));
    report.extensionsLight.wording = lightHits;
    check("扩展页浅色文案没有开发术语", lightHits.length === 0, { hits: lightHits });
    report.shots.push(await screenshot(cdp, "01-extensions-light.png"));

    // ── 2. 深色：走 App.vue 同一条主题切换路径
    await clickElement(cdp, byRoleText("tab", "外观"));
    await clickElement(cdp, byRoleText("radio", "深色"));
    await sleep(700);
    await clickElement(cdp, byRoleText("tab", "扩展"));
    await waitFor("深色扩展列表", async () =>
      cdp.evaluate("document.querySelectorAll('.item').length >= 12"),
    );
    const dark = await cdp.evaluate(EXTENSIONS_PANEL_STATE);
    report.extensionsDark = {
      switches: dark.switches,
      badges: dark.badges,
      theme: await cdp.evaluate("document.documentElement.dataset.theme"),
    };
    check("深色下扩展页同样没有开关", dark.switches === 0, { switches: dark.switches });
    check("深色主题确实生效", report.extensionsDark.theme === "dark", {
      theme: report.extensionsDark.theme,
    });
    const darkHits = scanText(dark.text).map((hit) => formatHit("扩展页(深色)", hit));
    report.extensionsDark.wording = darkHits;
    check("扩展页深色文案没有开发术语", darkHits.length === 0, { hits: darkHits });
    report.shots.push(await screenshot(cdp, "02-extensions-dark.png"));

    // ── 3. 侧栏：「临时会话」按钮不再冒充 Ctrl K
    await cdp.send("Page.navigate", { url: BASE_URL + "/" });
    await waitFor("应用外壳挂载", async () =>
      cdp.evaluate("Boolean(document.querySelector('.new-session'))"),
    );
    await cdp.evaluate(
      "new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))",
    );
    const sidebar = await cdp.evaluate(
      "(() => { const button = document.querySelector('.new-session');" +
        " const tooltipHost = button.closest('[data-reka-tooltip-trigger]') ?? button.parentElement;" +
        " return { text: button.innerText.replace(/\\s+/g, ' ').trim()," +
        "   kbd: button.querySelectorAll('kbd').length," +
        "   hostText: (tooltipHost?.textContent ?? '').replace(/\\s+/g, ' ').trim() }; })()",
    );
    report.sidebar = sidebar;
    check("临时会话按钮不再自带 kbd 标注", sidebar.kbd === 0, { kbd: sidebar.kbd });
    check("按钮文案保持不变", sidebar.text === "临时会话", { text: sidebar.text });
    report.shots.push(await screenshot(cdp, "03-sidebar-light.png"));

    report.pageErrors = cdp.errors;
    await writeFile(join(OUT_DIR, "metrics.json"), JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify({ shots: report.shots, checks }, null, 2));
    if (checks.some((entry) => !entry.ok)) {
      console.error("断言未通过：" + JSON.stringify(checks.filter((entry) => !entry.ok)));
      process.exitCode = 1;
    }
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
