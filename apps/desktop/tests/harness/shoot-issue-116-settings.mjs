/**
 * Issue #116（V4-S2）的可复现证据脚本：设置页四页的视觉、实时生效与持久化。
 *
 * 用法（仓库任意位置）：
 *   node apps/desktop/tests/harness/shoot-issue-116-settings.mjs
 *
 * 它自己拉起 Vite（默认 1425 端口）和一个独立 profile 的 headless Edge，通过 CDP
 * 点真实的控件（tab、色板、开关、按钮），截图并落盘指标：
 * - 切换强调色后 <html> 的 --soxu-accent 与 localStorage；
 * - 四个 tab 的 aria-selected 与面板可见性（键盘方向键走一遍）；
 * - 刷新页面（= 重启）后从 localStorage 读回的 data-* 与选中态。
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
const OUT_DIR = join(REPO_ROOT, "docs", "development", "evidence", "issue-116-v4-s2");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = Number(process.env.SOXU_HARNESS_PORT ?? 1425);
const DEBUG_PORT = Number(process.env.SOXU_CDP_PORT ?? 9457);
const BASE_URL = "http://127.0.0.1:" + PORT + "/tests/harness/settings.html";
const VIEWPORT = { width: 1280, height: 760 };

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
        } else if (payload.method === "Runtime.consoleAPICalled") {
          const text = payload.params.args
            .map((arg) => arg.value ?? arg.description ?? "")
            .join(" ");
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
  await sleep(260);
}

const bySelector = (selector) => "document.querySelector(" + JSON.stringify(selector) + ")";
const byRoleText = (role, text) =>
  "Array.from(document.querySelectorAll('[role=\"" + role + "\"]')).find((el) =>" +
  " el.textContent.replace(/\\s+/g, ' ').trim() === " + JSON.stringify(text) + ")";
const byText = (selector, text) =>
  "Array.from(document.querySelectorAll(" + JSON.stringify(selector) + ")).find((el) =>" +
  " el.textContent.replace(/\\s+/g, ' ').trim() === " + JSON.stringify(text) + ")";

/** 当前选中的 tab 与可见面板：用来验证方向键切换真的换了内容。 */
const TAB_STATE = "Array.from(document.querySelectorAll('[role=\"tab\"]')).map((tab) => ({" +
  " label: tab.textContent.trim()," +
  " selected: tab.getAttribute('aria-selected')," +
  " focused: tab === document.activeElement," +
  "}))";

const PANEL_STATE = "Array.from(document.querySelectorAll('[role=\"tabpanel\"]')).map((panel) => ({" +
  " hidden: panel.hasAttribute('hidden')," +
  " rows: panel.querySelectorAll('.row').length," +
  "}))";

/**
 * 逐条断言：脚本本身就是证据，所以「量到了什么」必须与「期望值」一起落盘，
 * 任何一条不成立就以非 0 退出，避免生成一份看起来正常、实际已经回归的 metrics.json。
 */
