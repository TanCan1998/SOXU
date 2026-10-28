//! 开发调度器的重试预算护栏（TASK-007 / Issue #37）。
//!
//! 产品运行时（crates/agent-runtime）有一套有界自动重试，调度器没有：
//! policy.json 的 recovery.automaticApiRetries 必须保持 0，
//! maxRetries（检查修复次数上限）必须留在安全范围内。
//! 这些断言是**离线**的：只读本地 policy.json，不联网、不调用模型。

import test from "node:test";
import assert from "node:assert/strict";

import { policy } from "../lib/config.mjs";

test("调度器保持零自动 API 重试，与产品运行时的有界重试不冲突", async () => {
  const value = await policy();
  assert.equal(value.recovery.automaticApiRetries, 0);
  assert.equal(value.recovery.preserveWorktree, true);
  assert.equal(value.recovery.manualOnQuota, true);
  assert.equal(value.recovery.manualOnNetwork, true);
  assert.equal(value.recovery.manualOnTimeout, true);
});

test("检查修复次数上限仍在安全范围，恢复入口不能把它调成无限", async () => {
  const value = await policy();
  assert.ok(Number.isSafeInteger(value.maxRetries));
  assert.ok(
    value.maxRetries >= 0 && value.maxRetries <= 3,
    "maxRetries 超出安全范围: " + value.maxRetries,
  );
  // 单轮调用与任务数同样有界，避免「重试上限很小但循环次数无限」。
  assert.ok(value.maxRoundsPerInvocation <= 50);
  assert.ok(value.maxIssuesPerWatch <= 50);
});

test("网络与超时预算有下界，网络故障不会退化成无限等待", async () => {
  const value = await policy();
  const timeouts = value.timeouts;
  assert.ok(timeouts.networkSeconds >= 10 && timeouts.networkSeconds <= 120);
  assert.ok(timeouts.piStartupSeconds >= 10 && timeouts.piStartupSeconds <= 300);
  assert.ok(timeouts.piIdleSeconds >= 30 && timeouts.piIdleSeconds <= 900);
  assert.ok(timeouts.piHardMinutes * 60 > timeouts.piIdleSeconds);
});

test("重试不会顺带触发发布：自动发布关闭，自动合并只能落集成分支", async () => {
  const value = await policy();
  // 自动合并在 #77 之后默认开启，只允许把 agent 的 PR 合进集成分支；
  // 重试复用同一 PR，不会因此多创建 PR 或写入发布分支。
  assert.equal(value.autoRelease, false);
  assert.equal(value.releaseChannel, "prerelease");
  assert.equal(value.releaseBranch, "main");
  assert.notEqual(
    value.integrationBranch,
    value.releaseBranch,
    "自动合并目标不能是发布分支",
  );
});
