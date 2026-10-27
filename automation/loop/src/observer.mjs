import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { join } from "node:path";
import { ROOT } from "./config.mjs";
import { readCheckpoint } from "./checkpoint.mjs";
import { localProgress } from "./status.mjs";

export const OBSERVER_PORT = 47321;
const GROUPS = ["running", "paused", "blocked", "pending", "done"];
const VALID_PHASES = new Set(["worktree", "install", "develop", "checks", "review", "finalChecks", "commit", "push", "createPr", "merge", "done", "archived"]);

/** A new, memory-only credential for every explicit observer start. Never persist it. */
export function observerToken() {
  return randomBytes(24).toString("hex");
}

function authorized(header, token) {
  if (typeof header !== "string" || !/^[0-9a-f]{48}$/i.test(header)) return false;
  const actual = Buffer.from(header, "hex");
  const expected = Buffer.from(token, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function publicTask(item, status) {
  return {
    id: item.id,
    title: String(item.title ?? "").replace(/[\r\n\u0000-\u001f]/g, " ").slice(0, 200),
    status,
    phase: VALID_PHASES.has(item.phase) ? item.phase : null,
    updatedAt: typeof item.updatedAt === "string" && !Number.isNaN(Date.parse(item.updatedAt)) ? item.updatedAt : null,
  };
}

/**
 * Only a projection of local coordinator checkpoints is exposed.
 * No Issue bodies, workspace paths, provider credentials, prompts, session text or RPC frames.
 * "running" means checkpoint state, NOT proof that a process remains alive.
 */
export async function observerSnapshot(root = ROOT) {
  const progress = await localProgress(root, id => readCheckpoint(id, join(root, ".soxu", "checkpoints")));
  return {
    schemaVersion: 1,
    source: "local-checkpoints",
    isLive: false,
    generatedAt: new Date().toISOString(),
    tasks: GROUPS.flatMap(status => progress[status].map(item => publicTask(item, status))),
    note: "Checkpoint-only; running does not prove a live Pi process. Read Pi JSONL via PiDeck for messages.",
  };
}

/** Does not open a port until the caller explicitly calls listen(). */
export function createObserverServer({ root = ROOT, token } = {}) {
  if (typeof token !== "string" || !/^[0-9a-f]{48}$/i.test(token)) throw new Error("Invalid observer token");
  const server = createServer(async (req, res) => {
    const port = server.address()?.port;
    const hostOk = req.headers.host === `127.0.0.1:${port}`;
    const peerOk = req.socket.remoteAddress === "127.0.0.1" || req.socket.remoteAddress === "::ffff:127.0.0.1";
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    const reply = (code, body) => { res.writeHead(code); res.end(JSON.stringify(body)); };
    if (!hostOk || !peerOk) return reply(403, { error: "forbidden-host" });
    if (!authorized(req.headers["x-soxu-observer-token"], token)) return reply(401, { error: "unauthorized" });
    if (req.method !== "GET") return reply(405, { error: "method-not-allowed" });
    if (req.url !== "/v1/tasks") return reply(404, { error: "not-found" });
    try {
      return reply(200, await observerSnapshot(root));
    } catch {
      return reply(503, { error: "snapshot-unavailable" });
    }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.maxRequestsPerSocket = 100;
  return server;
}
