/**
 * 回归测试：国际化框架与社区语言包（Issue #135）。
 *
 * 能在 Node 里确定验证的部分：
 * - loader：模块前缀合并、冲突启动即抛、缺失回退 zh-CN、插值、运行时切换的响应性；
 * - 内置包：zh-CN 与 en-US 的 key 完全一致（与 scripts/check-locales.mjs 同一份断言）；
 * - 社区包校验：子集 / 空值 / 重复 key / 标签非法 / 覆盖内置，各自给出具体原因；
 * - 语言偏好：读写、脏值回退、系统语言探测、启动引导的失败回退；
 * - 设置页语言包区：真接线（不是占位）、失败原因可见、无定时器；
 * - 顶栏：文案全部走 t()，不再有硬编码中文。
 *
 * 真实像素、键盘走查与「导入后重启仍生效」需要桌面端，见 docs/development/i18n.md
 * 的验收清单。
 *
 * 为什么是一个文件（超过 600 行）：loader 是应用级单例，每个用例都要先
 * resetLocaleStateForTests() 再断言；拆成多个文件会重复同一套假存储与假后端夹具，
 * 反而更难维护。这里超过 600 行是「同一份单例契约」的体量，不是混杂了无关主题。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { effect, nextTick } from "vue";

// resolveInitialTag() 的兜底链是「持久化偏好 → 系统语言 → zh-CN」，
// 而系统语言来自 navigator。CI 的 navigator.language 是 en-US、开发机多为 zh-CN，
// 于是「默认回退简体中文」这类断言在不同机器上结论不同（CI 上曾因此挂掉）。
// 这里把运行环境固定成 zh-CN，让断言只测代码逻辑，不测跑在哪台机器上。
Object.defineProperty(globalThis, "navigator", {
  value: { languages: ["zh-CN"], language: "zh-CN" },
  configurable: true,
  writable: true,
});

import {
  BASE_MESSAGES,
  BUILTIN_LOCALES,
  LocaleConflictError,
  LocaleFormatError,
  buildLocaleMessages,
  exportBaseLocaleJson,
  registerCommunityLocale,
  resetLocaleStateForTests,
  setDevelopmentModeForTests,
  unregisterCommunityLocale,
  useLocale,
} from "../src/locales/index.ts";
import {
  MAX_LOCALE_PACK_BYTES,
  baseLocaleKeys,
  localePackTagFromFileName,
  scanTopLevelKeys,
  validateLocalePack,
} from "../src/locales/community.ts";
import { startLocale } from "../src/locales/bootstrap.ts";
import {
  LOCALE_STORAGE_KEY,
  detectLocale,
  isLocaleTag,
  persistLocalePreference,
  readLocalePreference,
} from "../src/settings/locale.ts";
import type { KeyValueStorage } from "../src/settings/storage.ts";
import { useLocalePacks } from "../src/composables/useLocalePacks.ts";
import type { LocalePackList, LocalePacksBridge } from "../src/services/localePacks.ts";

const SRC_ROOT = fileURLToPath(new URL("../src", import.meta.url));
const LOCALES_ROOT = join(SRC_ROOT, "locales");

class FakeStorage implements KeyValueStorage {
  readonly entries = new Map<string, string>();
  failOnGet = false;
  failOnSet = false;

  getItem(key: string): string | null {
    if (this.failOnGet) throw new Error("SecurityError: localStorage 被禁用");
    return this.entries.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failOnSet) throw new Error("QuotaExceededError: 配额已满");
    this.entries.set(key, value);
  }
}

/** 假的语言包后端：只在内存里，记录调用次数，方便断言「失败时没写盘」。 */
class FakeLocalePacks implements LocalePacksBridge {
  tags: string[] = [];
  directory = "C:/Users/test/AppData/Roaming/dev.soxu.desktop/locales";
  files = new Map<string, string>();
  sources = new Map<string, string>();
  saveCalls = 0;
  removeCalls = 0;
  failList: string | null = null;

  list(): Promise<LocalePackList> {
    if (this.failList) return Promise.reject(new Error(this.failList));
    return Promise.resolve({ directory: this.directory, tags: [...this.tags] });
  }

