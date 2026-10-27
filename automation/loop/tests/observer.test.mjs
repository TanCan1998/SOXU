import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createObserverServer, observerSnapshot } from "../src/observer.mjs";
import { writeCheckpoint } from "../src/checkpoint.mjs";

const TOKEN = "a".repeat(48);
async function fetchLocal(port, { path = "/v1/tasks", method = "GET", token = TOKEN, host } = {}) {
  return await new Promise((resolve, reject) => {
    const req = request({
      hostname: "127.0.0.1", port, path, method,
      headers: { ...(token ? { "X-SOXU-Observer-Token": token } : {}), ...(host ? { Host: host } : {}) },
    }, response => {
      let body = "";
      response.on("data", chunk => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: JSON.parse(body) }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("observer is opt-in, credentialed, read-only and only projects safe checkpoint fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "soxu-observer-"));
  const server = createObserverServer({ root, token: TOKEN });
  try {
    await mkdir(join(root, "tasks", "backlog"), { recursive: true });
    await writeFile(join(root, "tasks", "backlog", "TASK-001.md"), "# Implement RPC supervisor\n");
    const checkpointDir = join(root, ".soxu", "checkpoints");
    await writeCheckpoint({
      issue: { number: 1, body: "secret ISSUE body", title: "private" },
      local: false, status: "running", phase: "develop", attempt: 0,
      directory: "F:\\private\\worktree", feedback: "private feedback",
      apiKey: "secret-token", 
    }, checkpointDir);
    const original = await readFile(join(checkpointDir, "github-issue-1.json"), "utf8");
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const port = server.address().port;
    assert.equal((await fetchLocal(port, { token: null })).status, 401);
    assert.equal((await fetchLocal(port, { token: "b".repeat(48) })).status, 401);
    assert.equal((await fetchLocal(port, { host: "evil.example" })).status, 403);
    assert.equal((await fetchLocal(port, { method: "POST" })).status, 405);
    assert.equal((await fetchLocal(port, { method: "OPTIONS" })).status, 405);
    assert.equal((await fetchLocal(port, { path: "/unknown" })).status, 404);
    const result = await fetchLocal(port);
    assert.equal(result.status, 200);
    assert.equal(result.headers["cache-control"], "no-store");
    assert.equal(result.headers["access-control-allow-origin"], undefined);
    assert.equal(result.body.isLive, false);
    assert.deepEqual(result.body.tasks.map(t => [t.id, t.status, t.phase]), [[1, "running", "develop"]]);
    for (const forbidden of ["secret", "private", "apiKey", "directory", "feedback", "worktree", "issue"]) {
      assert.ok(!JSON.stringify(result.body).includes(forbidden), forbidden);
    }
    assert.equal(await readFile(join(checkpointDir, "github-issue-1.json"), "utf8"), original);
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test("missing checkpoint is pending and never claimed to be live", async () => {
  const root = await mkdtemp(join(tmpdir(), "soxu-observer-missing-"));
  try {
    await mkdir(join(root, "tasks", "backlog"), { recursive: true });
    await writeFile(join(root, "tasks", "backlog", "TASK-002.md"), "# Waiting task\n");
    const snapshot = await observerSnapshot(root);
    assert.equal(snapshot.isLive, false);
    assert.deepEqual(snapshot.tasks.map(t => [t.id, t.status, t.phase]), [[2, "pending", null]]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
