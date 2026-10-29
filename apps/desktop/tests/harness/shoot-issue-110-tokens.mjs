/**
 * Issue #110（V4-S0 设计 token 落地）的可复现证据脚本。
 *
 * 用法（仓库任意位置）：
 *   node apps/desktop/tests/harness/shoot-issue-110-tokens.mjs
 *
 * 它自己拉起 Vite（默认 1434 端口）和一个独立 profile 的 headless Edge，通过 CDP
 * （Node 26 自带 WebSocket）派发真实鼠标事件、读 :root 上的计算值、拍截图，
 * 结束后回收两个子进程。产物：
 *   docs/development/evidence/issue-110-design-tokens/screens.json
 *   docs/development/evidence/issue-110-design-tokens/*.png
 *
 * 验证面是 /tokens.html（开发专用入口），不是 App.vue：本切片明确要求不动既有 10 个组件，
 * 色板因此独立成页，但走的是生产同一条主题切换链路（themeTransition.ts）。
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
const OUT_DIR = join(REPO_ROOT, "docs", "development", "evidence", "issue-110-design-tokens");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = Number(process.env.SOXU_HARNESS_PORT ?? 1434);
const DEBUG_PORT = Number(process.env.SOXU_CDP_PORT ?? 9457);
const BASE_URL = "http://127.0.0.1:" + PORT + "/tokens.html";
const VIEWPORT = { width: 1280, height: 900 };

/** 主题相关的 token：深浅色必须都给出值，且两边不同。 */
const THEME_TOKENS = [
  "--surface",
  "--bg-sidebar",
  "--bg-panel",
  "--bg-raised",
  "--bg-hover",
  "--bg-active",
  "--border",
  "--border-strong",
  "--fg",
  "--fg-muted",
  "--fg-subtle",
  "--code-bg",
  "--inset",
  "--glass",
  "--glass-border",
  "--shadow-pop-value",
];

/** 与主题无关的 token：两套主题下取值必须一致（原型就是这么定义的）。 */
const STATIC_TOKENS = [
  "--accent",
  "--accent-hover",
  "--ok",
  "--warn",
  "--danger",
  "--r-sm",
  "--r-md",
  "--r-lg",
  "--fs-micro",
  "--fs-caption",
  "--fs-chat",
  "--ease",
  "--ease-spring-value",
  "--shadow-modal",
  "--font-ui",
  "--font-code",
];

/** 原型 style.css 的字面量基线：抽出来的 token 必须与它一字不差。 */
const EXPECTED = {
  light: {
    "--surface": "#ffffff",
    "--bg-sidebar": "#f7f7f8",
    "--bg-raised": "#f2f2f3",
    "--border": "#e5e5e7",
    "--fg": "#1a1a1a",
    "--danger": "#dc2626",
  },
  dark: {
    "--surface": "#212121",
    "--bg-sidebar": "#191919",
    "--bg-raised": "#2f2f2f",
    "--border": "#383838",
    "--fg": "#ececec",
    "--danger": "#dc2626",
  },
  static: {
    "--accent": "#3a83f7",
    "--r-sm": "7px",
    "--r-md": "9px",
    "--r-lg": "13px",
    "--fs-micro": "11.5px",
    "--fs-caption": "12.5px",
    "--fs-chat": "16px",
  },
};

let pageErrors = [];

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

async function waitFor(label, probe, options) {
  const timeout = (options && options.timeout) || 30000;
  const interval = (options && options.interval) || 250;
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
      this.ws.onerror = (event) => fail(new Error("CDP 连接失败：" + (event && event.message ? event.message : "unknown")));
    });
    this.ws.onmessage = (event) => {
      const payload = JSON.parse(event.data);
      if (payload.id === undefined) {
        if (payload.method === "Runtime.exceptionThrown") {
          const details = payload.params.exceptionDetails;
          this.errors.push((details.exception && details.exception.description) || details.text);
        } else if (payload.method === "Runtime.consoleAPICalled") {
          const text = payload.params.args.map((arg) => arg.value || arg.description || "").join(" ");
          if (payload.params.type === "error" || payload.params.type === "warning") this.errors.push(text);
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
    const result = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      const details = result.exceptionDetails;
      throw new Error((details.exception && details.exception.description) || "页面脚本异常");
    }
    return result.result.value;
  }
}

