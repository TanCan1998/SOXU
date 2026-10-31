/**
 * Issue #145（TASK-035）的 Windows 实机走查脚本：真实 Tauri 窗口 + 真实 Rust 后端。
 *
 * 与 \`shoot-issue-116-settings.mjs\` 的区别：那个脚本在 headless Edge 里挂真实组件，
 * 量的是「组件行为」；本脚本启动的是 **构建产物 soxu-desktop.exe**，量的是
 * 「点了 × 到底退不退出进程」「系统文件管理器有没有真的打开」这类只有窗口宿主
 * 才能回答的问题（复审要求的三项实机证据）。
 *
 * 用法（仓库根目录，先 \`cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml\`）：
 *   node apps/desktop/tests/harness/verify-issue-145-desktop.mjs
 *
 * 三个用例各自独立启动一次应用，互不污染：
 *   1. tray-on  ——「关闭时最小化到托盘」为开：点 × 后进程仍在、窗口隐藏；
 *   2. tray-off ——该开关关掉后点 ×：进程退出（验收要求的那一条）；
 *   3. notify   ——「任务完成通知」开关真的管住 Toast；「打开数据目录」真的打开资源管理器。
 *
 * 两处刻意的替身，都在本机临时目录里生成，不进仓库、不进产品构建：
 * - \`pi\` 用 \`crates/agent-runtime/tests/fixtures/fake-pi.mjs\` 驱动（否则会真的调用模型、
 *   真的写用户会话文件）。替身入口是一个 rustc 编译的小 exe，因为 Windows 上
 *   \`Command::new("pi")\` 只会补 \`.exe\`，不认 \`.cmd\`；
 * - 用例只改自己的开关，跑完把开关恢复成进入时的值，避免把开发机的偏好留在关闭态。
 *
 * 需要的前提：\`pnpm dev\` 的 Vite 端口（1420）可用（脚本会自己拉起并在结束时回收）、
 * \`rustc\` 可用、WebView2 已安装。产物写入 docs/development/evidence/issue-145-product-i18n/。
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(HERE, "../..");
const REPO_ROOT = resolve(APP_ROOT, "../..");
const OUT_DIR = join(REPO_ROOT, "docs", "development", "evidence", "issue-145-product-i18n");
const EXE = join(REPO_ROOT, "target", "debug", "soxu-desktop.exe");
const FAKE_PI = join(REPO_ROOT, "crates", "agent-runtime", "tests", "fixtures", "fake-pi.mjs");

const VITE_PORT = Number(process.env.SOXU_HARNESS_PORT ?? 1420);
const CDP_PORT = Number(process.env.SOXU_DESKTOP_CDP_PORT ?? 9451);
const VIEWPORT = { width: 1280, height: 820 };

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

/** PowerShell 单行命令：进程与窗口状态只有窗口宿主知道，WebView 里看不到。 */
function ps(command) {
  const result = spawnSync("powershell", ["-NoProfile", "-Command", command], {
    encoding: "utf8",
    windowsHide: true,
  });
  return (result.stdout ?? "").trim();
}

function processAlive(pid) {
  return ps("if (Get-Process -Id " + pid + " -ErrorAction SilentlyContinue) { 'alive' } else { 'gone' }") === "alive";
}

/**
 * 进程 + 全部后代（WebView2 的浏览器/渲染/GPU 进程都是它的子进程）。
 *
 * 为什么需要：只判「主进程还在」不足以说明隐藏到托盘后应用仍然可用——窗口内容
 * 由 msedgewebview2.exe 渲染，那些进程若随窗口一起退掉，界面恢复后就是白屏。
 * 反过来「关掉开关后进程退出」也要看整棵树，否则残留的 WebView2 进程会漏判。
 */
function processTree(pid) {
  const raw = ps(
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress",
  );
  if (!raw) return [];
  let table;
  try {
    table = JSON.parse(raw);
  } catch {
    return [];
  }
  const rows = Array.isArray(table) ? table : [table];
  const childrenOf = new Map();
  for (const row of rows) {
    const parent = Number(row.ParentProcessId);
    const list = childrenOf.get(parent) ?? [];
    list.push({ pid: Number(row.ProcessId), name: String(row.Name) });
    childrenOf.set(parent, list);
  }
  const found = [];
  const queue = [pid];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const child of childrenOf.get(current) ?? []) {
      found.push(child);
      queue.push(child.pid);
    }
  }
  return found;
}

/** 进程树摘要：条数与按进程名计数，够用来对比关闭前后，也不会把整张进程表写进证据。 */
function treeSummary(pid) {
  const tree = processTree(pid);
  const byName = {};
  for (const entry of tree) byName[entry.name] = (byName[entry.name] ?? 0) + 1;
  return { total: tree.length, byName };
}

