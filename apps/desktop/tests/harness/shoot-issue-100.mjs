/**
 * Issue #100 的可复现证据脚本：会话状态面板去掉重复关闭按钮、「添加项目」改为按钮、
 * 「临时会话」换成虚线气泡图标，一次跑完并落盘截图与原始数值。
 *
 * 用法（仓库任意位置）：
 *   node apps/desktop/tests/harness/shoot-issue-100.mjs
 *
 * 它自己拉起 Vite（默认 1424 端口）和一个独立 profile 的 headless Edge，通过 CDP
 * （Node 26 自带 WebSocket）派发真实的鼠标/键盘事件，结束后回收两个子进程。
 *
 * 说明：浏览器预览没有 Tauri 桥（createUnavailableBridge），因此「添加项目」按钮
 * 以禁用态渲染——这恰好是「未连接时不假装能登记」的正确表现。选择器的真实行为由
 * tests/projectDirectory.test.ts 与 composables/useProjectDirectoryPick.ts 覆盖。
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(HERE, "../..");
const REPO_ROOT = resolve(APP_ROOT, "../..");
const OUT_DIR = join(REPO_ROOT, "docs", "development", "evidence", "issue-100-desktop-polish");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = Number(process.env.SOXU_HARNESS_PORT ?? 1424);
const DEBUG_PORT = Number(process.env.SOXU_CDP_PORT ?? 9456);
const BASE_URL = `http://127.0.0.1:${PORT}/`;
const VIEWPORT = { width: 1280, height: 800 };

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
    const result = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
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
  const buffer = Buffer.from(shot.data, "base64");
  await writeFile(join(OUT_DIR, name), buffer);
  // 记录哈希：两张"不同主题"的截图如果字节相同，就说明主题根本没换（上一版就是这么翻车的）。
  return { name, bytes: buffer.length, sha256: createHash("sha256").update(buffer).digest("hex") };
}

/**
 * 截图前必须自证主题。
 *
 * 主题来源是 localStorage 偏好 → 系统 prefers-color-scheme（见 theme/theme.ts）。全新
 * profile 没有偏好，所以主题完全由系统决定；headless Edge 跟随本机 Windows 深色设置，
 * 于是"浅色"截图其实全是深色、05 与 01 字节完全相同。现在显式钉住 prefers-color-scheme，
 * 并把 <html data-theme> + body 计算色换算成亮度写进 screens.json，不符合预期就让脚本失败。
 */
const THEME_PROBE = `(() => {
  const shell = document.querySelector(".app-shell");
  const body = getComputedStyle(document.body);
  return {
    datasetTheme: document.documentElement.dataset.theme ?? null,
    shellTheme: shell?.getAttribute("data-theme") ?? null,
    bodyBg: body.backgroundColor,
    bodyColor: body.color,
    colorScheme: body.colorScheme,
    storedTheme: localStorage.getItem("soxu.theme"),
  };
})()`;

function parseRgb(value) {
  const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/i.exec(value ?? "");
  if (!match) return null;
  return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) };
}