async function screenshot(cdp, name) {
  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  const buffer = Buffer.from(shot.data, "base64");
  await writeFile(join(OUT_DIR, name), buffer);
  return { name, bytes: buffer.length, sha256: createHash("sha256").update(buffer).digest("hex") };
}

/**
 * 整页截图：色板比一屏高，只拍视口会漏掉大半个 token 清单。
 * 用临时把视口拉到文档高度再拍，拍完立刻还原——所以只能在所有布局断言之后调用。
 */
async function fullPageScreenshot(cdp, name) {
  const height = await cdp.evaluate("document.documentElement.scrollHeight");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: VIEWPORT.width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(250);
  const info = await screenshot(cdp, name);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(250);
  return { ...info, pageHeight: height };
}

/** 证据断言：先全部收集（保证 screens.json 完整），最后统一决定退出码。 */
const checks = [];
function check(name, passed, detail) {
  checks.push({ name, passed: Boolean(passed), detail });
  return Boolean(passed);
}

/**
 * 页面内的探针一律写成真函数再序列化：这样探针本身也是被检查的 JS，
 * 不用把整段表达式塞进字符串里（那种写法最容易因转义出错而静默假绿）。
 */
function probeTokens(names) {
  const styles = getComputedStyle(document.documentElement);
  const values = {};
  for (const name of names) values[name] = styles.getPropertyValue(name).trim();
  return {
    theme: document.documentElement.dataset.theme || null,
    values,
    bodyBg: getComputedStyle(document.body).backgroundColor,
  };
}

function probeLayout() {
  const rects = {};
  document.querySelectorAll("[data-stable]").forEach((node) => {
    const rect = node.getBoundingClientRect();
    rects[node.dataset.stable] = [
      Math.round(rect.x * 100) / 100,
      Math.round(rect.y * 100) / 100,
      Math.round(rect.width * 100) / 100,
      Math.round(rect.height * 100) / 100,
    ];
  });
  const root = document.documentElement;
  return {
    rects,
    scrollHeight: root.scrollHeight,
    clientHeight: root.clientHeight,
    scrollWidth: root.scrollWidth,
    clientWidth: root.clientWidth,
  };
}

function probeUtility() {
  const node = document.querySelector("[data-utility-probe]");
  if (!node) return null;
  const styles = getComputedStyle(node);
  const easing = {};
  document.querySelectorAll("[data-ease-probe]").forEach((item) => {
    easing[item.dataset.easeProbe] = getComputedStyle(item).transitionTimingFunction;
  });
  return {
    backgroundColor: styles.backgroundColor,
    color: styles.color,
    borderColor: styles.borderTopColor,
    borderRadius: styles.borderTopLeftRadius,
    boxShadow: styles.boxShadow,
    fontSize: styles.fontSize,
    lineHeight: styles.lineHeight,
    fontFamily: styles.fontFamily,
    easing,
  };
}

function probeTransition() {
  const root = document.documentElement;
  const styles = getComputedStyle(root);
  return {
    supported: typeof document.startViewTransition === "function",
    hasClass: root.classList.contains("soxu-theme-transition"),
    originX: styles.getPropertyValue("--soxu-theme-x").trim(),
    originY: styles.getPropertyValue("--soxu-theme-y").trim(),
    radius: styles.getPropertyValue("--soxu-theme-r").trim(),
    duration: styles.getPropertyValue("--soxu-theme-duration").trim(),
  };
}

