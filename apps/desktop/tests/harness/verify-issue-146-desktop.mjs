/**
 * Issue #146（TASK-036）的 Windows 实机走查：真实 Tauri 窗口 + 真实 Rust 后端 + **真实 pi**。
 *
 * 为什么不用替身：本次复审的阻塞点正是「桌面端没有实机证据」。所以这里启动的是构建产物
 * \`soxu-desktop.exe\`，Pi 也是 PATH 上真实的 \`pi\`（不是 fixtures 里的假进程），
 * 走的是「点菜单 → invoke → Rust 驱动 → Pi stdin → Pi 队列 → Pi 会话文件」整条链路。
 * 投递是否真的发生，由 **Pi 自己写的会话 JSONL** 判定，而不是由 SOXU 的界面自称。
 *
 * 隔离措施（都不改动产品代码）：
 * - \`PI_CODING_AGENT_SESSION_DIR\` 指向临时目录（Pi 文档里的官方环境变量），
 *   因此真实 Pi 的会话文件不会落到开发者的 ~/.pi/agent/sessions；
 * - 项目根是一个临时空目录；\`catalog.json\` 与 \`retry/\` 在跑完后原样恢复，
 *   开发者的项目列表不会被这次走查污染；
 * - 启动前若已有 soxu-desktop.exe 在跑就直接退出（WebView2 用户数据目录会互相打架）。
 *
 * 用法（仓库根目录）：
 *   cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml
 *   node apps/desktop/tests/harness/verify-issue-146-desktop.mjs
 *
 * 需要：Vite 端口 1420 可用（脚本自己拉起并回收）、WebView2、PATH 上的 \`pi\`、
 * 已登录的模型配置（会真实调用模型：4 个长任务 + 1 条排队消息）。
 * 结果写入 docs/development/evidence/issue-146-send-modes/desktop-*.{json,png}。
 *
 * 环境变量：
 *   SOXU_HARNESS_PORT       Vite 端口，默认 1420
 *   SOXU_DESKTOP_CDP_PORT   CDP 端口，默认 9452
 *   SOXU_HARNESS_ONLY      只跑指定用例（逗号分隔：followup,steer,parallel,stop,default）
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(HERE, "../..");
const REPO_ROOT = resolve(APP_ROOT, "../..");
const OUT_DIR = join(REPO_ROOT, "docs", "development", "evidence", "issue-146-send-modes");
const EXE = join(REPO_ROOT, "target", "debug", "soxu-desktop.exe");
const APP_DATA = process.env.APPDATA ? join(process.env.APPDATA, "dev.soxu.desktop") : null;

/** 本次走查使用的 pi 可执行入口（见 ensurePiExe）；null 表示直接用 PATH 上的 pi.exe。 */
let piShim = null;

const VITE_PORT = Number(process.env.SOXU_HARNESS_PORT ?? 1420);
const CDP_PORT = Number(process.env.SOXU_DESKTOP_CDP_PORT ?? 9452);
const VIEWPORT = { width: 1280, height: 820 };

/**
 * 长任务：给「忙碌时投递」留出真实窗口，同时保证它在可接受时间内自己结束。
 *
 * 为什么要求「不要使用任何工具」：走查量的是投递语义，不是工具调用；
 * 让 Pi 只输出数字，长任务的时长就只跟模型速度有关。
 */
const longTask = (count) => "请从 1 数到 " + count + "，每行一个数字，不要使用任何工具，不要省略。";

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

async function waitFor(label, probe, { timeout = 30_000, interval = 200 } = {}) {
  const started = Date.now();
  let last = null;
  for (;;) {
    try {
      const value = await probe();
      if (value) return value;
      last = null;
    } catch (error) {
      last = error;
    }
    if (Date.now() - started > timeout) {
      throw new Error("等待超时：" + label + (last ? "（最后一次错误：" + last.message + "）" : ""));
    }
    await sleep(interval);
  }
}

/* ────────────────────────── 真实 pi 的启动方式 ────────────────────────── */

/**
 * 通过 cmd.exe 问一次 pi 版本（本机 pi 是 .cmd 包装，Node/Rust 的 CreateProcess
 * 只会给未带扩展名的程序补 .exe，直接 spawn("pi") 会 ENOENT）。
 */
