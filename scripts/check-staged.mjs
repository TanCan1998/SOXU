#!/usr/bin/env node
/**
 * Fast, staged-content-only pre-commit checks.
 * Intentionally does not run whole-repo pnpm/cargo builds on every Agent commit.
 */
import { execFileSync, spawnSync } from 'node:child_process';

function git(...args) {
  return execFileSync('git', args, { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 });
}

function die(message) {
  console.error(`❌ ${message}`);
  process.exitCode = 1;
}

function main() {
  console.log('SOXU pre-commit：检查暂存区');
  const whitespace = spawnSync('git', ['diff', '--cached', '--check'], { stdio: 'inherit' });
  if (whitespace.status !== 0 || whitespace.error) {
    die('检测到暂存内容的行尾空格、冲突相关空白或 EOF 多余空行');
  }

  const staged = git('diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z')
    .toString('utf8').split('\0').filter(Boolean);
  if (staged.length === 0) {
    console.log('✅ 没有新增或修改的暂存文件');
    return;
  }

  let checked = 0;
  for (const name of staged) {
    const slashName = name.replaceAll('\\', '/');
    const normalized = slashName.toLowerCase();
    // Disallow real dotenv files; documented example/template files are fine.
    if (/(^|\/)\.env(?:\.|$)/i.test(slashName)
        && !/(^|\/)\.env\.(example|sample|template)$/i.test(slashName)) {
      die(`疑似敏感环境配置被暂存：${name}（请只提交 .env.example）`);
      continue;
    }
    if (/(^|\/)(id_rsa|id_ed25519|id_ecdsa|id_dsa)$/i.test(slashName)
      || /\.(pem|p12|pfx|key|keystore)$/i.test(slashName)) {
      die(`疑似私钥/证书文件被暂存：${name}`);
      continue;
    }

    const textFile = /\.(?:mjs|cjs|js|ts|tsx|vue|json|jsonc|md|yaml|yml|toml|rs|html|css|scss|sh|ps1|txt)$/i.test(normalized)
      || /(?:^|\/)(?:dockerfile|\.gitignore|\.gitattributes|\.editorconfig|\.env\.example)$/i.test(normalized);
    if (!textFile) continue;

    let content;
    try {
      content = git('show', `:${name}`);
    } catch (error) {
      die(`无法读取暂存版本：${name}（${error.message}）`);
      continue;
    }
    // This is a fast gate; huge text/lockfiles are left for CI.
    if (content.length > 2 * 1024 * 1024 || content.includes(0)) continue;
    const source = content.toString('utf8');
    checked++;

    if (/^<{7} .+$/m.test(source) && /^={7}$/m.test(source) && /^>{7} .+$/m.test(source)) {
      die(`暂存文件包含 Git 冲突标记：${name}`);
    }
    if (/-----BEGIN (?:[A-Z ]* )?PRIVATE KEY-----/.test(source)
      || /\bghp_[A-Za-z0-9]{20,}\b/.test(source)
      || /\bgithub_pat_[A-Za-z0-9_]{20,}\b/.test(source)) {
      die(`暂存文件中发现疑似私钥或访问令牌：${name}`);
    }

    if (/\.(mjs|cjs)$/i.test(normalized)) {
      const kind = normalized.endsWith('.mjs') ? 'module' : 'commonjs';
      const result = spawnSync(process.execPath, ['--check', `--input-type=${kind}`], {
        input: source,
        encoding: 'utf8',
        timeout: 10_000,
        maxBuffer: 2 * 1024 * 1024,
      });
      if (result.status !== 0 || result.error) {
        die(`Node 语法检查未通过：${name}\n${result.stderr || result.error?.message || ''}`);
      }
    }
  }
  if (process.exitCode !== 1) {
    console.log(`✅ 暂存区检查通过：${staged.length} 个文件，检查 ${checked} 个文本文件`);
  }
}

try {
  main();
} catch (error) {
  console.error(`❌ pre-commit 检查异常：${error.message}`);
  process.exitCode = 2;
}
