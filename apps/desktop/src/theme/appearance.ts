/**
 * 外观偏好：界面字号与字体族（Issue #98）。
 *
 * 与 theme.ts 采用同一套结构，理由相同：
 * - 初始值必须在 Vue 挂载前就落到 <html data-font-size data-font-family>，
 *   否则首帧会先按基准字号/基准字体排版再重排，启动时能看见文字跳动；
 * - 读 localStorage、把偏好写进 DOM 都是可注入依赖的纯逻辑，Node 里能直接断言，
 *   不需要浏览器或 Tauri 宿主；
 * - 字号档位与字体族选项只在 FONT_SIZE_OPTIONS / FONT_FAMILY_OPTIONS 定义一次，
 *   设置面板只渲染这些数据，base.css 只认 data-* 属性，避免两处各写一份映射。
 */

/** 字号档位。base.css 的 :root[data-font-size="..."] 与本类型一一对应。 */
export type FontSizeName = "small" | "standard" | "large" | "xlarge";

/**
 * 字体族档位。
 *
 * - system：系统默认（沿用改动前的界面字体栈，默认值）；
 * - sans：通用无衬线栈，跨平台观感更统一；
 * - mono：界面字体切到等宽栈（--soxu-font-family-ui），会话正文仍用正文栈
 *   （--soxu-font-family-body），因此「不影响正文」成立。
 *
 * 作用域说明（Issue #98 复审澄清）：三项字体档改的都是界面字体 token；代码块与工具输出
 * 始终用 --soxu-font-family-mono，本来就恒等宽，不随这一项变化。Issue 技术路径里写的
 * 「等宽档只影响代码/工具输出块」在本项目里做不到「有可见效果」——代码块已是等宽，
 * 若等宽档连界面字体都不改，这一档就等于什么都没做。所以作用域如实定为「界面字体」，
 * 设置面板文案与本注释、证据文档三者保持同一说法。
 */
export type FontFamilyName = "system" | "sans" | "mono";

/** 一次设置里保存的全部外观项。 */
export interface Appearance {
  fontSize: FontSizeName;
  fontFamily: FontFamilyName;
}

/**
 * localStorage 键名。与 soxu.theme 同域（同一 localStorage），
 * 单独成键是因为两者独立演进：清掉字号偏好不应该顺便丢掉主题选择。
 * 值是一个 JSON 对象 `{"fontSize":...,"fontFamily":...}`，字段级容错见 readStoredAppearance。
 */
export const APPEARANCE_STORAGE_KEY = "soxu.appearance";

/** 默认值 = 改动前的现状：标准字号 + 系统默认字体，视觉零变化。 */
export const DEFAULT_APPEARANCE: Readonly<Appearance> = Object.freeze({
  fontSize: "standard",
  fontFamily: "system",
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

/** 设置面板渲染的字号档位；顺序即界面顺序（小 → 特大）。 */
export const FONT_SIZE_OPTIONS: readonly AppearanceOption<FontSizeName>[] = Object.freeze([
  { value: "small", label: "小" },
  { value: "standard", label: "标准" },
  { value: "large", label: "大" },
  { value: "xlarge", label: "特大" },
]);

/** 设置面板渲染的字体族档位；顺序即界面顺序。 */
export const FONT_FAMILY_OPTIONS: readonly AppearanceOption<FontFamilyName>[] = Object.freeze([
  { value: "system", label: "系统默认" },
  { value: "sans", label: "无衬线" },
  { value: "mono", label: "等宽" },
]);

export function isFontSizeName(value: unknown): value is FontSizeName {
  return (
    value === "small" || value === "standard" || value === "large" || value === "xlarge"
  );
}

export function isFontFamilyName(value: unknown): value is FontFamilyName {
  return value === "system" || value === "sans" || value === "mono";
}

/**
 * 读持久化的外观偏好。
 *
 * 逐字段校验而不是整体丢弃：只坏了其中一项时，另一项仍然照用户的选择保留；
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

  const record = parsed as Record<string, unknown>;
  return {
    fontSize: isFontSizeName(record.fontSize) ? record.fontSize : fallback.fontSize,
    fontFamily: isFontFamilyName(record.fontFamily) ? record.fontFamily : fallback.fontFamily,
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
  const normalized: Appearance = {
    fontSize: isFontSizeName(appearance.fontSize) ? appearance.fontSize : DEFAULT_APPEARANCE.fontSize,
    fontFamily: isFontFamilyName(appearance.fontFamily)
      ? appearance.fontFamily
      : DEFAULT_APPEARANCE.fontFamily,
  };
  try {
    storage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(normalized));
    return true;
  } catch {
    return false;
  }
}

/**
 * 把外观写到 <html data-font-size data-font-family>：base.css 只按这两个属性切换
 * 字号缩放与字体栈 token，组件里不出现任何档位判断。
 * 必须同步生效（不能等下一帧），否则改动字号时新一帧仍按旧 token 排版。
 */
export function applyDocumentAppearance(
  appearance: Appearance,
  doc: AppearanceDocumentLike | null | undefined = defaultDocument(),
): void {
  if (!doc) return;
  const { dataset } = doc.documentElement;
  dataset.fontSize = isFontSizeName(appearance.fontSize)
    ? appearance.fontSize
    : DEFAULT_APPEARANCE.fontSize;
  dataset.fontFamily = isFontFamilyName(appearance.fontFamily)
    ? appearance.fontFamily
    : DEFAULT_APPEARANCE.fontFamily;
}

function defaultStorage(): AppearanceStorageLike | null {
  if (typeof localStorage === "undefined") return null;
  return localStorage;
}

function defaultDocument(): AppearanceDocumentLike | null {
  if (typeof document === "undefined") return null;
  return document as unknown as AppearanceDocumentLike;
}
