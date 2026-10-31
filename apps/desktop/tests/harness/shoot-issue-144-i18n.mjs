/**
 * TASK-034（Issue #144）的可复现证据脚本：会话区与输入区的 i18n 存量迁移走查。
 *
 * 用法（仓库任意位置）：
 *   node apps/desktop/tests/harness/shoot-issue-144-i18n.mjs
 *
 * 它自己拉起 Vite（默认 1427 端口）和一个独立 profile 的 headless Edge，通过 CDP
 * 打开 tests/harness/session-i18n.html?locale=<tag>，对 zh-CN 与 en-US 各走一遍：
 * - 会话区 + 输入区整屏截图；
 * - 打开「发送选项」菜单截图（三项可见但置灰，原因随语言变化）；
 * - 打开「上下文与统计」浮窗截图（分组标题、指标名、降级说明随语言变化）。
 *
 * 断言（任何一条不成立就以非 0 退出）：
 * - en-US 下会话区/输入区的渲染文本**没有中文**，zh-CN 下有；
 * - en-US 下出现预期英文文案（状态、Tab、发送、占位符、统计）；
 * - 消息时间戳由语言决定：中文 24 小时制、英文带 AM/PM；
 * - 两种语言下渲染文本都不含禁用词（切片 / Issue # / 占位 / 演示 / V4-S / TODO( ）。
 *
 * 走查结论与截图一起落在 docs/development/evidence/issue-144-i18n/。
 * 结束后回收 Vite 与浏览器子进程（不留常驻服务）。
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { formatHit, scanText } from "../support/uiWordingScan.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(HERE, "../..");
const REPO_ROOT = resolve(APP_ROOT, "../..");
const OUT_DIR = join(REPO_ROOT, "docs", "development", "evidence", "issue-144-i18n");

const EDGE_CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];
const PORT = Number(process.env.SOXU_HARNESS_PORT ?? 1427);
const DEBUG_PORT = Number(process.env.SOXU_CDP_PORT ?? 9459);
const BASE_URL = "http://127.0.0.1:" + PORT;
const FIXTURE = "/tests/harness/session-i18n.html";
const VIEWPORT = { width: 1180, height: 900 };

/** CJK 统一表意文字 + 中日韩标点 + 全角形式。 */
const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/u;

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

/** 极简 CDP 客户端：只需要 evaluate / 截图 / 派发鼠标与键盘事件。 */
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
  await sleep(320);
}

async function pressEscape(cdp) {
  for (const type of ["keyDown", "keyUp"]) {
    await cdp.send("Input.dispatchKeyEvent", {
      type,
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27,
    });
  }
  await sleep(280);
}

/** 断言结果逐条落盘：脚本本身就是证据，量到什么必须和期望值一起写下来。 */
const checks = [];
function check(name, ok, detail = {}) {
  checks.push({ name, ok: Boolean(ok), ...detail });
}

/** 抓取会话区 + 输入区 + Tab 栏的渲染文本与关键节点。 */
const REGION_STATE =
  "(() => {" +
  " const panel = document.querySelector('.chat-panel');" +
  " const tabs = document.querySelector('.tab-strip');" +
  " const times = Array.from(document.querySelectorAll('.message-time')).map((el) => el.textContent.trim());" +
  " const labels = Array.from(document.querySelectorAll('.message-label')).map((el) => el.textContent.trim());" +
  " return {" +
  "   text: (tabs?.innerText ?? '') + String.fromCharCode(10) + (panel?.innerText ?? '')," +
  "   times," +
  "   labels," +
  "   placeholder: document.querySelector('#soxu-composer')?.getAttribute('placeholder') ?? null," +
  "   hint: document.querySelector('#soxu-composer-hint')?.textContent?.trim() ?? null," +
  "   statsAria: document.querySelector('.stats-row')?.getAttribute('aria-label') ?? null," +
  "   tabBadge: document.querySelector('.tab-tag')?.textContent?.trim() ?? null," +
  "   toolSummary: document.querySelector('.tool-block summary')?.textContent?.trim() ?? null," +
  "   sendLabel: document.querySelector('.send-main')?.getAttribute('aria-label') ?? null," +
  " };" +
  "})()";

/** 输入框占位符：两种语言各一份，用来确认 placeholder 也走了语言包。 */
const PLACEHOLDER = {
  "zh-CN": "向 Pi Agent 发送消息…",
  "en-US": "Send a message to Pi Agent…",
};

/**
 * 会话区 + 输入区各取一条代表性文案：状态、Tab 徽标、历史、运行中提示、统计、角色标签。
 * 夹具的 Tab 是 running 状态，因此输入区显示的是「忙碌时发送」提示（而不是 Enter 提示）。
 */
const EXPECTED = {
  "zh-CN": ["临时会话", "运行中", "加载更多历史", "忙碌时发送即将支持", "轮次", "你", "工具输出"],
  "en-US": [
    "Temporary session",
    "Running",
    "Load more history",
    "sending while busy is coming soon",
    "Turns",
    "You",
    "Tool output",
  ],
};

