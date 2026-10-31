/**
 * 语言包 loader（Issue #135）。
 *
 * 设计要点：
 * 1. **按模块拆文件**：zh-CN/common.json、zh-CN/settings.json……每个切片只改自己模块的包，
 *    避免单文件变成第二个 App.vue（所有并行切片都往同一处加 key）。
 * 2. **扁平 key**：合并后的 key 是「模块名 + 包内 key」，例如 common.action.copy。
 *    组件里写 t("common.action.copy")，一眼能看出该去哪个文件改文案。
 * 3. **冲突启动即报错**：两个模块定义同一个 key 属于真错误（社区翻译会对不上），
 *    在模块加载阶段直接抛错，而不是静默覆盖。
 * 4. **缺失回退 zh-CN**：任何语言缺 key 都退回简体中文，开发模式额外 console.warn，
 *    这样翻译进度可以分模块推进，不会让界面出现空白。
 * 5. **运行时切换不重建组件**：messages 是 shallowRef，setLocale 换表即可，
 *    所有用到 t() 的模板会自动重渲染。
 *
 * 不引入 vue-i18n 等重型库：这里只需要「查表 + 插值 + 回退」，几十行就够，
 * 而多一个运行时依赖就是多一份启动成本与升级风险。
 */

import { shallowRef, type Ref, type ShallowRef } from "vue";

import enUSCommands from "./en-US/commands.json" with { type: "json" };
import enUSCommon from "./en-US/common.json" with { type: "json" };
import enUSComposer from "./en-US/composer.json" with { type: "json" };
import enUSSession from "./en-US/session.json" with { type: "json" };
import enUSSettings from "./en-US/settings.json" with { type: "json" };
import zhCNCommands from "./zh-CN/commands.json" with { type: "json" };
import zhCNCommon from "./zh-CN/common.json" with { type: "json" };
import zhCNComposer from "./zh-CN/composer.json" with { type: "json" };
import zhCNSession from "./zh-CN/session.json" with { type: "json" };
import zhCNSettings from "./zh-CN/settings.json" with { type: "json" };
import {
  BUILTIN_LOCALES,
  FALLBACK_LOCALE,
  detectLocale,
  isBuiltinLocale,
  localeLabel,
  navigatorLanguages,
  persistLocalePreference,
  readLocalePreference,
  type BuiltinLocaleTag,
} from "../settings/locale.ts";

export {
  BUILTIN_LOCALES,
  FALLBACK_LOCALE,
  detectLocale,
  isBuiltinLocale,
  localeLabel,
  readLocalePreference,
} from "../settings/locale.ts";

/** 一个模块的语言包：包内 key（如 action.copy）→ 文案。 */
export type LocaleModuleTable = Record<string, string>;
/** 一个语言的全部模块：模块名（如 common）→ 模块包。 */
export type LocaleModuleSet = Record<string, LocaleModuleTable>;

/**
 * 包内 key 的合法形状：小写字母开头的点分段，至少两段（如 action.copy）。
 * 强制两段以上是为了让「哪个模块」永远能从 key 本身看出来，
 * 也顺手挡掉整包只写一个 key 的残包。
 */
export const LOCALE_KEY_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/u;

/** 两个模块定义了同一个 key。 */
export interface LocaleKeyConflict {
  /** 冲突的 key（包内 key 或合并后的完整 key）。 */
  key: string;
  /** 先定义它的模块。 */
  first: string;
  /** 又定义了一次的模块。 */
  second: string;
}

/**
 * key 冲突：启动即抛，不做静默覆盖。
 * 携带结构化 conflicts，测试与文档都能指出具体是哪两个模块。
 */
export class LocaleConflictError extends Error {
  readonly conflicts: LocaleKeyConflict[];

  constructor(conflicts: LocaleKeyConflict[]) {
    const detail = conflicts
      .map((item) => item.key + "（" + item.first + " 与 " + item.second + "）")
      .join("；");
    super("语言包 key 冲突：" + detail + "；同名 key 只能在一个模块定义，复用请指向原模块");
    this.name = "LocaleConflictError";
    this.conflicts = conflicts;
  }
}

/** 语言包里有不合法的 key 或空文案。 */
export class LocaleFormatError extends Error {
  readonly entries: string[];

  constructor(entries: string[]) {
    super("语言包条目不合法：" + entries.join("；"));
    this.name = "LocaleFormatError";
    this.entries = entries;
  }
}