/**
 * 主窗口的可见性，用 EnumWindows + IsWindowVisible 判定。
 *
 * 不能用 `(Get-Process).MainWindowHandle`：那个属性会挑「第一个可见的顶层窗口」，
 * 而 tao 自己有一个常驻可见的消息窗口（class = "Tao Thread Event Target"），
 * 于是窗口明明已经隐藏、探针却报 visible。这里只认 class 为 "Tauri Window" 的那个窗口。
 */
const WINDOW_PROBE = String.raw`
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class SoxuWindowProbe {
  delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassNameW(IntPtr hWnd, StringBuilder s, int n);
  public static string State(uint target) {
    string state = "missing";
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid != target) return true;
      var cls = new StringBuilder(256); GetClassNameW(h, cls, 256);
      if (cls.ToString() != "Tauri Window") return true;
      state = IsWindowVisible(h) ? "visible" : "hidden";
      return false;
    }, IntPtr.Zero);
    return state;
  }
  /// 该进程的全部顶层窗口：class|visible，一行一个。托盘图标窗口也在这里。
  public static string List(uint target) {
    var sb = new StringBuilder();
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid != target) return true;
      var cls = new StringBuilder(256); GetClassNameW(h, cls, 256);
      sb.Append(cls.ToString()).Append('|').Append(IsWindowVisible(h) ? "visible" : "hidden").Append('\n');
      return true;
    }, IntPtr.Zero);
    return sb.ToString();
  }
}
"@
[SoxuWindowProbe]::State(`;

/** "visible" | "hidden" | "missing"：主窗口当前的可见性（hidden = 窗口还在，只是不可见）。 */
function windowState(pid) {
  const raw = ps(WINDOW_PROBE + pid + ")").trim().split(/\r?\n/).pop();
  return raw === "visible" || raw === "hidden" ? raw : "missing";
}

/**
 * 该进程的全部顶层窗口（class|visible）。隐藏到托盘后主窗口仍在（hidden），
 * 托盘图标窗口也仍在；进程退出后整张表为空——这比一句「已隐藏」更可核对。
 */
function windowList(pid) {
  const raw = ps(WINDOW_PROBE.replace(/::State\($/, "::List(") + pid + ")").trim();
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function killTree(pid) {
  if (!pid) return;
  spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
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
          const text = payload.params.args.map((arg) => arg.value ?? arg.description ?? "").join(" ");
          if (payload.params.type === "error" || payload.params.type === "warning") {
            this.errors.push(payload.params.type + ": " + text);
          }
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
    const id = ++this.sequence;
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
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? "页面脚本异常");
    }
    return result.result.value;
  }

  async screenshot(name) {
    const shot = await this.send("Page.captureScreenshot", { format: "png" });
    await writeFile(join(OUT_DIR, name), Buffer.from(shot.data, "base64"));
    return name;
  }

  async key(key, code, virtualKeyCode, modifiers = 0) {
    for (const type of ["rawKeyDown", "keyUp"]) {
      await this.send("Input.dispatchKeyEvent", {
        type,
        key,
        code,
        modifiers,
        windowsVirtualKeyCode: virtualKeyCode,
        nativeVirtualKeyCode: virtualKeyCode,
      });
    }
    await sleep(220);
  }

  async type(text) {
    await this.send("Input.insertText", { text });
    await sleep(120);
  }

  close() {
    this.ws?.close();
    this.ws = null;
  }
}

const checks = [];
function check(name, ok, detail = {}) {
  checks.push({ name, ok: Boolean(ok), ...detail });
}

/* ────────────────────────── 准备临时替身 ────────────────────────── */

/**
 * Windows 上 \`Command::new("pi")\` 只会补 \`.exe\`，所以替身必须编译成 pi.exe。
 * 它只做一件事：把 stdin/stdout 原样转给 fake-pi.mjs，并记下「应用确实拉起过 pi」。
 */
async function preparePiStandIn(root) {
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  const source = join(root, "pi-shim.rs");
  await writeFile(
    source,
    [
      "use std::io::Write;",
      "use std::process::{Command, Stdio};",
      "fn main() {",
      "    let args: Vec<String> = std::env::args().skip(1).collect();",
      "    let script = std::env::var(\"SOXU_FAKE_PI_SCRIPT\").expect(\"SOXU_FAKE_PI_SCRIPT\");",
      "    if let Ok(log) = std::env::var(\"SOXU_FAKE_PI_LOG\") {",
      "        if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(log) {",
      "            let _ = writeln!(file, \"spawn args={args:?}\");",
      "        }",
      "    }",
      "    // 第 4 个参数是 fake-pi 的命令日志：没有它就只能知道「拉起过 pi」，",
      "    // 不知道 prompt 有没有真的写进 stdin。",
      "    let log_arg = std::env::var(\"SOXU_FAKE_PI_LOG\").unwrap_or_default();",
      "    let mut child = Command::new(\"node\")",
      "        .arg(script).arg(\"ok\").arg(\"issue-145\").arg(&log_arg)",
      "        .stdin(Stdio::inherit()).stdout(Stdio::inherit()).stderr(Stdio::inherit())",
      "        .spawn().expect(\"node\");",
      "    std::process::exit(child.wait().ok().and_then(|s| s.code()).unwrap_or(1));",
      "}",
    ].join("\n") + "\n",
  );
  const compiled = spawnSync("rustc", ["-O", source, "-o", join(bin, "pi.exe")], {
    encoding: "utf8",
  });
  if (compiled.status !== 0) {
    throw new Error("编译 pi 替身失败：" + (compiled.stderr ?? ""));
  }

  /*
   * fake-pi.mjs 自带的 30 秒兜底会让进程在走查中途退出（走查需要人眼可见的截图节奏）。
   * 复制一份只改这个兜底值，其余行为与仓库夹具逐字节一致。
   */
  const original = await readFile(FAKE_PI, "utf8");
  const patched = original.replace("30_000", "600_000");
  if (patched === original) throw new Error("fake-pi.mjs 的兜底时长已经不是 30_000，需要同步脚本");
  const script = join(root, "fake-pi.mjs");
  await writeFile(script, patched);
  const log = join(root, "pi-spawn.log");
  return { bin, script, log };
}