async function main() {
  const edgePath = EDGE_CANDIDATES.find((candidate) => existsSync(candidate));
  if (!edgePath) throw new Error("找不到 Edge，无法做浏览器走查：" + EDGE_CANDIDATES.join(" / "));

  await mkdir(OUT_DIR, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), "soxu-144-edge-"));

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
      edgePath,
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
      fixture: FIXTURE,
      shots: [],
      regions: {},
      checks,
    };

    for (const tag of ["zh-CN", "en-US"]) {
      const order = tag === "zh-CN" ? "01" : "02";

      await cdp.send("Page.navigate", { url: BASE_URL + FIXTURE + "?locale=" + tag });
      try {
        await waitFor("会话面板挂载", async () =>
          cdp.evaluate("Boolean(document.querySelector('.chat-panel'))"),
        );
      } catch (error) {
        // 夹具挂载失败时把页面异常与 body 文本一起抛出来，否则只看到「等待超时」。
        const body = await cdp
          .evaluate("document.body.innerText.slice(0, 400)")
          .catch(() => "(无法读取 body)");
        throw new Error(
          error.message + "\n页面异常：" + JSON.stringify(cdp.errors) + "\n页面文本：" + body,
        );
      }
      await waitFor("消息渲染", async () =>
        cdp.evaluate("document.querySelectorAll('.message-label').length >= 4"),
      );
      await cdp.evaluate(
        "new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))",
      );

      const state = await cdp.evaluate(REGION_STATE);
      const locale = await cdp.evaluate("window.__soxuI18n?.locale ?? null");
      report.regions[tag] = { locale, ...state };
      check(tag + "：夹具语言与请求一致", locale === tag, { locale });

      const hits = scanText(state.text).map((hit) => formatHit("会话区(" + tag + ")", hit));
      report.regions[tag].wording = hits;
      check(tag + "：渲染文本没有禁用词", hits.length === 0, { hits });

      const hasCjk = CJK.test(state.text);
      check(
        tag === "zh-CN" ? "zh-CN：渲染文本包含中文" : "en-US：渲染文本没有任何中文",
        tag === "zh-CN" ? hasCjk : !hasCjk,
        { hasCjk },
      );

      for (const expected of EXPECTED[tag]) {
        check(tag + "：出现「" + expected + "」", state.text.includes(expected), { expected });
      }

      // 时间戳：中文 24 小时制，英文带 AM/PM —— 证明走的是 Intl 而不是手拼 HH:mm。
      const firstTime = state.times[0] ?? "";
      const timeOk = tag === "zh-CN" ? /^\d{2}:\d{2}$/u.test(firstTime) : /(AM|PM)$/u.test(firstTime);
      check(tag + "：消息时间戳按语言格式化（" + firstTime + "）", timeOk, { firstTime });

      check(tag + "：输入区提示文案已本地化", Boolean(state.hint), { hint: state.hint });
      check(tag + "：输入框 placeholder 已本地化", state.placeholder === PLACEHOLDER[tag], {
        placeholder: state.placeholder,
      });
      check(tag + "：发送按钮有本地化的无障碍名称", Boolean(state.sendLabel), {
        sendLabel: state.sendLabel,
      });
      check(tag + "：统计行有本地化的无障碍名称", Boolean(state.statsAria), {
        statsAria: state.statsAria,
      });

      report.shots.push(await screenshot(cdp, order + "-session-" + tag + ".png"));

      // ── 发送选项菜单：三项可见但置灰，原因随语言变化
      await clickElement(cdp, bySelector(".send-mode-trigger"));
      await waitFor("发送选项菜单", async () =>
        cdp.evaluate("Boolean(document.querySelector('.send-menu'))"),
      );
      const menu = await cdp.evaluate(
        "(() => { const menu = document.querySelector('.send-menu');" +
          " return { text: menu?.innerText ?? '', items: menu?.querySelectorAll('.send-menu-item').length ?? 0," +
          "   disabled: menu?.querySelectorAll('.send-menu-item[data-disabled]').length ?? 0 }; })()",
      );
      report.regions[tag].sendMenu = menu;
      check(tag + "：发送菜单三项齐全", menu.items === 3, { items: menu.items });
      check(tag + "：投递语义未接入时三项全部置灰", menu.disabled === 3, { disabled: menu.disabled });
      check(
        tag === "zh-CN" ? "zh-CN：置灰原因写「即将支持」" : "en-US：置灰原因写 Coming soon",
        menu.text.includes(tag === "zh-CN" ? "即将支持" : "Coming soon"),
        { text: menu.text.slice(0, 160) },
      );
      report.shots.push(await screenshot(cdp, order + "-send-menu-" + tag + ".png"));
      await pressEscape(cdp);

      // ── 统计浮窗：分组标题、指标名与降级说明都随语言变化
      await clickElement(cdp, bySelector(".stats-ring"));
      await waitFor("统计浮窗", async () =>
        cdp.evaluate("Boolean(document.querySelector('.soxu-stats-popover'))"),
      );
      const popover = await cdp.evaluate(
        "(() => { const el = document.querySelector('.soxu-stats-popover');" +
          " return { text: el?.innerText ?? '' }; })()",
      );
      report.regions[tag].statsPopover = popover;
      check(
        tag === "zh-CN" ? "zh-CN：浮窗标题为「上下文与统计」" : "en-US：浮窗标题为 Context and statistics",
        popover.text.includes(
          tag === "zh-CN" ? "上下文与统计" : "Context and statistics",
        ),
        { text: popover.text.slice(0, 160) },
      );
      const popoverCjk = CJK.test(popover.text);
      check(
        tag === "zh-CN" ? "zh-CN：浮窗有中文" : "en-US：浮窗没有任何中文",
        tag === "zh-CN" ? popoverCjk : !popoverCjk,
        { popoverCjk },
      );
      report.shots.push(await screenshot(cdp, order + "-stats-" + tag + ".png"));
      await pressEscape(cdp);
    }

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
