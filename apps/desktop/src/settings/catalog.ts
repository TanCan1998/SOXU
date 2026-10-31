/**
 * 设置项元数据目录（Issue #123 · TASK-031；Issue #145 起文案走语言包）。
 *
 * **唯一来源**：设置面板的行标题/说明与命令面板的设置类命令都从这里读，
 * 因此新增一项设置只需要改这个文件，不会出现「设置里叫这个名字、命令面板里叫另一个」。
 *
 * 分工：
 * - 本文件只存 **语言包 key**（labelKey / descriptionKey / keywordsKey），不含任何界面文案：
 *   文案在 locales/<tag>/settings.json 里，切语言时界面立刻跟着变；
 * - 选项档位（主题两档、字号四档…）仍在 theme/appearance.ts、settings/*.ts 里，
 *   这里只描述「这一项叫什么、属于哪一页、还能怎么搜到它」；
 * - 命令面板（components/CommandPalette.vue）通过 commands/registry.ts 消费本文件，
 *   不复制任何标题字符串；
 * - SettingsRow 按 id 取标题与说明，面板模板里不再写死文案。
 *
 * 边界：本文件不读存储、不发 IPC、不含任何凭据；纯常量 + 查表 + 解析函数。
 */

/** 翻译函数的最小形状：与 locales/index.ts 的 t() 结构兼容，但不反向依赖 loader。 */
export type Translate = (key: string, params?: Record<string, string | number>) => string;

/** 设置弹窗的四页，顺序即界面顺序（与原型一致）。 */
export type SettingsTabId = "appearance" | "session" | "extensions" | "system";

export interface SettingsTabMeta {
  id: SettingsTabId;
  /** 标签页可见文案的 key。 */
  labelKey: string;
  /** 一句话说明这一页管什么（命令面板的结果行用它做补充说明）。 */
  descriptionKey: string;
  /** 额外搜索别名的 key；值是用逗号分隔的一串词（见 keywordList）。 */
  keywordsKey: string;
}

/** 解析后的标签页：组件直接渲染这个形状，不必再关心 key。 */
export interface SettingsTabView {
  id: SettingsTabId;
  label: string;
  description: string;
  keywords: readonly string[];
}

/** 四个标签页；SettingsDialog 直接 v-for 渲染，不再自己维护一份数组。 */
export const SETTINGS_TABS: readonly SettingsTabMeta[] = Object.freeze([
  {
    id: "appearance",
    labelKey: "settings.catalog.tab.appearance.label",
    descriptionKey: "settings.catalog.tab.appearance.description",
    keywordsKey: "settings.catalog.tab.appearance.keywords",
  },
  {
    id: "session",
    labelKey: "settings.catalog.tab.session.label",
    descriptionKey: "settings.catalog.tab.session.description",
    keywordsKey: "settings.catalog.tab.session.keywords",
  },
  {
    id: "extensions",
    labelKey: "settings.catalog.tab.extensions.label",
    descriptionKey: "settings.catalog.tab.extensions.description",
    keywordsKey: "settings.catalog.tab.extensions.keywords",
  },
  {
    id: "system",
    labelKey: "settings.catalog.tab.system.label",
    descriptionKey: "settings.catalog.tab.system.description",
    keywordsKey: "settings.catalog.tab.system.keywords",
  },
]);

export interface SettingsEntryMeta {
  /** 全局唯一 id，形如 tab.key（如 appearance.theme）；也是面板里的定位锚点。 */
  id: string;
  tab: SettingsTabId;
  /** 设置行可见标题的 key；SettingsRow 与命令面板共用。 */
  labelKey: string;
  /** 默认说明文案的 key；含动态值的行（当前版本 / 数据目录）由面板覆盖。 */
  descriptionKey: string;
  /** 额外搜索别名的 key（逗号分隔）。 */
  keywordsKey: string;
}

/** 解析后的设置项：标题/说明/别名都已经换成当前语言的文案。 */
export interface SettingsEntryView {
  id: string;
  tab: SettingsTabId;
  label: string;
  description: string;
  keywords: readonly string[];
}

/**
 * 驼峰段 → 语言包 key 段。
 *
 * key 只允许小写字母开头的点分段（scripts/check-locales.mjs 强制），
 * 而设置项 id 用驼峰（appearance.fontSize）更符合 TypeScript 习惯，
 * 因此这里做一次显式转换：fontSize → font.size。
 * id 保持驼峰不变：它是稳定标识（DOM 的 data-setting、测试、命令 id 都用它）。
 */
export function camelToKey(segment: string): string {
  return segment
    .replace(/([a-z0-9])([A-Z])/gu, "$1.$2")
    .toLowerCase();
}

/** 设置项 id → 语言包里的 key 路径（appearance.fontSize → appearance.font.size）。 */
export function settingsKeyPath(id: string): string {
  return id.split(".").map(camelToKey).join(".");
}

