/**
 * Issue #97 实机截图驱动：用 CDP 驱动真实 Edge（Chromium）打开本地 Vite 预览并逐帧落盘。
 *
 * 用法（先启动 apps/desktop 的 dev server 与一个 headful/headless Edge 的调试端口）：
 *   node shoot.mjs 9333 http://127.0.0.1:1420/ .
 *
 * 为什么不用命令行 --screenshot：需要「点击后暂停动画再把播放位置定到 200ms」，
 * 才能得到确定的 t≈200ms 帧；纯计时截图会被导航与截图延迟污染。
 * 只用 Node 内置能力（fetch + WebSocket + fs），不引入新依赖。
 */
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const port = Number(process.argv[2] ?? 9333);
const base = process.argv[3] ?? "http://127.0.0.1:1420/";
const outDir = new URL("./", import.meta.url);

const SHOTS = [
  { file: "dark-to-light-01-t200ms", shot: "to-light-t200" },
  { file: "dark-to-light-01b-t200ms-noglow", shot: "to-light-t200-noglow" },
  { file: "dark-to-light-02-ripple-fade", shot: "to-light-ripple" },
  { file: "dark-to-light-03-settled", shot: "to-light-settled" },
  { file: "baseline-light", shot: "baseline-light" },
  { file: "light-to-dark-01-t200ms", shot: "to-dark-t200" },
  { file: "light-to-dark-01b-t200ms-noglow", shot: "to-dark-t200-noglow" },
  { file: "light-to-dark-02-ripple-fade", shot: "to-dark-ripple" },
  { file: "light-to-dark-03-settled", shot: "to-dark-settled" },
  { file: "baseline-dark", shot: "baseline-dark" },
  { shot: "reduced-motion", media: "reduce" },
  { shot: "unsupported" },
];

/** 极简 CDP 客户端：单连接 + flatten session。 */
async function connect(wsUrl) {
  const socket = new WebSocket(wsUrl);
  const pending = new Map();
  let nextId = 1;
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const entry = message.id ? pending.get(message.id) : undefined;
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message + " (" + message.error.code + ")"));
    else entry.resolve(message.result);
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("CDP WebSocket 连接失败")), { once: true });
  });
  return {
    send(method, params = {}, sessionId) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    },
    close() {
      socket.close();
    },
  };
}

const version = await (await fetch("http://127.0.0.1:" + port + "/json/version")).json();
const cdp = await connect(version.webSocketDebuggerUrl);
// 视口尺寸交给 Emulation.setDeviceMetricsOverride；createTarget 带上 width/height 会要求 newWindow
const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
await cdp.send("Page.enable", {}, sessionId);
await cdp.send("Runtime.enable", {}, sessionId);
await cdp.send(
  "Emulation.setDeviceMetricsOverride",
  { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false },
  sessionId,
);

const pageScript = await readFile(new URL("./capture.js", import.meta.url), "utf8");

async function evaluate(expression) {
  const result = await cdp.send(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  );
  if (result.exceptionDetails) {
    const description = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
    throw new Error("页面脚本失败：" + description);
  }
  return result.result?.value;
}

/** 等新文档把 #app 渲染出来，避免在旧上下文里执行脚本。 */
async function waitReady() {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const ready = await evaluate(
      "document.readyState === 'complete' && !!document.querySelector('.app-shell')",
    );
    if (ready) return;
    await delay(50);
  }
  throw new Error("页面没有在 10s 内挂载 .app-shell");
}

const report = [];
for (const shot of SHOTS) {
  // 降级场景需要先改媒体能力/跑完再恢复，避免污染后面的截图
  await cdp.send(
    "Emulation.setEmulatedMedia",
    shot.media
      ? { features: [{ name: "prefers-reduced-motion", value: shot.media }] }
      : { features: [] },
    sessionId,
  );
  await cdp.send("Page.navigate", { url: base + "?shot=" + shot.shot }, sessionId);
  await waitReady();
  await delay(300);
  const meta = JSON.parse(await evaluate(pageScript));
  if (shot.file) {
    const image = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
    await writeFile(new URL("./" + shot.file + ".png", outDir), Buffer.from(image.data, "base64"));
  }
  report.push({ file: shot.file ?? shot.shot, ...meta });
  console.log(shot.file ?? shot.shot, JSON.stringify(meta));
}

await writeFile(new URL("./capture-report.json", outDir), JSON.stringify(report, null, 2) + "\n");
cdp.close();
console.log("done", SHOTS.length, "screenshots");