  read(tag: string): Promise<string> {
    const raw = this.files.get(tag);
    return raw === undefined
      ? Promise.reject(new Error("找不到语言包：" + tag))
      : Promise.resolve(raw);
  }

  save(tag: string, json: string): Promise<void> {
    this.saveCalls += 1;
    this.files.set(tag, json);
    if (!this.tags.includes(tag)) this.tags = [...this.tags, tag].sort();
    return Promise.resolve();
  }

  remove(tag: string): Promise<boolean> {
    this.removeCalls += 1;
    const existed = this.files.delete(tag);
    this.tags = this.tags.filter((item) => item !== tag);
    return Promise.resolve(existed);
  }

  readSource(path: string): Promise<string> {
    const raw = this.sources.get(path);
    return raw === undefined
      ? Promise.reject(new Error("无法读取语言包源文件：" + path))
      : Promise.resolve(raw);
  }
}

async function readSourceFile(relative: string): Promise<string> {
  return readFile(join(SRC_ROOT, relative), "utf8");
}

function reset(): void {
  resetLocaleStateForTests();
}

/** 组件里 t() 的参数可能用单引号（属性内）或双引号（插值里），两种都要认。 */
function usesKey(source: string, key: string): boolean {
  return new RegExp("t\\((['\"])" + key.replaceAll(".", "\\.") + "\\1", "u").test(source);
}

