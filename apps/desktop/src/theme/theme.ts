/**
 * 主题偏好：读取、持久化、写入 DOM。
 *
 * 为什么单独成模块（而不是继续写在 App.vue 里）：
 * - 主题的"初始值"必须在 Vue 挂载前就落到 <html data-theme>，否则 :root 上的 token
 *   与 color-scheme 还是浅色，深色主题启动时会先闪一帧浅色（Issue #86 的"顶部偏浅"）；
 * - 读 localStorage、读系统偏好、写 DOM 都是可注入依赖的纯逻辑，能在 Node 里直接断言，
 *   不需要浏览器或 Tauri 宿主；
 * - 原生窗口标题栏的同步是另一层适配（见 windowTheme.ts），这里只定义最小接口。
 */

/** 应用主题名。base.css 的 :root[data-theme="dark"] 与本类型一一对应。 */
export type ThemeName = "light" | "dark";

/** localStorage 的键名；改这里等于丢弃用户已有的主题偏好。 */
export const THEME_STORAGE_KEY = "soxu.theme";

/** 只依赖最小存储表面，测试可注入假对象。 */
export interface ThemeStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** matchMedia 的最小表面：只关心某条媒体查询当前是否命中。 */
export type ThemeMatchMediaLike = (query: string) => { matches: boolean };

/** 原生窗口的最小表面，真实实现见 windowTheme.ts。 */
export interface ThemeWindowTarget {
  setTheme(theme: ThemeName): Promise<void>;
}

/** 只需要 documentElement.dataset，测试可用 { dataset: {} } 代替整个 document。 */
export interface ThemeDocumentLike {
  documentElement: { dataset: Record<string, string | undefined> };
}

export function isThemeName(value: unknown): value is ThemeName {
  return value === "light" || value === "dark";
}

/** 读持久化的主题；存储不可用或存了脏值时返回 null（交给系统偏好决定）。 */
export function readStoredTheme(
  storage: ThemeStorageLike | null | undefined = defaultStorage(),
): ThemeName | null {
  if (!storage) return null;
  try {
    const stored = storage.getItem(THEME_STORAGE_KEY);
    return isThemeName(stored) ? stored : null;
  } catch {
    // 隐私模式/被策略禁用时 getItem 会抛错，此时按"没有偏好"处理
    return null;
  }
}

/** 系统是否偏好深色；没有 matchMedia 的环境按浅色处理。 */
export function prefersDarkScheme(
  matchMedia: ThemeMatchMediaLike | null | undefined = defaultMatchMedia(),
): boolean {
  if (!matchMedia) return false;
  try {
    return matchMedia("(prefers-color-scheme: dark)").matches === true;
  } catch {
    return false;
  }
}

/**
 * 初始主题：用户显式选过的优先，否则跟随系统。
 * 与 base.css 的 token 定义保持单一语义：light 是默认值，dark 由 data-theme 覆盖。
 */
export function resolveInitialTheme(
  env: {
    storage?: ThemeStorageLike | null;
    matchMedia?: ThemeMatchMediaLike | null;
  } = {},
): ThemeName {
  const stored = readStoredTheme(env.storage === undefined ? defaultStorage() : env.storage);
  if (stored) return stored;
  const matchMedia = env.matchMedia === undefined ? defaultMatchMedia() : env.matchMedia;
  return prefersDarkScheme(matchMedia) ? "dark" : "light";
}

/** 持久化主题；写入失败（配额、隐私模式）不算错误，只是下次启动跟随系统。 */
export function persistTheme(
  theme: ThemeName,
  storage: ThemeStorageLike | null | undefined = defaultStorage(),
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(THEME_STORAGE_KEY, theme);
    return true;
  } catch {
    return false;
  }
}

/**
 * 把主题写到 <html data-theme>：base.css 用 :root[data-theme="dark"] 覆盖 token，
 * 顺带让 color-scheme、原生滚动条、表单控件和 body 背景一起跟随。
 * 必须同步生效（不能等下一帧），否则主题过渡的新快照会拍到旧配色。
 */
export function applyDocumentTheme(
  theme: ThemeName,
  doc: ThemeDocumentLike | null | undefined = defaultDocument(),
): void {
  if (!doc) return;
  doc.documentElement.dataset.theme = theme;
}

/** 同步结果：applied 真的改了窗口；skipped 没有窗口（浏览器预览）；failed 平台不支持或 IPC 报错。 */
export type WindowThemeSyncResult = "applied" | "skipped" | "failed";

/**
 * 把主题同步给原生窗口装饰（标题栏）。
 *
 * CSS token 管不到系统绘制的标题栏，必须显式调用 setTheme；Linux 的 GTK 不支持窗口级主题、
 * 浏览器预览也没有窗口对象，两种情况都只返回 skipped/failed，绝不抛错打断主题切换。
 */
export async function syncWindowTheme(
  theme: ThemeName,
  target: ThemeWindowTarget | null | undefined,
): Promise<WindowThemeSyncResult> {
  if (!target) return "skipped";
  try {
    await target.setTheme(theme);
    return "applied";
  } catch {
    return "failed";
  }
}

function defaultStorage(): ThemeStorageLike | null {
  if (typeof localStorage === "undefined") return null;
  return localStorage;
}

function defaultMatchMedia(): ThemeMatchMediaLike | null {
  if (typeof matchMedia !== "function") return null;
  return matchMedia;
}

function defaultDocument(): ThemeDocumentLike | null {
  if (typeof document === "undefined") return null;
  return document as unknown as ThemeDocumentLike;
}
