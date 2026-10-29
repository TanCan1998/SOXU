/**
 * 外观偏好：界面字号、界面字体、代码字体、正文宽度、强调色（Issue #98 / #116）。
 *
 * 与 theme.ts 采用同一套结构，理由相同：
 * - 初始值必须在 Vue 挂载前就落到 <html data-*>，否则首帧会先按基准值排版再重排；
 * - 读 localStorage、把偏好写进 DOM 都是可注入依赖的纯逻辑，Node 里能直接断言，
 *   不需要浏览器或 Tauri 宿主；
 * - 档位与选项只在 *_OPTIONS 里定义一次，设置面板只渲染这些数据，base.css 只认 data-* 属性。
 *
 * 五项共用同一个存储键 `soxu.appearance`：它们都是「外观」这一件事，逐字段容错
 * （某一项坏了不影响其他项），键名沿用 Issue #98 的旧键，升级不会丢用户已选的字号。
 */

/** 字号档位。base.css 的 :root[data-font-size="..."] 与本类型一一对应。 */
export type FontSizeName = "small" | "standard" | "large" | "xlarge";

/**
 * 界面字体档位。
 *
 * - system：Inter 优先 + 各平台系统栈（默认值，与改动前完全一致）；
 * - sans：只用系统无衬线栈，不加载 Inter（原型 UI_FONT.system）；
 * - serif：衬线栈（中文回退宋体），用于长时间阅读正文的偏好；
 * - mono：界面字体切到等宽栈（--soxu-font-family-ui），会话正文仍用正文栈。
 *
 * 作用域说明（Issue #98 复审澄清）：四项改的都是界面字体 token；代码块与工具输出
 * 始终用 --soxu-font-family-mono，不随这一项变化。所以设置面板文案只能说「界面字体」。
 */
export type FontFamilyName = "system" | "sans" | "serif" | "mono";

/** 强调色色板（Issue #116）。默认 blue = 原型的索序蓝，其余为 V4 决策文档的候选色。 */
export type AccentName = "blue" | "green" | "teal" | "violet" | "rose" | "amber";

/**
 * 代码字体档位（Issue #116）。
 *
 * 三种都只写字体栈、不打包字体文件：JetBrains Mono / Fira Code 未安装时浏览器会
 * 逐级回退到系统等宽栈，所以默认档就是 system（= 改动前的观感，零变化）。
 */
export type CodeFontName = "system" | "jetbrains" | "fira";

/** 会话正文宽度（Issue #116）：固定 768px 或跟随窗口自适应。 */
export type ContentWidthName = "fixed" | "fluid";

/** 一次设置里保存的全部外观项。 */
export interface Appearance {
  fontSize: FontSizeName;
  fontFamily: FontFamilyName;
  codeFont: CodeFontName;
  contentWidth: ContentWidthName;
  accent: AccentName;
}

/**
 * localStorage 键名。与 soxu.theme 同域（同一 localStorage），
 * 单独成键是因为两者独立演进：清掉字号偏好不应该顺便丢掉主题选择。
 * 值是一个 JSON 对象，字段级容错见 readStoredAppearance。
 */
export const APPEARANCE_STORAGE_KEY = "soxu.appearance";

/** 默认值 = 改动前的现状：标准字号 + 系统默认字体 + 系统等宽 + 固定宽度 + 索序蓝。 */
export const DEFAULT_APPEARANCE: Readonly<Appearance> = Object.freeze({
  fontSize: "standard",
  fontFamily: "system",
  codeFont: "system",
  contentWidth: "fixed",
  accent: "blue",
});

/** 只依赖最小存储表面，测试可注入假对象（与 theme.ts 保持一致）。 */
export interface AppearanceStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** 只需要 documentElement.dataset，测试可用 { dataset: {} } 代替整个 document。 */
export interface AppearanceDocumentLike {
  documentElement: { dataset: Record<string, string | undefined> };
}

export interface AppearanceOption<T extends string> {
  value: T;
  label: string;
}

/** 带色值的选项：设置面板要画色块，所以色值必须和 base.css 里的调色板同源。 */
export interface AccentOption extends AppearanceOption<AccentName> {
  /** 色板主色；必须与 base.css 的同名 data-accent 分支一致（tests/appearance.test.ts 核对）。 */
  hex: string;
  /**
   * 主色底上的前景色（发送钮图标、色板勾选），必须与 base.css 同名分支的
   * --soxu-on-accent 一致。取白/墨两者中对比度更高的一侧：蓝绿与琥珀上的白字
   * 只有 2.5 / 2.2 :1，几乎看不见，所以这两档改用深墨色（实测见测试里的对比度用例）。
   */
  onAccent: string;
}

/** 设置面板渲染的字号档位；顺序即界面顺序（小 → 特大）。 */
export const FONT_SIZE_OPTIONS: readonly AppearanceOption<FontSizeName>[] = Object.freeze([
  { value: "small", label: "小" },
  { value: "standard", label: "标准" },
  { value: "large", label: "大" },
  { value: "xlarge", label: "特大" },
]);

/** 设置面板渲染的界面字体档位；顺序即界面顺序，默认档排第一。 */
export const FONT_FAMILY_OPTIONS: readonly AppearanceOption<FontFamilyName>[] = Object.freeze([
  { value: "system", label: "Inter" },
  { value: "sans", label: "系统栈" },
  { value: "serif", label: "衬线" },
  { value: "mono", label: "等宽" },
]);

