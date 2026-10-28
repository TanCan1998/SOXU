//! Pi RPC 冒烟测试的离线可测逻辑与进程封装。
//!
//! 本模块只做两件事：
//! 1. 纯函数：NDJSON 逐条切分、消息历史分析（重复执行检测）。
//! 2. RpcSession：按文档协议驱动真实 pi 的 RPC 子进程的薄封装。
//!
//! 进程所有权全部留在 RpcSession 内：close() 负责关 stdin、等待退出、超时才杀进程树。

import { spawn } from "node:child_process";

/** 冒烟标记：模型回复必须包含它，才说明提示真的走完了一整轮。 */
export const SMOKE_MARKER = "SOXU-SMOKE-OK";

/** 逐条切分 stdout：只按 LF 分帧（去掉可选前缀 CR），不把 U+2028/U+2029 当边界。 */
export function createRecordSplitter() {
  let rest = Buffer.alloc(0);
  return {
    push(chunk) {
      rest = rest.length ? Buffer.concat([rest, chunk]) : chunk;
      const out = [];
      let index = rest.indexOf(0x0a);
      while (index !== -1) {
        const line = rest.subarray(0, index).toString("utf8");
        rest = rest.subarray(index + 1);
        out.push(line.replace(/\r$/, ""));
        index = rest.indexOf(0x0a);
      }
      return out;
    },
    /** 进程退出时可能留下不带换行的最后一条记录。 */
    flush() {
      const tail = rest.toString("utf8").replace(/\r$/, "");
      rest = Buffer.alloc(0);
      return tail.trim() ? [tail] : [];
    },
  };
}

/** 解析单条记录；失败返回 {error}，由调用方决定计入诊断还是失败。 */
export function parseRecord(line) {
  try {
    const value = JSON.parse(line);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { error: "record is not a JSON object" };
    }
    return { value };
  } catch (error) {
    return { error: "invalid JSON: " + error.message.slice(0, 160) };
  }
}

/** 从消息内容里取出纯文本（字符串或内容块数组两种形态都要支持）。 */
export function messageText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

/**
 * P-02 的关键判据：持久化消息不丢、不重复执行。
 * - prompts：每条用户消息出现次数；同一条出现两次即为可疑重放。
 * - markerReplies：包含冒烟标记的助手回复条数，必须恰好 1（重复执行会变多）。
 */
export function analyzeConversation(messages, marker = SMOKE_MARKER) {
  const list = Array.isArray(messages) ? messages : [];
  const prompts = new Map();
  const assistantTexts = [];
  let markerReplies = 0;
  let userMessages = 0;
  for (const message of list) {
    const text = messageText(message).trim();
    if (message?.role === "user") {
      userMessages += 1;
      if (text) prompts.set(text, (prompts.get(text) ?? 0) + 1);
    } else if (message?.role === "assistant") {
      if (text) assistantTexts.push(text);
      if (text.includes(marker)) markerReplies += 1;
    }
  }
  const duplicates = [...prompts.entries()]
    .filter(([, count]) => count > 1)
    .map(([text]) => text.slice(0, 120));
  return {
    total: list.length,
    userMessages,
    assistantMessages: assistantTexts.length,
    distinctPrompts: prompts.size,
    markerReplies,
    duplicatePrompts: duplicates,
    lastAssistantText: assistantTexts.at(-1) ?? "",
  };
}