/* ────────────────────────── 应用进程 ────────────────────────── */

async function launchApp({ bin, script, log }, label) {
  const env = {
    ...process.env,
    PATH: bin + ";" + (process.env.PATH ?? ""),
    SOXU_FAKE_PI_SCRIPT: script,
    SOXU_FAKE_PI_LOG: log,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=" + CDP_PORT,
  };
  const child = spawn(EXE, [], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: false });
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(chunk.toString()));
  const cdp = new Cdp("");
  const target = await waitFor(label + " · CDP 目标", async () => {
    const list = await fetch("http://127.0.0.1:" + CDP_PORT + "/json/list").then((res) => res.json());
    return list.find((item) => item.type === "page" && item.url.startsWith("http://localhost:" + VITE_PORT)) ?? null;
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
  await waitFor(label + " · 应用挂载", async () =>
    cdp.evaluate("Boolean(document.querySelector('.app-shell'))"),
  );
  await sleep(600);
  return { child, cdp, stderr };
}

/* ────────────────────────── 界面操作 ────────────────────────── */

/** 元素表达式：按 role + 可见文案找控件（设置页与命令面板都靠文案定位）。 */
const byRoleText = (role, text) =>
  "Array.from(document.querySelectorAll('[role=\"" + role + "\"]')).find((node) =>" +
  " node.textContent.replace(/\\s+/g, ' ').trim() === " + JSON.stringify(text) + ")";

/** 元素表达式：按选择器 + 可见文案找控件（按钮用）。 */
const byText = (selector, text) =>
  "Array.from(document.querySelectorAll(" + JSON.stringify(selector) + ")).find((node) =>" +
  " node.textContent.replace(/\\s+/g, ' ').trim() === " + JSON.stringify(text) + ")";

/** 元素表达式：系统页里标题为 rowText 的那一行。 */
const rowElement = (rowText) =>
  "Array.from(document.querySelectorAll('.row')).find((node) => {" +
  " const label = node.querySelector('.row-label');" +
  " return label && label.textContent.replace(/\\s+/g, ' ').trim() === " + JSON.stringify(rowText) + "; })";

/**
 * 派发一次**真实鼠标点击**（pressed + released），返回是否点到了元素。
 *
 * 不能用 element.click()：reka-ui 的 Tabs / Switch 在 pointerdown / mousedown 上激活，
 * 合成的 click 事件不会切换标签页——上一版就是在这里等「系统页」等到超时。
 * 这里走 CDP 的 Input.dispatchMouseEvent，与真人点击走同一条输入管线。
 */
async function mouseClick(cdp, elementExpression) {
  const point = await cdp.evaluate(
    "(() => { const element = " + elementExpression + "; if (!element) return null;" +
      " element.scrollIntoView({ block: 'center' });" +
      " const rect = element.getBoundingClientRect();" +
      " return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; })()",
  );
  if (!point) return false;
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: point.x,
    y: point.y,
    button: "none",
    buttons: 0,
  });
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
  return true;
}

/**
 * 记录页面收到的 Tauri 事件（诊断用）。
 *
 * 为什么这样写：`__TAURI_INTERNALS__.runCallback` 是 defineProperty 定义的只读属性，
 * 包不了；但同一个脚本把回调表 `callbacks`（一个 Map）挂了出来，替换表项即可。
 * 于是「完成通知没弹」能直接区分成「事件没到」还是「到了但被闸门拦下」。
 */