/** 抽出源码里所有 t("...") / t('...') 的 key。 */
function translationKeys(source: string): string[] {
  return [...source.matchAll(/t\((['"])([a-zA-Z0-9.]+)\1/gu)].map((match) => match[2] ?? "");
}

// ──────────────────────────────────────────────────────────────
// 1. loader：合并、冲突、回退、插值、切换
// ──────────────────────────────────────────────────────────────
test("模块前缀合并：common.copy 与 settings.locale.import 落在同一张扁平表", () => {
  const table = buildLocaleMessages({
    common: { "action.copy": "复制" },
    settings: { "locale.import": "导入语言包" },
  });
  assert.deepEqual(table, {
    "common.action.copy": "复制",
    "settings.locale.import": "导入语言包",
  });
  // 基准包本身就包含两个模块，key 一律是「模块.包内 key」
  assert.equal(BASE_MESSAGES["common.action.copy"], "复制");
  assert.equal(BASE_MESSAGES["settings.locale.import"], "导入语言包");
});

test("两个模块出现同名 key：启动即抛，并指出是哪两个模块", () => {
  // drawer.json 里又写了一遍 copy：社区翻译会指到两处，必须在启动阶段拦住。
  assert.throws(
    () =>
      buildLocaleMessages({
        common: { "action.copy": "复制" },
        drawer: { "action.copy": "复制" },
      }),
    (error: unknown) => {
      assert.ok(error instanceof LocaleConflictError, "必须抛 LocaleConflictError");
      assert.equal(error.conflicts.length, 1);
      assert.equal(error.conflicts[0]?.key, "action.copy");
      assert.equal(error.conflicts[0]?.first, "common");
      assert.equal(error.conflicts[0]?.second, "drawer");
      assert.match(error.message, /common 与 drawer/u);
      return true;
    },
  );

  // 把带模块前缀的 key 抄进另一个模块，同样指向同一段文案。
  assert.throws(
    () =>
      buildLocaleMessages({
        common: { "action.copy": "复制" },
        drawer: { "common.action.copy": "复制" },
      }),
    LocaleConflictError,
  );
});

test("不合法的 key 与空文案在合并阶段就失败", () => {
  for (const modules of [
    { common: { copy: "复制" } }, // 只有一段：看不出属于哪个模块
    { common: { "action.Copy": "复制" } }, // 大写
    { common: { "action.copy": "  " } }, // 空白文案
  ]) {
    assert.throws(() => buildLocaleMessages(modules), LocaleFormatError);
  }
});

test("切换语言即时生效：t() 的读者被通知，无需重建组件", async () => {
  reset();
  const { t, setLocale, locale } = useLocale();
  assert.equal(locale.value, "zh-CN", "默认回退简体中文");
  assert.equal(t("common.action.copy"), "复制");

  // 用 effect 模拟模板：t() 读的是响应式表，换表后必须重新求值。
  const seen: string[] = [];
  const stop = effect(() => {
    seen.push(t("common.action.copy"));
  });
  try {
    await setLocale("en-US");
    await nextTick();
    assert.equal(locale.value, "en-US");
    assert.deepEqual(seen, ["复制", "Copy"], "已渲染文案必须跟着变");
  } finally {
    stop();
  }

  // 单例：所有组件拿到同一份 locale 与表。
  assert.equal(useLocale().locale.value, "en-US");
  await setLocale("zh-CN");
});

test("缺失 key 回退 zh-CN；开发模式每个 key 只 warn 一次", async () => {
  reset();
  const { t, setLocale } = useLocale();
  // 社区包只翻译了一部分：缺的 key 必须回退中文，而不是空白。
  registerCommunityLocale("ja-JP", { "common.action.copy": "コピー" });
  await setLocale("ja-JP");
  assert.equal(t("common.action.copy"), "コピー");
  assert.equal(t("common.action.close"), "关闭", "缺失 key 回退 zh-CN");

  // 两边都没有：原样返回 key，便于一眼看出漏了哪条。
  assert.equal(t("common.missing.key"), "common.missing.key");

  setDevelopmentModeForTests(true);
  const warned: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warned.push(args.map(String).join(" "));
  };
  try {
    assert.equal(t("common.missing.key"), "common.missing.key");
    assert.equal(t("common.missing.key"), "common.missing.key");
  } finally {
    console.warn = original;
  }
  assert.equal(warned.length, 1, "同一个 key 只提示一次");
  assert.match(warned[0] ?? "", /common\.missing\.key/u);
  await setLocale("zh-CN");
});

test("插值只替换已知参数，未提供的占位符原样保留", () => {
  reset();
  const { t } = useLocale();
  assert.equal(t("settings.locale.failed", { reason: "JSON 不合法" }), "导入失败：JSON 不合法");
  assert.equal(t("settings.locale.failed"), "导入失败：{reason}");
});

test("Intl：数字与时间按当前语言格式化，不写死格式", async () => {
  reset();
  const { formatNumber, formatDateTime, setLocale } = useLocale();
  const moment = new Date(2026, 0, 2, 9, 5, 0);
  const zh = formatDateTime(moment, { dateStyle: "short" });
  await setLocale("en-US");
  const en = formatDateTime(moment, { dateStyle: "short" });
  assert.notEqual(zh, en, "不同语言的日期顺序不同");
  assert.equal(formatNumber(1234.5), new Intl.NumberFormat("en-US").format(1234.5));
  assert.equal(formatDateTime("not-a-date"), "", "非法时间不产生文本");
  await setLocale("zh-CN");
});

test("导出基准包：可解析、按 key 排序、内容与基准表一致", () => {
  const json = exportBaseLocaleJson();
  const parsed = JSON.parse(json) as Record<string, string>;
  const keys = Object.keys(parsed);
  assert.deepEqual(keys, [...keys].sort(), "排序后输出，便于 diff");
  assert.deepEqual(parsed, { ...BASE_MESSAGES });
});

// ──────────────────────────────────────────────────────────────
// 2. 内置包：zh-CN / en-US key 完全一致
// ──────────────────────────────────────────────────────────────
test("内置语言：目录、模块与 key 集合完全对齐（与 CI 同源断言）", async () => {
  assert.deepEqual(
    BUILTIN_LOCALES.map((entry) => entry.tag),
    ["zh-CN", "en-US"],
  );
  for (const locale of BUILTIN_LOCALES) {
    const common = JSON.parse(
      await readFile(join(LOCALES_ROOT, locale.tag, "common.json"), "utf8"),
    ) as Record<string, string>;
    const settings = JSON.parse(
      await readFile(join(LOCALES_ROOT, locale.tag, "settings.json"), "utf8"),
    ) as Record<string, string>;
    assert.ok(Object.keys(common).length > 0, locale.tag + " 的 common 不能为空");
    assert.ok(Object.keys(settings).length > 0, locale.tag + " 的 settings 不能为空");
    for (const value of [...Object.values(common), ...Object.values(settings)]) {
      assert.equal(typeof value, "string");
      assert.ok(value.trim().length > 0, locale.tag + " 不能有空文案");
    }
  }

  const zh = JSON.parse(await readFile(join(LOCALES_ROOT, "zh-CN", "common.json"), "utf8"));
  const en = JSON.parse(await readFile(join(LOCALES_ROOT, "en-US", "common.json"), "utf8"));
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort(), "common 的 key 必须一致");

  const zhSettings = JSON.parse(await readFile(join(LOCALES_ROOT, "zh-CN", "settings.json"), "utf8"));
  const enSettings = JSON.parse(await readFile(join(LOCALES_ROOT, "en-US", "settings.json"), "utf8"));
  assert.deepEqual(
    Object.keys(enSettings).sort(),
    Object.keys(zhSettings).sort(),
    "settings 的 key 必须一致",
  );
});

// ──────────────────────────────────────────────────────────────
// 3. 社区语言包校验
// ──────────────────────────────────────────────────────────────
const BASE_KEYS = baseLocaleKeys();

test("导入校验：子集允许，缺的 key 回退中文", () => {
  const result = validateLocalePack({
    raw: JSON.stringify({ "common.action.copy": "コピー" }),
    fileName: "ja-JP.json",
    baseKeys: BASE_KEYS,
  });
  assert.equal(result.ok, true);
  assert.ok(result.ok);
  assert.equal(result.tag, "ja-JP");
  assert.deepEqual(result.entries, { "common.action.copy": "コピー" });
});

test("导入校验：每种失败都给出具体原因", () => {
  const cases: Array<{ raw: string; fileName?: string; expect: RegExp }> = [
    { raw: "", fileName: "ja-JP.json", expect: /文件是空的/u },
    { raw: "{", fileName: "ja-JP.json", expect: /不是合法的 JSON/u },
    { raw: "[]", fileName: "ja-JP.json", expect: /顶层必须是/u },
    {
      raw: JSON.stringify({ "common.action.copy": "コピー", "common.not.a.key": "x" }),
      fileName: "ja-JP.json",
      expect: /不是基准包的 key/u,
    },
    {
      raw: JSON.stringify({ "common.action.copy": "   " }),
      fileName: "ja-JP.json",
      expect: /文案为空/u,
    },
    {
      raw: '{"common.action.copy":"a","common.action.copy":"b"}',
      fileName: "ja-JP.json",
      expect: /重复的 key/u,
    },
    { raw: '{"common.action.copy":"a"}', fileName: "japanese.json", expect: /语言标签/u },
    { raw: '{"common.action.copy":"a"}', fileName: "ja_JP.json", expect: /语言标签不合法/u },
    { raw: '{"common.action.copy":"a"}', fileName: "en-US.json", expect: /不能覆盖内置语言/u },
    { raw: '{"common.action.copy":"a"}', expect: /无法确定语言标签/u },
  ];

  for (const item of cases) {
    const result = validateLocalePack({
      raw: item.raw,
      fileName: item.fileName,
      baseKeys: BASE_KEYS,
    });
    assert.equal(result.ok, false, item.raw.slice(0, 20));
    assert.ok(!result.ok);
    assert.match(result.problems.join(" "), item.expect, item.raw.slice(0, 20));
  }
});

test("导入校验：超过大小上限直接拒绝", () => {
  const huge = JSON.stringify({ "common.action.copy": "x".repeat(MAX_LOCALE_PACK_BYTES) });
  const result = validateLocalePack({ raw: huge, fileName: "ja-JP.json", baseKeys: BASE_KEYS });
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.match(result.problems.join(" "), /文件过大/u);
});

test("顶层键扫描：只认深度 1 的键，重复键不会被 JSON.parse 吞掉", () => {
  const scan = scanTopLevelKeys('{"a.b":"1","a.b":"2","c":{"d":"3"}}');
  assert.deepEqual(scan.keys, ["a.b", "a.b", "c"], "嵌套对象里的键不算顶层键");
  assert.deepEqual(scan.duplicates, ["a.b"]);
  assert.equal(scan.error, null);

  // 值里的引号与转义不能把扫描带偏
  const escaped = scanTopLevelKeys('{"a.b":"say \\"hi\\"","c.d":"x"}');
  assert.deepEqual(escaped.keys, ["a.b", "c.d"]);
  assert.equal(scanTopLevelKeys('{"a.b":"1').error, "字符串没有闭合", "未闭合的字符串要报错");
});

test("文件名 → 语言标签", () => {
  assert.equal(localePackTagFromFileName("ja-JP.json"), "ja-JP");
  assert.equal(localePackTagFromFileName("C:\\tmp\\pt-BR.json"), "pt-BR");
  assert.equal(localePackTagFromFileName("ja-JP.txt"), null);
  assert.equal(localePackTagFromFileName(".json"), null);
});

// ──────────────────────────────────────────────────────────────
// 4. 语言偏好
// ──────────────────────────────────────────────────────────────
test("语言偏好：往返、脏值回退、存储不可用不抛错", () => {
  assert.equal(LOCALE_STORAGE_KEY, "soxu.locale");
  const storage = new FakeStorage();
  assert.equal(readLocalePreference(storage), null, "没有偏好");
  assert.equal(persistLocalePreference("en-US", storage), true);
  assert.equal(readLocalePreference(storage), "en-US");
  assert.equal(storage.getItem(LOCALE_STORAGE_KEY), "en-US");

  for (const dirty of ["", "zh_CN", "../../evil", "x".repeat(40), "ZH-cn"]) {
    storage.entries.set(LOCALE_STORAGE_KEY, dirty);
    assert.equal(readLocalePreference(storage), null, dirty + " 不是合法标签");
  }

  assert.equal(persistLocalePreference("bad tag", storage), false);
  const broken = new FakeStorage();
  broken.failOnGet = true;
  assert.equal(readLocalePreference(broken), null);
  const full = new FakeStorage();
  full.failOnSet = true;
  assert.equal(persistLocalePreference("en-US", full), false);
  assert.equal(readLocalePreference(null), null);
});

test("系统语言探测：zh* / en* 落到内置语言，其它回退 zh-CN", () => {
  assert.equal(detectLocale(["zh-Hant-TW", "en-US"]), "zh-CN");
  assert.equal(detectLocale(["zh_CN"]), "zh-CN");
  assert.equal(detectLocale(["en-GB"]), "en-US");
  assert.equal(detectLocale(["ja-JP", "en-US"]), "en-US", "取第一个认识的");
  assert.equal(detectLocale(["ja-JP"]), "zh-CN");
  assert.equal(detectLocale([]), "zh-CN");
  for (const tag of ["zh-CN", "en-US", "pt-BR", "ja"]) assert.equal(isLocaleTag(tag), true);
  for (const value of ["", "zh_CN", "zh-CN/../x", "ZH-cn", null, 42]) {
    assert.equal(isLocaleTag(value), false, String(value));
  }
});

// ──────────────────────────────────────────────────────────────
// 5. 启动引导
// ──────────────────────────────────────────────────────────────
test("启动引导：上次选的是社区语言包时从磁盘读回来", async () => {
  reset();
  const bridge = new FakeLocalePacks();
  bridge.files.set("ja-JP", JSON.stringify({ "common.action.copy": "コピー" }));
  const tag = await startLocale(bridge, "ja-JP");
  assert.equal(tag, "ja-JP");
  assert.equal(useLocale().t("common.action.copy"), "コピー");
  assert.equal(useLocale().t("common.action.close"), "关闭", "没翻译的 key 回退中文");
});

test("启动引导：语言包读不到时回退中文，且不覆盖用户偏好", async () => {
  reset();
  const bridge = new FakeLocalePacks();
  const tag = await startLocale(bridge, "ja-JP");
  assert.equal(tag, "zh-CN");
  assert.equal(useLocale().locale.value, "zh-CN");
  assert.equal(useLocale().messages.value["common.action.copy"], "复制");
});

test("启动引导：内置语言偏好不需要访问后端", async () => {
  reset();
  const bridge = new FakeLocalePacks();
  bridge.failList = "不应该被调用";
  assert.equal(await startLocale(bridge, "en-US"), "en-US");
  assert.equal(await startLocale(bridge, null), "en-US", "没有偏好时保持当前语言");
});

// ──────────────────────────────────────────────────────────────
// 6. 设置页语言包区：真接线
// ──────────────────────────────────────────────────────────────
test("语言包区：刷新、导入、切换、移除都落到桥接上", async () => {
  reset();
  const bridge = new FakeLocalePacks();
  const packs = useLocalePacks(bridge);
  await packs.refresh();
  assert.equal(packs.directory.value, bridge.directory);
  assert.deepEqual(packs.tags.value, []);

  // 导入合法包：保存的是原文，注册后可以立即切换。
  const raw = JSON.stringify({ "common.action.copy": "コピー" });
  bridge.sources.set("C:/tmp/ja-JP.json", raw);
  assert.equal(await packs.importFromFile("C:/tmp/ja-JP.json"), true);
  assert.equal(bridge.saveCalls, 1);
  assert.equal(bridge.files.get("ja-JP"), raw, "保存原文，不打乱译者的排版");
  assert.deepEqual(packs.tags.value, ["ja-JP"]);
  assert.equal(packs.notice.value?.tone, "ok");
  assert.match(packs.notice.value?.text ?? "", /ja-JP/u);

  assert.equal(await packs.activate("ja-JP"), true);
  assert.equal(useLocale().locale.value, "ja-JP");
  assert.equal(useLocale().t("common.action.copy"), "コピー");

  // 移除：文件与内存注册一起清掉，正在用就先回退。
  await packs.remove("ja-JP");
  assert.equal(bridge.removeCalls, 1);
  assert.equal(useLocale().locale.value, "zh-CN");
  assert.deepEqual(packs.tags.value, []);
  assert.equal(useLocale().t("common.action.copy"), "复制");
});

test("语言包区：校验失败不写盘，提示里带具体原因", async () => {
  reset();
  const bridge = new FakeLocalePacks();
  const packs = useLocalePacks(bridge);
  bridge.sources.set("C:/tmp/en-US.json", JSON.stringify({ "common.action.copy": "Copy" }));
  assert.equal(await packs.importFromFile("C:/tmp/en-US.json"), false);
  assert.equal(bridge.saveCalls, 0, "校验失败绝不能写盘");
  assert.equal(packs.notice.value?.tone, "error");
  assert.match(packs.notice.value?.text ?? "", /不能覆盖内置语言/u);

  bridge.sources.set("C:/tmp/ja-JP.json", JSON.stringify({ "nope.key": "x" }));
  assert.equal(await packs.importFromFile("C:/tmp/ja-JP.json"), false);
  assert.match(packs.notice.value?.text ?? "", /不是基准包的 key/u);
});

test("语言包区：后端失败变成可读原因，不抛给调用方", async () => {
  reset();
  const bridge = new FakeLocalePacks();
  bridge.failList = "浏览器预览没有文件访问能力";
  const packs = useLocalePacks(bridge);
  await packs.refresh();
  assert.equal(packs.notice.value?.tone, "error");
  assert.match(packs.notice.value?.text ?? "", /浏览器预览/u);

  assert.equal(await packs.activate("ja-JP"), false);
  assert.match(packs.notice.value?.text ?? "", /找不到语言包/u);

  // 不存在的包删除时给出原因，而不是假装成功。
  await packs.remove("pt-BR");
  assert.match(packs.notice.value?.text ?? "", /不在语言包目录里/u);

  packs.dismissNotice();
  assert.equal(packs.notice.value, null);
});

// ──────────────────────────────────────────────────────────────
// 7. 组件接线与无障碍
// ──────────────────────────────────────────────────────────────
test("语言包组件：走 t()、用统一的设置控件、失败用 alert 暴露", async () => {
  const panel = await readSourceFile("components/settings/SettingsLocale.vue");
  assert.ok(panel.includes("useLocale"), "文案必须走 loader");
  assert.ok(panel.includes("useLocalePacks"), "读写走后端桥接");
  assert.ok(panel.includes("SettingsChoice"), "语言选择用统一的分段单选");
  assert.ok(panel.includes("SettingsRow"), "设置项用统一的行布局");
  assert.ok(panel.includes(":role="), "notice 的 role 由语气决定");
  assert.ok(panel.includes("'alert'"), "失败要用 alert 播报");
  assert.ok(panel.includes("'status'"), "成功用 status 播报");
  assert.ok(panel.includes('extensions: ["json"]'), "文件选择器只放行 json");
  assert.ok(panel.includes("isTauriRuntime"), "浏览器预览要禁用导入并说明原因");
  // 复制回执与 notice 都靠状态，不排定时器 —— 没有定时器就没有要释放的资源。
  assert.doesNotMatch(panel, /setTimeout|setInterval/u);
  assert.doesNotMatch(panel, /\stitle="/u, "提示走 AppTooltip，不用原生 title");
});

test("语言包区接进扩展页，扩展页仍是静态占位", async () => {
  const page = await readSourceFile("components/settings/SettingsExtensions.vue");
  assert.ok(page.includes("SettingsLocale"), "扩展页要渲染语言包区");
  assert.ok(page.includes("占位"), "占位说明不能删");
  assert.doesNotMatch(page, /localStorage|persist[A-Z]|invoke\(/u, "占位页本身不写存储、不发 IPC");
});

test("顶栏文案全部走 t()：common 模块完成迁移", async () => {
  const app = await readSourceFile("App.vue");
  const header = app.slice(
    app.indexOf('<header class="app-header">'),
    app.indexOf("</header>"),
  );
  assert.ok(header.length > 0, "没有找到顶栏");

  for (const key of [
    "common.nav.sidebar",
    "common.nav.sidebar.collapse",
    "common.nav.sidebar.expand",
    "common.nav.back",
    "common.nav.back.label",
    "common.nav.forward",
    "common.nav.forward.label",
    "common.status.connected",
    "common.status.disconnected",
    "common.nav.search",
    "common.nav.notifications",
    "common.nav.git",
    "common.nav.inspector",
  ]) {
    assert.ok(usesKey(header, key), "顶栏缺少 t(\"" + key + "\")");
  }

  // 迁移完成的标志：顶栏不再出现这些硬编码文案。
  for (const literal of ["收起侧栏", "展开侧栏", "已连接本机运行时", "通知历史", "会话状态 ("]) {
    assert.ok(!header.includes(literal), "顶栏仍在硬编码「" + literal + "」");
  }

  // 仍然保留无障碍名称：aria-label 换成绑定值，但一个都不能少。
  const labels = header.match(/:?aria-label=/g) ?? [];
  assert.ok(labels.length >= 4, "顶栏的图标按钮必须都有无障碍名称");
  assert.ok(header.includes(":disabled=\"!backTarget\""), "历史为空时后退仍要禁用");
});

test("语言包注册的 key 都能在基准包里找到（防止 t() 写错名字）", async () => {
  const panel = await readSourceFile("components/settings/SettingsLocale.vue");
  const keys = translationKeys(panel);
  assert.ok(keys.length >= 10, "语言包组件应当有若干条文案");
  for (const key of keys) {
    assert.ok(BASE_MESSAGES[key] !== undefined, "基准包里没有 " + key);
  }

  const app = await readSourceFile("App.vue");
  const header = app.slice(app.indexOf('<header class="app-header">'), app.indexOf("</header>"));
  for (const key of translationKeys(header)) {
    assert.ok(BASE_MESSAGES[key] !== undefined, "基准包里没有 " + key);
  }
});

test("移除语言包会同时清掉内存注册（不留悬空标签）", async () => {
  reset();
  registerCommunityLocale("pt-BR", { "common.action.copy": "Copiar" });
  await useLocale().setLocale("pt-BR");
  assert.equal(useLocale().availableLocales().includes("pt-BR"), true);
  await unregisterCommunityLocale("pt-BR");
  assert.equal(useLocale().availableLocales().includes("pt-BR"), false);
  assert.equal(useLocale().locale.value, "zh-CN", "正在用的包被移除时回退中文");
  assert.equal(useLocale().t("common.action.copy"), "复制");
});
