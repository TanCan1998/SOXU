/**
 * 主题切换：从点击位置做圆形扩散，扩散边缘带一圈发光涟漪。
 *
 * 为什么单独成模块（而不是写进 App.vue）：
 * - 圆心、半径、降级判断都是纯逻辑，可以在 Node 里用假 document 覆盖；
 * - View Transitions 的快照位于浏览器 top layer 的最上层，普通 z-index 元素会被完全盖住；
 *   popover 能进 top layer，但实测仍压在"旧快照"下面，只有落在已经揭开的新区域内才可见
 *   （见 docs/development/evidence/issue-88-theme-transition/README.md 的像素证据）。
 *   因此发光环必须比扩散边缘略微滞后，才能一直处在已揭开的区域里；
 * - View Transitions 的伪元素在 finished 之后就销毁了，扩散到边界后的水波只有在此刻才完整可见，
 *   所以"涟漪淡出"必须靠过渡类名之外的真实节点存活到淡出结束，不能写成 ::view-transition-* 动画；
 * - 快速连点时浏览器会跳过上一个过渡，用自增 runId 做代际守卫，避免旧过渡清理掉新过渡的 DOM。
 *
 * 几何量与时长由本模块写到 :root 的内联样式，base.css 只负责消费，避免两处各写一份常量。
 */

import { nextTick } from "vue";

import type { ThemeName } from "./theme.ts";

// 主题名的唯一定义在 theme.ts；这里转发一次，保持既有导入路径可用。
export type { ThemeName };

/** 扩散时长（毫秒）；CSS 通过 --soxu-theme-duration 读取同一数值。 */
export const THEME_TRANSITION_DURATION_MS = 420;
/**
 * 发光环相对扩散边缘的滞后量（毫秒）。
 * 快照永远盖在 top layer 元素上面，只有"已经揭开"的区域才看得见光晕；
 * 实测光晕动画会因插入时机比扩散早启动几十毫秒而跑到边缘外面被旧快照盖住，
 * 所以这里让它整体延后并压缩到同一结束时刻，保证始终跟在边缘内侧。
 */
export const THEME_GLOW_LAG_MS = 30;
/** 缓动：先快后慢，控制点都在 [0, 1] 内，不会出现过冲回弹。 */
export const THEME_TRANSITION_EASING = "cubic-bezier(0.22, 0.61, 0.36, 1)";
/** 过渡进行中挂在 <html> 上的类名，CSS 依赖它限定 ::view-transition-* 规则。 */
export const THEME_TRANSITION_CLASS = "soxu-theme-transition";
/** 发光涟漪容器（top layer popover）的类名，淡出结束后必须从 DOM 移除。 */
export const THEME_GLOW_CLASS = "soxu-theme-glow";
/** 追着扩散边缘推进的光晕层。 */
export const THEME_GLOW_EDGE_CLASS = "soxu-theme-glow__edge";
/** 扩散抵达边界后沿边缘向外轻轻散开的水波层。 */
export const THEME_RIPPLE_CLASS = "soxu-theme-glow__ripple";
/**
 * 水波淡出时长（毫秒）：扩散结束后涟漪继续可见这么久。
 * Issue #97 要求落在 300–600ms；CSS 通过 --soxu-theme-ripple-duration 读取同一数值。
 */
export const THEME_RIPPLE_FADE_MS = 480;
/**
 * 淡出结束后额外等待的余量：最后一帧要真正画完再摘节点，
 * 否则水波会在还没透明时就整块消失。CSS 端不用这个值，只供 JS 计时。
 */
export const THEME_RIPPLE_SETTLE_MS = 60;
/** 从扩散结束算起，涟漪需要保留的总时长，用于清理计时与测试断言。 */
export const THEME_RIPPLE_TOTAL_MS = THEME_RIPPLE_FADE_MS + THEME_RIPPLE_SETTLE_MS;

export interface ViewportSize {
  width: number;
  height: number;
}

export interface ThemeOrigin {
  x: number;
  y: number;
}

/** 点击事件里我们只关心这两个坐标，声明成结构化类型便于测试。 */
export interface PointerLike {
  clientX?: number;
  clientY?: number;
}

export interface ThemeTransitionResult {
  /** animated 表示真的播放了圆形扩散；instant 表示直接切换。 */
  mode: "animated" | "instant";
  reason: "animated" | "unsupported" | "reduced-motion" | "no-document" | "start-failed";
  origin: ThemeOrigin;
  radius: number;
}

/** 只依赖最小 DOM 表面，测试可注入假对象。 */
interface StyleLike {
  setProperty(name: string, value: string): void;
}

interface ClassListLike {
  add(token: string): void;
  remove(token: string): void;
}

interface TransitionLike {
  ready: Promise<void>;
  finished: Promise<void>;
}

interface TransitionRootLike {
  classList: ClassListLike;
  style: StyleLike;
}

interface GlowElementLike {
  className: string;
  style: StyleLike;
  setAttribute(name: string, value: string): void;
  /** 容器挂光晕层/水波层；缺省的实现只是没有光晕，不影响扩散。 */
  appendChild?(child: GlowElementLike): unknown;
  remove(): void;
  showPopover?(): void;
}

