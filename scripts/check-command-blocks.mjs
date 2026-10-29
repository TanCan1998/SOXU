#!/usr/bin/env node
/**
 * 校验 lib.rs 中 tauri::generate_handler![...] 的「领域占位块」（Issue #112）。
 *
 * 背景：所有新 command 曾经都追加在同一个锚点（最后一条注册之后），
 * 并行切片必然在 lib.rs 撞车。现在改为按领域预置注释块，
 * 每个切片只在自己的块内追加；本脚本把这条约定变成机器可校验的门禁：
 *
 * 1. 解析 lib.rs 的块结构（按 `// ── 领域名 ──` 注释切分）；
 * 2. 断言每条 `模块::command` 落在与其所属模块名一致的块内；
 * 3. 断言领域块顺序与固定列表一致（防止重排导致后续 diff 全乱）；
 * 4. 断言块内条目按字母序排列（减少无意义 diff）；
 * 5. 断言 src/commands/ 下的每个 #[tauri::command] 都已注册（搬位置时不会漏）。
 *
 * 用法：node scripts/check-command-blocks.mjs
 * 规则文档：docs/development/command-blocks.md
 */
import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 已经存在内容的领域块，顺序同样固定。 */
export const LEGACY_DOMAINS = Object.freeze(['session', 'workspace', 'worktree', 'history']);

/** V4 预置的空占位块，顺序固定（与 docs/development/command-blocks.md 一致）。 */
export const V4_DOMAINS = Object.freeze([
  'files',
  'git',
  'pty',
  'model',
  'stats',
  'outline',
  'extension',
  'notify',
  'search',
]);

/** 领域块的固定顺序：先已有领域，再 V4 占位块。 */
export const DOMAIN_ORDER = Object.freeze([...LEGACY_DOMAINS, ...V4_DOMAINS]);

/** `// ── session ──` 与 `// ── files（V4：新 command 只加在本行下方）──` 都能解析。 */
const BLOCK_HEADER = /^\/\/\s*──\s*([a-z][a-z0-9_-]*)\s*(?:（[^）]*）)?\s*──$/u;
/** 注册条目：`commands::name,` 或 `commands::files::name,`。 */
const ENTRY = /^([A-Za-z0-9_]+(?:::[A-Za-z0-9_]+)+)\s*,$/u;

/**
 * 解析 generate_handler! 列表。
 *
 * @param {string} source lib.rs 全文
 * @returns {{blocks: Array<{domain: string, line: number, entries: Array<{path: string, name: string, line: number}>}>, startLine: number, violations: Array<{line: number, message: string}>}}
 */
export function parseHandlerBlocks(source) {
  const lines = source.split(/\r?\n/u);
  const violations = [];
  const start = lines.findIndex((line) => line.includes('generate_handler!['));
  if (start === -1) {
    return {
      blocks: [],
      startLine: 1,
      violations: [{ line: 1, message: '未找到 tauri::generate_handler![ 列表' }],
    };
  }

  const blocks = [];
  let current = null;
  let closed = false;
  for (let index = start + 1; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (trimmed.startsWith(']')) {
      closed = true;
      break;
    }
    if (trimmed === '') continue;

    const header = BLOCK_HEADER.exec(trimmed);
    if (header) {
      current = { domain: header[1], line: index + 1, entries: [] };
      blocks.push(current);
      continue;
    }
    // 块内允许额外说明注释，但不能当注册条目。
    if (trimmed.startsWith('//')) continue;

    const entry = ENTRY.exec(trimmed);
    if (!entry) {
      violations.push({
        line: index + 1,
        message: '无法解析的行 ' + JSON.stringify(trimmed)
          + '：只允许「// ── 领域名 ──」注释或「commands::name,」注册条目',
      });
      continue;
    }
    const path = entry[1];
    if (!current) {
      violations.push({
        line: index + 1,
        message: path + ' 出现在第一个领域块之前：必须放进对应领域块内',
      });
      continue;
    }
    current.entries.push({ path, name: path.split('::').pop(), line: index + 1 });
  }

  if (!closed) {
    violations.push({ line: start + 1, message: 'generate_handler! 列表没有闭合的 ]）' });
  }

  return { blocks, startLine: start + 1, violations };
}

/**
 * 扫描 src/commands/*.rs，建立 command 名 → 所属领域模块的映射。
 *
 * @param {Array<{path: string, source: string}>} files
 * @returns {Map<string, {domain: string, file: string, line: number}>}
 */
export function parseCommandOwners(files) {
  const owners = new Map();
  for (const { path, source } of files) {
    const domain = basename(path).replace(/\.rs$/u, '');
    const lines = source.split(/\r?\n/u);
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index].trim() !== '#[tauri::command]') continue;
      for (let probe = index + 1; probe < Math.min(index + 6, lines.length); probe += 1) {
        const signature = /(?:pub )?(?:async )?fn ([A-Za-z0-9_]+)/u.exec(lines[probe]);
        if (!signature) continue;
        owners.set(signature[1], { domain, file: path, line: index + 1 });
        break;
      }
    }
  }
  return owners;
}

/**
 * 检查领域块结构。
 *
 * @param {{libSource: string, commandOwners: Map<string, {domain: string, file: string, line: number}>}} input
 * @returns {{violations: Array<{line: number, message: string}>, blockCount: number, entryCount: number}}
 */