function piVersionViaShell() {
  const result = spawnSync("cmd.exe", ["/d", "/s", "/c", "pi --version"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) return null;
  return (result.stdout ?? "").trim().split(/\r?\n/)[0] || null;
}

/**
 * 最小转发 shim：真正的 pi.exe。
 *
 * SOXU 走 `Command::new("pi")`（crates/agent-runtime/src/config.rs 的 PiProgram::pi_rpc），
 * Windows 的 CreateProcess 不会解析 .cmd/.ps1 包装，所以本机（托管安装只有 pi.cmd）
 * 上应用起 Pi 会直接失败——这一点本身就是需要记录的平台风险。
 * 走查因此用 rustc（已批准工具链）在**临时目录**编译一个转发 shim，
 * 把 argv 原样交给 node + pi-launcher.js；不改产品代码，也不写仓库目录。
 */
const PI_SHIM_SOURCE = [
  "use std::os::windows::process::CommandExt;",
  "use std::process::Command;",
  "",
  "fn main() {",
  '    let launcher = std::env::var("PI_SHIM_LAUNCHER").expect("PI_SHIM_LAUNCHER");',
  '    let mut command = Command::new("node");',
  "    command.arg(launcher);",
  "    command.args(std::env::args().skip(1));",
  "    // 不额外弹控制台窗口：stdin/stdout 继续是父进程给的管道，RPC 分帧不受影响。",
  "    command.creation_flags(0x0800_0000);",
  '    let status = command.status().expect("spawn node pi launcher");',
  "    std::process::exit(status.code().unwrap_or(1));",
  "}",
  "",
].join("\n");

/** 定位仓库里装 pi 的托管 launcher：优先 where pi.cmd，其次 where pi。 */
function locatePiLauncher() {
  for (const name of ["pi.cmd", "pi"]) {
    const found = spawnSync("where.exe", [name], { encoding: "utf8", windowsHide: true });
    if (found.status !== 0) continue;
    for (const line of (found.stdout ?? "").split(/\r?\n/)) {
      const text = line.trim();
      if (!text) continue;
      const launcher = join(dirname(text), "pi-launcher.js");
      try {
        if (statSync(launcher).isFile()) return { launcher, wrapper: text };
      } catch {
        // 没有 launcher.js 就继续找：可能这台的 pi 是真的可执行文件。
      }
    }
  }
  return null;
}

/**
 * 给 app 准备一个能真正启动的 pi.exe。
 *
 * 返回 { path, dir, version, kind }；path 为 null 表示 PATH 上已有真的 pi.exe。
 */
function ensurePiExe(root) {
  const direct = spawnSync("pi.exe", ["--version"], { encoding: "utf8", windowsHide: true });
  if (direct.status === 0) {
    return {
      path: null,
      dir: null,
      version: (direct.stdout ?? "").trim().split(/\r?\n/)[0] || null,
      kind: "pi.exe on PATH",
    };
  }
  const located = locatePiLauncher();
  if (!located) {
    throw new Error("PATH 上找不到 pi.exe，也找不到 pi.cmd/pi-launcher.js：无法启动真实 Pi");
  }
  const source = join(root, "pi-shim.rs");
  const dir = join(root, "pi-bin");
  const exe = join(dir, "pi.exe");
  mkdirSync(dir, { recursive: true });
  writeFileSync(source, PI_SHIM_SOURCE, "utf8");
  const build = spawnSync("rustc", [source, "-O", "-o", exe], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, PI_SHIM_LAUNCHER: located.launcher },
  });
  if (build.status !== 0) {
    throw new Error("rustc 编译 pi 转发 shim 失败：" + (build.stderr ?? "").slice(0, 400));
  }
  const check = spawnSync(exe, ["--version"], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, PI_SHIM_LAUNCHER: located.launcher },
  });
  if (check.status !== 0) {
    throw new Error("pi 转发 shim 无法运行：" + (check.stderr ?? "").slice(0, 400));
  }
  return {
    path: exe,
    dir,
    version: (check.stdout ?? "").trim().split(/\r?\n/)[0] || null,
    kind: "rustc 转发 shim（本机只有 pi.cmd 包装）",
    launcher: located.launcher,
  };
}

function ps(command) {
  const result = spawnSync("powershell", ["-NoProfile", "-Command", command], {
    encoding: "utf8",
    windowsHide: true,
  });
  return (result.stdout ?? "").trim();
}

const processAlive = (pid) =>
  ps("if (Get-Process -Id " + pid + " -ErrorAction SilentlyContinue) { 'alive' } else { 'gone' }") ===
  "alive";

function killTree(pid) {
  if (!pid) return;
  spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
}

/**
 * 回收本次走查拉起的 Pi 进程。
 *
 * 走查里 Pi 是 `pi.exe` shim（临时目录里的唯一路径），所以按可执行文件路径匹配是精确的：
 * 只杀本次沙箱里的进程，绝不碰开发者自己的 Pi。应用退出路径若因为 shim 多一层
 * 而漏掉孙进程，这里就是兜底清理（也顺带断言「零残留」）。
 */
function reapPiProcesses() {
  if (!piShim?.path) return { found: 0, killed: 0 };
  const filter = "Name='pi.exe'";
  const list = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      "$ErrorActionPreference='SilentlyContinue'; Get-CimInstance Win32_Process -Filter \"" +
        filter +
        "\" | Where-Object { $_.ExecutablePath -like '*" +
        piShim.dir.replace(/\\/g, "\\\\") +
        "*' } | ForEach-Object { $_.ProcessId }",
    ],
    { encoding: "utf8", windowsHide: true },
  );
  const pids = (list.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const pid of pids) killTree(Number(pid));
  return { found: pids.length, killed: pids.length };
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
    await sleep(180);
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

/* ────────────────────────── Pi 会话文件（判据来源） ────────────────────────── */

async function listJsonl(root) {
  const found = [];
  const walk = async (dir) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith(".jsonl")) found.push(path);
    }
  };
  await walk(root);
  return found.sort();
}

function messageText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

/**
 * 一个会话文件的摘要：用户/助手消息按出现顺序排列。
 *
 * 只保留 role 与正文前 120 字符——证据里不需要整段模型输出，
 * 但「标记在第几轮之后出现」必须能从下标算出来。
 */