/** WCAG 相对亮度：只用来区分"确实是浅色 / 确实是深色"，不做对比度验收。 */
function relativeLuminance(rgb) {
  if (!rgb) return null;
  const channel = (value) => {
    const scaled = value / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

/** 证据断言：先全部收集（保证 screens.json 完整），最后统一决定退出码。 */
const checks = [];
function check(name, passed, detail) {
  checks.push({ name, passed: Boolean(passed), detail });
  return Boolean(passed);
}

function themeCheck(prefix, probe, expected) {
  const luminance = relativeLuminance(parseRgb(probe.bodyBg));
  const record = { ...probe, relativeLuminance: luminance };
  check(`${prefix}：<html data-theme> 为 ${expected}`, probe.datasetTheme === expected, record);
  check(
    `${prefix}：.app-shell[data-theme] 为 ${expected}`,
    probe.shellTheme === expected,
    record,
  );
  check(
    expected === "light" ? `${prefix}：body 背景确实是浅色（亮度 > 0.8）` : `${prefix}：body 背景确实是深色（亮度 < 0.05）`,
    luminance !== null && (expected === "light" ? luminance > 0.8 : luminance < 0.05),
    { bodyBg: probe.bodyBg, relativeLuminance: luminance },
  );
  check(`${prefix}：没有被持久化偏好覆盖（localStorage 无 soxu.theme）`, probe.storedTheme === null, {
    storedTheme: probe.storedTheme,
  });
  return record;
}

/** 三个验收点的运行期事实：面板按钮清单、添加项目入口的标签与禁用态、临时会话图标。 */
const MEASURE = `(() => {
  const text = (node) => (node?.textContent ?? "").replace(/\\s+/g, " ").trim();
  const inspector = document.querySelector(".inspector");
  const welcome = document.querySelector(".welcome");
  const welcomeAdd = document.querySelector(".welcome-add");
  const sidebarAdd = document.querySelector(".add-project");
  const newSession = document.querySelector(".new-session");
  const icon = newSession?.querySelector("svg");
  return {
    inspector: inspector
      ? {
          present: true,
          headButtons: inspector.querySelectorAll(".inspector-head button").length,
          buttons: Array.from(inspector.querySelectorAll("button")).map((button) => ({
            label: button.getAttribute("aria-label") ?? text(button),
            tag: button.tagName,
          })),
          closeButtonCount: Array.from(inspector.querySelectorAll("button")).filter(
            (button) => (button.getAttribute("aria-label") ?? "").includes("关闭"),
          ).length,
        }
      : { present: false },
    welcome: welcome
      ? {
          inputCount: welcome.querySelectorAll("input").length,
          formCount: welcome.querySelectorAll("form").length,
          button: welcomeAdd
            ? {
                tag: welcomeAdd.tagName,
                text: text(welcomeAdd),
                disabled: welcomeAdd.disabled,
                hasPlusIcon: Boolean(welcomeAdd.querySelector("svg")),
              }
            : null,
        }
      : null,
    sidebar: {
      inputCount: sidebarAdd ? sidebarAdd.querySelectorAll("input").length : null,
      button: sidebarAdd
        ? {
            tag: sidebarAdd.tagName,
            text: text(sidebarAdd),
            disabled: sidebarAdd.disabled,
            hasPlusIcon: Boolean(sidebarAdd.querySelector("svg")),
          }
        : null,
      addProjectInputCount: document.querySelectorAll(".sidebar input[type=text], .sidebar .add-project input").length,
    },
    temporarySession: newSession
      ? {
          text: text(newSession),
          iconClass: icon?.getAttribute("class") ?? null,
          iconPaths: icon ? icon.querySelectorAll("path,rect,line,polyline").length : 0,
        }
      : null,
    topbarToggle: (() => {
      const button = Array.from(document.querySelectorAll(".app-header button")).find((node) =>
        node.querySelector("svg.lucide-panel-right") || (node.getAttribute("aria-label") ?? "").includes("会话状态面板"),
      );
      return button
        ? {
            label: button.getAttribute("aria-label"),
            expanded: button.getAttribute("aria-expanded"),
            shortcuts: button.getAttribute("aria-keyshortcuts"),
          }
        : null;
    })(),
    titleAttrCount: document.querySelectorAll("[title]").length,
    geometry: (() => {
      const box = (node) => {
        if (!node) return null;
        const rect = node.getBoundingClientRect();
        return {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
        };
      };
      return {
        welcomeAdd: box(welcomeAdd),
        sidebarAdd: box(sidebarAdd),
        tempSessionIcon: box(icon),
        sidebar: box(document.querySelector(".sidebar")),
        inspector: box(inspector),
      };
    })(),
  };
})()`;

async function centerOf(cdp, selector) {
  return cdp.evaluate(
    `(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) return null; const rect = node.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; })()`,
  );
}

async function click(cdp, selector) {
  const point = await centerOf(cdp, selector);
  if (!point) throw new Error(`找不到可点击元素：${selector}`);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1 });
  await sleep(260);
}

async function hover(cdp, selector) {
  const point = await centerOf(cdp, selector);
  if (!point) throw new Error(`找不到可悬停元素：${selector}`);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 4, y: 400 });
  await sleep(120);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
  await sleep(900);
}