const installEventTap = (cdp) =>
  cdp.evaluate(`(function () {
    const internals = window.__TAURI_INTERNALS__;
    const callbacks = internals && internals.callbacks;
    if (!callbacks || typeof callbacks.forEach !== 'function') return 'missing';
    window.__soxuEvents = window.__soxuEvents || [];
    let wrapped = 0;
    callbacks.forEach((fn, id) => {
      if (typeof fn !== 'function' || fn.__soxuTapped) return;
      const tapped = function (data) {
        try {
          if (data && data.event) {
            const payload = data.payload || {};
            window.__soxuEvents.push({
              event: data.event,
              type: payload.type,
              generation: payload.generation,
              runtimeId: payload.runtimeId,
            });
          }
        } catch (error) {
          // 诊断失败不能影响被测代码。
        }
        return fn(data);
      };
      tapped.__soxuTapped = true;
      callbacks.set(id, tapped);
      wrapped += 1;
    });
    return 'wrapped:' + wrapped;
  })()`);

/**
 * 只截「开关本身」，返回文件、MD5 与截图时的 aria-checked。
 *
 * 为什么单独截：上一版两张托盘证据截图 MD5 完全相同，因为整页截图里看不出开关位置，
 * 读证据的人无法确认「tray-on 那张真的是开着」。裁到开关这一小块后，两张图的 MD5
 * 必须不同，且各自带着 aria-checked，截图本身就成了一条可核对的断言。
 */
async function captureSwitchCrop(cdp, rowText, name) {
  const rect = await cdp.evaluate(
    "(function () { const row = " + rowElement(rowText) + ";" +
      " const target = row && row.querySelector('[role=switch]');" +
      " if (!target) return null; target.scrollIntoView({ block: 'center' });" +
      " const r = target.getBoundingClientRect();" +
      " return { x: r.x, y: r.y, width: r.width, height: r.height," +
      " checked: target.getAttribute('aria-checked') }; })()",
  );
  if (!rect) return null;
  const shot = await cdp.send("Page.captureScreenshot", {
    format: "png",
    clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 },
  });
  const bytes = Buffer.from(shot.data, "base64");
  await writeFile(join(OUT_DIR, name), bytes);
  return {
    file: name,
    md5: createHash("md5").update(bytes).digest("hex"),
    checked: rect.checked,
  };
}

/** 读一行里开关的 aria-checked；没有这一行或没有开关时返回 null。 */
const readRowSwitch = (rowText) =>
  "(function () { const row = " + rowElement(rowText) + ";" +
  " const target = row && row.querySelector('[role=switch]');" +
  " return target ? target.getAttribute('aria-checked') : null; })()";

const openSettingsOnSystemTab = async (cdp) => {
  // Ctrl+, 是产品里的设置入口（与 macOS 通用约定一致），不是测试专用开关。
  // modifiers=2 是 CDP 的 Ctrl 位；少了它就是一个孤立的逗号键。
  await cdp.key(",", "Comma", 188, 2);
  await waitFor("设置弹窗", async () => cdp.evaluate("Boolean(document.querySelector('[role=dialog]'))"));
  const clicked = await mouseClick(cdp, byRoleText("tab", "系统"));
  if (!clicked) throw new Error("没找到「系统」标签页");
  // 等「系统页独有的行」出现，而不是等行数：外观页同样有 6 行，按行数等会提前通过。
  await waitFor("系统页", async () =>
    cdp.evaluate(
      "Array.from(document.querySelectorAll('.row-label')).some((node) =>" +
        " node.textContent.trim() === '任务完成通知')",
    ),
  );
};

/**
 * 关闭设置弹窗，返回实际用到的路径（"escape" | "close-button"）。
 *
 * Esc 是产品里真实的关闭路径（SettingsDialog 的 @keydown），但它对焦点敏感：
 * 走查上一轮就出现过「点过开关之后 Esc 30 秒关不掉」的偶发失败，把整条托盘证据链
 * 拖没了。这里给 Esc 两次机会，再退回标题栏的关闭按钮（同样是真实用户路径），
 * 并记录用了哪条——连续两条路径都失败就抛错，绝不让走查静默带过。
 */
const closeSettings = async (cdp) => {
  const dialogOpen = () =>
    cdp.evaluate("Boolean(document.querySelector('[role=dialog]'))");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await cdp.key("Escape", "Escape", 27);
    const closed = await waitFor("弹窗关闭（Esc）", async () => !(await dialogOpen()), {
      timeout: 2500,
    }).then(() => true, () => false);
    if (closed) return "escape";
  }
  const clicked = await mouseClick(cdp, "document.querySelector('.dialog-head .icon-button')");
  if (!clicked) throw new Error("设置弹窗既不能用 Esc 关闭，也找不到关闭按钮");
  await waitFor("弹窗关闭（关闭按钮）", async () => !(await dialogOpen()), { timeout: 5000 });
  return "close-button";
};

const readSystemStorage = (cdp) =>
  cdp.evaluate("window.localStorage.getItem('soxu.system')");

/**
 * 把走查改过的两个系统开关恢复成产品默认值（都是 true）。
 *
 * 直接写 localStorage 而不是点开关：托盘用例结束时窗口已经隐藏或进程已经退出，
 * 没有界面可点；而这两个字段只在挂载时读一次，进程随后就被回收，写存储即可。
 * 恢复成默认值而不是「进入时的值」，是为了让走查可重复——上一轮失败留下的
 * notifyOnComplete=false 会被下一轮当成初始值继续传递，机器就再也回不到干净状态。
 */
