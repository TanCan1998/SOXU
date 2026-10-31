/**
 * TASK-037（Issue #147）的可复现证据脚本：扩展页真数据走查。
 *
 * 用法（仓库任意位置）：
 *   cargo run -q -p soxu-desktop --example scan-agent-dir > docs/development/evidence/issue-147-extensions-page/agent-scan-windows.json
 *   node apps/desktop/tests/harness/shoot-issue-147-extensions.mjs
 *
 * 数据链是「真实 Rust 扫描 → JSON → 注入浏览器夹具 → 生产组件渲染」：
 * 截图里看到的名字、来源、启停、文件数都来自本机 ~/.pi/agent，
 * 夹具只替换 Tauri 的传输层（window.__TAURI_INTERNALS__.invoke）。
 *
 * 断言（任何一条不成立就以非 0 退出）：
 * - 页面渲染的条目顺序与扫描 JSON 完全一致（扩展 / 技能 / MCP 三段）；
 * - 区块计数、来源徽章数、停用条数与 JSON 一致；
 * - 技能详情展示真实文件数（脚本按同一规则数一遍目录）；
 * - 失败态显示后端原因与重试按钮，且**不出现**空态文案；
 * - 空清单显示三条空态文案；读取中显示进度文案；
 * - en-US 下界面状态词是英文（数据本身的语言不翻译）；
 * - 两种语言下渲染文本都不含禁用词（切片 / Issue # / 占位 / 演示 / V4-S / TODO( ）。
 *
 * 结束后回收 Vite 与浏览器子进程（不留常驻服务）。
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { formatHit, scanText } from "../support/uiWordingScan.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(HERE, "../..");
const REPO_ROOT = resolve(APP_ROOT, "../..");
const OUT_DIR = join(REPO_ROOT, "docs", "development", "evidence", "issue-147-extensions-page");
const SCAN_JSON = join(OUT_DIR, "agent-scan-windows.json");

const EDGE_CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];
const PORT = Number(process.env.SOXU_HARNESS_PORT ?? 1429);
const DEBUG_PORT = Number(process.env.SOXU_CDP_PORT ?? 9461);
const BASE_URL = "http://127.0.0.1:" + PORT;
const FIXTURE = "/tests/harness/extensions.html";
const VIEWPORT = { width: 900, height: 1100 };

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
    process.kill(-pid, "SIGTERM");
  }
}

/** 极简 CDP 客户端：只需要 evaluate / 截图 / 鼠标事件。 */
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

async function clickSelector(cdp, selector) {
  const point = await cdp.evaluate(
    "(() => { const element = document.querySelector(" +
      JSON.stringify(selector) +
      "); if (!element) return null;" +
      " const rect = element.getBoundingClientRect();" +
      " return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; })()",
  );
  if (!point) throw new Error("找不到可点击元素：" + selector);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await cdp.send("Input.dispatchMouseEvent", {
      type,
      x: point.x,
      y: point.y,
      button: "left",
      buttons: type === "mousePressed" ? 1 : 0,
      clickCount: 1,
    });
  }
  await sleep(320);
}

/** 页面上读出来的东西：区块标题、条目名、来源徽章、状态词、详情与空/失败文案。 */
const READ_PAGE =
  "(() => {" +
  " const text = (selector) => Array.from(document.querySelectorAll(selector)).map((el) => el.textContent.trim());" +
  " return {" +
  // 只读三段清单容器：页尾的语言包区也有 .section-title / .empty，不能串味。
  "   sections: text('.catalog .section-title')," +
  "   names: text('.catalog .item-title')," +
  "   sources: text('.catalog .item-source')," +
  "   states: text('.catalog .item-state')," +
  "   details: text('.catalog .item-detail')," +
  "   empty: text('.catalog .empty')," +
  "   failure: text('.failure-text')," +
  "   status: text('.state')," +
  "   note: text('.catalog .note')," +
  "   buttons: text('.failure .action')," +
  "   body: document.querySelector('.panel')?.innerText ?? ''," +
  " };" +
  "})()";

/** 按 Rust count_files 的同一规则数一遍目录：不跟随目录链接，最多 2000 个。 */
async function countFiles(root) {
  const stats = await readdir(root, { withFileTypes: true });
  let count = 0;
  const stack = [];
  for (const entry of stats) {
    if (entry.isDirectory()) stack.push(join(root, entry.name));
    else if (entry.isFile()) count += 1;
  }
  while (stack.length > 0 && count < 2000) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (count >= 2000) break;
      if (entry.isDirectory()) stack.push(join(dir, entry.name));
      else if (entry.isFile()) count += 1;
    }
  }
  return count;
}

