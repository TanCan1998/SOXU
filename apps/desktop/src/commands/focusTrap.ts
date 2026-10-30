/**
 * 命令面板的焦点圈定（Issue #123 复审修正）。
 *
 * 面板是 role="dialog" + aria-modal="true"，语义上就承诺了「面板开着时焦点不会跑到
 * 面板背后」。浏览器不会替 aria-modal 做这件事：Tab 照常走进后面的界面，键盘与
 * 屏幕阅读器用户会以为面板已经关掉，或者被带到看不见的控件上。
 *
 * 只有「下一个该聚焦第几个」是纯逻辑，放在这里可以直接在 Node 里断言；
 * 真正的 DOM 遍历与 focus() 留在 CommandPalette.vue，不在这里碰 document。
 */

/** 面板内可聚焦元素的查询选择器（与 focusTargetIndex 一起构成焦点圈）。 */
export const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(", ");

/**
 * 面板内 Tab / Shift+Tab 的目标下标。
 *
 * 首尾相接：最后一个再按 Tab 回到第一个（反向亦然），焦点因此永远出不去。
 * - total <= 0：面板里没有可聚焦元素，返回 -1，调用方只 preventDefault；
 * - current < 0 或越界：焦点此刻不在面板内（刚打开、或被点到遮罩上），
 *   向前时从第一个开始，反向时从最后一个开始。
 */
export function focusTargetIndex(current: number, total: number, shift: boolean): number {
  if (total <= 0) return -1;
  if (current < 0 || current >= total) return shift ? total - 1 : 0;
  return shift ? (current - 1 + total) % total : (current + 1) % total;
}