/** 强调色色板：六色，顺序即界面顺序（蓝 → 琥珀）。 */
export const ACCENT_OPTIONS: readonly AccentOption[] = Object.freeze([
  // blue 是默认色：沿用改动前的白色前景（默认观感零变化），对比度 3.64:1 仍满足非文本 3:1。
  { value: "blue", label: "索序蓝", hex: "#3a83f7", onAccent: "#ffffff" },
  { value: "green", label: "青绿", hex: "#10a37f", onAccent: "#191717" },
  { value: "teal", label: "蓝绿", hex: "#14b8a6", onAccent: "#191717" },
  { value: "violet", label: "紫罗兰", hex: "#8b5cf6", onAccent: "#ffffff" },
  { value: "rose", label: "玫红", hex: "#f43f5e", onAccent: "#191717" },
  { value: "amber", label: "琥珀", hex: "#f59e0b", onAccent: "#191717" },
]);

/** 代码字体档位；默认档（系统等宽）排第一，另两档需要本机已安装对应字体。 */
export const CODE_FONT_OPTIONS: readonly AppearanceOption<CodeFontName>[] = Object.freeze([
  { value: "system", label: "系统等宽" },
  { value: "jetbrains", label: "JetBrains Mono" },
  { value: "fira", label: "Fira Code" },
]);

/** 正文宽度档位。 */
export const CONTENT_WIDTH_OPTIONS: readonly AppearanceOption<ContentWidthName>[] = Object.freeze([
  { value: "fixed", label: "固定 768" },
  { value: "fluid", label: "自适应" },
]);

export function isFontSizeName(value: unknown): value is FontSizeName {
  return (
    value === "small" || value === "standard" || value === "large" || value === "xlarge"
  );
}

export function isFontFamilyName(value: unknown): value is FontFamilyName {
  return (
    value === "system" || value === "sans" || value === "serif" || value === "mono"
  );
}

export function isAccentName(value: unknown): value is AccentName {
  return (
    value === "blue" ||
    value === "green" ||
    value === "teal" ||
    value === "violet" ||
    value === "rose" ||
    value === "amber"
  );
}

export function isCodeFontName(value: unknown): value is CodeFontName {
  return value === "system" || value === "jetbrains" || value === "fira";
}

export function isContentWidthName(value: unknown): value is ContentWidthName {
  return value === "fixed" || value === "fluid";
}

/**
 * 读持久化的外观偏好。
 *
 * 逐字段校验而不是整体丢弃：只坏了其中一项时，其他项仍然照用户的选择保留；
 * 存储不可用（隐私模式/被策略禁用）或 JSON 解析失败都退回默认值，绝不抛错。
 */
export function readStoredAppearance(
  storage: AppearanceStorageLike | null | undefined = defaultStorage(),
): Appearance {
  const fallback: Appearance = { ...DEFAULT_APPEARANCE };
  if (!storage) return fallback;

  let raw: string | null;
  try {
    raw = storage.getItem(APPEARANCE_STORAGE_KEY);
  } catch {
    return fallback;
  }
  if (!raw) return fallback;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fallback;
  }
  if (typeof parsed !== "object" || parsed === null) return fallback;

  return normalizeAppearance(parsed as Record<string, unknown>);
}

/** 逐字段归一：脏字段退回默认值，合法字段原样保留。 */
export function normalizeAppearance(record: Record<string, unknown>): Appearance {
  return {
    fontSize: isFontSizeName(record.fontSize) ? record.fontSize : DEFAULT_APPEARANCE.fontSize,
    fontFamily: isFontFamilyName(record.fontFamily)
      ? record.fontFamily
      : DEFAULT_APPEARANCE.fontFamily,
    codeFont: isCodeFontName(record.codeFont) ? record.codeFont : DEFAULT_APPEARANCE.codeFont,
    contentWidth: isContentWidthName(record.contentWidth)
      ? record.contentWidth
      : DEFAULT_APPEARANCE.contentWidth,
    accent: isAccentName(record.accent) ? record.accent : DEFAULT_APPEARANCE.accent,
  };
}

/** 启动时的外观：用户选过的优先，否则用默认值（= 现状）。 */
export function resolveInitialAppearance(
  env: { storage?: AppearanceStorageLike | null } = {},
): Appearance {
  return readStoredAppearance(env.storage === undefined ? defaultStorage() : env.storage);
}

/**
 * 持久化外观；只写入已知字段，脏字段不会通过这里回写到存储。
 * 写入失败（配额、隐私模式）不算错误，只是下次启动回到默认值。
 */
export function persistAppearance(
  appearance: Appearance,
  storage: AppearanceStorageLike | null | undefined = defaultStorage(),
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(
      APPEARANCE_STORAGE_KEY,
      JSON.stringify(normalizeAppearance(appearance as unknown as Record<string, unknown>)),
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * 把外观写到 <html data-font-size data-font-family data-code-font data-content-width data-accent>：
 * base.css 只按这些属性切换 token，组件里不出现任何档位判断。
 * 必须同步生效（不能等下一帧），否则改动字号时新一帧仍按旧 token 排版。
 */
export function applyDocumentAppearance(
  appearance: Appearance,
  doc: AppearanceDocumentLike | null | undefined = defaultDocument(),
): void {
  if (!doc) return;
  const normalized = normalizeAppearance(appearance as unknown as Record<string, unknown>);
  const { dataset } = doc.documentElement;
  dataset.fontSize = normalized.fontSize;
  dataset.fontFamily = normalized.fontFamily;
  dataset.codeFont = normalized.codeFont;
  dataset.contentWidth = normalized.contentWidth;
  dataset.accent = normalized.accent;
}

function defaultStorage(): AppearanceStorageLike | null {
  if (typeof localStorage === "undefined") return null;
  return localStorage;
}

function defaultDocument(): AppearanceDocumentLike | null {
  if (typeof document === "undefined") return null;
  return document as unknown as AppearanceDocumentLike;
}
