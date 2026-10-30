/**
 * 语言包门禁（scripts/check-locales.mjs）的回归测试。
 *
 * 用临时目录构造「仓库」，逐条验证它真的能拦住：
 * 模块缺失、key 不齐、重复 key、跨模块同名、空文案、非法命名、未知语言目录。
 * 另有一条用真实仓库跑一遍，防止规则与内置包本身脱节。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BASE_LOCALE, BUILTIN_LOCALES, checkLocales } from '../check-locales.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOCALES_DIR = join('apps', 'desktop', 'src', 'locales');

/** 在临时目录里搭一个最小仓库；值可以是对象（会被格式化成 JSON）或原文。 */
function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'soxu-locales-'));
  for (const [relative, content] of Object.entries(files)) {
    const path = join(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return root;
}

function localeFile(locale, module) {
  return join(LOCALES_DIR, locale, module + '.json');
}

function check(files) {
  const root = fixture(files);
  try {
    return checkLocales(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function messages(result) {
  return result.violations.map((violation) => violation.message).join('\n');
}

const COMMON = { 'action.copy': '复制' };
const SETTINGS = { 'locale.import': '导入语言包' };

test('真实仓库通过：内置语言的 key 完全对齐', () => {
  const result = checkLocales(REPO_ROOT);
  assert.deepEqual(result.violations, [], '内置语言包必须无问题');
  assert.equal(result.locales, BUILTIN_LOCALES.length);
  assert.ok(result.modules >= 2, '至少 common 与 settings 两个模块');
  assert.ok(result.keys > 0);
});

test('模块缺失：en-US 少了 settings.json 会被拦下', () => {
  const result = check({
    [localeFile(BASE_LOCALE, 'common')]: COMMON,
    [localeFile(BASE_LOCALE, 'settings')]: SETTINGS,
    [localeFile('en-US', 'common')]: { 'action.copy': 'Copy' },
  });
  assert.match(messages(result), /缺少模块 settings\.json/u);
});

test('多余的模块同样被拦下', () => {
  const result = check({
    [localeFile(BASE_LOCALE, 'common')]: COMMON,
    [localeFile('en-US', 'common')]: { 'action.copy': 'Copy' },
    [localeFile('en-US', 'extra')]: { 'only.here': 'x' },
  });
  assert.match(messages(result), /多余的模块 extra\.json/u);
});

test('key 不齐：两个语言的 key 集合必须完全一致', () => {
  const result = check({
    [localeFile(BASE_LOCALE, 'common')]: { 'action.copy': '复制', 'action.close': '关闭' },
    [localeFile('en-US', 'common')]: { 'action.copy': 'Copy' },
  });
  assert.match(messages(result), /缺少 1 个 key/u);
  assert.match(messages(result), /action\.close/u);
});

test('同一文件里重复 key 会被拦下（JSON.parse 会静默取最后一个）', () => {
  const result = check({
    [localeFile(BASE_LOCALE, 'common')]: '{"action.copy":"复制","action.copy":"复制2"}',
    [localeFile('en-US', 'common')]: { 'action.copy': 'Copy' },
  });
  assert.match(messages(result), /重复的 key：action\.copy/u);
});

test('跨模块同名 key 会被拦下：复用原模块，不要重写一遍', () => {
  const result = check({
    [localeFile(BASE_LOCALE, 'common')]: COMMON,
    [localeFile(BASE_LOCALE, 'drawer')]: { 'action.copy': '复制' },
    [localeFile('en-US', 'common')]: { 'action.copy': 'Copy' },
    [localeFile('en-US', 'drawer')]: { 'action.copy': 'Copy' },
  });
  assert.match(messages(result), /跨模块同名 key：action\.copy/u);
  assert.match(messages(result), /common\.action\.copy/u);
});

test('空文案与非法 key 命名会被拦下', () => {
  const result = check({
    [localeFile(BASE_LOCALE, 'common')]: { 'action.copy': '   ' },
    [localeFile('en-US', 'common')]: { 'action.copy': 'Copy', copy: 'Copy' },
  });
  const text = messages(result);
  assert.match(text, /文案为空：action\.copy/u);
  assert.match(text, /key 不合规范：copy/u);
});

test('非法 JSON 与未知语言目录都会被拦下', () => {
  const result = check({
    [localeFile(BASE_LOCALE, 'common')]: '{',
    [localeFile('en-US', 'common')]: { 'action.copy': 'Copy' },
    [localeFile('ja-JP', 'common')]: { 'action.copy': 'コピー' },
  });
  const text = messages(result);
  assert.match(text, /不是合法的 JSON/u);
  assert.match(text, /未知的语言目录 ja-JP/u);
});

test('缺少内置语言目录时直接报错', () => {
  const result = check({ [localeFile(BASE_LOCALE, 'common')]: COMMON });
  assert.match(messages(result), /缺少内置语言目录 en-US\//u);
});
