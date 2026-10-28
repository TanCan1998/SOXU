//! agent:doctor 的离线测试（Issue #41）。
//!
//! 只测纯逻辑：版本解析与比较、基线匹配、锁文件与工具链文件判定。
//! 不启动子进程、不联网，因此可以随 pnpm check 一起跑。

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  APPROVED_TOOLCHAIN,
  assessLockfiles,
  assessRustToolchain,
  assessToolchain,
  buildReport,
  compareVersions,
  matchesSpec,
  parseLowerBound,
  parseVersion,
  renderText,
  summarize,
} from "../lib/agent-doctor.mjs";

const goodProbes = {
  node: { ok: true, raw: "v26.10.0" },
  pnpm: { ok: true, raw: "12.15.0" },
  rustc: { ok: true, raw: "rustc 1.99.1 (58cf8f9c3 2026-10-13)" },
  cargo: { ok: true, raw: "cargo 1.99.1 (5f94df478 2026-08-27)" },
  pi: { ok: true, raw: "1.4.0" },
};

test("从真实版本的输出格式里取出 semver", () => {
  assert.deepEqual(parseVersion("v26.10.0"), { major: 26, minor: 10, patch: 0 });
  assert.deepEqual(parseVersion("rustc 1.99.1 (58cf8f9c3 2026-10-13)"), { major: 1, minor: 99, patch: 1 });
  assert.deepEqual(parseVersion("cargo 1.99.1 (5f94df478 2026-08-27)"), { major: 1, minor: 99, patch: 1 });
  assert.equal(parseVersion("no version here"), null);
  assert.equal(parseVersion(undefined), null);
});

test("版本比较按 主.次.补 逐段比较", () => {
  assert.ok(compareVersions({ major: 26, minor: 10, patch: 0 }, { major: 24, minor: 0, patch: 0 }) > 0);
  assert.ok(compareVersions({ major: 12, minor: 15, patch: 0 }, { major: 12, minor: 15, patch: 0 }) === 0);
  assert.ok(compareVersions({ major: 1, minor: 99, patch: 0 }, { major: 1, minor: 99, patch: 1 }) < 0);
});

test("下界允许只写主版本，未知写法一律不通过", () => {
  assert.deepEqual(parseLowerBound("24"), { major: 24, minor: 0, patch: 0 });
  assert.deepEqual(parseLowerBound("12.15"), { major: 12, minor: 15, patch: 0 });
  assert.equal(parseLowerBound("latest"), null);

  assert.equal(matchesSpec(parseVersion("v26.10.0"), ">=24"), true);
  assert.equal(matchesSpec(parseVersion("v22.19.0"), ">=24"), false);
  assert.equal(matchesSpec(parseVersion("12.15.0"), "12.15.0"), true);
  assert.equal(matchesSpec(parseVersion("12.16.0"), "12.15.0"), false);
  assert.equal(matchesSpec(parseVersion("12.15.0"), "latest"), false);
  assert.equal(matchesSpec(null, "12.15.0"), false);
});

test("全部符合基线时没有任何失败项", () => {
  const checks = assessToolchain(goodProbes);
  assert.equal(checks.length, Object.keys(APPROVED_TOOLCHAIN).length);
  assert.deepEqual(checks.filter((item) => item.status === "fail"), []);
});

test("版本漂移与探测失败都记为失败，并带出实际值", () => {
  const drifted = assessToolchain({ ...goodProbes, node: { ok: true, raw: "v22.19.0" } });
  const nodeCheck = drifted.find((item) => item.id === "tool:node");
  assert.equal(nodeCheck.status, "fail");
  assert.match(nodeCheck.detail, /22\.19\.0/);

  const missing = assessToolchain({ ...goodProbes, pi: { ok: false, raw: "", error: "无法启动 pi: ENOENT" } });
  const piCheck = missing.find((item) => item.id === "tool:pi");
  assert.equal(piCheck.status, "fail");
  assert.match(piCheck.detail, /ENOENT/);

  const garbage = assessToolchain({ ...goodProbes, pnpm: { ok: true, raw: "(not a version)" } });
  assert.equal(garbage.find((item) => item.id === "tool:pnpm").status, "fail");
});

test("锁文件缺失、过小或不可读都不能算通过", () => {
  const ok = assessLockfiles([
    { path: "pnpm-lock.yaml", label: "pnpm 锁文件", minBytes: 1024, exists: true, bytes: 64826 },
    { path: "Cargo.lock", label: "Cargo 锁文件", minBytes: 1024, exists: true, bytes: 105170 },
  ]);
  assert.deepEqual(ok.filter((item) => item.status === "fail"), []);

  const bad = assessLockfiles([
    { path: "pnpm-lock.yaml", label: "pnpm 锁文件", minBytes: 1024, exists: false, bytes: 0 },
    { path: "Cargo.lock", label: "Cargo 锁文件", minBytes: 1024, exists: true, bytes: 12 },
    { path: "rust-toolchain.toml", label: "Rust 工具链文件", minBytes: 0, exists: false, bytes: 0, error: "EACCES" },
  ]);
  assert.equal(bad.filter((item) => item.status === "fail").length, 3);
});

test("rust-toolchain.toml 的 channel 必须等于批准版本", () => {
  assert.equal(assessRustToolchain("[toolchain]\nchannel = \"1.99.1\"\n")[0].status, "pass");
  assert.equal(assessRustToolchain("[toolchain]\nchannel = \"1.98.0\"\n")[0].status, "fail");
  assert.equal(assessRustToolchain("[toolchain]\ncomponents = []\n")[0].status, "fail");
  assert.equal(assessRustToolchain(null)[0].status, "fail");
});

test("CLI 接受 pnpm 透传的 --，--help 不探测环境", () => {
  const cli = fileURLToPath(new URL("../agent-doctor.mjs", import.meta.url));
  for (const args of [["--help"], ["--", "--help"]]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", timeout: 20_000 });
    assert.equal(result.status, 0, "退出码应为 0，实际 " + result.status);
    assert.match(result.stdout, /用法: node scripts\/agent-doctor\.mjs/);
  }
});

test("报告结论与文本渲染来自同一份事实", () => {
  const report = buildReport({
    platform: "win32",
    probes: goodProbes,
    files: [
      { path: "pnpm-lock.yaml", label: "pnpm 锁文件", minBytes: 1024, exists: true, bytes: 64826 },
      { path: "Cargo.lock", label: "Cargo 锁文件", minBytes: 1024, exists: true, bytes: 105170 },
    ],
    toolchainText: "[toolchain]\nchannel = \"1.99.1\"\n",
    generatedAt: "2026-10-30T00:00:00.000Z",
  });
  assert.equal(report.verdict, "pass");
  assert.deepEqual(report.summary, summarize(report.checks));
  assert.equal(report.summary.failed, 0);

  const text = renderText(report);
  assert.match(text, /结论: pass/);
  assert.match(text, /tool:node/);

  const failing = buildReport({
    platform: "win32",
    probes: { ...goodProbes, pnpm: { ok: true, raw: "12.14.0" } },
    files: [],
    toolchainText: "[toolchain]\nchannel = \"1.99.1\"\n",
  });
  assert.equal(failing.verdict, "fail");
  assert.match(renderText(failing), /结论: fail/);
});