/**
 * 把「模块 → 包」合并成扁平表，并在冲突/格式错误时抛错。
 *
 * 冲突判定覆盖两种真实写法：
 * - 两个模块写了同一个包内 key（drawer.json 又写一遍 "copy"）；
 * - 某个模块把带模块前缀的 key 抄了进来（drawer.json 里写 "common.copy"），
 *   与 common 模块的 copy 指向同一段文案。
 */
export function buildLocaleMessages(modules: LocaleModuleSet): Record<string, string> {
  const table: Record<string, string> = {};
  const owners = new Map<string, string>();
  const conflicts: LocaleKeyConflict[] = [];
  const invalid: string[] = [];

  for (const module of Object.keys(modules).sort()) {
    const entries = modules[module] ?? {};
    for (const [key, value] of Object.entries(entries)) {
      const qualified = module + "." + key;
      if (!LOCALE_KEY_PATTERN.test(key)) {
        invalid.push(qualified + " 不是合法的扁平 key（小写点分段，至少两段）");
        continue;
      }
      if (typeof value !== "string" || value.trim() === "") {
        invalid.push(qualified + " 的文案为空");
        continue;
      }
      const sameKey = owners.get(key);
      const sameQualified = owners.get(qualified);
      if (sameKey !== undefined) {
        conflicts.push({ key, first: sameKey, second: module });
        continue;
      }
      if (sameQualified !== undefined) {
        conflicts.push({ key: qualified, first: sameQualified, second: module });
        continue;
      }
      owners.set(key, module);
      owners.set(qualified, module);
      table[qualified] = value;
    }
  }

  if (invalid.length > 0) throw new LocaleFormatError(invalid);
  if (conflicts.length > 0) throw new LocaleConflictError(conflicts);
  return table;
}

/** 内置语言的全部模块。新增模块时在这里登记一次，两个语言必须同时提供。 */
const BUILTIN_MODULES: Record<BuiltinLocaleTag, LocaleModuleSet> = {
  // 模块按界面切片归属：common / commands（命令面板，Issue #145）/
  // composer + session（会话区与输入区，Issue #144）/ settings（设置页，Issue #145）。
  // 切片之间互不重叠，一个切片只改自己模块的包，避免并行改动把语言包变成冲突热点。
  "zh-CN": {
    commands: zhCNCommands,
    common: zhCNCommon,
    composer: zhCNComposer,
    session: zhCNSession,
    settings: zhCNSettings,
  },
  "en-US": {
    commands: enUSCommands,
    common: enUSCommon,
    composer: enUSComposer,
    session: enUSSession,
    settings: enUSSettings,
  },
};

/**
 * 内置语言包在模块加载时就算好：冲突与格式错误必须在启动阶段暴露，
 * 而不是等用户切到某种语言才炸。这里抛出的异常会中断应用启动——这是有意的。
 */
const BUILTIN_MESSAGES: Record<BuiltinLocaleTag, Record<string, string>> = {
  "zh-CN": buildLocaleMessages(BUILTIN_MODULES["zh-CN"]),
  "en-US": buildLocaleMessages(BUILTIN_MODULES["en-US"]),
};

/** 基准包：回退目标，也是社区翻译「复制基准包」导出的内容。 */
export const BASE_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  ...BUILTIN_MESSAGES["zh-CN"],
});

export interface TranslateParams {
  [name: string]: string | number;
}

export interface LocaleRuntime {
  /** 当前语言标签；切换语言后立即变化。 */
  locale: Ref<string>;
  /** 当前语言的扁平表（社区包只含它翻译过的 key）。 */
  messages: ShallowRef<Record<string, string>>;
  /** 查表 + 插值 + 回退 zh-CN。 */
  t: (key: string, params?: TranslateParams) => string;
  /**
   * 运行时切换语言：只换表，不重建组件。
   * persist=false 用于「偏好还在、包暂时读不到」的回退，不覆盖用户的选择。
   */
  setLocale: (tag: string, options?: { persist?: boolean }) => Promise<void>;
  /** 内置语言 + 已注册的社区语言标签。 */
  availableLocales: () => string[];
  /** 用当前语言的 Intl 格式化数字（不写死千分位等格式）。 */
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string;
  /** 用当前语言的 Intl 格式化时间（不写死年月日顺序）。 */
  formatDateTime: (value: string | number | Date, options?: Intl.DateTimeFormatOptions) => string;
}

/** 开发模式下每个缺失 key 只提示一次，避免模板重渲染把控制台刷爆。 */
const warned = new Set<string>();

/** 测试用：Node 里没有 import.meta.env，用显式开关验证「开发模式 warn」。 */
let devOverride: boolean | null = null;

