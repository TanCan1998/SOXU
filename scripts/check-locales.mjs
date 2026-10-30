#!/usr/bin/env node
/**
 * 校验内置语言包（Issue #135）。
 *
 * 背景：语言包按模块拆成 locales/<tag>/<module>.json，一个切片只改自己模块的包。
 * 拆开之后「某个模块只在 zh-CN 加了 key、忘了加 en-US」这类错误不会再在编译期暴露，
 * 于是把它变成机器校验，进入 pnpm check（CI 的 quality 作业会跑）。
 *
 * 校验项：
 * 1. 内置语言目录齐全（zh-CN / en-US），模块集合一一对应；
 * 2. 每个模块的 key 集合在两个语言里完全一致；
 * 3. key 形状合法（小写点分段、至少两段）、文案非空；
 * 4. 同一文件里不出现重复 key（JSON.parse 会静默取最后一个）；
 * 5. 同一语言内不出现跨模块同名 key（社区翻译时会指到两处，违反复用规则）。
 *
 * 社区导入的语言包不进本检查：它们不在仓库里，导入时由 locales/community.ts 校验。
 *
 * 用法：node scripts/check-locales.mjs [仓库根目录]
 * 规则文档：docs/development/i18n.md
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 顶层键扫描与前端共用同一份实现（packScan.ts 没有任何依赖，可以直接被脚本 import）。
import { scanTopLevelKeys } from '../apps/desktop/src/locales/packScan.ts';

/** 基准语言：其它语言必须与它的 key 集合完全一致。 */
export const BASE_LOCALE = 'zh-CN';

/** 内置语言：顺序即设置页里的顺序。 */
export const BUILTIN_LOCALES = Object.freeze(['zh-CN', 'en-US']);

/** 包内 key：小写字母开头的点分段，至少两段（action.copy）。 */
const MODULE_KEY = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/u;

/** 语言包目录（相对仓库根）。 */
const LOCALE_ROOT = join('apps', 'desktop', 'src', 'locales');

function listJsonFiles(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort();
}

/**
 * 检查一个仓库的语言包。
 *
 * @param {string} root 仓库根目录
 * @returns {{violations: Array<{file: string, message: string}>, locales: number, modules: number, keys: number}}
 */
