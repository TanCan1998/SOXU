/**
 * Issue #123（TASK-031）的可复现证据脚本：命令面板的拼音首字母搜索与全键盘执行。
 *
 * 用法（仓库任意位置）：
 *   node apps/desktop/tests/harness/shoot-issue-123-palette.mjs
 *
 * 它自己拉起 Vite（默认 1427 端口）和一个独立 profile 的 headless Edge，
 * 通过 CDP（Node 26 自带 WebSocket）用**真实键盘事件**驱动：
 * 输入 dk → ↓↓ → ↑ → ↵ 执行 → Esc 关闭，并截图。
 * 指标写进 docs/development/evidence/issue-123-command-palette/metrics.json。
 * 不依赖 Playwright/Puppeteer，结束后回收两个子进程。
 *
 * 量到的是什么：命令清单是生产代码里的 COMMANDS，匹配与高亮是生产代码里的
 * match.ts，因此这里验证的是真实渲染 + 真实按键，而不是夹具重写的逻辑。
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
const OUT_DIR = join(REPO_ROOT, "docs", "development", "evidence", "issue-123-command-palette");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = Number(process.env.SOXU_HARNESS_PORT ?? 1427);
const DEBUG_PORT = Number(process.env.SOXU_CDP_PORT ?? 9459);
const BASE_URL = "http://127.0.0.1:" + PORT + "/tests/harness/command-palette.html";
const VIEWPORT = { width: 1280, height: 720 };

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

/** 当前 CDP 连接；超时的时候把页面异常一起报出来，否则只能看到「等待超时」。 */
let activeCdp = null;

async function waitFor(label, probe, { timeout = 30_000, interval = 50 } = {}) {
  const started = Date.now();
  for (;;) {
    try {
      const value = await probe();
      if (value) return value;
    } catch {
      // 还没起来，继续等。
    }
    if (Date.now() - started > timeout) {
      const pageErrors = activeCdp?.errors ?? [];
      const detail = pageErrors.length > 0 ? "；页面异常：" + pageErrors.join(" | ") : "";
      throw new Error("等待超时：" + label + detail);
    }
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

/** 真实键盘输入：走浏览器默认的 input 事件，等价于用户逐字打字。 */
async function typeText(cdp, text) {
  await cdp.send("Input.insertText", { text });
}

const KEYS = {
  ArrowDown: { code: "ArrowDown", key: "ArrowDown", windowsVirtualKeyCode: 40 },
  ArrowUp: { code: "ArrowUp", key: "ArrowUp", windowsVirtualKeyCode: 38 },
  Enter: { code: "Enter", key: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  Escape: { code: "Escape", key: "Escape", windowsVirtualKeyCode: 27 },
  Tab: { code: "Tab", key: "Tab", windowsVirtualKeyCode: 9 },
};

/**
 * 真按一次键（keyDown + keyUp），不是页面里 synthetic 的 KeyboardEvent。
 * modifiers 走 CDP 的位掩码（8 = Shift），页面里的 event.shiftKey 由它决定。
 */
async function press(cdp, name, modifiers = {}) {
  const key = KEYS[name];
  if (!key) throw new Error("未定义的按键：" + name);
  const bits = modifiers.shift ? 8 : 0;
  const payload = { ...key, modifiers: bits, nativeVirtualKeyCode: key.windowsVirtualKeyCode };
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...payload });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...payload });
  await sleep(60);
}

