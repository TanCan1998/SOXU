/**
 * Issue #116（V4-S2）复审证据：强调色底上的前景对比度（真实浏览器实测）。
 *
 * 复审阻塞点：ComposerSendMenu 的 caret 把前景写死成 #fff，在浅色板上不可读。
 * 这个脚本把真正的 ChatPanel（含 composer 的「主钮 + caret」）挂进 headless Edge，
 * 逐个色板 × 深浅主题读取**计算后的**前景色与底色，用 WCAG 公式算对比度并落盘。
 *
 * 用法（仓库任意位置）：
 *   node apps/desktop/tests/harness/shoot-send-caret-contrast.mjs
 *
 * 说明：色板通过 document.documentElement.dataset.accent 设置——这与生产里
 * applyDocumentAppearance() 写的是同一个属性，因此量到的就是用户切色板后的渲染结果。
 * 任一断言不成立即以非 0 退出，避免留下「看起来正常」的证据。
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(HERE, "../..");
const REPO_ROOT = resolve(APP_ROOT, "../..");
const OUT_DIR = join(REPO_ROOT, "docs", "development", "evidence", "issue-116-v4-s2");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = Number(process.env.SOXU_CARET_PORT ?? 1426);
const DEBUG_PORT = Number(process.env.SOXU_CARET_CDP_PORT ?? 9458);
const BASE_URL = "http://127.0.0.1:" + PORT + "/tests/harness/v4-session.html";
const VIEWPORT = { width: 1280, height: 800 };

const ACCENTS = ["blue", "green", "teal", "violet", "rose", "amber"];
const THEMES = ["light", "dark"];
const MIN_NON_TEXT_CONTRAST = 3;

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

async function waitFor(label, probe, options) {
  const timeout = (options && options.timeout) || 30000;
  const started = Date.now();
  for (;;) {
    try {
      const value = await probe();
      if (value) return value;
    } catch {
      // 还没起来，继续等。
    }
    if (Date.now() - started > timeout) throw new Error("等待超时：" + label);
    await sleep(200);
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

/** 极简 CDP 客户端：只用到 Runtime.evaluate / Page.captureScreenshot / Emulation。 */
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
      this.ws.onerror = (event) => fail(new Error("CDP 连接失败：" + (event && event.message)));
    });
    this.ws.onmessage = (event) => {
      const payload = JSON.parse(event.data);
      if (payload.id === undefined) {
        if (payload.method === "Runtime.exceptionThrown") {
          this.errors.push(
            (payload.params.exceptionDetails.exception && payload.params.exceptionDetails.exception.description) ||
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

  send(method, params) {
    this.sequence += 1;
    const id = this.sequence;
    return new Promise((done, fail) => {
      this.pending.set(id, { done, fail });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception.description || "页面脚本异常");
    }
    return result.result.value;
  }

  close() {
    if (this.ws) this.ws.close();
    this.ws = null;
  }
}

/**
 * 把色值解析成 [r, g, b]：兼容 rgb()/rgba()、color(srgb …) 两种计算值序列化，
 * 以及 token 原文的 #rrggbb（--soxu-on-accent 在 base.css 里就是十六进制）。
 */
function parseColor(value) {
  const text = String(value || "").trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(text);
  if (hex) {
    const packed = Number.parseInt(hex[1], 16);
    return [(packed >> 16) & 255, (packed >> 8) & 255, packed & 255];
  }
  const rgb = /^rgba?\(([^)]+)\)$/.exec(text);
  if (rgb) {
    const parts = rgb[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return [parts[0], parts[1], parts[2]];
  }
  const srgb = /^color\(srgb\s+([^)]+)\)$/.exec(text);
  if (srgb) {
    const parts = srgb[1].split(/[\s/]+/).filter(Boolean).map(Number);
    return [
      Math.round(parts[0] * 255),
      Math.round(parts[1] * 255),
      Math.round(parts[2] * 255),
    ];
  }
  throw new Error("无法解析颜色：" + text);
}

function linearChannel(value) {
  const channel = value / 255;
  return channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
}

function relativeLuminance(rgb) {
  return (
    0.2126 * linearChannel(rgb[0]) +
    0.7152 * linearChannel(rgb[1]) +
    0.0722 * linearChannel(rgb[2])
  );
}

function contrastRatio(background, foreground) {
  const high = Math.max(relativeLuminance(background), relativeLuminance(foreground));
  const low = Math.min(relativeLuminance(background), relativeLuminance(foreground));
  return (high + 0.05) / (low + 0.05);
}

const checks = [];
function check(name, ok, detail) {
  checks.push(Object.assign({ name, ok: Boolean(ok) }, detail));
}

/** 一次性取回「主钮 / caret / 分隔线 / 底色 / token」的计算值。 */
const PROBE =
  "(() => {" +
  " const caret = document.querySelector('.send-caret');" +
  " const main = document.querySelector('.send-main');" +
  " const split = document.querySelector('.send-split');" +
  " if (!caret || !main || !split) return null;" +
  " const caretStyle = getComputedStyle(caret);" +
  " const rootStyle = getComputedStyle(document.documentElement);" +
  " return {" +
  "  caretColor: caretStyle.color," +
  "  caretBorder: caretStyle.borderLeftColor," +
  "  mainColor: getComputedStyle(main).color," +
  "  splitBg: getComputedStyle(split).backgroundColor," +
  "  accent: rootStyle.getPropertyValue('--soxu-accent').trim()," +
  "  onAccent: rootStyle.getPropertyValue('--soxu-on-accent').trim()," +
  "  theme: document.documentElement.dataset.theme || 'light'," +
  "  accentName: document.documentElement.dataset.accent || 'blue'," +
  " };" +
  "})()";

const SET_ACCENT = (accent, theme) =>
  "(() => { const root = document.documentElement;" +
  " root.dataset.theme = " + JSON.stringify(theme) + ";" +
  " if (" + JSON.stringify(accent) + " === 'blue') delete root.dataset.accent;" +
  " else root.dataset.accent = " + JSON.stringify(accent) + ";" +
  " return new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(true))));" +
  "})()";

async function captureSplit(cdp, name) {
  const box = await cdp.evaluate(
    "(() => { const rect = document.querySelector('.send-split').getBoundingClientRect();" +
      " return { x: Math.floor(rect.x) - 6, y: Math.floor(rect.y) - 6," +
      " width: Math.ceil(rect.width) + 12, height: Math.ceil(rect.height) + 12 }; })()",
  );
  const shot = await cdp.send("Page.captureScreenshot", {
    format: "png",
    clip: Object.assign({ scale: 6 }, box),
  });
  await writeFile(join(OUT_DIR, name), Buffer.from(shot.data, "base64"));
  return name;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), "soxu-116-caret-edge-"));

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
      return list.find((item) => item.type === "page" && item.webSocketDebuggerUrl) || null;
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
      fixture: "tests/harness/v4-session.html",
      threshold: MIN_NON_TEXT_CONTRAST,
      note:
        "色板通过 documentElement.dataset.accent 设置，与生产 applyDocumentAppearance 同一属性；" +
        "量的是 ChatPanel 里真实 composer 的计算样式。",
      samples: [],
      shots: [],
    };

    await cdp.send("Page.navigate", { url: BASE_URL });
    await waitFor("composer 挂载", async () =>
      cdp.evaluate("Boolean(document.querySelector('.send-caret') && document.querySelector('.send-split'))"),
    );
    await cdp.evaluate(
      "new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))",
    );

    for (const theme of THEMES) {
      for (const accent of ACCENTS) {
        await cdp.evaluate(SET_ACCENT(accent, theme));
        const probe = await cdp.evaluate(PROBE);
        if (!probe) throw new Error("composer 在 " + theme + "/" + accent + " 下消失了");
        const caretRgb = parseColor(probe.caretColor);
        const mainRgb = parseColor(probe.mainColor);
        const bgRgb = parseColor(probe.splitBg);
        const sample = {
          theme,
          accent,
          accentHex: probe.accent,
          onAccentHex: probe.onAccent,
          caretColor: probe.caretColor,
          mainColor: probe.mainColor,
          splitBg: probe.splitBg,
          caretBorderColor: probe.caretBorder,
          contrast: Number(contrastRatio(bgRgb, caretRgb).toFixed(2)),
        };
        report.samples.push(sample);

        check(
          theme + "/" + accent + "：caret 前景对底色达到非文本 3:1",
          sample.contrast >= MIN_NON_TEXT_CONTRAST,
          { actual: sample.contrast, caret: sample.caretColor, bg: sample.splitBg },
        );
        check(
          theme + "/" + accent + "：caret 与主钮前景一致",
          caretRgb.join(",") === mainRgb.join(","),
          { caret: sample.caretColor, main: sample.mainColor },
        );
        check(
          theme + "/" + accent + "：caret 前景等于色板的 --soxu-on-accent",
          probe.caretColor.replace(/\s/g, "") ===
            "rgb(" + parseColor(probe.onAccent).join(",") + ")",
          { caret: sample.caretColor, onAccent: probe.onAccent },
        );
      }
    }

    // 两个曾经不可读的色板各留一张放大截图（6 倍，直接看得见图标与分隔线）。
    await cdp.evaluate(SET_ACCENT("amber", "light"));
    report.shots.push(await captureSplit(cdp, "09-send-caret-amber.png"));
    await cdp.evaluate(SET_ACCENT("teal", "light"));
    report.shots.push(await captureSplit(cdp, "10-send-caret-teal.png"));

    report.pageErrors = cdp.errors;
    report.checks = checks;
    await writeFile(join(OUT_DIR, "send-caret-contrast.json"), JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report, null, 2));
    if (checks.some((entry) => !entry.ok)) {
      console.error("断言未通过：" + JSON.stringify(checks.filter((entry) => !entry.ok)));
      process.exitCode = 1;
    }
  } finally {
    cdp.close();
    killTree(edge && edge.pid);
    killTree(vite.pid);
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      // 临时 profile 清理失败不影响证据。
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
