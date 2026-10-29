//! 提交门禁的离线回归（PRD P-08 / Issue #40）：疑似密钥不得进入暂存区。
//!
//! 直接运行真实的 `.githooks/pre-commit` 所调用的 `scripts/check-staged.mjs`，
//! 在一个一次性临时仓库里暂存各种"像密钥"的内容，断言门禁确实拦得住，
//! 并且普通文本照常通过——既不假绿，也不误伤。
//!
//! 注意：本文件里的假密钥一律在运行时拼出来，源码中不出现形似密钥的连续字面量，
//! 否则门禁会拦住它自己的测试。

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const GATE = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'check-staged.mjs');

/** 运行时拼接的假凭据，避免把字面量写进仓库。 */
const FAKE_GITHUB_TOKEN = ['ghp', '_', 'A'.repeat(32)].join('');
const FAKE_PAT = ['github_pat', '_', 'B'.repeat(24)].join('');
const FAKE_PRIVATE_KEY = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'soxu-secret-gate-'));
  git(dir, 'init', '-b', 'main', '.');
  git(dir, 'config', 'user.name', 'SOXU Test');
  git(dir, 'config', 'user.email', 'soxu-test@example.invalid');
  // 不让全局 autocrlf 设置把噪声写进测试输出。
  git(dir, 'config', 'core.autocrlf', 'false');
  git(dir, 'config', 'core.safecrlf', 'false');
  return dir;
}

/** 写入并暂存一个文件；返回门禁进程的结果。 */
function stageAndRunGate(dir, relativePath, content) {
  const target = join(dir, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  git(dir, 'add', '--', relativePath);
  return runGate(dir);
}

function runGate(dir) {
  return spawnSync(process.execPath, [GATE], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 60_000,
  });
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

test('暂存疑似 GitHub 令牌时提交被拒绝', () => {
  const dir = sandbox();
  try {
    const result = stageAndRunGate(dir, 'src/config.ts', `export const token = "${FAKE_GITHUB_TOKEN}";\n`);
    assert.equal(result.status, 1, `门禁必须阻止提交：${result.stdout}${result.stderr}`);
    assert.match(result.stdout + result.stderr, /令牌|私钥/);
  } finally {
    cleanup(dir);
  }
});

test('暂存 fine-grained PAT 时提交被拒绝', () => {
  const dir = sandbox();
  try {
    const result = stageAndRunGate(dir, 'notes.md', `token: ${FAKE_PAT}\n`);
    assert.equal(result.status, 1);
    assert.match(result.stdout + result.stderr, /令牌/);
  } finally {
    cleanup(dir);
  }
});

test('暂存私钥文件时提交被拒绝', () => {
  const dir = sandbox();
  try {
    const result = stageAndRunGate(dir, 'keys/deploy.pem', `${FAKE_PRIVATE_KEY}\nAAAA\n`);
    assert.equal(result.status, 1);
    assert.match(result.stdout + result.stderr, /私钥|证书/);
  } finally {
    cleanup(dir);
  }
});

test('暂存真实 .env 与 id_rsa 时提交被拒绝', () => {
  const dir = sandbox();
  try {
    const env = stageAndRunGate(dir, '.env', 'API_KEY=placeholder\n');
    assert.equal(env.status, 1, '.env 必须被拦下');
    assert.match(env.stdout + env.stderr, /敏感环境配置/);

    const key = stageAndRunGate(dir, 'id_rsa', 'placeholder\n');
    assert.equal(key.status, 1, 'id_rsa 必须被拦下');
    assert.match(key.stdout + key.stderr, /私钥|证书/);
  } finally {
    cleanup(dir);
  }
});

test('暂存普通文本时门禁放行且不误报', () => {
  const dir = sandbox();
  try {
    // 文档模板是被允许的例外：只拦真实 .env。
    writeFileSync(join(dir, '.env.example'), 'API_KEY=\n');
    git(dir, 'add', '--', '.env.example');
    const template = runGate(dir);
    assert.equal(
      template.status,
      0,
      `示例文件必须放行：${template.stdout}${template.stderr}`,
    );

    const clean = stageAndRunGate(dir, 'docs/readme.md', '这是一段普通文档。\n');
    assert.equal(clean.status, 0, `普通文本必须放行：${clean.stdout}${clean.stderr}`);
  } finally {
    cleanup(dir);
  }
});