/** 有界等待：超时抛出可读错误，不无限挂起。 */
export function waitFor(predicate, { timeoutMs, label, intervalMs = 25 } = {}) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + (timeoutMs ?? 30_000);
    const tick = () => {
      let value;
      try {
        value = predicate();
      } catch (error) {
        reject(error);
        return;
      }
      if (value) {
        resolve(value);
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error("timed out after " + timeoutMs + "ms waiting for " + label));
        return;
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

/**
 * 单个 pi RPC 运行时的观察与命令入口。
 * 事件与 response 都按协议记录分类；response 用 id 关联，不看到达顺序。
 */
export class RpcSession {
  #child;
  #splitter = createRecordSplitter();
  #pending = new Map();
  #waiters = new Set();
  #stderr = "";
  #exited = null;

  constructor({ command, args, cwd, env, onRecord } = {}) {
    this.command = command ?? "pi";
    this.args = args ?? [];
    this.cwd = cwd;
    this.env = env ?? process.env;
    this.onRecord = onRecord;
    this.records = [];
    this.counts = Object.create(null);
    this.parseErrors = [];
    this.exit = null;
  }

  get pid() {
    return this.#child?.pid ?? null;
  }

  get stderrTail() {
    return this.#stderr.slice(-2000);
  }

  start() {
    this.#child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child.stdout.on("data", (chunk) => {
      for (const line of this.#splitter.push(chunk)) this.#ingest(line);
    });
    this.#child.stderr.on("data", (chunk) => {
      this.#stderr = (this.#stderr + chunk.toString("utf8")).slice(-20_000);
    });
    this.#exited = new Promise((resolve) => {
      this.#child.on("close", (code, signal) => {
        for (const line of this.#splitter.flush()) this.#ingest(line);
        this.exit = { code, signal };
        this.#failPending("pi exited before responding (code=" + code + ", signal=" + signal + ")");
        resolve(this.exit);
      });
      this.#child.on("error", (error) => {
        this.exit = { code: null, signal: null, error: error.message };
        this.#failPending("pi spawn failed: " + error.message);
        resolve(this.exit);
      });
    });
    return this;
  }

  #ingest(line) {
    if (!line.trim()) return;
    const parsed = parseRecord(line);
    if (parsed.error) {
      this.parseErrors.push(parsed.error);
      return;
    }
    const record = parsed.value;
    // 有界保留：完整事件流可能很大，不能整段落进内存或报告。
    this.records.push(record);
    if (this.records.length > 5000) this.records.splice(0, this.records.length - 5000);
    // Pi RPC 1.4 的线上格式：事件本身就是 {type:"agent_settled", ...}，
    // 只有命令回执是 {type:"response", id, ...}；不存在 {type:"event", event:"..."} 包装。
    const kind = typeof record.type === "string" ? record.type : "unknown";
    const key = kind === "response" ? "response" : "event:" + kind;
    this.counts[key] = (this.counts[key] ?? 0) + 1;
    this.onRecord?.(record);
    if (record.type === "response" && typeof record.id === "string") {
      const pending = this.#pending.get(record.id);
      if (pending) {
        this.#pending.delete(record.id);
        pending.resolve(record);
      }
    }
    for (const waiter of [...this.#waiters]) {
      if (waiter.match(record)) {
        this.#waiters.delete(waiter);
        waiter.resolve(record);
      }
    }
  }

  #failPending(reason) {
    for (const [id, pending] of [...this.#pending]) {
      this.#pending.delete(id);
      pending.reject(new Error(reason));
    }
    for (const waiter of [...this.#waiters]) {
      this.#waiters.delete(waiter);
      waiter.reject(new Error(reason));
    }
  }

  /** 发送一条命令（JSON + LF）。stdin 关闭或已退出时立刻失败，不静默丢命令。 */
  send(command) {
    if (this.exit) throw new Error("cannot send " + command.type + ": pi already exited");
    if (!this.#child?.stdin.writable) throw new Error("cannot send " + command.type + ": stdin is not writable");
    this.#child.stdin.write(JSON.stringify(command) + "\n");
  }

  /** 发命令并按 id 等 response；超时只报告，不自动重试（不产生重复付费请求）。 */
  request(command, { timeoutMs = 30_000 } = {}) {
    const id = command.id;
    if (!id) throw new Error("command needs an id for correlation");
    const response = new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    this.send(command);
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error("no response for " + command.type + " (id=" + id + ") within " + timeoutMs + "ms"));
      }, timeoutMs);
    });
    return Promise.race([response, timeout]).finally(() => clearTimeout(timer));
  }

  /** 等某个 session 事件（例如 agent_settled）。 */
  waitEvent(name, { timeoutMs = 120_000 } = {}) {
    return new Promise((resolve, reject) => {
      const waiter = {
        match: (record) => record.type === name,
        resolve: (record) => {
          clearTimeout(timer);
          resolve(record);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      const timer = setTimeout(() => {
        this.#waiters.delete(waiter);
        reject(new Error("timed out after " + timeoutMs + "ms waiting for event " + name));
      }, timeoutMs);
      this.#waiters.add(waiter);
    });
  }

  /** 有序关闭：先关 stdin 请求 Pi 自行析构，超时才结束进程树。 */
  async close({ graceMs = 8_000 } = {}) {
    if (!this.#child) return { code: null, signal: null, forced: false };
    if (this.exit) return { ...this.exit, forced: false };
    try {
      this.#child.stdin.end();
    } catch {
      // stdin 已关闭；继续等待退出。
    }
    const graceful = await Promise.race([
      this.#exited.then((exit) => ({ ...exit, forced: false })),
      new Promise((resolve) => setTimeout(() => resolve(null), graceMs)),
    ]);
    if (graceful) return graceful;
    const pid = this.#child.pid;
    if (pid && process.platform === "win32") {
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).unref();
    } else if (pid) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // 进程已退出。
      }
    }
    const exit = await this.#exited;
    return { ...exit, forced: true };
  }
}
