import { createServer } from "node:http";
import { fork } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { ROOT } from "./config.mjs";
import { readCheckpoint } from "./checkpoint.mjs";
import { localProgress } from "./status.mjs";
import { safeActivity } from "./dashboard-activity.mjs";

export const DASHBOARD_PORT = 47321;
const COMMANDS = new Set(["once", "resume", "loop", "watch"]);
const GROUPS = ["running", "paused", "blocked", "pending", "done"];
const MAX_LOGS = 500;
const MAX_STREAM_CLIENTS = 8;
const PHASES = new Set(["worktree", "install", "develop", "checks", "review", "postConflictInstall", "finalChecks", "commit", "push", "createPr", "merge", "done"]);
const WEB_DIR = join(ROOT, "automation", "loop", "web");
const ASSETS = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
]);

export function dashboardToken() { return randomBytes(24).toString("hex"); }
function tokenMatches(header, expected) {
  if (typeof header !== "string" || !/^[0-9a-f]{48}$/i.test(header)) return false;
  const a = Buffer.from(header, "hex"), b = Buffer.from(expected, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
function cleanLine(value) {
  return String(value).replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/(Bearer\s+)\S+/gi, "$1[redacted]")
    .replace(/((?:api[_-]?key|token|password|authorization|secret)\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").slice(0, 400);
}
async function liveExternalLocks(root) {
  const dir = join(root, ".soxu", "locks");
  let files;
  try { files = await readdir(dir); }
  catch (e) { if (e.code === "ENOENT") return 0; throw e; }
  let running = 0;
  for (const file of files.filter(x => /^(?:github|local)-issue-\d+\.lock$/.test(x))) {
    try {
      const lock = JSON.parse(await readFile(join(dir, file), "utf8"));
      if (!Number.isSafeInteger(lock.pid) || lock.pid <= 0) { running++; continue; }
      try { process.kill(lock.pid, 0); running++; }
      catch (e) { if (e.code !== "ESRCH") running++; }
    } catch (e) { if (e.code !== "ENOENT") running++; }
  }
  return running;
}

/** Owns only jobs explicitly launched from this web process. It cannot seize external Pi processes. */
export class DashboardCoordinator extends EventEmitter {
  constructor({ root = ROOT, spawn = fork } = {}) {
    super();
    this.root = root;
    this.spawn = spawn;
    this.active = null;
    this.reserved = false;
    this.lastRun = null;
    this.lines = [];
    this.serial = 0;
    this.instanceId = randomBytes(8).toString("hex");
    this.agents = new Map();
    this.phases = new Map();
  }
  push(message, stream = "system") {
    const line = { seq: ++this.serial, time: new Date().toISOString(), stream, message: cleanLine(message) };
    this.lines.push(line);
    if (this.lines.length > MAX_LOGS) this.lines.splice(0, this.lines.length - MAX_LOGS);
    this.emit("dashboard:event", { type: "log", data: line });
  }
  receiveTelemetry(message) {
    if (!this.active || !message || typeof message !== "object") return;
    if (message.type === "soxu:activity") {
      const activity = safeActivity(message.data);
      if (!activity) return;
      const key = `${activity.taskId}:${activity.role}`;
      if (!this.agents.has(key) && this.agents.size >= 32) return;
      this.agents.set(key, activity);
      this.emit("dashboard:event", { type: "agent", data: activity });
    } else if (message.type === "soxu:phase") {
      const { taskId, phase, status } = message.data ?? {};
      if (!Number.isSafeInteger(taskId) || taskId <= 0 || taskId >= 1e9 ||
          !PHASES.has(phase) || !["running", "paused", "blocked", "done"].includes(status)) return;
      this.phases.set(taskId, { phase, status, at: new Date().toISOString() });
      if (this.phases.size > 32) this.phases.delete(this.phases.keys().next().value);
      this.emit("dashboard:event", { type: "status", data: {} });
    }
  }
  async snapshot() {
    const [progress, externalLocks] = await Promise.all([
      localProgress(this.root, id => readCheckpoint(id, join(this.root, ".soxu", "checkpoints"))),
      liveExternalLocks(this.root),
    ]);
    return {
      schemaVersion: 2,
      instanceId: this.instanceId,
      agents: [...this.agents.values()],
      generatedAt: new Date().toISOString(),
      source: "local-checkpoints",
      isLive: false,
      tasks: GROUPS.flatMap(status => progress[status].map(item => ({
        id: item.id, title: cleanLine(item.title ?? item.name).slice(0, 160),
        status, phase: item.phase, updatedAt: item.updatedAt,
      }))),
      runner: this.active ? { command: this.active.command, startedAt: this.active.startedAt, stopping: this.active.stopping } : null,
      lastRun: this.lastRun,
      externalLocks,
      busy: this.reserved || this.active !== null || externalLocks > 0,
      log: this.lines.slice(-MAX_LOGS),
      note: "Task phase is a checkpoint, not proof of a live Pi process; controls affect only dashboard-launched jobs.",
    };
  }
  async start(command) {
    if (!COMMANDS.has(command)) throw Object.assign(new Error("unsupported-command"), { status: 400 });
    if (this.reserved || this.active) throw Object.assign(new Error("runner-busy"), { status: 409 });
    this.reserved = true; // reserve before awaiting disk I/O to reject simultaneous requests
    try {
      if (await liveExternalLocks(this.root)) throw Object.assign(new Error("external-runner-active"), { status: 409 });
      const script = join(this.root, "automation", "loop", "src", "cli.mjs");
      const child = this.spawn(script, [command], {
        cwd: this.root,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        windowsHide: true,
        env: process.env,
      });
      const job = { child, command, startedAt: new Date().toISOString(), stopping: false };
      this.active = job;
      this.agents.clear();
      this.phases.clear();
      child.on("message", data => { if (this.active === job) this.receiveTelemetry(data); });
      this.push(`Started ${command} (dashboard-owned)`);
      this.emit("dashboard:event", { type: "status", data: {} });
      const attach = (stream, pipe) => {
        if (!pipe) return;
        let unfinished = "";
        pipe.on("data", chunk => {
          const lines = (unfinished + String(chunk).slice(-16384)).split(/\r?\n/);
          unfinished = lines.pop().slice(-600);
          for (const line of lines.slice(-120)) if (line.trim()) this.push(line, stream);
        });
        pipe.on("end", () => { if (unfinished.trim()) this.push(unfinished, stream); });
      };
      attach("stdout", child.stdout);
      attach("stderr", child.stderr);
      child.once("error", e => this.push(`Runner spawn failed: ${e.code ?? "unknown"}`, "system"));
      // Prefer actual runner exit; inherited descendants may delay close on Windows.
      let finalized = false;
      const finish = (code, signal) => {
        if (finalized) return;
        finalized = true;
        if (this.active === job) this.active = null;
        for (const [key, value] of this.agents) {
          if (value.state === "waiting" || value.state === "generating" || value.state === "tool") {
            const finalState = code === 0 ? "completed" : "failed";
            const closed = { ...value, state: finalState, tool: null, activitySince: new Date().toISOString() };
            this.agents.set(key, closed);
            this.emit("dashboard:event", { type: "agent", data: closed });
          }
        }
        this.emit("dashboard:event", { type: "status", data: {} });
        this.lastRun = { command, finishedAt: new Date().toISOString(), exitCode: Number.isInteger(code) ? code : null, signal: signal ?? null };
        this.push(`Finished ${command}; exit=${code ?? "signal"}`, "system");
      };
      child.once("exit", finish);
      child.once("close", finish);
      return { accepted: true, command };
    } finally {
      this.reserved = false;
    }
  }
  stop() {
    const job = this.active;
    if (!job) throw Object.assign(new Error("no-dashboard-job"), { status: 409 });
    if (job.stopping) return { accepted: true, stopping: true };
    if (!job.child.connected) throw Object.assign(new Error("runner-ipc-unavailable"), { status: 409 });
    job.child.send({ type: "soxu:interrupt" });
    job.stopping = true;
    this.push(`Graceful stop requested for ${job.command}`);
    this.emit("dashboard:event", { type: "status", data: {} });
    return { accepted: true, stopping: true };
  }
  shutdown() {
    if (this.active && !this.active.stopping) {
      try { this.stop(); } catch { this.push("Stop message failed; inspect child process before exit"); }
    }
  }
}

async function readBody(request) {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk.toString("utf8");
    if (Buffer.byteLength(raw) > 1024) throw Object.assign(new Error("body-too-large"), { status: 413 });
  }
  try { return JSON.parse(raw); }
  catch { throw Object.assign(new Error("invalid-json"), { status: 400 }); }
}

export function createDashboardServer({ root = ROOT, token, coordinator = new DashboardCoordinator({ root }) } = {}) {
  if (typeof token !== "string" || !/^[0-9a-f]{48}$/i.test(token)) throw new Error("Invalid dashboard token");
  const streamClients = new Set();
  let heartbeat = null;
  const release = response => {
    streamClients.delete(response);
    if (streamClients.size === 0 && heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  };
  const sendFrame = (response, type, data) => {
    if (response.destroyed || response.writableEnded) return release(response);
    const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    try {
      if (!response.write(frame)) { // Drop a slow reader; never buffer unbounded event frames.
        release(response);
        response.destroy();
      }
    } catch {
      release(response);
      response.destroy();
    }
  };
  const onEvent = event => {
    for (const response of streamClients) sendFrame(response, event.type, event.data);
  };
  coordinator.on("dashboard:event", onEvent);
  const stopStreams = () => {
    for (const response of streamClients) response.end();
    streamClients.clear();
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    coordinator.off("dashboard:event", onEvent);
  };
  const server = createServer({ maxHeaderSize: 8192 }, async (request, response) => {
    const port = server.address()?.port;
    const origin = `http://127.0.0.1:${port}`;
    const reply = (status, body) => {
      response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(body));
    };
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    const peer = request.socket.remoteAddress;
    if (request.headers.host !== `127.0.0.1:${port}` || (peer !== "127.0.0.1" && peer !== "::ffff:127.0.0.1")) {
      return reply(403, { error: "invalid-host" });
    }
    if (request.headers.origin && request.headers.origin !== origin) return reply(403, { error: "invalid-origin" });
    if (request.method === "GET" && ASSETS.has(request.url)) {
      const [filename, type] = ASSETS.get(request.url);
      try {
        response.writeHead(200, { "Content-Type": type });
        return response.end(await readFile(join(WEB_DIR, filename)));
      } catch { return reply(503, { error: "ui-unavailable" }); }
    }
    if (!tokenMatches(request.headers["x-soxu-control-token"], token)) return reply(401, { error: "unauthorized" });
    if (request.method === "GET" && request.url === "/api/events") {
      if (streamClients.size >= MAX_STREAM_CLIENTS) return reply(429, { error: "too-many-streams" });
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });
      streamClients.add(response);
      response.on("close", () => release(response));
      sendFrame(response, "hello", { instanceId: coordinator.instanceId });
      if (!heartbeat) {
        heartbeat = setInterval(() => {
          for (const client of streamClients) {
            if (client.destroyed || client.writableEnded || !client.write(": ping\n\n")) {
              release(client);
              client.destroy();
            }
          }
        }, 15000);
        heartbeat.unref?.();
      }
      return;
    }
    if (request.method === "GET" && request.url === "/api/status") {
      try { return reply(200, await coordinator.snapshot()); }
      catch { return reply(503, { error: "status-unavailable" }); }
    }
    if (request.method === "POST" && ["/api/run", "/api/stop"].includes(request.url)) {
      if (request.headers.origin !== origin || request.headers["content-type"] !== "application/json") {
        return reply(403, { error: "invalid-request-origin" });
      }
      try {
        const body = await readBody(request);
        if (request.url === "/api/run") {
          if (!body || typeof body !== "object" || Object.keys(body).length !== 1 || typeof body.command !== "string")
            return reply(400, { error: "invalid-command" });
          return reply(202, await coordinator.start(body.command));
        }
        if (!body || typeof body !== "object" || Object.keys(body).length !== 0)
          return reply(400, { error: "invalid-body" });
        return reply(202, coordinator.stop());
      } catch (error) {
        return reply(error.status ?? 503, { error: error.status ? error.message : "operation-failed" });
      }
    }
    return reply(404, { error: "not-found" });
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  return { server, coordinator, stopStreams };
}