const checks = [];
function check(name, ok, detail = {}) {
  checks.push({ name, ok: Boolean(ok), ...detail });
}

function sorted(list) {
  return [...list].sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
}

async function main() {
  if (!existsSync(SCAN_JSON)) {
    throw new Error(
      "缺少真实扫描结果：" + SCAN_JSON + "\n先运行：cargo run -q -p soxu-desktop --example scan-agent-dir > \"" + SCAN_JSON + "\"",
    );
  }
  const catalog = JSON.parse(await readFile(SCAN_JSON, "utf8"));
  const edgePath = EDGE_CANDIDATES.find((candidate) => existsSync(candidate));
  if (!edgePath) throw new Error("找不到 Edge，无法做浏览器走查：" + EDGE_CANDIDATES.join(" / "));

  // 详情夹具用真实目录数出来的文件数（挑第一个存在的技能）。
  const details = {};
  let detailTarget = null;
  for (const skill of catalog.skills) {
    if (!existsSync(skill.path)) continue;
    const fileCount = await countFiles(skill.path);
    details[skill.id] = {
      id: skill.id,
      name: skill.name,
      path: skill.path,
      fileCount,
      fileCountTruncated: fileCount >= 2000,
      description: skill.description,
    };
    detailTarget = skill;
    break;
  }

  const fixtureData = {
    catalog,
    details,
    error: "读不到 Pi 的配置目录 C:\\Users\\tanca\\.pi\\agent（系统找不到指定的路径）",
  };

  await mkdir(OUT_DIR, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), "soxu-147-edge-"));
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
    // 数据在页面脚本之前注入：组件挂载时就能读到真实扫描结果。
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: "window.__SOXU_EXTENSION_FIXTURE__ = " + JSON.stringify(fixtureData) + ";",
    });

    const shots = [];
    const open = async (mode, tag) => {
      await cdp.send("Page.navigate", { url: BASE_URL + FIXTURE + "?mode=" + mode + "&locale=" + tag });
      try {
        await waitFor("扩展页挂载", async () =>
          cdp.evaluate("Boolean(document.querySelector('.panel'))"),
        );
      } catch (error) {
        const body = await cdp
          .evaluate("document.body.innerText.slice(0, 400)")
          .catch(() => "(无法读取 body)");
        throw new Error(
          error.message + "\n页面异常：" + JSON.stringify(cdp.errors) + "\n页面文本：" + body,
        );
      }
      await sleep(240);
    };

    // ── 1. 真数据（zh-CN）──
    await open("ready", "zh-CN");
    await waitFor("扩展条目渲染", async () =>
      cdp.evaluate("document.querySelectorAll('.item-title').length >= 3"),
    );
    const zhPage = await cdp.evaluate(READ_PAGE);
    shots.push(await screenshot(cdp, "01-ready-zh-CN.png"));

    const expectedNames = [
      ...catalog.extensions.map((item) => item.name),
      ...catalog.skills.map((item) => item.name),
      ...catalog.mcpServers.map((item) => item.name),
    ];
    check("渲染顺序与扫描 JSON 完全一致（扩展 + 技能 + MCP）",
      JSON.stringify(zhPage.names) === JSON.stringify(expectedNames), {
        rendered: zhPage.names.length,
        scanned: expectedNames.length,
      });
    check("区块计数与 JSON 一致",
      zhPage.sections.length === 3 &&
        zhPage.sections[0].includes(String(catalog.extensions.length)) &&
        zhPage.sections[1].includes(String(catalog.skills.length)) &&
        zhPage.sections[2].includes(String(catalog.mcpServers.length)),
      { sections: zhPage.sections });
    check("来源徽章数 = 扩展数 + 带传输方式的 MCP 数",
      zhPage.sources.length ===
        catalog.extensions.length + catalog.mcpServers.filter((item) => item.transport).length,
      { sources: zhPage.sources.length });
    const disabled = [...catalog.extensions, ...catalog.skills].filter((item) => !item.enabled).length;
    check("停用条数与 JSON 一致",
      zhPage.states.filter((text) => text === "已停用").length === disabled,
      { disabled, states: zhPage.states.filter((text) => text === "已停用").length });
    check("MCP 连接状态如实写「未知」",
      zhPage.states.filter((text) => text === "连接状态未知").length === catalog.mcpServers.length,
      { mcp: catalog.mcpServers.length });
    check("页面上说明了只读与读取来源",
      zhPage.body.includes(catalog.agentDir) && zhPage.note.length === 1,
      { note: zhPage.note });

    // ── 2. 技能详情按需展开 ──
    if (detailTarget) {
      await clickSelector(cdp, ".expand");
      await waitFor("技能详情展开", async () =>
        cdp.evaluate("Boolean(document.querySelector('.item-detail'))"),
      );
      await sleep(200);
      const detailPage = await cdp.evaluate(READ_PAGE);
      shots.push(await screenshot(cdp, "02-ready-skill-detail-zh-CN.png"));
      const expected = details[detailTarget.id];
      check("技能详情展示真实文件数",
        detailPage.details.join(" ").includes(String(expected.fileCount) + " 个文件"),
        { skill: detailTarget.name, fileCount: expected.fileCount, rendered: detailPage.details });
      check("详情里带上技能目录", detailPage.details.join(" ").includes(expected.path));
    }

    // ── 3. en-US 的界面状态词 ──
    await open("ready", "en-US");
    await waitFor("扩展条目渲染", async () =>
      cdp.evaluate("document.querySelectorAll('.item-title').length >= 3"),
    );
    const enPage = await cdp.evaluate(READ_PAGE);
    shots.push(await screenshot(cdp, "03-ready-en-US.png"));
    check("en-US 下状态词是英文",
      enPage.states.includes("Enabled") &&
        enPage.states.includes("Connection unknown") &&
        !enPage.states.some((text) => text === "已启用" || text === "连接状态未知"),
      { states: [...new Set(enPage.states)] });

    // ── 4. 读取中 ──
    await open("loading", "zh-CN");
    const loadingPage = await cdp.evaluate(READ_PAGE);
    shots.push(await screenshot(cdp, "04-loading-zh-CN.png"));
    check("读取中显示进度文案",
      loadingPage.status.join(" ").includes("正在读取") && loadingPage.names.length === 0,
      { status: loadingPage.status });

    // ── 5. 失败态：原因 + 重试，且不冒充空列表 ──
    await open("error", "zh-CN");
    const errorPage = await cdp.evaluate(READ_PAGE);
    shots.push(await screenshot(cdp, "05-error-zh-CN.png"));
    check("失败态显示后端原因",
      errorPage.failure.join(" ").includes("读不到 Pi 的配置目录"),
      { failure: errorPage.failure });
    check("失败态有重试入口", errorPage.buttons.length === 1, { buttons: errorPage.buttons });
    check("失败态不出现空态文案（不把失败装成空列表）",
      errorPage.empty.length === 0 && errorPage.names.length === 0,
      { empty: errorPage.empty });

    // ── 6. 空清单 ──
    await open("empty", "zh-CN");
    const emptyPage = await cdp.evaluate(READ_PAGE);
    shots.push(await screenshot(cdp, "06-empty-zh-CN.png"));
    check("空清单三段各有一条空态文案", emptyPage.empty.length === 3, { empty: emptyPage.empty });

    // ── 7. 渲染文本禁用词 ──
    for (const [label, page] of [
      ["zh-CN", zhPage],
      ["en-US", enPage],
      ["failure", errorPage],
    ]) {
      const hits = scanText(page.body).map((hit) => formatHit(label, hit));
      check(label + " 渲染文本没有开发术语", hits.length === 0, { hits });
    }

    const report = {
      generatedAt: new Date().toISOString(),
      viewport: VIEWPORT,
      browser: await cdp.send("Browser.getVersion").then((info) => info.product),
      fixture: FIXTURE,
      scanSource: "docs/development/evidence/issue-147-extensions-page/agent-scan-windows.json",
      agentDir: catalog.agentDir,
      counts: {
        extensions: catalog.extensions.length,
        skills: catalog.skills.length,
        mcpServers: catalog.mcpServers.length,
        disabled: [...catalog.extensions, ...catalog.skills].filter((item) => !item.enabled).length,
      },
      shots,
      checks,
    };
    await writeFile(join(OUT_DIR, "desktop-report.json"), JSON.stringify(report, null, 2) + "\n");

    const failed = checks.filter((item) => !item.ok);
    for (const item of checks) {
      console.log((item.ok ? "PASS " : "FAIL ") + item.name);
    }
    console.log("截图：" + shots.join(", "));
    if (failed.length > 0) {
      console.error("共 " + failed.length + " 项未通过");
      process.exitCode = 1;
    }
  } finally {
    cdp.close();
    killTree(edge?.pid);
    killTree(vite?.pid);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