export interface ThemeDocumentLike {
  documentElement: TransitionRootLike;
  body: { appendChild(child: never): unknown } | null;
  createElement(tagName: string): GlowElementLike;
  startViewTransition?(update: () => void | Promise<void>): TransitionLike;
}

export interface ThemeTransitionEnv {
  /** 默认取全局 document；显式传 null 表示没有 DOM。 */
  document?: ThemeDocumentLike | null;
  viewport?: ViewportSize;
  /** 默认读取 prefers-reduced-motion。 */
  reducedMotion?: boolean;
  /** 等新主题渲染进 DOM；默认 Vue 的 nextTick。 */
  flush?: () => Promise<void>;
  /** 等涟漪淡出（毫秒）；默认 setTimeout，测试注入立即返回的实现以免真的等 540ms。 */
  waitForRipple?: (ms: number) => Promise<void>;
}

export interface ThemeTransitionOptions {
  /** 点击坐标；缺省（例如设置对话框）时从视口中心扩散。 */
  origin?: PointerLike | null;
  /** 真正写入主题状态的回调，由调用方更新响应式数据。 */
  commit: () => void | Promise<void>;
  env?: ThemeTransitionEnv;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** 圆心：取点击坐标并夹到视口内；没有坐标时用视口中心。 */
export function resolveOrigin(pointer: PointerLike | null | undefined, viewport: ViewportSize): ThemeOrigin {
  const width = Math.max(0, finiteOr(viewport.width, 0));
  const height = Math.max(0, finiteOr(viewport.height, 0));
  return {
    x: clamp(finiteOr(pointer?.clientX, width / 2), 0, width),
    y: clamp(finiteOr(pointer?.clientY, height / 2), 0, height),
  };
}

/**
 * 覆盖半径：圆心到视口最远角的距离，向上取整。
 * 取最大值而不是对角线，保证圆心贴在角落时也不会露出一块没切换的区域。
 */
export function coverRadius(origin: ThemeOrigin, viewport: ViewportSize): number {
  const width = Math.max(0, finiteOr(viewport.width, 0));
  const height = Math.max(0, finiteOr(viewport.height, 0));
  const dx = Math.max(clamp(origin.x, 0, width), width - clamp(origin.x, 0, width));
  const dy = Math.max(clamp(origin.y, 0, height), height - clamp(origin.y, 0, height));
  return Math.ceil(Math.hypot(dx, dy));
}

let activeRunId = 0;
let activeGlow: GlowElementLike | null = null;

/**
 * 切换主题：能动画就做圆形扩散，否则直接提交。
 * 无论走哪条路径，commit 都只执行一次，且所有 DOM 副作用都会被清理。
 */
export async function runThemeTransition(options: ThemeTransitionOptions): Promise<ThemeTransitionResult> {
  const env = options.env ?? {};
  const viewport = env.viewport ?? defaultViewport();
  const origin = resolveOrigin(options.origin ?? null, viewport);
  const radius = coverRadius(origin, viewport);
  const doc = env.document === undefined ? defaultDocument() : env.document;

  // 任何路径都只提交一次：同步抛错后补一次提交时不会重复改状态
  let commitDone = false;
  const commitOnce = async (): Promise<void> => {
    if (commitDone) return;
    commitDone = true;
    await options.commit();
  };

  if (!doc) {
    await commitOnce();
    return { mode: "instant", reason: "no-document", origin, radius };
  }
  if (env.reducedMotion ?? defaultReducedMotion()) {
    await commitOnce();
    return { mode: "instant", reason: "reduced-motion", origin, radius };
  }
  const startViewTransition = doc.startViewTransition?.bind(doc);
  if (typeof startViewTransition !== "function") {
    await commitOnce();
    return { mode: "instant", reason: "unsupported", origin, radius };
  }

  // 新过渡接管：上一次的发光涟漪可能还在淡出，先整块摘掉再开始，避免两代水波重叠。
  activeGlow?.remove();
  activeGlow = null;

  const runId = (activeRunId += 1);
  const root = doc.documentElement;
  writeGeometry(root, origin, radius);
  root.classList.add(THEME_TRANSITION_CLASS);

  let glow: GlowElementLike | null = null;
  let transition: TransitionLike;
  try {
    transition = startViewTransition(async () => {
      await commitOnce();
      // 快照在这一步之后拍摄，必须等 Vue 把新主题刷进 DOM，否则会拍到旧画面
      await (env.flush ?? nextTick)();
    });
  } catch {
    // startViewTransition 同步抛错（浏览器策略禁用、被其他过渡占用等）时
    // 回调根本不会执行；此时必须自己提交主题，否则点击按钮会静默无效。
    releaseTransitionClass(runId, root);
    await commitOnce();
    return { mode: "instant", reason: "start-failed", origin, radius };
  }

  let interrupted = false;
  try {
    // ready 时快照已经拍完：此刻插入发光涟漪才不会被拍进新旧快照里
    await transition.ready;
    glow = mountGlowLayer(doc, origin, radius);
    if (glow) activeGlow = glow;
    await transition.finished;
  } catch {
    // 连点或页面切走时浏览器会跳过过渡，ready/finished 以 AbortError 拒绝；
    // 这里只做清理，主题状态已经在 commit 里生效，不需要回滚。
    interrupted = true;
  }

  // 类名一到 finished 就撤：::view-transition-* 规则已经用不上，涟漪层接管剩下的淡出。
  releaseTransitionClass(runId, root);
  if (glow) {
    // 被跳过/中断的过渡没有完整的水波可看，立刻摘掉；正常结束才等淡出跑完再回收节点。
    if (!interrupted && runId === activeRunId) {
      await (env.waitForRipple ?? defaultWaitForRipple)(THEME_RIPPLE_TOTAL_MS);
    }
    releaseGlow(glow);
  }
  return { mode: "animated", reason: "animated", origin, radius };
}

/** 摘掉自己这一代的发光涟漪节点，并清掉全局引用。重复调用是安全的。 */
function releaseGlow(glow: GlowElementLike | null): void {
  glow?.remove();
  if (activeGlow === glow) activeGlow = null;
}

/** 撤掉过渡类名；已有更新的过渡接管时保持原样。 */
function releaseTransitionClass(runId: number, root: TransitionRootLike): void {
  if (runId !== activeRunId) return;
  root.classList.remove(THEME_TRANSITION_CLASS);
}

function writeGeometry(root: TransitionRootLike, origin: ThemeOrigin, radius: number): void {
  root.style.setProperty("--soxu-theme-x", `${origin.x}px`);
  root.style.setProperty("--soxu-theme-y", `${origin.y}px`);
  root.style.setProperty("--soxu-theme-r", `${radius}px`);
  root.style.setProperty("--soxu-theme-duration", `${THEME_TRANSITION_DURATION_MS}ms`);
  root.style.setProperty("--soxu-theme-easing", THEME_TRANSITION_EASING);
  // 发光环与扩散同时结束，但起步更晚，形成"光晕追着边缘跑"的涟漪
  root.style.setProperty("--soxu-theme-glow-delay", `${THEME_GLOW_LAG_MS}ms`);
  root.style.setProperty(
    "--soxu-theme-glow-duration",
    `${Math.max(120, THEME_TRANSITION_DURATION_MS - THEME_GLOW_LAG_MS)}ms`,
  );
  // 水波在扩散结束的那一刻起跑，与扩散首尾相接，不会在覆盖过程中被旧快照挡掉
  root.style.setProperty("--soxu-theme-ripple-delay", `${THEME_TRANSITION_DURATION_MS}ms`);
  root.style.setProperty("--soxu-theme-ripple-duration", `${THEME_RIPPLE_FADE_MS}ms`);
}

/**
 * 发光涟漪：一个 0×0 的 top layer 容器 + 两层圆圈。
 * - edge：跟随扩散边缘推进的光晕；
 * - ripple：抵达边界后沿边缘向外散开并淡出的水波（Issue #97）。
 * ::view-transition-* 只支持裁切，box-shadow 不会跟随 clip-path，所以用独立节点实现。
 * popover 是让节点进入 top layer 的唯一纯前端手段；不支持时保留扩散、放弃发光。
 */
function mountGlowLayer(
  doc: ThemeDocumentLike,
  origin: ThemeOrigin,
  radius: number,
): GlowElementLike | null {
  const body = doc.body;
  if (!body) return null;
  const layer = doc.createElement("div");
  layer.className = THEME_GLOW_CLASS;
  layer.setAttribute("aria-hidden", "true");
  // 没有 popover 属性时 showPopover() 会抛 NotSupportedError，节点就留在普通层里被快照盖住
  layer.setAttribute("popover", "manual");
  layer.style.setProperty("--soxu-theme-x", `${origin.x}px`);
  layer.style.setProperty("--soxu-theme-y", `${origin.y}px`);
  layer.style.setProperty("--soxu-theme-r", `${radius}px`);
  // 两层都是绝对定位的圆圈，圆心由容器左上角（= 点击点）给出，随容器的自定义属性缩放
  if (typeof layer.appendChild === "function") {
    for (const className of [THEME_GLOW_EDGE_CLASS, THEME_RIPPLE_CLASS]) {
      const sublayer = doc.createElement("div");
      sublayer.className = className;
      layer.appendChild(sublayer);
    }
  }
  body.appendChild(layer as never);
  if (typeof layer.showPopover === "function") {
    try {
      layer.showPopover();
    } catch {
      // 已经打开了别的 popover 等情况：没有发光涟漪也不影响扩散
    }
  }
  return layer;
}

/** 默认的淡出等待：真实计时即可，节点在动画结束后才被移除。 */
function defaultWaitForRipple(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultDocument(): ThemeDocumentLike | null {
  if (typeof document === "undefined") return null;
  return document as unknown as ThemeDocumentLike;
}

function defaultViewport(): ViewportSize {
  if (typeof window === "undefined") return { width: 0, height: 0 };
  return { width: window.innerWidth || 0, height: window.innerHeight || 0 };
}

function defaultReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}
