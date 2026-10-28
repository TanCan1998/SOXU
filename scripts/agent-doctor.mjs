#!/usr/bin/env node
//! SOXU agent:doctor —— 本机开发环境与批准基线的对照检查。
//!
//! 只读、离线：不安装依赖、不联网、不写锁文件、不调用模型。
//! 退出码：0 = 全部通过；1 = 有失败项；2 = 用法或读取错误。
//!
//! 用法:
//!   node scripts/agent-doctor.mjs
//!   node scripts/agent-doctor.mjs --json
//!   node scripts/agent-doctor.mjs --json --out evidence/doctor.json

import { readFile, stat, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { commandPlan } from "./lib/command-plan.mjs";
import { redactHome } from "./lib/redact.mjs";
import {
  REQUIRED_FILES,
  buildReport,
  renderText,
} from "./lib/agent-doctor.mjs";
import { ROOT } from "./lib/config.mjs";

const USAGE = [
  "用法: node scripts/agent-doctor.mjs [--json] [--out <path>] [--help]",
  "",
  "只读核对：node/pnpm/rustc/cargo/pi 版本、pnpm-lock.yaml 与 Cargo.lock、rust-toolchain.toml。",
  "退出码: 0 全部通过；1 有失败项；2 用法/读取错误。",
].join("\n");

function parseArgs(argv) {
  const options = { json: false, out: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    // pnpm/npm 会原样透传 "--"，用户按习惯写 pnpm agent:doctor -- --json 时也要能用。
    if (arg === "--") continue;
    else if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--out") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--out 缺少文件路径");
      options.out = value;
      index += 1;
    } else throw new Error("未知参数: " + arg);
  }
  return options;
}

/** 跑一条只读版本命令：超时或失败都记为探测失败，不重试、不猜测。 */
function probe(bin, args, timeoutMs = 20_000) {
  return new Promise((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const plan = commandPlan(bin, args);
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(value);
    };
    let child;
    try {
      child = spawn(plan.command, plan.args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      finish({ ok: false, raw: "", error: "无法启动 " + bin + ": " + error.message });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // 进程已退出。
      }
      finish({ ok: false, raw: stdout, error: bin + " " + args.join(" ") + " 超过 " + timeoutMs + "ms 无响应" });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => finish({ ok: false, raw: stdout, error: "无法启动 " + bin + ": " + error.message }));
    child.on("close", (code) => {
      const first = stdout.trim().split(/\r?\n/)[0] ?? "";
      if (code !== 0 || !first) {
        finish({ ok: false, raw: stdout, error: bin + " 退出码 " + code + (stderr.trim() ? ": " + stderr.trim().slice(0, 200) : "") });
      } else {
        finish({ ok: true, raw: first, error: null });
      }
    });
  });
}

async function inspectFile(entry) {
  const path = resolve(ROOT, entry.path);
  try {
    const info = await stat(path);
    return { ...entry, exists: true, bytes: info.size, error: null };
  } catch (error) {
    if (error.code === "ENOENT") return { ...entry, exists: false, bytes: 0, error: null };
    return { ...entry, exists: false, bytes: 0, error: entry.label + " 无法读取: " + error.code };
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  const [pnpm, rustc, cargo, pi] = await Promise.all([
    probe("pnpm", ["--version"]),
    probe("rustc", ["--version"]),
    probe("cargo", ["--version"]),
    probe("pi", ["--version"]),
  ]);

  let toolchainText = null;
  let toolchainError = null;
  try {
    toolchainText = await readFile(resolve(ROOT, "rust-toolchain.toml"), "utf8");
  } catch (error) {
    toolchainError = "rust-toolchain.toml 无法读取: " + error.code;
  }
  if (toolchainError) toolchainText = null;

  const files = await Promise.all(REQUIRED_FILES.map(inspectFile));
  if (toolchainError) files.push({ path: "rust-toolchain.toml", label: "Rust 工具链文件", minBytes: 0, exists: false, bytes: 0, error: toolchainError });

  const report = buildReport({
    platform: process.platform,
    probes: {
      node: { ok: true, raw: process.version, execPath: process.execPath },
      pnpm,
      rustc,
      cargo,
      pi,
    },
    files,
    toolchainText,
  });
  report.environment = {
    arch: process.arch,
    cwd: process.cwd(),
    nodeExecPath: process.execPath,
  };

  const json = JSON.stringify(redactHome(report), null, 2);
  if (options.out) {
    const target = resolve(process.cwd(), options.out);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, json + "\n", "utf8");
  }
  console.log(options.json ? json : renderText(report));
  return report.verdict === "pass" ? 0 : 1;
}

main().then((code) => {
  process.exitCode = code;
}).catch((error) => {
  console.error("agent:doctor 无法执行: " + error.message);
  console.error(USAGE);
  process.exitCode = 2;
});