/** Ctrl+I：顶栏面板的键盘入口，必须与按钮等价。 */
async function pressCtrlI(cdp) {
  const base = { modifiers: 2, key: "i", code: "KeyI", windowsVirtualKeyCode: 73, nativeVirtualKeyCode: 73 };
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...base });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  await sleep(260);
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), "soxu-100-edge-"));

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

    const report = {
      generatedAt: new Date().toISOString(),
      viewport: VIEWPORT,
      browser: await cdp.send("Browser.getVersion").then((info) => info.product),
      bridge: "unavailable（浏览器预览无 Tauri 桥）",
    };

    // 主题必须显式钉住：全新 profile 没有 localStorage 偏好，主题完全由
    // prefers-color-scheme 决定；headless Edge 跟随本机 Windows 的深色设置，
    // 不钉浅色的话 01–04 会全部拍成深色（Reviewer 已指出过）。
    await cdp.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: "light" }],
    });
    await cdp.send("Page.navigate", { url: BASE_URL });
    await waitFor("应用外壳（浅色）", () => cdp.evaluate(`Boolean(document.querySelector(".app-shell"))`));
    await sleep(700);

    const shots = [];
    const shot = async (name) => {
      const info = await screenshot(cdp, name);
      shots.push(info);
      return info;
    };

    // 浅色主题自证：<html data-theme>、.app-shell[data-theme]、body 计算色都必须指向 light。
    report.lightTheme = themeCheck("浅色", await cdp.evaluate(THEME_PROBE), "light");

    // ---- 1. 面板默认打开：内部没有第二个关闭按钮
    report.initial = await cdp.evaluate(MEASURE);
    const lightShot = await shot("01-welcome-add-project-button.png");

    // ---- 2. 悬停临时会话按钮：虚线气泡图标 + 提示文案不变
    await hover(cdp, ".new-session");
    report.tempSessionHover = await cdp.evaluate(
      `Array.from(document.querySelectorAll(".soxu-tooltip")).map((node) => node.textContent?.trim())`,
    );
    await shot("02-sidebar-temp-session-dashed.png");
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 640, y: 760 });
    await sleep(500);

    // ---- 3. 顶栏 PanelRight 关闭面板
    await click(cdp, '.app-header button[aria-label*="会话状态面板"]');
    report.afterTopbarClick = await cdp.evaluate(MEASURE);
    report.afterTopbarClick.inspectorVisible = await cdp.evaluate(
      `document.querySelectorAll(".inspector").length`,
    );
    await shot("03-panel-closed-by-topbar.png");

    // ---- 4. Ctrl+I 重新打开面板
    await pressCtrlI(cdp);
    report.afterCtrlI = await cdp.evaluate(MEASURE);
    report.afterCtrlI.inspectorVisible = await cdp.evaluate(
      `document.querySelectorAll(".inspector").length`,
    );
    await shot("04-panel-reopened-by-ctrl-i.png");

    // ---- 5. 深色主题下的同一组控件
    // 没有持久化偏好时主题跟随系统，因此直接用 CDP 模拟 prefers-color-scheme 再重载，
    // 比点主题按钮更确定（不受 hover / 过渡动画的时序影响）。
    await cdp.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: "dark" }],
    });
    await cdp.send("Page.navigate", { url: BASE_URL });
    await waitFor("应用外壳（深色）", () => cdp.evaluate(`Boolean(document.querySelector(".app-shell"))`));
    await sleep(700);
    report.darkTheme = themeCheck("深色", await cdp.evaluate(THEME_PROBE), "dark");
    check(
      "深色与浅色的 body 背景确实不同",
      report.darkTheme.bodyBg !== report.lightTheme.bodyBg,
      { light: report.lightTheme.bodyBg, dark: report.darkTheme.bodyBg },
    );
    report.dark = await cdp.evaluate(MEASURE);
    const darkShot = await shot("05-dark-inspector-no-close.png");
    // 最后一关：05 与 01 若字节完全相同，说明主题切换根本没生效（上一版就是这样翻车的）。
    check(
      "深色截图与浅色截图字节不同（05 ≠ 01）",
      darkShot.sha256 !== lightShot.sha256,
      { light: lightShot.sha256, dark: darkShot.sha256 },
    );

    report.shots = shots;
    report.checks = checks;
    await writeFile(join(OUT_DIR, "screens.json"), JSON.stringify(report, null, 2), "utf8");

    const failed = checks.filter((entry) => !entry.passed);
    if (failed.length > 0) {
      throw new Error(
        `证据断言失败 ${failed.length} 项：\n${failed.map((entry) => `- ${entry.name}：${JSON.stringify(entry.detail)}`).join("\n")}`,
      );
    }

    console.log(JSON.stringify({
      inspector: report.initial.inspector,
      welcome: report.initial.welcome,
      sidebar: report.initial.sidebar,
      temporarySession: report.initial.temporarySession,
      topbarToggle: report.initial.topbarToggle,
      tempSessionHover: report.tempSessionHover,
      afterTopbarClick: { present: report.afterTopbarClick.inspector.present, visible: report.afterTopbarClick.inspectorVisible, toggle: report.afterTopbarClick.topbarToggle },
      afterCtrlI: { present: report.afterCtrlI.inspector.present, visible: report.afterCtrlI.inspectorVisible, toggle: report.afterCtrlI.topbarToggle },
      darkInspector: report.dark.inspector,
      geometry: report.initial.geometry,
      themes: {
        light: { theme: report.lightTheme.datasetTheme, bodyBg: report.lightTheme.bodyBg, luminance: report.lightTheme.relativeLuminance },
        dark: { theme: report.darkTheme.datasetTheme, bodyBg: report.darkTheme.bodyBg, luminance: report.darkTheme.relativeLuminance },
      },
      shots,
      checks: { total: checks.length, passed: checks.filter((entry) => entry.passed).length },
      titleAttrCount: report.initial.titleAttrCount,
    }, null, 2));
  } finally {
    pageErrors = cdp.errors;
    cdp.close();
    killTree(edge?.pid);
    killTree(vite.pid);
    await rm(profile, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  console.error(`页面错误：${JSON.stringify(pageErrors, null, 2)}`);
  process.exitCode = 1;
});