/** 一项设置：只声明 key，不写文案。 */
function entry(tab: SettingsTabId, key: string): SettingsEntryMeta {
  const id = tab + "." + key;
  const path = "settings.catalog.entry." + settingsKeyPath(id);
  return {
    id,
    tab,
    labelKey: path + ".label",
    descriptionKey: path + ".description",
    keywordsKey: path + ".keywords",
  };
}

/**
 * 全部设置项（18 项）。
 *
 * 顺序即「设置 → 该页」里的顺序；命令面板在空查询时按这个顺序展示。
 * 扩展页是静态列表（12 个扩展 + 技能 + MCP），没有独立设置行，因此这里没有它的条目。
 *
 * Issue #145 移除了两项与「发布通道」绑定的入口：system.autoUpdate 与
 * system.updateCheck。更新能力还没落地，留一个点了没反应的开关只会误导用户；
 * 真实更新通道接入时把这两项按同样的 key 结构加回来即可。
 */
export const SETTINGS_ENTRIES: readonly SettingsEntryMeta[] = Object.freeze([
  // ── 外观 ────────────────────────────────────────────────────
  entry("appearance", "theme"),
  entry("appearance", "accent"),
  entry("appearance", "fontSize"),
  entry("appearance", "fontFamily"),
  entry("appearance", "codeFont"),
  entry("appearance", "contentWidth"),
  // ── 会话 ────────────────────────────────────────────────────
  entry("session", "sendAfterScroll"),
  entry("session", "enterToSend"),
  entry("session", "showToolCalls"),
  entry("session", "showTimestamps"),
  entry("session", "thinkingLevel"),
  entry("session", "busyDelivery"),
  entry("session", "clearSession"),
  // ── 系统 ────────────────────────────────────────────────────
  entry("system", "notifyOnComplete"),
  entry("system", "minimizeToTray"),
  entry("system", "resetLayout"),
  entry("system", "dataDirectory"),
  entry("system", "about"),
]);

/** id → 元数据；模块加载时建一次，查表 O(1)。 */
const BY_ID = new Map<string, SettingsEntryMeta>(
  SETTINGS_ENTRIES.map((item) => [item.id, item]),
);

/**
 * 按 id 取设置项元数据。
 *
 * 找不到时直接抛错而不是返回占位对象：把 id 拼错（appearance.foo 之类）必须在
 * 第一次渲染就炸掉（Node 测试也能断言），否则界面会安静地显示一个空标题。
 * 错误码保持 ASCII：它是机器可读契约，也是「本文件不含界面文案」的一部分。
 */
export function settingsEntry(id: string): SettingsEntryMeta {
  const found = BY_ID.get(id);
  if (!found) {
    throw new Error("E_SETTINGS_ENTRY_MISSING: unknown settings entry id: " + id);
  }
  return found;
}

/** 某一页的全部设置项元数据；命令面板与设置页共用同一份顺序。 */
export function settingsEntriesFor(tab: SettingsTabId): readonly SettingsEntryMeta[] {
  return SETTINGS_ENTRIES.filter((item) => item.tab === tab);
}

/** 按 id 取标签页元数据；拼错同样直接抛错。 */
export function settingsTab(tab: SettingsTabId): SettingsTabMeta {
  const found = SETTINGS_TABS.find((candidate) => candidate.id === tab);
  if (!found) throw new Error("E_SETTINGS_TAB_MISSING: unknown settings tab: " + tab);
  return found;
}

/**
 * 把「逗号分隔的别名串」拆成数组。
 *
 * 别名放在语言包里而不是代码里，是为了让中文同义词（深色 / 夜间）与英文同义词
 * （dark / night）各自随语言维护；解析规则只有这一处，命令面板与设置页共用。
 */
export function keywordList(raw: string | undefined): readonly string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((word) => word.trim())
    .filter((word) => word.length > 0);
}

/** 解析一条设置项：key → 当前语言的文案。 */
export function settingsEntryView(meta: SettingsEntryMeta, t: Translate): SettingsEntryView {
  return {
    id: meta.id,
    tab: meta.tab,
    label: t(meta.labelKey),
    description: t(meta.descriptionKey),
    keywords: keywordList(t(meta.keywordsKey)),
  };
}

/** 解析一页标签：key → 当前语言的文案。 */
export function settingsTabView(meta: SettingsTabMeta, t: Translate): SettingsTabView {
  return {
    id: meta.id,
    label: t(meta.labelKey),
    description: t(meta.descriptionKey),
    keywords: keywordList(t(meta.keywordsKey)),
  };
}

/** 四页的解析结果（界面顺序不变）。 */
export function settingsTabs(t: Translate): readonly SettingsTabView[] {
  return SETTINGS_TABS.map((meta) => settingsTabView(meta, t));
}

/** 全部设置项的解析结果（界面顺序不变）。 */
export function settingsEntries(t: Translate): readonly SettingsEntryView[] {
  return SETTINGS_ENTRIES.map((meta) => settingsEntryView(meta, t));
}