async function restoreSystemDefaults(cdp) {
  const raw = await readSystemStorage(cdp);
  let current = {};
  try {
    current = raw ? JSON.parse(raw) : {};
  } catch {
    current = {};
  }
  const restored = { ...current, minimizeToTray: true, notifyOnComplete: true };
  await cdp.evaluate(
    "window.localStorage.setItem('soxu.system', " + JSON.stringify(JSON.stringify(restored)) + ")",
  );
  // 写入后停一下再回读：localStorage 落在 WebView2 的 LevelDB 里，进程随后会被
  // 回收（tray-on 是隐藏窗口 + taskkill），留出落盘时间，回读结果一并进证据。
  await sleep(700);
  return { written: restored, readBack: await readSystemStorage(cdp) };
}

/** 把某个开关设成目标值：已经是目标值就不动，保证用例可重复执行。 */
async function setSystemSwitch(cdp, rowText, target) {
  const current = await cdp.evaluate(readRowSwitch(rowText));
  if (current === null) throw new Error("没找到开关所在的行：" + rowText);
  if (current === String(target)) return { changed: false, value: current };
  const clicked = await mouseClick(cdp, rowElement(rowText) + "?.querySelector('[role=switch]')");
  if (!clicked) throw new Error("点击开关失败：" + rowText);
  await waitFor("开关写入存储", async () => {
    const storage = await readSystemStorage(cdp);
    if (!storage) return false;
    const parsed = JSON.parse(storage);
    const key = rowText === "关闭时最小化到托盘" ? "minimizeToTray" : "notifyOnComplete";
    return parsed[key] === target;
  });
  return { changed: true, value: String(target) };
}

/* ────────────────────────── 用例 ────────────────────────── */

/** 用例 1：「关闭时最小化到托盘」= 开 → 点 × 后窗口隐藏、进程与 WebView2 仍在。 */
async function caseTrayOn(standIn, report) {
  const app = await launchApp(standIn, "tray-on");
  const pid = app.child.pid;
  try {
    await openSettingsOnSystemTab(app.cdp);
    const state = await setSystemSwitch(app.cdp, "关闭时最小化到托盘", true);
    report.trayOn.switch = state;
    // 截图取「系统页本身」而不是关掉弹窗后的工作台：上一版两张托盘截图 MD5 相同，
    // 就是因为拍的是同一片空界面，看的人无法判断当时开关到底是开还是关。
    report.trayOn.switchShot = await app.cdp.screenshot("desktop-tray-on-switch-on.png");
    report.trayOn.switchCrop = await captureSwitchCrop(
      app.cdp,
      "关闭时最小化到托盘",
      "desktop-tray-on-switch-crop.png",
    );
    report.trayOn.storageBefore = await readSystemStorage(app.cdp);
    report.trayOn.closePath = await closeSettings(app.cdp);
    // 偏好经 watch → invoke 异步推给 Rust，等它落地再点 ×，否则量的是旧值。
    await sleep(600);
    report.trayOn.consoleWarnings = app.cdp.errors.filter((line) => line.includes("[system]"));
    check(
      "「关闭时最小化到托盘」= 开：开关已开且偏好推送没有 [system] 失败诊断",
      state.value === "true" && report.trayOn.consoleWarnings.length === 0,
      { switch: state, warnings: report.trayOn.consoleWarnings },
    );

    report.trayOn.beforeClose = {
      process: processAlive(pid) ? "alive" : "gone",
      window: windowState(pid),
      tree: treeSummary(pid),
    };
    // WM_CLOSE 与真人点标题栏 × 走同一条路径（Tauri 收到的是 WindowEvent::CloseRequested）。
    report.trayOn.closeMainWindow = ps("(Get-Process -Id " + pid + ").CloseMainWindow()");
    await sleep(2500);
    report.trayOn.afterClose = {
      process: processAlive(pid) ? "alive" : "gone",
      window: windowState(pid),
      // 顶层窗口清单：主窗口应仍在但不可见；进程退出后整张表应为空。
      windows: windowList(pid),
      tree: treeSummary(pid),
    };
    // 仅供记录：WebView2 隐藏窗口后不一定改 document.visibilityState，
    // 因此这条只作参考，不进断言（断言只认窗口与进程这两个客观事实）。
    report.trayOn.visibilityState = await app.cdp.evaluate("document.visibilityState");
    // hide 失败只写 stderr（Rust 侧 eprintln），不看它就只能猜「窗口为什么还在」。
    report.trayOn.stderr = app.stderr.join("").trim();
    check(
      "「关闭时最小化到托盘」= 开：点 × 后进程仍在、主窗口存在但不可见",
      report.trayOn.afterClose.process === "alive" && report.trayOn.afterClose.window === "hidden",
      report.trayOn.afterClose,
    );
    check(
      "隐藏到托盘后 WebView2 子进程仍在（从托盘恢复时不会白屏）",
      report.trayOn.afterClose.tree.total > 0,
      { before: report.trayOn.beforeClose.tree, after: report.trayOn.afterClose.tree },
    );
  } finally {
    report.trayOn.restored = await restoreSystemDefaults(app.cdp).catch(() => null);
    app.cdp.close();
    killTree(pid);
    await sleep(800);
  }
}