export function checkCommandBlocks({ libSource, commandOwners }) {
  const parsed = parseHandlerBlocks(libSource);
  const violations = [...parsed.violations];
  const blocks = parsed.blocks;

  // 1. 未知/重复领域块。
  const known = [];
  for (const block of blocks) {
    if (!DOMAIN_ORDER.includes(block.domain)) {
      violations.push({
        line: block.line,
        message: '未知领域块「' + block.domain + '」：允许的领域（顺序固定）为 '
          + DOMAIN_ORDER.join(', '),
      });
      continue;
    }
    const duplicate = known.find((other) => other.domain === block.domain);
    if (duplicate) {
      violations.push({
        line: block.line,
        message: '领域块「' + block.domain + '」重复出现（第 ' + duplicate.line
          + ' 行已有一个）：同一领域只能有一个块',
      });
      continue;
    }
    known.push(block);
  }
  for (let index = 1; index < known.length; index += 1) {
    const previous = DOMAIN_ORDER.indexOf(known[index - 1].domain);
    const current = DOMAIN_ORDER.indexOf(known[index].domain);
    if (current < previous) {
      violations.push({
        line: known[index].line,
        message: '领域块顺序错误：「' + known[index].domain + '」不能排在「'
          + known[index - 1].domain + '」之后；固定顺序为 ' + DOMAIN_ORDER.join(' → '),
      });
    }
  }

  // 2. 预置块不得删除。
  for (const domain of DOMAIN_ORDER) {
    if (!blocks.some((block) => block.domain === domain)) {
      violations.push({
        line: parsed.startLine,
        message: '缺少领域块「' + domain + '」：预置占位块不得删除，新 command 才有地方追加',
      });
    }
  }

  // 3. 条目落位、字母序与重复注册。
  const seen = new Map();
  for (const block of blocks) {
    let previous = null;
    for (const entry of block.entries) {
      const firstLine = seen.get(entry.path);
      if (firstLine === undefined) seen.set(entry.path, entry.line);
      else {
        violations.push({
          line: entry.line,
          message: entry.path + ' 重复注册（首次出现在第 ' + firstLine + ' 行）',
        });
      }

      const segments = entry.path.split('::');
      const owner = segments.length > 2 ? { domain: segments[1] } : commandOwners.get(entry.name);
      if (!owner) {
        violations.push({
          line: entry.line,
          message: '第 ' + entry.line + ' 行的 ' + entry.path + ' 在块「' + block.domain
            + '」内，但 src/commands/ 下找不到带 #[tauri::command] 的同名函数：'
            + '新 command 必须先在对应领域模块中定义',
        });
      } else if (owner.domain !== block.domain) {
        violations.push({
          line: entry.line,
          message: '第 ' + entry.line + ' 行的 ' + entry.path + ' 在块「' + block.domain
            + '」内，应属于「' + owner.domain + '」块',
        });
      }

      if (previous && entry.name < previous.name) {
        violations.push({
          line: entry.line,
          message: '第 ' + entry.line + ' 行的 ' + entry.name + ' 破坏了块「' + block.domain
            + '」的字母序：应排在 ' + previous.name + '（第 ' + previous.line + ' 行）之前',
        });
      }
      previous = entry;
    }
  }

  // 4. 定义了但没注册的 command（搬位置时最容易漏）。
  const registered = new Set([...seen.keys()].map((path) => path.split('::').pop()));
  for (const [name, owner] of commandOwners) {
    if (!registered.has(name)) {
      violations.push({
        line: owner.line,
        message: owner.file + ' 中的 command ' + name + ' 未注册到 lib.rs 的「'
          + owner.domain + '」块',
      });
    }
  }

  return {
    violations,
    blockCount: blocks.length,
    entryCount: blocks.reduce((total, block) => total + block.entries.length, 0),
  };
}

/** 读取仓库里的 lib.rs 与 src/commands/*.rs，跑一遍检查。 */
export function checkRepository(root) {
  const srcDir = join(root, 'apps', 'desktop', 'src-tauri', 'src');
  const libSource = readFileSync(join(srcDir, 'lib.rs'), 'utf8');
  const commandsDir = join(srcDir, 'commands');
  const files = readdirSync(commandsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.rs') && entry.name !== 'mod.rs')
    .map((entry) => entry.name)
    .sort()
    .map((name) => ({
      path: 'apps/desktop/src-tauri/src/commands/' + name,
      source: readFileSync(join(commandsDir, name), 'utf8'),
    }));
  return checkCommandBlocks({ libSource, commandOwners: parseCommandOwners(files) });
}

function main(argv) {
  const root = argv[0] ? resolve(argv[0]) : resolve(dirname(fileURLToPath(import.meta.url)), '..');
  let result;
  try {
    result = checkRepository(root);
  } catch (error) {
    console.error('❌ 无法读取后端命令结构：' + error.message);
    return 2;
  }
  if (result.violations.length > 0) {
    for (const violation of result.violations) {
      console.error('❌ lib.rs:' + violation.line + ' ' + violation.message);
    }
    console.error(
      '共 ' + result.violations.length + ' 处问题；规则见 docs/development/command-blocks.md',
    );
    return 1;
  }
  console.log(
    '✅ 领域块检查通过：' + result.blockCount + ' 个领域块、' + result.entryCount
      + ' 个 command，落位与顺序正确',
  );
  return 0;
}

// 被单元测试 import 时不执行 CLI。
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error('❌ 领域块检查异常：' + error.message);
    process.exitCode = 2;
  }
}
