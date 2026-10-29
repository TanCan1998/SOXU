/**
 * 悬浮提示的位置映射（Issue #111 · V4-S1）。
 *
 * 提示不该一律向上弹：贴在窗口右侧的元素向上弹会被窗口边缘裁掉，
 * 贴在底部的输入区向上弹则会盖住正在编辑的文字。
 * 这里把「元素相对视口的位置」映射成 reka-ui Tooltip 的 `side`：
 * - 靠右的元素 → 提示弹在左侧；
 * - 靠左的元素 → 弹在右侧；
 * - 底部区域的元素 → 向上弹；
 * - 其余（顶部/中部）→ 向上弹，与既有观感一致。
 *
 * 纯函数：调用方传矩形与视口尺寸，Node 里可直接断言，不依赖 DOM。
 */

export type TooltipSide = "top" | "right" | "bottom" | "left";

export interface AnchorRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface ViewportSize {
  width: number;
  height: number;
}

/** 右/左判定阈值：中心点落在视口 60% 右侧算「右元素」，40% 左侧算「左元素」。 */
export const HORIZONTAL_EDGE_RATIO = 0.6;

/** 底部判定阈值：中心点低于视口 72% 高度算「底部元素」，提示向上弹。 */
export const BOTTOM_EDGE_RATIO = 0.72;

export function resolveTooltipSide(rect: AnchorRect, viewport: ViewportSize): TooltipSide {
  if (viewport.width <= 0 || viewport.height <= 0) return "top";

  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;

  // 底部优先：输入区/底部工具条向上弹是唯一不会挡住内容的方向。
  if (centerY >= viewport.height * BOTTOM_EDGE_RATIO) return "top";
  if (centerX >= viewport.width * HORIZONTAL_EDGE_RATIO) return "left";
  if (centerX <= viewport.width * (1 - HORIZONTAL_EDGE_RATIO)) return "right";
  return "top";
}