/**
 * 进程已经退出时无法再用 CDP 写存储：重新拉起一次应用，把偏好写回默认值后**正常关闭**。
 *
 * 为什么不能直接 taskkill：localStorage 落在 WebView2 的 LevelDB 里，强杀可能丢掉
 * 最后一次写入，于是开发机（以及下一轮走查）就永久停在 minimizeToTray=false。
 * 这里写入后先回读确认，再走窗口 × 让进程自己退出，存储才会被干净落盘。
 */
async function restorePreferenceByRelaunch(standIn) {
  const app = await launchApp(standIn, "tray-off · 恢复偏好");
  try {
    const written = await restoreSystemDefaults(app.cdp);
    await sleep(800);
    const readBack = await readSystemStorage(app.cdp);
    ps("(Get-Process -Id " + app.child.pid + ").CloseMainWindow()");
    await waitFor("恢复实例退出", () => !processAlive(app.child.pid), { timeout: 10_000 }).catch(
      () => null,
    );
    return { ...written, readBack };
  } finally {
    app.cdp.close();
    killTree(app.child.pid);
    await sleep(600);
  }
}

/** 用例 2：「关闭时最小化到托盘」= 关 → 点 × 后进程退出（Issue #145 的核心验收点）。 */
async function caseTrayOff(standIn, report) {
  const app = await launchApp(standIn, "tray-off");
  const pid = app.child.pid;
  try {
    await openSettingsOnSystemTab(app.cdp);
    const state = await setSystemSwitch(app.cdp, "关闭时最小化到托盘", false);
    report.trayOff.switch = state;
    // 与用例 1 对应：这张截图里开关必须是关的，两张图才有对照价值。
    report.trayOff.switchShot = await app.cdp.screenshot("desktop-tray-off-switch-off.png");
    report.trayOff.switchCrop = await captureSwitchCrop(
      app.cdp,
      "关闭时最小化到托盘",
      "desktop-tray-off-switch-crop.png",
    );
    report.trayOff.storageBefore = await readSystemStorage(app.cdp);
    report.trayOff.closePath = await closeSettings(app.cdp);
    // 偏好是经 watch → invoke 异步推给 Rust 的：等它落地再点 ×，否则量的是旧值。
    await sleep(600);
    // 真实 IPC 成功与否只有控制台知道：invoke 失败会留一行 [system] 诊断。
    report.trayOff.consoleWarnings = app.cdp.errors.filter((line) => line.includes("[system]"));
    check(
      "关掉开关后前端把偏好推给 Rust（没有 [system] 同步失败诊断）",
      state.value === "false" && report.trayOff.consoleWarnings.length === 0,
      { switch: state, warnings: report.trayOff.consoleWarnings },
    );

    report.trayOff.beforeClose = {
      process: processAlive(pid) ? "alive" : "gone",
      window: windowState(pid),
      tree: treeSummary(pid),
    };
    report.trayOff.closeMainWindow = ps("(Get-Process -Id " + pid + ").CloseMainWindow()");
    const gone = await waitFor("进程退出", () => !processAlive(pid), { timeout: 15_000 }).then(
      () => true,
      () => false,
    );
    report.trayOff.afterClose = {
      process: gone ? "gone" : "alive",
      window: gone ? "missing" : windowState(pid),
      windows: gone ? [] : windowList(pid),
      tree: treeSummary(pid),
    };
    check(
      "「关闭时最小化到托盘」= 关：点 × 后 soxu-desktop.exe 退出（窗口随之消失）",
      gone && report.trayOff.afterClose.window === "missing",
      report.trayOff.afterClose,
    );
    check(
      "进程退出后没有残留子进程（整棵进程树一起结束）",
      gone && report.trayOff.afterClose.tree.total === 0,
      { before: report.trayOff.beforeClose.tree, after: report.trayOff.afterClose.tree },
    );
  } finally {
    report.trayOff.restored = await restorePreferenceByRelaunch(standIn).catch(() => null);
    app.cdp.close();
    killTree(pid);
    await sleep(800);
  }
}

