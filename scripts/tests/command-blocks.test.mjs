//! lib.rs 领域占位块门禁的离线回归（Issue #112）。
//!
//! 直接驱动真实的 `scripts/check-command-blocks.mjs`：既验证当前仓库通过，
//! 也验证每一种违规写法都会被拦住并指出「哪一行、在哪个块、应该属于哪个块」。
//! 夹具全部是内存字符串或一次性临时目录，不依赖网络，也不改仓库文件。

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DOMAIN_ORDER,
  V4_DOMAINS,
  checkCommandBlocks,
  checkRepository,
  parseCommandOwners,
  parseHandlerBlocks,
} from '../check-command-blocks.mjs';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'check-command-blocks.mjs');
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 构造 lib.rs 里 generate_handler! 的最小片段。 */
function libSource(blocks) {
  const lines = [
    'pub fn run() {',
    '    tauri::Builder::default()',
    '        .invoke_handler(tauri::generate_handler![',
  ];
  for (const [domain, entries] of blocks) {
    lines.push('            // ── ' + domain + ' ──');
    for (const entry of entries) lines.push('            ' + entry + ',');
  }
  lines.push('        ])');
  lines.push('}');
  return lines.join('\n');
}

/** 每个领域块都按固定顺序给出（默认空），便于只覆盖被测试的那一块。 */
function blocksWith(overrides) {
  return DOMAIN_ORDER.map((domain) => [domain, overrides[domain] ?? []]);
}

/** 造一个只声明了给定 command 的 commands/*.rs 源。 */
function ownersFrom(spec) {
  const files = Object.entries(spec).map(([domain, names]) => ({
    path: 'apps/desktop/src-tauri/src/commands/' + domain + '.rs',
    source: names
      .map((name) => '#[tauri::command]\npub async fn ' + name + '() -> Result<(), String> {\n    Ok(())\n}\n')
      .join('\n'),
  }));
  return parseCommandOwners(files);
}

/** 便捷：用同一份 spec 同时生成 lib.rs 与 owners，再跑检查。 */
function check(spec, mutate) {
  const blocks = blocksWith(Object.fromEntries(
    Object.entries(spec).map(([domain, names]) => [domain, names.map((name) => 'commands::' + name)]),
  ));
  const source = libSource(mutate ? mutate(blocks) : blocks);
  return checkCommandBlocks({ libSource: source, commandOwners: ownersFrom(spec) });
}

function messages(result) {
  return result.violations.map((violation) => 'L' + violation.line + ' ' + violation.message).join('\n');
}

test('当前仓库的 lib.rs 通过领域块检查', () => {
  const result = checkRepository(REPO_ROOT);
  assert.deepEqual(result.violations, [], messages(result));
  assert.equal(result.blockCount, DOMAIN_ORDER.length);
  assert.ok(result.entryCount >= 24, '既有 command 必须全部注册：' + result.entryCount);
});

test('九个 V4 领域占位块按固定顺序预置且可以为空', () => {
  const { blocks } = parseHandlerBlocks(
    libSource(blocksWith({})),
  );
  assert.deepEqual(blocks.map((block) => block.domain), [...DOMAIN_ORDER]);
  const v4 = blocks.filter((block) => V4_DOMAINS.includes(block.domain));
  assert.equal(v4.length, 9);
  for (const block of v4) assert.deepEqual(block.entries, [], block.domain);
});

test('落错块时报出所在块与应属块', () => {
  const result = check({ session: ['start_session'], history: ['search_session'] }, (blocks) => {
    for (const block of blocks) {
      if (block[0] === 'files') block[1].push('commands::search_session');
    }
    return blocks;
  });
  const text = messages(result);
  assert.match(text, /在块「files」内，应属于「history」块/);
});

test('领域块顺序被重排时被拒绝', () => {
  const reordered = blocksWith({});
  const files = reordered.findIndex(([domain]) => domain === 'files');
  const git = reordered.findIndex(([domain]) => domain === 'git');
  const [moved] = reordered.splice(git, 1);
  reordered.splice(files, 0, moved);
  const result = checkCommandBlocks({
    libSource: libSource(reordered),
    commandOwners: ownersFrom({}),
  });
  assert.match(messages(result), /领域块顺序错误/);
});

test('块内不按字母序时被拒绝', () => {
  const result = check({ session: ['start_session', 'cancel_session'] });
  assert.match(messages(result), /破坏了块「session」的字母序/);
});

test('预置块被删除时被拒绝', () => {
  const blocks = blocksWith({}).filter(([domain]) => domain !== 'notify');
  const result = checkCommandBlocks({ libSource: libSource(blocks), commandOwners: ownersFrom({}) });
  assert.match(messages(result), /缺少领域块「notify」/);
});

test('重复注册与未定义 command 都被拒绝', () => {
  const result = check({ session: ['start_session'] }, (blocks) => {
    for (const block of blocks) {
      if (block[0] === 'session') block[1].push('commands::start_session', 'commands::ghost');
    }
    return blocks;
  });
  const text = messages(result);
  assert.match(text, /重复注册/);
  assert.match(text, /找不到带 #\[tauri::command\] 的同名函数/);
});

test('定义了但没注册的 command 被拒绝', () => {
  const result = check({ session: ['start_session', 'stop_session'] }, (blocks) => {
    for (const block of blocks) {
      if (block[0] === 'session') block[1] = ['commands::start_session'];
    }
    return blocks;
  });
  assert.match(messages(result), /command stop_session 未注册到 lib.rs 的「session」块/);
});

test('嵌套路径 commands::files::list_dir 落在 files 块内可通过', () => {
  const blocks = blocksWith({ files: ['commands::files::list_dir'] });
  const result = checkCommandBlocks({ libSource: libSource(blocks), commandOwners: ownersFrom({}) });
  assert.deepEqual(result.violations, [], messages(result));
});

test('无法解析的行与未闭合的列表被拒绝', () => {
  const broken = [
    'fn run() {',
    '    .invoke_handler(tauri::generate_handler![',
    '        commands::start_session,',
    '    ])',
    '}',
  ].join('\n');
  const result = checkCommandBlocks({ libSource: broken, commandOwners: ownersFrom({}) });
  assert.match(messages(result), /出现在第一个领域块之前/);
});

test('CLI 在违规仓库上以退出码 1 失败并指出块名', () => {
  const dir = mkdtempSync(join(tmpdir(), 'soxu-command-blocks-'));
  try {
    const srcDir = join(dir, 'apps', 'desktop', 'src-tauri', 'src');
    mkdirSync(join(srcDir, 'commands'), { recursive: true });
    const blocks = blocksWith({ session: ['commands::start_session'] });
    for (const block of blocks) {
      if (block[0] === 'worktree') block[1].push('commands::start_session');
    }
    writeFileSync(join(srcDir, 'lib.rs'), libSource(blocks));
    writeFileSync(
      join(srcDir, 'commands', 'session.rs'),
      '#[tauri::command]\npub async fn start_session() -> Result<(), String> {\n    Ok(())\n}\n',
    );

    const result = spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8', timeout: 60_000 });
    assert.equal(result.status, 1, '违规仓库必须失败：' + result.stdout + result.stderr);
    assert.match(result.stderr, /应属于「session」块/);
    assert.match(result.stderr, /docs\/development\/command-blocks\.md/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