/** 仅供测试：切换开发模式判定；传 null 恢复按构建环境判断。 */
export function setDevelopmentModeForTests(enabled: boolean | null): void {
  devOverride = enabled;
}

function isDevBuild(): boolean {
  if (devOverride !== null) return devOverride;
  const meta = import.meta as unknown as { env?: { DEV?: boolean } };
  return meta.env?.DEV === true;
}

function interpolate(template: string, params?: TranslateParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/gu, (whole, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

/** 社区语言包：标签 → 扁平表。只在这里保存，不写存储（内容由后端文件提供）。 */
const communityTables = new Map<string, Record<string, string>>();

let runtime: LocaleRuntime | null = null;

/** 启动时的初始语言：持久化偏好 → 系统语言 → zh-CN。 */
export function resolveInitialTag(): BuiltinLocaleTag {
  const preference = readLocalePreference();
  if (preference && isBuiltinLocale(preference)) return preference;
  return detectLocale(navigatorLanguages());
}

function createRuntime(): LocaleRuntime {
  const initial = resolveInitialTag();
  const locale = shallowRef<string>(initial);
  const messages = shallowRef<Record<string, string>>({ ...BUILTIN_MESSAGES[initial] });

  function t(key: string, params?: TranslateParams): string {
    const table = messages.value;
    const raw = table[key] ?? BASE_MESSAGES[key];
    if (raw === undefined) {
      if (isDevBuild() && !warned.has(key)) {
        warned.add(key);
        console.warn("[i18n] 缺失 key：" + key + "（语言 " + locale.value + "，已回退 " + FALLBACK_LOCALE + "）");
      }
      // 回退也没有：把 key 原样显示，比空白更容易被发现与修复。
      return key;
    }
    return interpolate(raw, params);
  }

  async function setLocale(tag: string, options?: { persist?: boolean }): Promise<void> {
    const persist = options?.persist ?? true;
    if (isBuiltinLocale(tag)) {
      messages.value = { ...BUILTIN_MESSAGES[tag] };
      locale.value = tag;
      if (persist) persistLocalePreference(tag);
      return;
    }
    const community = communityTables.get(tag);
    if (!community) {
      throw new Error("没有可用的语言包：" + tag);
    }
    messages.value = { ...community };
    locale.value = tag;
    if (persist) persistLocalePreference(tag);
  }

  function availableLocales(): string[] {
    return [...BUILTIN_LOCALES.map((entry) => entry.tag), ...communityTables.keys()];
  }

  function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
    try {
      return new Intl.NumberFormat(locale.value, options).format(value);
    } catch {
      return String(value);
    }
  }

  function formatDateTime(
    value: string | number | Date,
    options?: Intl.DateTimeFormatOptions,
  ): string {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    try {
      return new Intl.DateTimeFormat(locale.value, options).format(date);
    } catch {
      return date.toISOString();
    }
  }

  return { locale, messages, t, setLocale, availableLocales, formatNumber, formatDateTime };
}

/**
 * 语言运行时是**应用级单例**：所有组件共享同一份 locale 与 messages，
 * 否则切换语言只会有半个界面跟着变。
 */
export function useLocale(): LocaleRuntime {
  runtime ??= createRuntime();
  return runtime;
}

/**
 * 注册社区语言包（由导入流程或启动时的磁盘读取调用）。
 * 传入的 entries 是完整扁平 key（common.action.copy），与基准包同一命名空间。
 */
export function registerCommunityLocale(tag: string, entries: Record<string, string>): void {
  communityTables.set(tag, { ...entries });
}

/** 移除社区语言包；如果正用它，先回退到基准语言再删。 */
export async function unregisterCommunityLocale(tag: string): Promise<void> {
  const current = useLocale();
  if (current.locale.value === tag) await current.setLocale(FALLBACK_LOCALE);
  communityTables.delete(tag);
}

/** 已注册的社区语言标签（不含内置语言）。 */
export function communityLocaleTags(): string[] {
  return [...communityTables.keys()];
}

/**
 * 导出基准包文本：社区译者「复制 → 翻译 → 提交或导入」的起点。
 * 排序后输出，保证同一份基准包导出的文本稳定（便于 diff）。
 */
export function exportBaseLocaleJson(): string {
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(BASE_MESSAGES).sort()) sorted[key] = BASE_MESSAGES[key] ?? "";
  return JSON.stringify(sorted, null, 2) + "\n";
}

/** 仅供测试：清掉单例与已注册的社区包，避免用例之间互相污染。 */
export function resetLocaleStateForTests(): void {
  runtime = null;
  communityTables.clear();
  warned.clear();
  devOverride = null;
}