/** 用例 3：完成通知开关真的管住 Toast；「打开数据目录」真的打开资源管理器。 */
async function caseNotifyAndDataDir(standIn, report) {
  const app = await launchApp(standIn, "notify");
  const pid = app.child.pid;
  try {
    // 会话：命令面板 → 「新建临时会话」（临时会话不写任何 JSONL，不碰用户数据）。
    await app.cdp.key("k", "KeyK", 75, 2);
    await waitFor("命令面板", async () =>
      app.cdp.evaluate("Boolean(document.querySelector('#soxu-command-palette-title'))"),
    );
    await app.cdp.type("临时");
    await sleep(400);
    const opened = await mouseClick(
      app.cdp,
      "Array.from(document.querySelectorAll('[role=option]')).find((node) =>" +
        " node.textContent.includes('新建临时会话'))",
    );
    report.notify.paletteCommand = opened ? "clicked" : "missing";
    if (!opened) throw new Error("命令面板里没有「新建临时会话」");
    // 会话打开时才注册运行时事件监听器，而且 listen 是异步注册：
    // 等它落地（一次 IPC 往返）之后再包回调表，否则包到的是空表。
    await sleep(1200);
    report.notify.eventTap = await installEventTap(app.cdp);

    /*
     * 补齐临时会话缺失的 retain_session_events（**既有行为，不属本任务范围**）。
     *
     * 后端只在 fanout 计数 > 0 时 emit（session_runtime.rs → EventFanout::wants）。
     * 持久化会话由 openSession 调 retainSession 挂上计数；临时会话在
     * sessionWorkspace.openSession 里提前 return，从没调过它，于是后端一条事件都不发。
     * 走查要验证的是「完成通知总闸」，必须先让真实事件链跑起来，所以在这里补一次
     * retain——它调的就是前端本来会调的那条命令，不改产品代码、不碰用户会话文件。
     * 该缺口已记入 evidence README 的「已知边界」。
     */
    const sessionId = await app.cdp.evaluate(
      "(document.body.textContent.match(/ses_tmp_[a-z0-9]+/) || [null])[0]",
    );
    if (!sessionId) throw new Error("界面里找不到临时会话 id");
    report.notify.sessionId = sessionId;
    report.notify.retained = await app.cdp.evaluate(
      "window.__TAURI_INTERNALS__.invoke('retain_session_events', { sessionId: " +
        JSON.stringify(sessionId) +
        " })",
    );
    await waitFor("会话输入框", async () =>
      app.cdp.evaluate("Boolean(document.querySelector('textarea'))"),
    );

    const sendPrompt = async (text) => {
      await app.cdp.evaluate("document.querySelector('textarea').focus()");
      await app.cdp.type(text);
      await app.cdp.key("Enter", "Enter", 13);
    };

    // 3a. 通知开：完成一轮后右下角出现 sessionCompleted Toast
    await openSettingsOnSystemTab(app.cdp);
    const enabled = await setSystemSwitch(app.cdp, "任务完成通知", true);
    report.notify.switchOn = enabled;
    await closeSettings(app.cdp);
    await sendPrompt("ping one");
    const toast = await waitFor(
      "完成 Toast",
      async () =>
        app.cdp.evaluate(
          "(function () { const node = document.querySelector('.toast[data-kind=\"sessionCompleted\"]');" +
            " return node ? { title: node.querySelector('.toast-title')?.textContent?.trim() ?? ''," +
            " body: node.querySelector('.toast-text')?.textContent?.trim() ?? '' } : null; })()",
        ),
      { timeout: 20_000 },
    ).catch(() => null);
    report.notify.toastOn = toast;
    report.notify.stderr = app.stderr.join("").trim();
    // 失败时最想知道的是「prompt 到底发出去了没有」：把输入框与状态行一起留证。
    report.notify.diagnostics = await app.cdp.evaluate(
      "(function () { const textarea = document.querySelector('textarea');" +
        " return { composerValue: textarea ? textarea.value : null," +
        " toasts: document.querySelectorAll('.toast').length," +
        " toastKinds: Array.from(document.querySelectorAll('.toast')).map((n) => n.dataset.kind)," +
        " messageCount: document.querySelectorAll('[data-message-role]').length," +
        " statusLine: (document.querySelector('[data-status]') || {}).textContent || null }; })()",
    );
    // 事件级开关（soxu.notifications）与总闸是两道独立的闸：Toast 没弹时先看它。
    report.notify.storage = await app.cdp.evaluate(
      "JSON.stringify(Object.fromEntries(Object.entries(window.localStorage)))",
    );
    report.notify.consoleIssues = app.cdp.errors.slice();
    report.notify.events = await app.cdp.evaluate(
      "(window.__soxuEvents || []).slice(-60)",
    );
    report.notify.shotToastOn = await app.cdp.screenshot("desktop-notify-on-toast.png");
    check("通知开：完成一轮后真的弹出 sessionCompleted Toast", Boolean(toast), {
      toast: report.notify.toastOn,
    });

    // 3b. 通知关：同样一轮不再弹 Toast（先把已有的关掉，避免误判旧 Toast）
    await app.cdp.evaluate(
      "Array.from(document.querySelectorAll('.toast-close')).forEach((node) => node.click())",
    );
    await openSettingsOnSystemTab(app.cdp);
    const disabled = await setSystemSwitch(app.cdp, "任务完成通知", false);
    report.notify.switchOff = disabled;
    await closeSettings(app.cdp);
    const before = await app.cdp.evaluate("document.querySelectorAll('.toast').length");
    await sendPrompt("ping two");
    await sleep(6000);
    const after = await app.cdp.evaluate(
      "(function () { return { toasts: document.querySelectorAll('.toast').length," +
        " completed: document.querySelectorAll('.toast[data-kind=\"sessionCompleted\"]').length }; })()",
    );
    report.notify.toastCountBeforeOff = before;
    report.notify.toastCountAfterOff = after;
    report.notify.shotToastOff = await app.cdp.screenshot("desktop-notify-off.png");
    check("通知关：同样的完成事件不再弹 Toast", after.toasts === 0 && before === 0, {
      before,
      after,
    });

    // 3c. 打开数据目录：真实命令 → 系统文件管理器
    await openSettingsOnSystemTab(app.cdp);
    const clicked = await mouseClick(app.cdp, byText("button.action", "打开数据目录"));
    report.dataDir.click = clicked ? "clicked" : "missing";
    if (!clicked) throw new Error("系统页没有「打开数据目录」按钮");
    await waitFor("按钮回显已打开", async () =>
      app.cdp.evaluate(
        "Array.from(document.querySelectorAll('button.action')).some((node) => node.textContent.trim() === '已打开')",
      ),
    ).catch(() => null);
    report.dataDir.buttonLabels = await app.cdp.evaluate(
      "Array.from(document.querySelectorAll('button.action')).map((node) => node.textContent.trim())",
    );
    await sleep(2500);
    report.dataDir.explorerUrls = ps(
      "(New-Object -ComObject Shell.Application).Windows() | ForEach-Object { $_.LocationURL }",
    )
      .split(/\r?\n/)
      .filter(Boolean);
    report.dataDir.shot = await app.cdp.screenshot("desktop-open-data-directory.png");
    const expected = report.dataDir.explorerUrls.some((url) =>
      /dev\.soxu\.desktop/i.test(url),
    );
    check("「打开数据目录」打开了应用数据目录（资源管理器窗口）", expected, {
      urls: report.dataDir.explorerUrls,
      labels: report.dataDir.buttonLabels,
    });

  } finally {
    report.notify.restored = await restoreSystemDefaults(app.cdp).catch(() => null);
    app.cdp.close();
    killTree(pid);
    await sleep(800);
  }
}