async function digestSessionFile(path) {
  const text = await readFile(path, "utf8");
  const messages = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.type !== "message") continue;
    const role = record.message?.role;
    if (role !== "user" && role !== "assistant") continue;
    messages.push({ role, text: messageText(record.message).slice(0, 120) });
  }
  return { file: path, messages };
}

async function sessionDigests(root) {
  const files = await listJsonl(root);
  const digests = [];
  for (const file of files) digests.push(await digestSessionFile(file));
  return digests;
}

/** 某个标记作为**用户消息**出现在哪些文件里、在第几条消息。 */
function findMark(digests, mark) {
  const hits = [];
  for (const digest of digests) {
    const index = digest.messages.findIndex(
      (message) => message.role === "user" && message.text.includes(mark),
    );
    if (index >= 0) hits.push({ file: digest.file, index, digest });
  }
  return hits;
}

/** 标记之前是否已经完成过一轮助手回复（followUp 的语义就是「下一轮」）。 */
function assistantTurnBefore(digest, index) {
  return digest.messages.slice(0, index).some((message) => message.role === "assistant");
}

/* ────────────────────────── 应用进程与界面操作 ────────────────────────── */

function appEnv(root) {
  const env = { ...process.env };
  // 不继承当前 Agent 会话的身份与模型覆盖：走查要的是「用户正常启动应用」的行为。
  for (const key of [
    "PI_SESSION_FILE",
    "PI_SESSION_ID",
    "PI_MODEL",
    "PI_PROVIDER",
    "PI_REASONING_LEVEL",
  ]) {
    delete env[key];
  }
  env.PI_CODING_AGENT_SESSION_DIR = join(root, "pi-sessions");
  env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=" + CDP_PORT;
  // app 里 PiProgram::pi_rpc() 起的 "pi" 必须是真正的可执行文件（见 ensurePiExe）。
  if (piShim?.dir) {
    env.PATH = piShim.dir + ";" + (env.PATH ?? "");
    env.PI_SHIM_LAUNCHER = piShim.launcher;
  }
  return env;
}

async function launchApp(root, label) {
  // cwd 指向临时沙箱：SOXU 拉起的 Pi 继承它作为会话 cwd，
  // 这样 Pi 不会读到本仓库的 AGENTS.md / .pi 资源（走查只测投递语义）。
  const child = spawn(EXE, [], {
    cwd: root,
    env: appEnv(root),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: false,
  });
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(chunk.toString()));
  const cdp = new Cdp("");
  const target = await waitFor(label + " · CDP 目标", async () => {
    const list = await fetch("http://127.0.0.1:" + CDP_PORT + "/json/list").then((res) => res.json());
    return (
      list.find(
        (item) => item.type === "page" && item.url.startsWith("http://localhost:" + VITE_PORT),
      ) ?? null
    );
  }, { timeout: 60_000 });
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

