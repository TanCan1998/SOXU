#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
for (const hook of ['pre-commit', 'commit-msg']) {
  const path = resolve(root, '.githooks', hook);
  if (!existsSync(path)) throw new Error(`缺少 Git hook：${path}`);
  if (process.platform !== 'win32') chmodSync(path, 0o755);
}
execFileSync('git', ['config', '--local', 'core.hooksPath', '.githooks'], { cwd: root });
console.log(`✅ 已启用 SOXU Git hooks：${root}/.githooks`);
console.log('   git config --local --get core.hooksPath');