/* ────────────────────────── 主流程 ────────────────────────── */

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const root = mkdtempSync(join(tmpdir(), "soxu-145-desktop-"));
  const standIn = await preparePiStandIn(root);
  const report = {
    generatedAt: new Date().toISOString(),
    environment: {
      exe: EXE,
      vitePort: VITE_PORT,
      cdpPort: CDP_PORT,
      viewport: VIEWPORT,
      platform: process.platform,
      node: process.version,
    },
    trayOn: {},
    trayOff: {},
    notify: {},
    dataDir: {},
    checks: [],
  };

  const vite = spawn(
    process.platform === "win32" ? "pnpm.cmd" : "pnpm",
    ["exec", "vite", "--port", String(VITE_PORT), "--strictPort", "--host", "127.0.0.1"],
    { cwd: APP_ROOT, shell: process.platform === "win32", stdio: "ignore" },
  );

  try {
    await waitFor("Vite 开发服务器", async () => {
      const response = await fetch("http://127.0.0.1:" + VITE_PORT + "/", { method: "HEAD" });
      return response.ok;
    });

    // SOXU_HARNESS_ONLY=tray-on,tray-off,notify 便于单条排查；默认三条全跑。
    const only = (process.env.SOXU_HARNESS_ONLY ?? "tray-on,tray-off,notify")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    if (only.includes("tray-on")) await caseTrayOn(standIn, report);
    if (only.includes("tray-off")) await caseTrayOff(standIn, report);
    if (only.includes("notify")) await caseNotifyAndDataDir(standIn, report);

    // 跨用例断言：两张托盘证据图必须是「同一块屏幕、不同的开关状态」。
    const onCrop = report.trayOn.switchCrop;
    const offCrop = report.trayOff.switchCrop;
    if (onCrop && offCrop) {
      check(
        "两张托盘证据截图的开关区域确实不同（截图反映开关状态，不是同一张图）",
        onCrop.md5 !== offCrop.md5 && onCrop.checked === "true" && offCrop.checked === "false",
        { on: onCrop, off: offCrop },
      );
    }

    report.piSpawns = await readFile(standIn.log, "utf8").catch(() => "");
    report.checks = checks;
    await writeFile(join(OUT_DIR, "desktop-metrics.json"), JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify({ checks, trayOn: report.trayOn, trayOff: report.trayOff, notify: report.notify, dataDir: report.dataDir }, null, 2));
    if (checks.some((entry) => !entry.ok)) {
      console.error("断言未通过：" + JSON.stringify(checks.filter((entry) => !entry.ok)));
      process.exitCode = 1;
    }
  } finally {
    killTree(vite.pid);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
