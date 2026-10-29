/**
 * 消息虚拟列表参数，以及「视口内最多渲染多少行」的推导。
 *
 * 组件与回归测试共用这一份数值：如果测试自己写一套 96/6，它验证的就不是真实组件。
 * 行高是估算值，真实高度由 `measureElement` 实测；估算只影响首次布局的滚动条长度。
 */
export const MESSAGE_ROW_ESTIMATE_PX = 96;

/** 视口外多渲染几行，避免快速滚动时出现空白；同时也是 DOM 行数的固定开销。 */
export const MESSAGE_OVERSCAN_ROWS = 6;

/** 距离底部小于该像素时认为「贴底」，新消息到达时自动跟随。 */
export const MESSAGE_STICK_THRESHOLD_PX = 120;

/**
 * 估算行高下「渲染行数」的上界（含 overscan 与 1 行取整余量）。
 *
 * 长会话的 DOM 规模只取决于视口高度与行高，与消息总数无关：50,000 条事件在 1080px
 * 视口下按 96px 估算也只应渲染约 25 行。回归测试用这个函数核对不变量；
 * 实测行高比估算更小时行数会更多，因此它只是估算上界，不是硬上限。
 */
export function estimatedRenderedRows(viewportHeightPx: number): number {
  if (!Number.isFinite(viewportHeightPx) || viewportHeightPx <= 0) {
    return MESSAGE_OVERSCAN_ROWS * 2 + 1;
  }
  return Math.ceil(viewportHeightPx / MESSAGE_ROW_ESTIMATE_PX) + MESSAGE_OVERSCAN_ROWS * 2 + 1;
}
