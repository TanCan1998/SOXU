import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const APP = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
const TOKEN = "a".repeat(48);
const TOKEN_STORAGE_KEY = "soxu.dashboard.sessionToken.v1";
const STATUS = {
  generatedAt: "2026-10-27T00:00:00.000Z",
  tasks: [], runner: null, lastRun: null, externalLocks: 0,
  busy: false, log: [],
};
const tick = () => new Promise(resolve => setImmediate(resolve));

function response(status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return status === 200 ? STATUS : { error: "unauthorized" }; },
  };
}
function node() {
  const listeners = new Map();
  return {
    value: "", textContent: "", disabled: false, checked: false, dataset: {},
    scrollTop: 0, scrollHeight: 0, clientHeight: 100,
    classList: { add() {}, remove() {}, contains() { return false; } },
    addEventListener(type, fn) { listeners.set(type, fn); },
    dispatch(type, event = {}) { listeners.get(type)?.(event); },
    replaceChildren() {}, append() {},
  };
}
function page({ storage = new Map(), handler = () => response(), hidden = false } = {}) {
  const ids = [
    "token", "connect", "notice", "connection", "dot", "running", "pending", "done",
    "total", "badge", "runner", "updated", "stop", "tasks", "logs", "refresh",
    "logLimit", "logFilter", "followLogs", "logCount", "agentCards",
  ];
  const elements = Object.fromEntries(ids.map(id => [id, node()]));
  const actions = ["once", "resume", "loop", "watch"].map(command => {
    const button = node();
    button.dataset.command = command;
    return button;
  });
  const listeners = new Map();
  const document = {
    hidden,
    getElementById(id) { assert.ok(elements[id], `Unexpected element: ${id}`); return elements[id]; },
    querySelectorAll(selector) { if (selector === ".agent-elapsed") return []; assert.equal(selector, "[data-command]"); return actions; },
    createElement() { return node(); },
    createTextNode(value) { return { textContent: value }; },
    addEventListener(type, fn) { listeners.set(type, fn); },
    dispatch(type) { listeners.get(type)?.(); },
  };
  const requests = [];
  const sessionStorage = {
    getItem(key) { return storage.get(key) ?? null; },
    setItem(key, value) { storage.set(key, String(value)); },
    removeItem(key) { storage.delete(key); },
  };
  runInNewContext(APP, {
    document, sessionStorage, localStorage: { getItem() { return null; }, setItem() {} },
    setInterval() {}, setTimeout() { return 1; }, clearTimeout() {},
    AbortSignal: { timeout() { return undefined; } },
    fetch: async (path, options) => {
      requests.push({ path, options });
      return handler(path, options);
    },
    confirm: () => true,
  }, { filename: "dashboard-app.js" });
  return { elements, actions, document, storage, requests };
}

test("authenticated token survives same-tab reload and reconnects automatically", async () => {
  const storage = new Map();
  const first = page({ storage });
  first.elements.token.value = TOKEN;
  first.elements.connect.dispatch("click");
  await tick();
  assert.equal(first.elements.connection.textContent, "本机已连接");
  assert.equal(storage.get(TOKEN_STORAGE_KEY), TOKEN);

  const reloaded = page({ storage });
  await tick();
  assert.equal(reloaded.elements.token.value, TOKEN);
  assert.equal(reloaded.elements.connection.textContent, "本机已连接");
  const statusRequests = reloaded.requests.filter(x => x.path === "/api/status");
  assert.equal(statusRequests.length, 1);
  assert.equal(statusRequests[0].options.headers["X-SOXU-Control-Token"], TOKEN);
});

test("rejecting a token clears only the matching stored session", async () => {
  const storage = new Map([[TOKEN_STORAGE_KEY, TOKEN]]);
  const reloaded = page({ storage, handler: () => response(401) });
  await tick();
  assert.equal(storage.has(TOKEN_STORAGE_KEY), false);
  assert.equal(reloaded.elements.token.value, "");
  assert.equal(reloaded.elements.connection.textContent, "未连接");
  assert.match(reloaded.elements.notice.textContent, /令牌已失效/);
  assert.ok(reloaded.actions.every(button => button.disabled));

  const incorrect = page({ storage, handler: () => response(401) });
  incorrect.elements.token.value = "b".repeat(48);
  incorrect.elements.connect.dispatch("click");
  await tick();
  assert.equal(storage.has(TOKEN_STORAGE_KEY), false);
});

test("temporary network errors retain the token and allow reconnection", async () => {
  const storage = new Map([[TOKEN_STORAGE_KEY, TOKEN]]);
  let available = false;
  const view = page({ storage, handler: () => {
    if (!available) throw new Error("network-unavailable");
    return response();
  } });
  await tick();
  assert.equal(storage.get(TOKEN_STORAGE_KEY), TOKEN);
  assert.equal(view.elements.connection.textContent, "未连接");
  available = true;
  view.elements.refresh.dispatch("click");
  await tick();
  assert.equal(view.elements.connection.textContent, "本机已连接");
});

test("hidden-page reload restores the token when the page becomes visible", async () => {
  const storage = new Map([[TOKEN_STORAGE_KEY, TOKEN]]);
  const view = page({ storage, hidden: true });
  await tick();
  assert.equal(view.requests.length, 0);
  view.document.hidden = false;
  view.document.dispatch("visibilitychange");
  await tick();
  assert.equal(view.requests.filter(x => x.path === "/api/status").length, 1);
  assert.equal(view.elements.connection.textContent, "本机已连接");
});

test("invalid stored data is discarded without connecting", async () => {
  const storage = new Map([[TOKEN_STORAGE_KEY, "not-a-valid-token"]]);
  const view = page({ storage });
  await tick();
  assert.equal(storage.has(TOKEN_STORAGE_KEY), false);
  assert.equal(view.requests.length, 0);
});

test("an earlier response cannot authenticate a newly edited token", async () => {
  const storage = new Map();
  let release;
  const view = page({ storage, handler: () => new Promise(resolve => { release = resolve; }) });
  view.elements.token.value = TOKEN;
  view.elements.connect.dispatch("click");
  await tick();
  view.elements.token.value = "b".repeat(48);
  view.elements.token.dispatch("input");
  release(response());
  await tick();
  assert.equal(storage.has(TOKEN_STORAGE_KEY), false);
  assert.notEqual(view.elements.connection.textContent, "本机已连接");
});