function probeToggleCenter() {
  const node = document.querySelector(".toggle");
  if (!node) return null;
  const rect = node.getBoundingClientRect();
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function callProbe(fn, args) {
  // 没有参数时也要带括号：漏掉就成了「函数表达式本身」，CDP 会回一个空对象，断言全部静默失败。
  const payload = args === undefined ? "()" : "(" + JSON.stringify(args) + ")";
  return "(" + fn.toString() + ")" + payload;
}

function normalize(value) {
  return String(value === undefined || value === null ? "" : value).trim().toLowerCase();
}

function diffLayout(before, after) {
  let maxShift = 0;
  const changed = [];
  for (const key of Object.keys(before.rects)) {
    const rect = before.rects[key];
    const next = after.rects[key];
    if (!next) continue;
    let shift = 0;
    for (let index = 0; index < rect.length; index += 1) {
      shift = Math.max(shift, Math.abs(next[index] - rect[index]));
    }
    if (shift > 0) changed.push({ key, before: rect, after: next, shift });
    maxShift = Math.max(maxShift, shift);
  }
  return {
    maxShift: Math.round(maxShift * 100) / 100,
    changed,
    scrollHeightDelta: after.scrollHeight - before.scrollHeight,
    scrollWidthDelta: after.scrollWidth - before.scrollWidth,
  };
}

async function clickToggle(cdp) {
  const point = await cdp.evaluate(callProbe(probeToggleCenter));
  if (!point) throw new Error("找不到主题切换按钮");
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1 });
  return point;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), "soxu-110-edge-"));

  const vite = spawn(
    process.platform === "win32" ? "pnpm.cmd" : "pnpm",
    ["exec", "vite", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"],
    { cwd: APP_ROOT, shell: process.platform === "win32", stdio: "ignore" },
  );
  let edge = null;
  const cdp = new Cdp("");
  try {
    await waitFor("Vite 开发服务器", async () => {
      const response = await fetch("http://127.0.0.1:" + PORT + "/tokens.html", { method: "HEAD" });
      return response.ok;
    });

    edge = spawn(EDGE, [
      "--headless=new",
      "--remote-debugging-port=" + DEBUG_PORT,
      "--user-data-dir=" + profile,
      "--no-first-run",
      "--disable-extensions",
      "--hide-scrollbars",
      "--disable-gpu",
      "about:blank",
    ], { stdio: "ignore" });

    const target = await waitFor("Chromium CDP", async () => {
      const response = await fetch("http://127.0.0.1:" + DEBUG_PORT + "/json/new?about:blank", { method: "PUT" });
      const created = await response.json();
      return created && created.webSocketDebuggerUrl ? created : null;
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
      url: BASE_URL,
    };

    // 初始主题必须钉成浅色：headless Edge 跟随本机 Windows 深色设置，不钉就会先拍到深色。
    await cdp.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: "light" }],
    });
    await cdp.send("Page.navigate", { url: BASE_URL });
    await waitFor("色板渲染完成", () => cdp.evaluate("Boolean(document.querySelector('[data-utility-probe]'))"));
    await sleep(600);

    const shots = [];
    const shot = async (name) => {
      const info = await screenshot(cdp, name);
      shots.push(info);
      return info;
    };

    const tokenExpression = callProbe(probeTokens, [...THEME_TOKENS, ...STATIC_TOKENS]);

    // ---- 1. 浅色 token
    const light = await cdp.evaluate(tokenExpression);
    report.light = light;
    check("浅色：<html data-theme> 为 light", light.theme === "light", light.theme);
    for (const token of Object.keys(EXPECTED.light)) {
      check("浅色 " + token + " = " + EXPECTED.light[token], normalize(light.values[token]) === normalize(EXPECTED.light[token]), light.values[token]);
    }
    for (const token of Object.keys(EXPECTED.static)) {
      check(token + " = " + EXPECTED.static[token], normalize(light.values[token]) === normalize(EXPECTED.static[token]), light.values[token]);
    }
    for (const token of [...THEME_TOKENS, ...STATIC_TOKENS]) {
      check("浅色：" + token + " 有值", Boolean(light.values[token]), light.values[token]);
    }

    // ---- 2. @theme 工具类
    report.utilityLight = await cdp.evaluate(callProbe(probeUtility));
    const utilLight = report.utilityLight;
    check("@theme：bg-bg-raised 生成背景色", utilLight.backgroundColor === "rgb(242, 242, 243)", utilLight.backgroundColor);
    check("@theme：text-fg 生成文字色", utilLight.color === "rgb(26, 26, 26)", utilLight.color);
    check("@theme：border-border 生成描边色", utilLight.borderColor === "rgb(229, 229, 231)", utilLight.borderColor);
    check("@theme：rounded-lg = 13px", utilLight.borderRadius === "13px", utilLight.borderRadius);
    check("@theme：shadow-pop 生成阴影", utilLight.boxShadow !== "none", utilLight.boxShadow);
    check("@theme：text-chat = 16px", utilLight.fontSize === "16px", utilLight.fontSize);
    check("@theme：text-chat 带出 --lh-chat 行高 26.88px", utilLight.lineHeight === "26.88px", utilLight.lineHeight);
    check("@theme：font-mono 用项目等宽栈", /JetBrains Mono/i.test(utilLight.fontFamily), utilLight.fontFamily);
    check(
      "@theme：ease-spring 生成弹簧缓动",
      utilLight.easing["ease-spring"] === "cubic-bezier(0.34, 1.42, 0.64, 1)",
      utilLight.easing,
    );
    check(
      "@theme：ease-standard 指向原型 --ease",
      utilLight.easing["ease-standard"] === "cubic-bezier(0.2, 0, 0, 1)",
      utilLight.easing,
    );

    const layoutBefore = await cdp.evaluate(callProbe(probeLayout));
    const lightShot = await shot("01-light-tokens.png");

    // ---- 3. 点击切换：证明走 startViewTransition 圆形扩散
    const origin = await clickToggle(cdp);
    await sleep(120);
    const midTransition = await cdp.evaluate(callProbe(probeTransition));
    report.transition = { origin, midTransition };
    check("切换：浏览器支持 startViewTransition", midTransition.supported === true, midTransition.supported);
    check("切换：过渡期间 <html> 挂上过渡类名", midTransition.hasClass === true, midTransition.hasClass);
    check(
      "切换：圆心写在点击位置上",
      Math.abs(Number.parseFloat(midTransition.originX) - origin.x) < 1 &&
        Math.abs(Number.parseFloat(midTransition.originY) - origin.y) < 1,
      { origin, probe: midTransition },
    );
    check("切换：扩散半径 > 0", Number.parseFloat(midTransition.radius) > 0, midTransition.radius);
    // 同一段过渡里取两帧：圆形扩散是逐帧推进的，两帧必须不同，否则只是"换了个配色"。
    const earlyShot = await shot("02-light-to-dark-reveal-early.png");
    await sleep(180);
    const lateShot = await shot("03-light-to-dark-reveal-late.png");
    check("切换：扩散逐帧推进（两帧过渡截图不同）", earlyShot.sha256 !== lateShot.sha256, {
      early: earlyShot.sha256,
      late: lateShot.sha256,
    });
    check("切换：过渡帧既不是纯浅色也不是纯深色", earlyShot.sha256 !== lightShot.sha256, {
      early: earlyShot.sha256,
      light: lightShot.sha256,
    });

    await waitFor("深色落地", () => cdp.evaluate("document.documentElement.dataset.theme === 'dark'"));
    await sleep(900);

    // ---- 4. 深色 token
    const dark = await cdp.evaluate(tokenExpression);
    report.dark = dark;
    check("深色：<html data-theme> 为 dark", dark.theme === "dark", dark.theme);
    for (const token of Object.keys(EXPECTED.dark)) {
      check("深色 " + token + " = " + EXPECTED.dark[token], normalize(dark.values[token]) === normalize(EXPECTED.dark[token]), dark.values[token]);
    }
    for (const token of THEME_TOKENS) {
      check("深色：" + token + " 与浅色不同", normalize(dark.values[token]) !== normalize(light.values[token]), {
        light: light.values[token],
        dark: dark.values[token],
      });
    }
    for (const token of STATIC_TOKENS) {
      check("深色：" + token + " 与浅色一致（主题无关）", normalize(dark.values[token]) === normalize(light.values[token]), {
        light: light.values[token],
        dark: dark.values[token],
      });
    }

    report.utilityDark = await cdp.evaluate(callProbe(probeUtility));
    check(
      "深色：bg-bg-raised 工具类跟着换色",
      report.utilityDark.backgroundColor === "rgb(47, 47, 47)",
      report.utilityDark.backgroundColor,
    );
    check(
      "深色：shadow-pop 工具类跟着换成深色阴影",
      report.utilityDark.boxShadow !== report.utilityLight.boxShadow,
      { light: report.utilityLight.boxShadow, dark: report.utilityDark.boxShadow },
    );

    const layoutAfter = await cdp.evaluate(callProbe(probeLayout));
    report.layout = { before: layoutBefore, after: layoutAfter, diff: diffLayout(layoutBefore, layoutAfter) };
    check("切换：没有元素发生位移或尺寸变化", report.layout.diff.maxShift === 0, report.layout.diff);
    check("切换：文档滚动高度不变", report.layout.diff.scrollHeightDelta === 0, report.layout.diff);
    check("切换：文档滚动宽度不变", report.layout.diff.scrollWidthDelta === 0, report.layout.diff);
    const darkShot = await shot("04-dark-tokens.png");
    check("深色截图与浅色截图字节不同（主题真的换了）", darkShot.sha256 !== lightShot.sha256, {
      light: lightShot.sha256,
      dark: darkShot.sha256,
    });
    check("深色截图与过渡帧不同", darkShot.sha256 !== lateShot.sha256, {
      late: lateShot.sha256,
      dark: darkShot.sha256,
    });

    // ---- 5. 切回浅色，确认双向都对
    await clickToggle(cdp);
    await waitFor("浅色回退", () => cdp.evaluate("document.documentElement.dataset.theme === 'light'"));
    await sleep(900);
    const backToLight = await cdp.evaluate(tokenExpression);
    report.backToLight = backToLight;
    check("切回浅色：--surface 恢复 #ffffff", normalize(backToLight.values["--surface"]) === "#ffffff", backToLight.values["--surface"]);
    const layoutBack = await cdp.evaluate(callProbe(probeLayout));
    report.layoutBack = diffLayout(layoutBefore, layoutBack);
    check("切回浅色：布局仍然零位移", report.layoutBack.maxShift === 0, report.layoutBack);

    // ---- 6. 整页截图：色板比一屏高，只拍视口会漏掉大半个 token 清单
    const lightFull = await fullPageScreenshot(cdp, "05-light-tokens-full.png");
    shots.push(lightFull);
    check("整页截图高度大于视口（确实拍到了整页）", lightFull.pageHeight > VIEWPORT.height, lightFull.pageHeight);

    await clickToggle(cdp);
    await waitFor("深色整页", () => cdp.evaluate("document.documentElement.dataset.theme === 'dark'"));
    await sleep(900);
    const darkFull = await fullPageScreenshot(cdp, "06-dark-tokens-full.png");
    shots.push(darkFull);
    check("整页截图：深浅两页字节不同", darkFull.sha256 !== lightFull.sha256, {
      light: lightFull.sha256,
      dark: darkFull.sha256,
    });

    report.shots = shots;
    report.pageErrors = cdp.errors;
    check("页面没有运行期异常", cdp.errors.length === 0, cdp.errors);

    report.checks = checks;
    await writeFile(join(OUT_DIR, "screens.json"), JSON.stringify(report, null, 2), "utf8");

    const failed = checks.filter((entry) => !entry.passed);
    if (failed.length > 0) {
      throw new Error(
        "证据断言失败 " + failed.length + " 项：\n" + failed.map((entry) => "- " + entry.name + "：" + JSON.stringify(entry.detail)).join("\n"),
      );
    }

    console.log(JSON.stringify({
      url: BASE_URL,
      tokens: {
        light: { surface: light.values["--surface"], fg: light.values["--fg"], bodyBg: light.bodyBg },
        dark: { surface: dark.values["--surface"], fg: dark.values["--fg"], bodyBg: dark.bodyBg },
      },
      transition: report.transition,
      layout: report.layout.diff,
      utility: { light: report.utilityLight, dark: report.utilityDark },
      shots,
      checks: { total: checks.length, passed: checks.filter((entry) => entry.passed).length },
    }, null, 2));
  } finally {
    pageErrors = cdp.errors;
    cdp.ws && cdp.ws.close();
    killTree(edge && edge.pid);
    killTree(vite.pid);
    await rm(profile, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  console.error("页面错误：" + JSON.stringify(pageErrors, null, 2));
  process.exitCode = 1;
});