/** 派发一次真实鼠标点击（pressed + released）：reka 的菜单项在 pointer 事件上激活。 */
async function mouseClick(cdp, elementExpression) {
  const point = await cdp.evaluate(
    "(() => { const element = " + elementExpression + "; if (!element) return null;" +
      " element.scrollIntoView({ block: 'center' });" +
      " const rect = element.getBoundingClientRect();" +
      " if (rect.width === 0 || rect.height === 0) return null;" +
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
  await sleep(240);
  return true;
}

const isRunning = (cdp) =>
  cdp.evaluate("Boolean(document.querySelector('.composer[data-running=\"true\"]'))");

const queuedNote = (cdp) =>
  cdp.evaluate(
    "(function () { const node = document.querySelector('.queued-note');" +
      " return node ? node.textContent.replace(/\\s+/g, ' ').trim() : null; })()",
  );

const composerDraft = (cdp) =>
  cdp.evaluate("(document.querySelector('#soxu-composer') || {}).value ?? null");

/** 发送方式菜单是否还开着（portal 渲染，单独判断比读 DOM 层级稳）。 */
const sendMenuOpen = (cdp) => cdp.evaluate("Boolean(document.querySelector('.send-menu'))");

const composerHint = (cdp) =>
  cdp.evaluate(
    "(function () { const node = document.querySelector('#soxu-composer-hint');" +
      " return node ? node.textContent.replace(/\\s+/g, ' ').trim() : null; })()",
  );

async function sendText(cdp, text) {
  await cdp.evaluate("document.querySelector('#soxu-composer').focus()");
  await cdp.type(text);
  await cdp.key("Enter", "Enter", 13);
}

/** 点开 caret → 选中某个投递方式；返回是否点到了菜单项。 */
async function chooseSendMode(cdp, mode) {
  const opened = await mouseClick(cdp, "document.querySelector('.send-mode-trigger')");
  if (!opened) return false;
  const clicked = await waitFor(
    "发送方式菜单 · " + mode,
    async () => {
      const found = await cdp.evaluate(
        "(() => { const node = document.querySelector('.send-menu-item[data-mode=\"" + mode + "\"]');" +
          " return node ? { disabled: node.hasAttribute('data-disabled') } : null; })()",
      );
      if (!found) return null;
      if (found.disabled) return { disabled: true };
      const ok = await mouseClick(cdp, "document.querySelector('.send-menu-item[data-mode=\"" + mode + "\"]')");
      return ok ? { disabled: false } : null;
    },
    { timeout: 8_000 },
  ).catch(() => null);
  if (!clicked) return false;
  // 选中后 composer 会显示「下一条消息将 …」横条：这是「选择真的进了状态」的界面证据。
  await waitFor("发送方式横条", async () =>
    cdp.evaluate("Boolean(document.querySelector('.send-mode-bar'))"),
  ).catch(() => null);
  return !clicked.disabled;
}

/**
 * 起一轮长任务并确认它真的在跑。
 *
 * 模型太快时（长任务在我们发送排队消息之前就结束了）返回 false，由调用方决定是否重试——
 * 绝不无限重试：每多一次都是真实的模型调用。
 */
async function startBusyRun(cdp, count) {
  await sendText(cdp, longTask(count));
  const busy = await waitFor("长任务进入 running", () => isRunning(cdp), { timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
  return busy;
}

/** 停止当前轮次并等界面回到空闲（下一次用例要干净的起点）。 */
async function settleOrStop(cdp, label) {
  if (await isRunning(cdp)) {
    await mouseClick(cdp, "document.querySelector('.stop-button')");
  }
  await waitFor(label + " · 回到空闲", async () => !(await isRunning(cdp)), { timeout: 30_000 }).catch(
    () => null,
  );
  // 队列里可能还有残留：再点一次停止（幂等）并等界面稳定。
  await sleep(400);
}

/* ────────────────────────── 应用数据备份 / 恢复 ────────────────────────── */

async function snapshotAppData() {
  if (!APP_DATA) return null;
  const catalog = await readFile(join(APP_DATA, "catalog.json")).catch(() => null);
  const retry = await readdir(join(APP_DATA, "retry")).catch(() => []);
  return { catalog, retry };
}

/**
 * 恢复开发者自己的应用数据：走查会登记一个临时项目、并为临时会话写重试预算。
 * catalog.json 原样写回；新增的 retry 条目删掉（它们指向已经消失的临时会话）。
 */
async function restoreAppData(snapshot) {
  if (!APP_DATA || !snapshot) return null;
  if (snapshot.catalog === null) {
    await rm(join(APP_DATA, "catalog.json"), { force: true });
  } else {
    await writeFile(join(APP_DATA, "catalog.json"), snapshot.catalog);
  }
  const now = await readdir(join(APP_DATA, "retry")).catch(() => []);
  const added = now.filter((name) => !snapshot.retry.includes(name));
  for (const name of added) await rm(join(APP_DATA, "retry", name), { force: true });
  return { catalogRestored: true, retryRemoved: added.length };
}

/* ────────────────────────── 用例 ────────────────────────── */

/**
 * 当前所有 Tab 的 sessionId。
 *
 * Tab 元素带 `id="soxu-tab-<sessionId>"`（SessionTabs.vue），这是界面上
 * 唯一能稳定读到真实 sessionId 的地方——标题是「临时会话」，不含身份。
 */
const tabIds = (cdp) =>
  cdp.evaluate(
    "Array.from(document.querySelectorAll('[role=tab]'))" +
      ".map((node) => (node.id || '').replace(/^soxu-tab-/, ''))" +
      ".filter(Boolean)",
  );

/**
 * 打开一个临时会话（真实 open_temporary_session），返回 sessionId。
 *
 * 走侧栏的「新建会话」按钮，而不是直接 invoke：这样连「按钮 → store → IPC」也一起验了。
 */
async function openTemporarySession(cdp) {
  const before = await tabIds(cdp);
  const clicked = await mouseClick(cdp, "document.querySelector('.new-session')");
  if (!clicked) throw new Error("侧栏没有「新建会话」按钮");
  const sessionId = await waitFor(
    "新建的会话 Tab",
    async () => {
      const fresh = (await tabIds(cdp)).filter((id) => !before.includes(id));
      return fresh.length === 1 ? fresh[0] : null;
    },
    { timeout: 20_000 },
  );
  await waitFor("会话输入框", async () =>
    cdp.evaluate("Boolean(document.querySelector('#soxu-composer'))"),
  );
  await sleep(600);
  return sessionId;
}

/**
 * 用例 1：忙碌时选「排到下轮」→ 消息进 Pi 队列，本轮结束后**由 Pi 自己**投递。
 *
 * 判据不看界面自称：Pi 的会话 JSONL 里必须出现这条用户消息，而且它出现在
 * 至少一轮助手回复之后（followUp 的定义就是「下一轮」，不是插进当前回合）。
 */
async function caseFollowUp(app, state) {
  const mark = "SOXU-FOLLOWUP-" + Date.now().toString(36);
  let attempt = 0;
  let queued = null;
  while (attempt < 2 && !queued) {
    attempt += 1;
    const busy = await startBusyRun(app.cdp, attempt === 1 ? 120 : 400);
    state.followUp.attempts = attempt;
    if (!busy) continue;
    const chosen = await chooseSendMode(app.cdp, "followUp");
    if (!chosen) throw new Error("「排到下轮」在忙碌时不可点");
    await sendText(app.cdp, mark);
    queued = await waitFor("排队回执", () => queuedNote(app.cdp), { timeout: 8_000 }).catch(() => null);
    if (!queued) {
      // 长任务在排队之前就结束了：这一轮没观测到排队窗口，停止并重试一次。
      await settleOrStop(app.cdp, "followUp · 重试前");
    }
  }
  state.followUp.mark = mark;
  state.followUp.queuedNote = queued;
  check(
    "排到下轮：忙碌时发送后输入区显示「已排队 1 条」",
    Boolean(queued && /1/.test(queued)),
    { queuedNote: queued },
  );
  state.followUp.shot = await app.cdp.screenshot("desktop-followup-queued.png");

  // 等 Pi 真的把这条消息作为用户消息写进会话文件。
  const delivered = await waitFor(
    "Pi 会话文件出现排队的用户消息",
    async () => {
      const digests = await sessionDigests(join(state.root, "pi-sessions"));
      return findMark(digests, mark)[0] ?? null;
    },
    { timeout: 300_000, interval: 1000 },
  ).catch(() => null);
  state.followUp.delivered = delivered
    ? {
        file: relative(state.root, delivered.file),
        index: delivered.index,
        assistantTurnBefore: assistantTurnBefore(delivered.digest, delivered.index),
        messagesBefore: delivered.digest.messages.slice(0, delivered.index).map((m) => m.role),
      }
    : null;
  check(
    "排到下轮：本轮结束后这条消息由 Pi 真的投递（会话 JSONL 里是用户消息）",
    Boolean(delivered),
    { delivered: state.followUp.delivered },
  );
  check(
    "排到下轮：投递发生在至少一轮助手回复之后（是下一轮，不是插进当前回合）",
    Boolean(delivered && assistantTurnBefore(delivered.digest, delivered.index)),
    { delivered: state.followUp.delivered },
  );

  // 排队回执必须在 Pi 消费队列后消失，否则用户会以为消息还挂在队列里。
  const noteGone = await waitFor("排队回执消失", async () => (await queuedNote(app.cdp)) === null, {
    timeout: 120_000,
  })
    .then(() => true)
    .catch(() => false);
  check("排到下轮：Pi 消费队列后「已排队」回执消失", noteGone);
  state.followUp.noteGone = noteGone;
  state.followUp.shotDelivered = await app.cdp.screenshot("desktop-followup-delivered.png");
  await settleOrStop(app.cdp, "followUp");
}

/** 用例 2：忙碌时选「加入当前」→ 消息被 Pi 投递进当前会话。 */
async function caseSteer(app, state) {
  const mark = "SOXU-STEER-" + Date.now().toString(36);
  const busy = await startBusyRun(app.cdp, 800);
  state.steer.busy = busy;
  if (!busy) throw new Error("长任务没有进入 running，无法测忙碌投递");
  const chosen = await chooseSendMode(app.cdp, "steer");
  check("加入当前：忙碌时可点（菜单项未置灰）", chosen);
  state.steer.chosen = chosen;
  await sendText(app.cdp, mark);
  const note = await waitFor("排队回执", () => queuedNote(app.cdp), { timeout: 8_000 }).catch(
    () => null,
  );
  state.steer.queuedNote = note;
  check("加入当前：发送后同样显示排队回执", Boolean(note), { queuedNote: note });
  state.steer.shot = await app.cdp.screenshot("desktop-steer-queued.png");

  const delivered = await waitFor(
    "Pi 会话文件出现 steer 的用户消息",
    async () => {
      const digests = await sessionDigests(join(state.root, "pi-sessions"));
      return findMark(digests, mark)[0] ?? null;
    },
    { timeout: 300_000, interval: 1000 },
  ).catch(() => null);
  state.steer.delivered = delivered
    ? { file: relative(state.root, delivered.file), index: delivered.index }
    : null;
  check("加入当前：这条消息真的被 Pi 投递（会话 JSONL 里是用户消息）", Boolean(delivered), {
    delivered: state.steer.delivered,
  });
  await settleOrStop(app.cdp, "steer");
}

/**
 * 用例 3：忙碌时选「并行发送」→ 新建临时会话并发出，当前会话不被打断。
 *
 * 判据：出现第二个 Tab（临时会话）、Pi 侧出现**另一个**会话文件，
 * 且并行消息只出现在新文件里，原会话仍在 running。
 */
async function caseParallel(app, state) {
  const mark = "SOXU-PARALLEL-" + Date.now().toString(36);
  const originalId = await app.cdp.evaluate(
    "(function () { const tab = document.querySelector('[role=tab][aria-selected=\"true\"]');" +
      " return tab ? (tab.id || '').replace(/^soxu-tab-/, '') : null; })()",
  );
  const tabsBefore = await tabIds(app.cdp);
  state.parallel.originalSessionId = originalId;
  // 2000 个数字给菜单交互留出真实窗口：模型很快（本机实测数百 tok/s），
  // 1200 的窗口会在点菜单时就结束，用例会退化成「空闲投递」。
  const busy = await startBusyRun(app.cdp, 2000);
  state.parallel.busy = busy;
  // 基线必须是「原会话已经开跑之后」的文件集合：早于它取基线，会把原会话自己
  // 的 JSONL 也当成新文件，从而漏掉「并行消息其实被塞进同一个会话」这种错误。
  await sleep(900);
  const filesBefore = (await listJsonl(join(state.root, "pi-sessions"))).map((file) =>
    resolve(file),
  );
  state.parallel.filesBefore = filesBefore.length;
  if (!busy) throw new Error("长任务没有进入 running，无法测并行发送");
  // 并行发送的可用条件要求草稿非空：必须先输入，再打开菜单（否则菜单项是置灰的）。
  await app.cdp.evaluate("document.querySelector('#soxu-composer').focus()");
  await app.cdp.type(mark);
  const chosen = await chooseSendMode(app.cdp, "parallel");
  check("并行发送：忙碌时可点（草稿非空 + 纯文本 + 有项目）", chosen);
  state.parallel.chosen = chosen;
  // 菜单是 portal 且默认 open：先点输入框把焦点还给文本框（并让菜单关掉），
  // 再按 Enter。直接按 Enter 时按键会被菜单吞掉——上一版就是这样「看起来点了、
  // 其实没发」，截图里菜单还开着、草稿还在。
  await mouseClick(app.cdp, "document.querySelector('#soxu-composer')");
  await app.cdp.evaluate("document.querySelector('#soxu-composer').focus()");
  state.parallel.menuClosed = await waitFor(
    "发送方式菜单关闭",
    async () => ((await sendMenuOpen(app.cdp)) ? null : true),
    { timeout: 5_000 },
  ).catch(() => false);
  await app.cdp.key("Enter", "Enter", 13);

  // 新 Tab 的身份必须是一个**新的** sessionId，而不是原会话换了标题。
  const createdId = await waitFor(
    "并行发送新建了 Tab",
    async () => {
      const fresh = (await tabIds(app.cdp)).filter((id) => !tabsBefore.includes(id));
      return fresh.length === 1 ? fresh[0] : null;
    },
    { timeout: 20_000 },
  ).catch(() => null);
  const tabsAfter = await tabIds(app.cdp);
  state.parallel.tabsBefore = tabsBefore;
  state.parallel.tabsAfter = tabsAfter;
  state.parallel.createdSessionId = createdId;
  check("并行发送：同一窗口里新建了一个会话 Tab", Boolean(createdId), {
    before: tabsBefore,
    after: tabsAfter,
    created: createdId,
  });

  const activeId = await app.cdp.evaluate(
    "(function () { const tab = document.querySelector('[role=tab][aria-selected=\"true\"]');" +
      " return tab ? (tab.id || '').replace(/^soxu-tab-/, '') : null; })()",
  );
  const activeTitle = await app.cdp.evaluate(
    "(function () { const tab = document.querySelector('[role=tab][aria-selected=\"true\"]');" +
      " return tab ? tab.textContent.replace(/\\s+/g, ' ').trim() : null; })()",
  );
  state.parallel.activeTab = activeTitle;
  state.parallel.activeSessionId = activeId;
  check(
    "并行发送：active 切到新建的临时会话（不是原会话改名）",
    Boolean(createdId && activeId === createdId && activeId !== originalId),
    { activeSessionId: activeId, created: createdId, original: originalId, activeTab: activeTitle },
  );
  check("并行发送：新会话标签标明是临时会话", /临时/.test(activeTitle ?? ""), { activeTab: activeTitle });
  state.parallel.shot = await app.cdp.screenshot("desktop-parallel-new-session.png");

  // 立刻回到原会话确认它还在跑：并行发送不能打断当前轮次。
  // （先查这一条，再等新会话的投递——等投递期间原轮次可能自己跑完，那会变成假阴性。）
  const backToOriginal = originalId
    ? await mouseClick(app.cdp, "document.getElementById('soxu-tab-" + originalId + "')")
    : false;
  const stillRunning = backToOriginal
    ? await waitFor("原会话仍在 running", () => isRunning(app.cdp), { timeout: 15_000 })
        .then(() => true)
        .catch(() => false)
    : false;
  state.parallel.stillRunning = stillRunning;
  check("并行发送：原会话仍在 running（当前输出不被打断）", stillRunning);
  state.parallel.shotOriginal = await app.cdp.screenshot("desktop-parallel-original-running.png");

  const delivered = await waitFor(
    "Pi 侧出现并行会话的用户消息",
    async () => {
      const digests = await sessionDigests(join(state.root, "pi-sessions"));
      return findMark(digests, mark)[0] ?? null;
    },
    { timeout: 180_000, interval: 1000 },
  ).catch(() => null);
  state.parallel.delivered = delivered
    ? { file: relative(state.root, delivered.file), index: delivered.index }
    : null;
  check("并行发送：消息在新的 Pi 会话里真的发出（另一个会话文件）", Boolean(delivered), {
    delivered: state.parallel.delivered,
  });
  // 与用例顺序无关的硬判据：新会话文件里这条并行消息就是第 0 条用户消息。
  // 如果它被塞进原会话（同一个运行时排队），前面一定已经有长任务与排队消息。
  check(
    "并行发送：并行消息是那个 Pi 会话的第一条用户消息（确实是全新会话）",
    delivered?.index === 0,
    { index: delivered?.index ?? null },
  );

  // 并行消息必须落在一个**新**的 Pi 会话文件里。
  // 判据用「发送前的文件集合」而不是「上一个用例的标记」：单独跑 parallel 用例时
  // 没有别的标记可比，靠标记推断会得到假阴性。
  const parallelFile = delivered?.file ? resolve(delivered.file) : null;
  state.parallel.newPiFile = Boolean(parallelFile && !filesBefore.includes(parallelFile));
  state.parallel.piFile = parallelFile ? relative(state.root, parallelFile) : null;
  check(
    "并行发送：消息写进一个新的 Pi 会话文件（不是同一个运行时里的排队）",
    state.parallel.newPiFile,
    { piFile: state.parallel.piFile, filesBefore: filesBefore.length },
  );

  // 有其它用例的标记时，再补一条「并行消息不在那些会话文件里」的交叉验证。
  const digests = await sessionDigests(join(state.root, "pi-sessions"));
  const otherMarks = [state.followUp.mark, state.steer.mark].filter(Boolean);
  const otherFiles = new Set(
    otherMarks.flatMap((value) => findMark(digests, value).map((hit) => resolve(hit.file))),
  );
  state.parallel.separateFiles = Boolean(parallelFile && !otherFiles.has(parallelFile));
  check(
    "并行发送：并行消息不在其它用例的会话文件里",
    state.parallel.separateFiles,
    { parallel: state.parallel.piFile, otherFiles: otherFiles.size },
  );

  await settleOrStop(app.cdp, "parallel");
  // 关掉并行新建的临时会话 Tab，避免影响后续用例的 Tab 计数。
  if (createdId) {
    await mouseClick(
      app.cdp,
      "document.getElementById('soxu-tab-" + createdId + "')?.parentElement.querySelector('.tab-close')",
    ).catch(() => null);
    await sleep(600);
  }
}

/**
 * 用例 4：「停止」必须先清 Pi 的队列再 abort —— 排队的消息不能被偷偷执行，
 * 而且文本要还回输入框（用户按停止的语义就是「这些还没发」）。
 */
async function caseStop(app, state) {
  const mark = "SOXU-STOP-" + Date.now().toString(36);
  const busy = await startBusyRun(app.cdp, 800);
  state.stop.busy = busy;
  if (!busy) throw new Error("长任务没有进入 running，无法测停止撤回");
  const chosen = await chooseSendMode(app.cdp, "followUp");
  if (!chosen) throw new Error("「排到下轮」不可点");
  await sendText(app.cdp, mark);
  const note = await waitFor("排队回执", () => queuedNote(app.cdp), { timeout: 8_000 }).catch(
    () => null,
  );
  state.stop.queuedNote = note;
  check("停止前：排队回执已出现", Boolean(note), { queuedNote: note });
  state.stop.shotBefore = await app.cdp.screenshot("desktop-stop-before.png");

  await mouseClick(app.cdp, "document.querySelector('.stop-button')");
  const stopped = await waitFor("停止后回到空闲", async () => !(await isRunning(app.cdp)), {
    timeout: 30_000,
  })
    .then(() => true)
    .catch(() => false);
  const noteAfter = await queuedNote(app.cdp);
  const draft = await composerDraft(app.cdp);
  state.stop.stopped = stopped;
  state.stop.queuedNoteAfter = noteAfter;
  state.stop.draft = draft;
  check("停止后：界面回到空闲", stopped);
  check("停止后：排队回执消失（队列已清空）", noteAfter === null, { queuedNote: noteAfter });
  check("停止后：被撤回的消息回到输入框", Boolean(draft && draft.includes(mark)), {
    draft: (draft ?? "").slice(0, 200),
  });
  state.stop.shotAfter = await app.cdp.screenshot("desktop-stop-after.png");

  // 给 Pi 一点时间：如果 clear_queue 没生效，这条消息会在 abort 后被执行。
  await sleep(6_000);
  const digests = await sessionDigests(join(state.root, "pi-sessions"));
  const leaked = findMark(digests, mark);
  state.stop.deliveredAfterStop = leaked.length > 0;
  check("停止后：被撤回的消息没有被 Pi 执行（abort 前先 clear_queue）", leaked.length === 0, {
    hits: leaked.map((hit) => relative(state.root, hit.file)),
  });
  // 清掉输入框里的撤回文本，避免它被下一个用例当成草稿。
  await app.cdp.evaluate(
    "(function () { const node = document.querySelector('#soxu-composer');" +
      " if (!node) return; node.focus(); node.select(); })()",
  );
  await app.cdp.key("Delete", "Delete", 46);
}

/**
 * 用例 5：设置里的「忙碌时发送」默认值真的参与决策。
 *
 * 不额外调用模型：用同一轮长任务，先看提示语是否跟随设置变化，
 * 再在不选菜单的情况下直接发送，确认它按默认值（排到下轮）进了队列。
 */
async function caseDefaultDelivery(app, state) {
  const mark = "SOXU-DEFAULT-" + Date.now().toString(36);
  const busy = await startBusyRun(app.cdp, 800);
  state.defaultDelivery.busy = busy;
  if (!busy) throw new Error("长任务没有进入 running，无法测默认投递");
  const hint = await composerHint(app.cdp);
  state.defaultDelivery.hint = hint;
  // 默认值来自设置（默认「加入当前」），提示语必须把它写出来，而不是含糊地说「即将支持」。
  check("忙碌时提示语写明默认投递方式", Boolean(hint && /投递/.test(hint)), { hint });
  await sendText(app.cdp, mark);
  const note = await waitFor("排队回执", () => queuedNote(app.cdp), { timeout: 8_000 }).catch(
    () => null,
  );
  state.defaultDelivery.queuedNote = note;
  check("不选菜单时按设置里的默认值投递（消息进了队列而不是被丢弃）", Boolean(note), {
    queuedNote: note,
  });
  state.defaultDelivery.shot = await app.cdp.screenshot("desktop-default-delivery.png");
  // 撤回这条排队消息，别让它真的跑一轮。
  await mouseClick(app.cdp, "document.querySelector('.stop-button')").catch(() => null);
  await waitFor("停止后回到空闲", async () => !(await isRunning(app.cdp)), { timeout: 30_000 }).catch(
    () => null,
  );
}

/* ────────────────────────── 主流程 ────────────────────────── */

async function main() {
  if (ps("if (Get-Process -Name soxu-desktop -ErrorAction SilentlyContinue) { 'running' }") === "running") {
    throw new Error("已有 soxu-desktop.exe 在运行：请先退出它（WebView2 用户数据目录会互相打架）");
  }
  const piVersionText = piVersionViaShell();
  if (!piVersionText) {
    throw new Error("PATH 上找不到可用的 pi（cmd.exe /d /s /c pi --version 失败）");
  }

  await mkdir(OUT_DIR, { recursive: true });
  const root = mkdtempSync(join(tmpdir(), "soxu-146-desktop-"));
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  await mkdir(join(root, "pi-sessions"), { recursive: true });
  // 真实 pi 的可执行入口：本机托管安装只有 pi.cmd，需要临时转发 shim。
  piShim = ensurePiExe(root);

  const report = {
    generatedAt: new Date().toISOString(),
    environment: {
      exe: EXE,
      piVersion: piShim.version ?? piVersionText,
      piLaunch: piShim.kind,
      piLauncher: piShim.launcher ?? null,
      vitePort: VITE_PORT,
      cdpPort: CDP_PORT,
      viewport: VIEWPORT,
      platform: process.platform,
      node: process.version,
      piSessionDir: "临时目录（PI_CODING_AGENT_SESSION_DIR）",
    },
    cases: {},
    checks: [],
  };

  const vite = spawn(
    process.platform === "win32" ? "pnpm.cmd" : "pnpm",
    // 不覆盖 host：走 apps/desktop/vite.config.ts 的 127.0.0.1:1420，
    // 与 tauri.conf.json 的 devUrl 保持一致（真实开发路径）。
    ["exec", "vite", "--port", String(VITE_PORT), "--strictPort"],
    { cwd: APP_ROOT, shell: process.platform === "win32", stdio: "ignore" },
  );

  const snapshot = await snapshotAppData();
  const state = {
    root,
    projectRoot,
    followUp: {},
    steer: {},
    parallel: {},
    stop: {},
    defaultDelivery: {},
  };
  let app = null;
  try {
    await waitFor("Vite 开发服务器", async () => {
      const response = await fetch("http://127.0.0.1:" + VITE_PORT + "/", { method: "HEAD" });
      return response.ok;
    }, { timeout: 60_000 });

    app = await launchApp(root, "app");

    // 真实 IPC 登记项目（原生目录选择器无法自动化，但命令与后端都是真的）。
    report.cases.project = await app.cdp.evaluate(
      "window.__TAURI_INTERNALS__.invoke('register_project', { root: " +
        JSON.stringify(projectRoot) +
        " })",
    );
    await app.cdp.send("Page.reload");
    await waitFor("重载后应用挂载", async () =>
      app.cdp.evaluate("Boolean(document.querySelector('.app-shell'))"),
    );
    await waitFor("侧栏出现项目", async () =>
      app.cdp.evaluate(
        "Array.from(document.querySelectorAll('.project-name, .sidebar-project, .project-item'))" +
          ".some((node) => node.textContent.includes('project'))",
      ),
    ).catch(() => null);
    report.cases.sessionId = await openTemporarySession(app.cdp);
    state.sessionId = report.cases.sessionId;
    check(
      "临时会话由真实 open_temporary_session 分配（ses_tmp_* 身份）",
      /^ses_tmp_/.test(report.cases.sessionId),
      { sessionId: report.cases.sessionId },
    );

    const only = (process.env.SOXU_HARNESS_ONLY ?? "followup,steer,parallel,stop,default")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    if (only.includes("followup")) await caseFollowUp(app, state);
    if (only.includes("steer")) await caseSteer(app, state);
    if (only.includes("parallel")) await caseParallel(app, state);
    if (only.includes("stop")) await caseStop(app, state);
    if (only.includes("default")) await caseDefaultDelivery(app, state);

    report.consoleIssues = app.cdp.errors.slice(0, 20);
    report.stderr = app.stderr.join("").trim().slice(-2000);
  } finally {
    if (app) {
      app.cdp.close();
      killTree(app.child.pid);
    }
    killTree(vite.pid);
    await sleep(800);
    // 零残留：app 退出后还有没有本次走查的 pi.exe（shim）活着。
    report.piProcesses = reapPiProcesses();
    report.appData = await restoreAppData(snapshot).catch(() => null);
    report.cases.followUp = state.followUp;
    report.cases.steer = state.steer;
    report.cases.parallel = state.parallel;
    report.cases.stop = state.stop;
    report.cases.defaultDelivery = state.defaultDelivery;
    report.checks = checks;
    await writeFile(join(OUT_DIR, "desktop-send-modes.json"), JSON.stringify(report, null, 2) + "\n");
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }

  console.log(JSON.stringify({ checks, cases: report.cases, appData: report.appData }, null, 2));
  if (checks.some((entry) => !entry.ok)) {
    console.error("断言未通过：" + JSON.stringify(checks.filter((entry) => !entry.ok)));
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