const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), ...detail });
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
  await sleep(220);
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), "soxu-116-edge-"));

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
    };

    const mount = async () => {
      await waitFor("夹具挂载", async () =>
        cdp.evaluate("Boolean(window.__soxu116) && Boolean(document.querySelector('#harness-open'))"),
      );
      await cdp.evaluate(
        "new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))",
      );
    };

    await cdp.send("Page.navigate", { url: BASE_URL });
    await mount();

    // ---- 打开设置：默认外观页
    await clickElement(cdp, bySelector("#harness-open"));
    await waitFor("设置弹窗", async () => cdp.evaluate("Boolean(document.querySelector('[role=\"dialog\"]'))"));
    report.tabs = await cdp.evaluate(TAB_STATE);
    report.initial = await cdp.evaluate("window.__soxu116.read()");
    check("默认强调色在 app-shell 子树内也是索序蓝", report.initial.accentInShell === "#3a83f7", {
      actual: report.initial.accentInShell,
    });
    report.shots.push(await screenshot(cdp, "01-appearance-light.png"));

    // 夹具固定从浅色起步（见 settings.ts 的说明），因此这里能真正走到「切到深色」。
    if (report.initial.theme !== "light") {
      throw new Error("夹具起点不是浅色，主题切换将无法验证");
    }

    // ---- 强调色：紫罗兰。实时生效（<html data-accent> + 计算值 + 色板 soft）
    await clickElement(cdp, bySelector('[role="radio"][aria-label="紫罗兰"]'));
    report.accentViolet = await cdp.evaluate("window.__soxu116.read()");
    check("浅色下切到紫罗兰：<html> 与 app-shell 子树同时变紫",
      report.accentViolet.accent === "#8b5cf6" && report.accentViolet.accentInShell === "#8b5cf6",
      { html: report.accentViolet.accent, shell: report.accentViolet.accentInShell },
    );
    // 组件级：选中 tab 的下划线也必须跟着走（变量对了但组件引用别的 token 会在这里露馅）
    check("选中 tab 的下划线取到紫罗兰",
      report.accentViolet.activeTabBorder === "rgb(139, 92, 246)",
      { actual: report.accentViolet.activeTabBorder },
    );
    report.shots.push(await screenshot(cdp, "02-appearance-violet.png"));

    // ---- 琥珀：白字对比度只有 2.15:1，色板必须改用深墨色前景（复审要求验证）
    await clickElement(cdp, bySelector('[role="radio"][aria-label="琥珀"]'));
    report.accentAmber = await cdp.evaluate("window.__soxu116.read()");
    check("琥珀色板的前景切到深墨色（白字 2.15:1 不可用）",
      report.accentAmber.onAccentInShell === "#191717",
      { actual: report.accentAmber.onAccentInShell },
    );
    await clickElement(cdp, bySelector('[role="radio"][aria-label="紫罗兰"]'));
    await sleep(200);

    // ---- 代码字体 + 正文宽度：两档都只改对应 token
    await clickElement(cdp, byRoleText("radio", "JetBrains Mono"));
    await clickElement(cdp, byRoleText("radio", "自适应"));
    report.codeFontAndWidth = await cdp.evaluate("window.__soxu116.read()");

    // ---- 会话页：切换「发送后滚动」
    await clickElement(cdp, byRoleText("tab", "会话"));
    await waitFor("会话面板", async () => cdp.evaluate("document.querySelectorAll('[role=\"switch\"]').length >= 4"));
    report.sessionPanel = {
      tabs: await cdp.evaluate(TAB_STATE),
      panels: await cdp.evaluate(PANEL_STATE),
      switches: await cdp.evaluate(
        "Array.from(document.querySelectorAll('[role=\"switch\"]')).map((el) => el.getAttribute('aria-checked'))",
      ),
      select: await cdp.evaluate("document.querySelector('.select-trigger')?.textContent?.trim() ?? null"),
    };
    report.shots.push(await screenshot(cdp, "03-session-light.png"));
    await clickElement(cdp, "document.querySelectorAll('[role=\"switch\"]')[0]");
    report.sessionToggled = await cdp.evaluate("window.__soxu116.read()");

    // ---- 扩展页：静态占位列表
    await clickElement(cdp, byRoleText("tab", "扩展"));
    await waitFor("扩展列表", async () => cdp.evaluate("document.querySelectorAll('.item').length >= 12"));
    report.extensions = await cdp.evaluate(
      "({ items: document.querySelectorAll('.item').length," +
        " switches: document.querySelectorAll('[role=\"switch\"]').length," +
        " tags: Array.from(document.querySelectorAll('.item-tag')).slice(0, 3).map((el) => el.textContent.trim()) })",
    );
    report.shots.push(await screenshot(cdp, "04-extensions-light.png"));

    // ---- 系统页：5 行 + 复制路径 + 打开数据目录（Issue #145 移除了两个更新入口）
    await clickElement(cdp, byRoleText("tab", "系统"));
    await waitFor("系统页", async () => cdp.evaluate("document.querySelectorAll('.row').length >= 5"));
    report.system = await cdp.evaluate(
      "({ rows: document.querySelectorAll('.row').length," +
        " hasOpenDataDir: Array.from(document.querySelectorAll('button.action'))" +
        "   .some((el) => el.textContent.trim() === '打开数据目录')," +
        " hasUpdateEntry: document.body.textContent.includes('检查更新')" +
        "   || document.body.textContent.includes('自动更新')," +
        " about: document.querySelectorAll('.row')[4]?.textContent?.replace(/\\s+/g, ' ').trim() ?? null })",
    );
    check("系统页没有更新入口（发布通道落地前移除）", report.system.hasUpdateEntry === false, report.system);
    check("系统页有「打开数据目录」", report.system.hasOpenDataDir === true, report.system);
    report.shots.push(await screenshot(cdp, "05-system-light.png"));
    // 两个开关都真接线：点掉「任务完成通知」后存储里要能看到 false
    await clickElement(cdp, "document.querySelectorAll('[role=switch]')[0]");
    report.systemToggled = await cdp.evaluate("window.__soxu116.read()");
    await clickElement(cdp, byText("button.action", "复制路径"));
    report.copy = await cdp.evaluate("window.__soxu116.read()");
    await clickElement(cdp, byText("button.action", "打开数据目录"));
    report.openDataDir = await cdp.evaluate("window.__soxu116.read()");
    check("「打开数据目录」接到真实动作", report.openDataDir.openDataDirCount === 1, {
      count: report.openDataDir.openDataDirCount,
      state: report.openDataDir.openState,
    });

    // ---- 深色主题：走 App.vue 同一条圆形扩散路径
    await clickElement(cdp, byRoleText("tab", "外观"));
    await clickElement(cdp, byRoleText("radio", "深色"));
    await sleep(700);
    report.dark = await cdp.evaluate("window.__soxu116.read()");
    /*
     * 复审阻塞点：深色 token 同时挂在 :root 与 .app-shell 两个选择器上，
     * 上一版在深色块里重复声明了 --soxu-accent，导致 app-shell 子树退回蓝色。
     * 这里直接量子树内的值，而不是只看 documentElement。
     */
    check("深色下 app-shell 子树的强调色仍是紫罗兰（不再退回蓝色）",
      report.dark.accentInShell === "#8b5cf6",
      { actual: report.dark.accentInShell },
    );
    check("深色下组件实际渲染的强调色也是紫罗兰",
      report.dark.activeTabBorder === "rgb(139, 92, 246)",
      { actual: report.dark.activeTabBorder },
    );
    check("深色下派生色用深色比例（26%），不是浅色的 14%",
      typeof report.dark.accentSoftInShell === "string" &&
        report.dark.accentSoftInShell.includes("26%") &&
        report.dark.accentSoftInShell !== report.accentViolet.accentSoftInShell,
      { dark: report.dark.accentSoftInShell, light: report.accentViolet.accentSoftInShell },
    );
    report.shots.push(await screenshot(cdp, "06-appearance-dark.png"));

    // ---- 键盘：焦点在标签栏时方向键切换页面
    await cdp.evaluate("document.querySelector('[role=\"tab\"]').focus()");
    await pressKey(cdp, "ArrowRight", "ArrowRight", 39);
    report.keyboard = {
      tabs: await cdp.evaluate(TAB_STATE),
      panels: await cdp.evaluate(PANEL_STATE),
    };
    // Tab 键：从标签栏进入面板内容（roving focus 只让当前标签停在 Tab 序列里）
    await pressKey(cdp, "Tab", "Tab", 9);
    report.keyboard.afterTab = await cdp.evaluate(
      "({ tag: document.activeElement?.tagName ?? null," +
        " role: document.activeElement?.getAttribute('role') ?? null," +
        " insidePanel: Boolean(document.activeElement?.closest('[role=tabpanel]'))," +
        " text: (document.activeElement?.textContent ?? '').trim().slice(0, 20) })",
    );
    report.shots.push(await screenshot(cdp, "07-keyboard-tabs.png"));

    // ---- 「重启」：刷新页面后从 localStorage 读回同一套外观
    await cdp.send("Page.reload");
    await mount();
    report.afterReload = await cdp.evaluate("window.__soxu116.read()");
    await clickElement(cdp, bySelector("#harness-open"));
    await waitFor("重启后弹窗", async () => cdp.evaluate("Boolean(document.querySelector('[role=\"dialog\"]'))"));
    report.shots.push(await screenshot(cdp, "08-after-reload-dark-violet.png"));

    // ---- Issue #145：切到 en-US 后设置页全英文
    // （源码级断言在 tests/productI18n.test.ts；这里量的是真实渲染出来的文字）
    await cdp.evaluate("window.__soxu116.setLocale('en-US')");
    await sleep(500);
    report.english = await cdp.evaluate(
      "({ text: (document.querySelector('[role=dialog]')?.textContent ?? '').replace(/\\s+/g, ' ').trim()," +
        " tabs: Array.from(document.querySelectorAll('[role=tab]')).map((el) => el.textContent.trim())," +
        " rows: Array.from(document.querySelectorAll('.row-label')).map((el) => el.textContent.trim()) })",
    );
    const CJK = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/u;
    check("en-US 下设置页没有中文文案", !CJK.test(report.english.text), {
      text: report.english.text.slice(0, 200),
    });
    check(
      "en-US 下四个标签页是英文",
      report.english.tabs.join(",") === "Appearance,Session,Extensions,System",
      report.english.tabs,
    );
    report.shots.push(await screenshot(cdp, "09-settings-en-us.png"));

    // 扩展页：静态清单（12 个扩展 + 技能 + MCP）也要全英文
    await clickElement(cdp, byRoleText("tab", "Extensions"));
    await waitFor("en-US 扩展页", async () =>
      cdp.evaluate("document.querySelectorAll('.item').length >= 12"),
    );
    /*
     * 复审阻塞点（Issue #145）：上一版只读 `[role=tabpanel]` 的 textContent，
     * 取到空串时 !CJK.test("") 恒真——「没有中文」就变成了一条永远成立的断言。
     * 现在同时量三件事：条目数量、每个条目是否有真实文案、面板文本是否够长，
     * 并把「文本必须够长」写进断言本身，空文本一律判失败。
     */
    report.englishExtensions = await cdp.evaluate(
      "(() => {" +
        " const items = Array.from(document.querySelectorAll('.item'))" +
        "   .map((el) => (el.textContent ?? '').replace(/\\s+/g, ' ').trim());" +
        " const panels = Array.from(document.querySelectorAll('[role=tabpanel]'));" +
        " const visible = panels.filter((panel) => !panel.hasAttribute('hidden'));" +
        " const panelText = visible.map((panel) => panel.textContent ?? '')" +
        "   .join(' ').replace(/\\s+/g, ' ').trim();" +
        " return { items: items.length," +
        "   emptyItems: items.filter((text) => text.length === 0).length," +
        "   shortestItem: items.reduce((min, text) => Math.min(min, text.length), Number.POSITIVE_INFINITY)," +
        "   itemText: items.join(' | ')," +
        "   panels: panels.length," +
        "   visiblePanels: visible.length," +
        "   panelText }; })()",
    );
    check(
      "en-US 下扩展页 20 个条目全部渲染（12 个扩展 + 4 个技能 + 4 个 MCP）",
      report.englishExtensions.items === 20 && report.englishExtensions.emptyItems === 0,
      { items: report.englishExtensions.items, emptyItems: report.englishExtensions.emptyItems },
    );
    check(
      "en-US 下扩展页每个条目都有真实文案（空文本不能让 CJK 断言恒真）",
      report.englishExtensions.shortestItem >= 10,
      { shortestItem: report.englishExtensions.shortestItem },
    );
    check(
      "en-US 下扩展页面板渲染出内容（面板文本非空）",
      report.englishExtensions.panelText.length >= 200,
      {
        panels: report.englishExtensions.panels,
        visiblePanels: report.englishExtensions.visiblePanels,
        length: report.englishExtensions.panelText.length,
      },
    );
    check(
      "en-US 下扩展页没有中文文案",
      report.englishExtensions.panelText.length >= 200 &&
        !CJK.test(report.englishExtensions.panelText) &&
        !CJK.test(report.englishExtensions.itemText),
      {
        panel: report.englishExtensions.panelText.slice(0, 200),
        items: report.englishExtensions.itemText.slice(0, 200),
      },
    );
    report.shots.push(await screenshot(cdp, "10-extensions-en-us.png"));
    await cdp.evaluate("window.__soxu116.setLocale('zh-CN')");

    report.pageErrors = cdp.errors;
    report.checks = checks;
    await writeFile(join(OUT_DIR, "metrics.json"), JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report, null, 2));
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