export function checkLocales(root) {
  const violations = [];
  const baseDir = join(root, LOCALE_ROOT);
  const locales = readdirSync(baseDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  for (const required of BUILTIN_LOCALES) {
    if (!locales.includes(required)) {
      violations.push({
        file: LOCALE_ROOT,
        message: '缺少内置语言目录 ' + required + '/：新增语言必须同时建 zh-CN 与 en-US',
      });
    }
  }
  for (const locale of locales) {
    if (!BUILTIN_LOCALES.includes(locale)) {
      violations.push({
        file: join(LOCALE_ROOT, locale),
        message: '未知的语言目录 ' + locale + '：仓库里只允许内置语言 '
          + BUILTIN_LOCALES.join(' / ') + '（社区语言包不提交到仓库）',
      });
    }
  }

  const modulesByLocale = new Map();
  for (const locale of locales) {
    const dir = join(baseDir, locale);
    const modules = listJsonFiles(dir);
    if (modules.length === 0) {
      violations.push({ file: join(LOCALE_ROOT, locale), message: '语言目录里没有任何模块 json' });
    }
    modulesByLocale.set(locale, modules);
  }

  // 模块集合必须与基准语言一致：少一个模块 = 该模块的文案整段缺失。
  const baseModules = modulesByLocale.get(BASE_LOCALE) ?? [];
  for (const [locale, modules] of modulesByLocale) {
    if (locale === BASE_LOCALE) continue;
    for (const missing of baseModules.filter((name) => !modules.includes(name))) {
      violations.push({
        file: join(LOCALE_ROOT, locale, missing),
        message: '缺少模块 ' + missing + '：' + BASE_LOCALE + ' 有、' + locale + ' 没有',
      });
    }
    for (const extra of modules.filter((name) => !baseModules.includes(name))) {
      violations.push({
        file: join(LOCALE_ROOT, locale, extra),
        message: '多余的模块 ' + extra + '：' + BASE_LOCALE + ' 里没有对应文件，先在基准包里建',
      });
    }
  }

  // 每个模块逐条校验，并记录 key 集合用于跨语言比对。
  const keysByLocale = new Map();
  let keyCount = 0;
  for (const [locale, modules] of modulesByLocale) {
    const perModule = new Map();
    const leafOwners = new Map();
    for (const file of modules) {
      const path = join(LOCALE_ROOT, locale, file);
      const source = readFileSync(join(baseDir, locale, file), 'utf8');
      let parsed;
      try {
        parsed = JSON.parse(source);
      } catch (error) {
        violations.push({ file: path, message: '不是合法的 JSON：' + error.message });
        continue;
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        violations.push({ file: path, message: '顶层必须是 { "key": "文案" } 对象' });
        continue;
      }
      const scan = scanTopLevelKeys(source);
      if (scan.error) violations.push({ file: path, message: scan.error });
      for (const duplicate of scan.duplicates) {
        violations.push({ file: path, message: '重复的 key：' + duplicate + '（JSON.parse 会静默取最后一个）' });
      }

      const moduleName = file.replace(/\.json$/u, '');
      const keys = Object.keys(parsed);
      for (const key of keys) {
        if (!MODULE_KEY.test(key)) {
          violations.push({
            file: path,
            message: 'key 不合规范：' + key + '（小写点分段、至少两段，例如 action.copy）',
          });
          continue;
        }
        const value = parsed[key];
        if (typeof value !== 'string' || value.trim() === '') {
          violations.push({ file: path, message: '文案为空：' + key });
        }
        const owner = leafOwners.get(key);
        if (owner !== undefined && owner !== moduleName) {
          violations.push({
            file: path,
            message: '跨模块同名 key：' + key + ' 已经在 ' + owner + '.json 里定义，'
              + '复用请直接引用 ' + owner + '.' + key + '，不要在 ' + moduleName + '.json 里再写一遍',
          });
        } else {
          leafOwners.set(key, moduleName);
        }
      }
      perModule.set(moduleName, keys.sort());
      keyCount += keys.length;
    }
    keysByLocale.set(locale, perModule);
  }

  // key 集合必须与基准语言逐模块完全一致。
  const baseTables = keysByLocale.get(BASE_LOCALE) ?? new Map();
  for (const [locale, perModule] of keysByLocale) {
    if (locale === BASE_LOCALE) continue;
    for (const [moduleName, baseKeys] of baseTables) {
      const keys = perModule.get(moduleName);
      if (!keys) continue;
      const missing = baseKeys.filter((key) => !keys.includes(key));
      const extra = keys.filter((key) => !baseKeys.includes(key));
      const path = join(LOCALE_ROOT, locale, moduleName + '.json');
      if (missing.length > 0) {
        violations.push({
          file: path,
          message: '缺少 ' + missing.length + ' 个 key（' + BASE_LOCALE + ' 有）：'
            + missing.slice(0, 8).join(', ') + (missing.length > 8 ? ' …' : ''),
        });
      }
      if (extra.length > 0) {
        violations.push({
          file: path,
          message: '多出 ' + extra.length + ' 个 ' + BASE_LOCALE + ' 里没有的 key：'
            + extra.slice(0, 8).join(', ') + (extra.length > 8 ? ' …' : ''),
        });
      }
    }
  }

  return { violations, locales: locales.length, modules: baseModules.length, keys: keyCount };
}

function main(argv) {
  const root = argv[0] ? resolve(argv[0]) : resolve(dirname(fileURLToPath(import.meta.url)), '..');
  let result;
  try {
    result = checkLocales(root);
  } catch (error) {
    console.error('❌ 无法读取语言包目录：' + error.message);
    return 2;
  }
  if (result.violations.length > 0) {
    for (const violation of result.violations) {
      console.error('❌ ' + relative(root, join(root, violation.file)).replaceAll('\\', '/')
        + ' ' + violation.message);
    }
    console.error('共 ' + result.violations.length + ' 处问题；规则见 docs/development/i18n.md');
    return 1;
  }
  console.log(
    '✅ 语言包检查通过：' + result.locales + ' 种语言、' + result.modules + ' 个模块、'
      + result.keys + ' 条文案，key 完全对齐',
  );
  return 0;
}

// 被单元测试 import 时不执行 CLI。
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error('❌ 语言包检查异常：' + error.message);
    process.exitCode = 2;
  }
}