function isDark(color) {
  const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(color ?? "");
  if (!match) return false;
  const [r, g, b] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.4;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), "soxu-123-edge-"));

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
    activeCdp = cdp;
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
      cdp.evaluate("Boolean(window.__soxuPalette) && Boolean(document.querySelector('.cp-input'))"),
    );
    await cdp.evaluate(
      "new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))",
    );

    // ── 1. 打开：输入框已聚焦，列表给出全部命令
    const opened = await cdp.evaluate("window.__soxuPalette.state()");
    report.opened = opened;
    report.shots.push(await screenshot(cdp, "01-light-open.png"));
    check("open-focused", opened.open && opened.focused === "cp-input", opened.focused);
    check("pinyin-lazy-loaded", opened.pinyin === "ready", opened.pinyin);
    check("all-commands-listed", opened.rows.length === 36, opened.rows.length);
    check(
      "footer-hints",
      opened.footer.includes("选择") && opened.footer.includes("执行") && opened.footer.includes("关闭"),
      opened.footer,
    );

    // ── 2. 拼音首字母 dk：命中全部「打开…」，命中字高亮
    const typingStarted = Date.now();
    await typeText(cdp, "dk");
    await waitFor("dk 结果", async () =>
      cdp.evaluate("document.querySelectorAll('.cp-item').length > 0"),
    );
    const dkLatencyMs = Date.now() - typingStarted;
    const dk = await cdp.evaluate("window.__soxuPalette.state()");
    report.dk = dk;
    report.dkLatencyMs = dkLatencyMs;
    report.shots.push(await screenshot(cdp, "02-light-dk.png"));
    const allTitles = await cdp.evaluate("window.__soxuPalette.commands()");
    const openingTitles = allTitles.filter((title) => title.startsWith("打开"));
    check(
      "dk-hits-all-open-commands",
      openingTitles.length >= 4 &&
        openingTitles.every((title) => dk.rows.some((row) => row.title === title)),
      { expected: openingTitles, rows: dk.rows.map((row) => row.title) },
    );
    check("dk-first-is-settings", dk.rows[0]?.title === "打开设置", dk.rows[0]?.title);
    check(
      "dk-highlight-marks-open",
      dk.rows[0]?.marks.join("") === "打开",
      dk.rows[0]?.marks,
    );
    check("dk-latency-budget", dkLatencyMs <= 250, dkLatencyMs);

    // ── 3. ↓↓ 选择第三条：高亮跟随，aria-activedescendant 同步
    await press(cdp, "ArrowDown");
    await press(cdp, "ArrowDown");
    const moved = await cdp.evaluate("window.__soxuPalette.state()");
    report.moved = moved;
    report.shots.push(await screenshot(cdp, "03-light-keyboard.png"));
    const activeRow = moved.rows.findIndex((row) => row.active);
    check("arrow-down-moves-active", activeRow === 2, activeRow);
    check(
      "aria-activedescendant",
      moved.activeDescendant === "soxu-command-option-2",
      moved.activeDescendant,
    );

    // ── 4. ↑ 回到第二条，再按 ↵ 执行（全键盘完成一次命令执行）
    await press(cdp, "ArrowUp");
    const selected = await cdp.evaluate("window.__soxuPalette.state()");
    const selectedTitle = selected.rows.find((row) => row.active)?.title ?? null;
    await press(cdp, "Enter");
    await waitFor("面板关闭", async () =>
      cdp.evaluate("document.querySelector('.palette') === null"),
    );
    const executed = await cdp.evaluate("window.__soxuPalette.executed()");
    const afterRun = await cdp.evaluate("window.__soxuPalette.state()");
    report.keyboardRun = { selectedTitle, executed, afterRun };
    report.shots.push(await screenshot(cdp, "04-after-execute.png"));
    check("enter-executes-active-row", executed.ids.length === 1, executed.ids);
    check("action-really-ran", executed.actions.length === 1, executed.actions);
    check("panel-closes-after-run", afterRun.open === false, afterRun.open);

    // ── 5. Esc 关闭：不执行任何命令
    await cdp.evaluate("window.__soxuPalette.reopen()");
    await waitFor("面板就绪", async () =>
      cdp.evaluate(
        "window.__soxuPalette.state().focused === 'cp-input' && window.__soxuPalette.state().pinyin === 'ready'",
      ),
    );
    await press(cdp, "Escape");
    await waitFor("Esc 关闭", async () =>
      cdp.evaluate("document.querySelector('.palette') === null"),
    );
    const afterEscape = await cdp.evaluate("window.__soxuPalette.executed()");
    check("escape-closes-without-running", afterEscape.ids.length === 1, afterEscape.ids);

    // ── 6. 首字母 sz：命中设置相关命令
    await cdp.evaluate("window.__soxuPalette.reopen()");
    await waitFor("面板就绪", async () =>
      cdp.evaluate(
        "window.__soxuPalette.state().focused === 'cp-input' && window.__soxuPalette.state().pinyin === 'ready'",
      ),
    );
    await typeText(cdp, "sz");
    await waitFor("sz 结果", async () =>
      cdp.evaluate("document.querySelectorAll('.cp-item').length > 0"),
    );
    const sz = await cdp.evaluate("window.__soxuPalette.state()");
    report.sz = sz;
    report.shots.push(await screenshot(cdp, "05-light-sz.png"));
    check("sz-hits-settings", sz.rows[0]?.title === "打开设置", sz.rows[0]?.title);
    check(
      "sz-highlight-settings",
      (sz.rows[0]?.marks.join("") ?? "").includes("设置"),
      sz.rows[0]?.marks,
    );

    // ── 7. 设置项也能搜到并直接打开对应页（元数据同源）
    await cdp.evaluate("window.__soxuPalette.reopen()");
    await waitFor("面板就绪", async () =>
      cdp.evaluate(
        "window.__soxuPalette.state().focused === 'cp-input' && window.__soxuPalette.state().pinyin === 'ready'",
      ),
    );
    await typeText(cdp, "消息时间戳");
    await waitFor("设置项结果", async () =>
      cdp.evaluate("document.querySelectorAll('.cp-item').length > 0"),
    );
    const settingRow = await cdp.evaluate("window.__soxuPalette.state()");
    report.settingRow = settingRow;
    report.shots.push(await screenshot(cdp, "06-light-setting-entry.png"));
    check(
      "setting-entry-found",
      settingRow.rows[0]?.title === "消息时间戳" && settingRow.rows[0]?.hint === "设置 · 会话",
      settingRow.rows[0],
    );
    await press(cdp, "Enter");
    await waitFor("面板关闭", async () =>
      cdp.evaluate("document.querySelector('.palette') === null"),
    );
    const settingRun = await cdp.evaluate("window.__soxuPalette.executed()");
    report.settingRun = settingRun;
    check(
      "setting-entry-opens-tab",
      settingRun.actions.at(-1) === "openSettings:session",
      settingRun.actions,
    );
    // 设置弹窗真的开了、而且落在会话页：证明「设置项命令 = 打开设置并定位到该页」。
    const settingDialog = await cdp.evaluate("window.__soxuPalette.settings()");
    check(
      "setting-entry-really-opened-settings",
      settingDialog.open === true && settingDialog.activeTab === "会话",
      { open: settingDialog.open, activeTab: settingDialog.activeTab },
    );
    // 收起来：后面的截图只应包含命令面板。
    await cdp.evaluate("window.__soxuPalette.closeSettings()");
    await waitFor("设置弹窗收起", async () =>
      cdp.evaluate("window.__soxuPalette.settings().open === false"),
    );

    // ── 8. 无结果态
    await cdp.evaluate("window.__soxuPalette.reopen()");
    await waitFor("面板就绪", async () =>
      cdp.evaluate(
        "window.__soxuPalette.state().focused === 'cp-input' && window.__soxuPalette.state().pinyin === 'ready'",
      ),
    );
    await typeText(cdp, "xxt");
    await waitFor("无结果", async () =>
      cdp.evaluate("Boolean(document.querySelector('.cp-empty'))"),
    );
    const noResults = await cdp.evaluate("window.__soxuPalette.state()");
    report.noResults = noResults;
    report.shots.push(await screenshot(cdp, "07-light-no-results.png"));
    check("no-results-state", noResults.rows.length === 0 && noResults.count === "没有匹配的命令", noResults.count);

    // ── 9. 深色主题
    await cdp.evaluate("window.__soxuPalette.setTheme('dark')");
    await cdp.evaluate("window.__soxuPalette.reopen()");
    await waitFor("面板就绪", async () =>
      cdp.evaluate(
        "window.__soxuPalette.state().focused === 'cp-input' && window.__soxuPalette.state().pinyin === 'ready'",
      ),
    );
    await typeText(cdp, "dk");
    await waitFor("dk 结果", async () =>
      cdp.evaluate("document.querySelectorAll('.cp-item').length > 0"),
    );
    await sleep(120);
    const panelBackground = await cdp.evaluate("window.__soxuPalette.panelBackground()");
    const darkState = await cdp.evaluate("window.__soxuPalette.state()");
    report.dark = { panelBackground, rows: darkState.rows.length };
    report.shots.push(await screenshot(cdp, "08-dark-dk.png"));
    check("dark-panel", isDark(panelBackground), panelBackground);
    await cdp.evaluate("window.__soxuPalette.setTheme('light')");

    // ── 10. 无障碍语义
    const a11y = await cdp.evaluate(
      "({ dialog: document.querySelector('.palette')?.getAttribute('role') ?? null," +
        " modal: document.querySelector('.palette')?.getAttribute('aria-modal') ?? null," +
        " combobox: document.querySelector('.cp-input')?.getAttribute('role') ?? null," +
        " controls: document.querySelector('.cp-input')?.getAttribute('aria-controls') ?? null," +
        " listbox: document.querySelector('.cp-list')?.getAttribute('role') ?? null," +
        " options: document.querySelectorAll('.cp-item[role=\"option\"]').length," +
        " selected: document.querySelectorAll('.cp-item[aria-selected=\"true\"]').length," +
        " statusRole: document.querySelector('.cp-meta')?.getAttribute('role') ?? null })",
    );
    report.a11y = a11y;
    check(
      "a11y",
      a11y.dialog === "dialog" &&
        a11y.modal === "true" &&
        a11y.combobox === "combobox" &&
        a11y.controls === "soxu-command-list" &&
        a11y.listbox === "listbox" &&
        a11y.options === darkState.rows.length &&
        a11y.options > 0 &&
        a11y.selected === 1 &&
        a11y.statusRole === "status",
      a11y,
    );

    // ── 11. 模态焦点：Tab 圈在面板内，关闭后还给触发元素
    // 复审阻塞点：aria-modal 只是语义，浏览器不会替你圈焦点，也不会替你还原焦点。
    await cdp.evaluate("window.__soxuPalette.setTheme('light')");
    await cdp.evaluate("window.__soxuPalette.openFromTrigger()");
    await waitFor("面板就绪", async () =>
      cdp.evaluate(
        "window.__soxuPalette.state().focused === 'cp-input' && window.__soxuPalette.state().pinyin === 'ready'",
      ),
    );
    const focusOpened = await cdp.evaluate("window.__soxuPalette.focusInfo()");
    await press(cdp, "Tab");
    const focusAfterTab = await cdp.evaluate("window.__soxuPalette.focusInfo()");
    await press(cdp, "Tab", { shift: true });
    const focusAfterShiftTab = await cdp.evaluate("window.__soxuPalette.focusInfo()");
    report.focus = { opened: focusOpened, afterTab: focusAfterTab, afterShiftTab: focusAfterShiftTab };
    check("tab-trap-stays-inside", focusOpened.insidePalette && focusAfterTab.insidePalette, focusAfterTab);
    check(
      "shift-tab-trap-stays-inside",
      focusAfterShiftTab.insidePalette && focusAfterShiftTab.className === "cp-input",
      focusAfterShiftTab,
    );

    await press(cdp, "Escape");
    await waitFor("Esc 关闭", async () =>
      cdp.evaluate("document.querySelector('.palette') === null"),
    );
    const focusRestored = await cdp.evaluate("window.__soxuPalette.focusInfo()");
    report.focusRestored = focusRestored;
    check(
      "focus-restored-to-trigger",
      focusRestored.id === "harness-trigger",
      focusRestored,
    );

    // ── 12. 复审阻塞点 A：设置已经开着时，命令面板的设置命令必须换页
    // 旧实现只在 open 由 false→true 时应用 initialTab，设置已经开着的那次请求会被
    // 静默丢掉：界面停在原页，命令看起来没生效。这里用真实按键 + 真实 SettingsDialog 验证。
    const settingsBaseline = (await cdp.evaluate("window.__soxuPalette.settings()")).request;

    await cdp.evaluate("window.__soxuPalette.openFromTrigger()");
    await waitFor("面板就绪", async () =>
      cdp.evaluate(
        "window.__soxuPalette.state().focused === 'cp-input' && window.__soxuPalette.state().pinyin === 'ready'",
      ),
    );
    await typeText(cdp, "系统");
    await waitFor("设置页命令", async () =>
      cdp.evaluate("document.querySelectorAll('.cp-item').length > 0"),
    );
    const tabCommand = await cdp.evaluate("window.__soxuPalette.state()");
    check(
      "settings-tab-command-found",
      tabCommand.rows[0]?.title === "打开设置 · 系统",
      tabCommand.rows[0]?.title,
    );
    await press(cdp, "Enter");
    await waitFor("设置弹窗打开并落到系统页", async () =>
      cdp.evaluate(
        "(() => { const s = window.__soxuPalette.settings(); return s.open === true && s.activeTab === '系统'; })()",
      ),
    );
    const firstOpen = await cdp.evaluate("window.__soxuPalette.settings()");
    check(
      "settings-opened-on-target-tab",
      firstOpen.open === true &&
        firstOpen.activeTab === "系统" &&
        firstOpen.request === settingsBaseline + 1,
      { open: firstOpen.open, activeTab: firstOpen.activeTab, request: firstOpen.request, baseline: settingsBaseline },
    );

    // 设置仍然开着：再从命令面板执行「打开设置 · 外观」，必须切页且弹窗不关。
    await cdp.evaluate("window.__soxuPalette.reopen()");
    await waitFor("面板就绪", async () =>
      cdp.evaluate(
        "window.__soxuPalette.state().focused === 'cp-input' && window.__soxuPalette.state().pinyin === 'ready'",
      ),
    );
    await typeText(cdp, "外观");
    await waitFor("外观页命令", async () =>
      cdp.evaluate("document.querySelectorAll('.cp-item').length > 0"),
    );
    await press(cdp, "Enter");
    await waitFor("设置切到外观页", async () =>
      cdp.evaluate("window.__soxuPalette.settings().activeTab === '外观'"),
    );
    const retargeted = await cdp.evaluate("window.__soxuPalette.settings()");
    report.settingsRetarget = { baseline: settingsBaseline, firstOpen, retargeted };
    report.shots.push(await screenshot(cdp, "09-settings-retarget.png"));
    check("settings-stays-open-on-retarget", retargeted.open === true, retargeted.open);
    check("settings-retargeted-to-new-tab", retargeted.activeTab === "外观", retargeted.activeTab);
    check(
      "settings-request-incremented",
      retargeted.request === settingsBaseline + 2,
      { request: retargeted.request, baseline: settingsBaseline },
    );
    await cdp.evaluate("window.__soxuPalette.closeSettings()");

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
