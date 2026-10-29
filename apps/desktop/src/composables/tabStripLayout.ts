/**
 * 会话 Tab 栏的等宽计算与拖拽落位判定（纯函数，Issue #99）。
 *
 * 组件只负责 DOM 测量与事件接线，尺寸/落位规则放在这里：
 * 这样「1/3/8 个 Tab 多宽」「拖到第几位」可以用普通 Node 用例验证，
 * 不需要为每次调参跑一遍浏览器。
 */

/** 单个 Tab 的最小宽度：再窄标题就没法看，改为横向滚动（`.tabs-scroll`）。 */
export const TAB_MIN_WIDTH = 96;
/** 单个 Tab 的最大宽度：Tab 少时不把标题栏拉成一整条大块。 */
export const TAB_MAX_WIDTH = 220;
/** Tab 间距，必须与 `SessionTabs.vue` 里 `.tabs-scroll` 的 gap 一致。 */
export const TAB_GAP = 6;
/**
 * 拖拽启动阈值：位移超过这个值才认定为拖动。
 *
 * 指针事件在点击时也会产生 1~3px 抖动，没有阈值会把「点一下切会话」变成「微调顺序」。
 */
export const DRAG_THRESHOLD_PX = 6;

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function clampIndex(index: number, total: number): number {
  if (total <= 0) return 0;
  return clamp(Math.trunc(index), 0, total - 1);
}

/**
 * 等宽：把可用宽度均分给 N 个 Tab，再夹到 [TAB_MIN_WIDTH, TAB_MAX_WIDTH]。
 *
 * 向下取整是为了让 N 个固定宽度 + (N-1) 个 gap 永远不超过容器，
 * 否则每个 Tab 多出半像素就会把整条栏推成「能滚动但只多 1px」的假溢出。
 */
export function tabWidth(count: number, availableWidth: number): number {
  if (count <= 0) return TAB_MAX_WIDTH;
  if (!Number.isFinite(availableWidth) || availableWidth <= 0) return TAB_MIN_WIDTH;
  const usable = availableWidth - TAB_GAP * (count - 1);
  const shared = usable / count;
  if (!Number.isFinite(shared) || shared <= 0) return TAB_MIN_WIDTH;
  return clamp(Math.floor(shared), TAB_MIN_WIDTH, TAB_MAX_WIDTH);
}

/** 是否需要横向滚动：等宽已经被下限夹住，说明按最小宽度也放不下。 */
export function overflows(count: number, availableWidth: number): boolean {
  if (count <= 0 || !Number.isFinite(availableWidth) || availableWidth <= 0) return false;
  return TAB_MIN_WIDTH * count + TAB_GAP * (count - 1) > availableWidth;
}

/**
 * 由指针位置判定落位下标。
 *
 * `centers` 是拖动开始时各 Tab 的水平中心（含被拖的那个）；`pointerX` 是当前指针坐标。
 * 规则：最终下标 = 其余 Tab 中「中心还在指针左侧」的个数。指针跨过某个 Tab 的中心，
 * 顺序就跟着换，与用户看到的让位动画一致；左右移动用同一套判定，不需要分方向特判。
 */
export function dropIndex(centers: readonly number[], fromIndex: number, pointerX: number): number {
  const total = centers.length;
  if (total === 0) return 0;
  const origin = clampIndex(fromIndex, total);
  if (!Number.isFinite(pointerX)) return origin;
  let target = 0;
  for (let index = 0; index < total; index += 1) {
    if (index === origin) continue;
    const center = centers[index];
    if (typeof center === "number" && center < pointerX) target += 1;
  }
  return clampIndex(target, total);
}

/**
 * 让位方向：正在被拖的 Tab 从 `fromIndex` 落到 `toIndex` 时，
 * 第 `index` 个 Tab 应该平移几个槽位。
 *
 * 返回 -1 表示左移一格、1 表示右移一格、0 表示不动。
 * 组件把它乘以槽距（宽度 + gap）作为 transform，于是「其它 Tab 平移让位」只是同一份数据的渲染结果，
 * 松手时的落位与动画中的空位必然一致。
 */
export function slotShift(index: number, fromIndex: number, toIndex: number): number {
  if (fromIndex === toIndex) return 0;
  if (fromIndex < toIndex) return index > fromIndex && index <= toIndex ? -1 : 0;
  return index >= toIndex && index < fromIndex ? 1 : 0;
}

/** 位移是否已经越过拖拽阈值（只比较水平分量：Tab 栏只有横向排序）。 */
export function exceedsDragThreshold(deltaX: number, threshold = DRAG_THRESHOLD_PX): boolean {
  return Math.abs(deltaX) >= threshold;
}
