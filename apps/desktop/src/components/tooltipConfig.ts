/*
 * 悬浮提示的统一参数（Issue #96）。
 *
 * 400ms 是「用户确实在停留、想要说明」的阈值：更短会在鼠标扫过时闪屏，
 * 更长会让提示看起来根本没出现。skipDelay 让光标在相邻按钮间移动时立即出现，
 * 不重复等待——这是桌面工具里已经验证过的习惯用法。
 */
export const TOOLTIP_DELAY_MS = 400;
export const TOOLTIP_SKIP_DELAY_MS = 300;
export const TOOLTIP_SIDE_OFFSET_PX = 8;
export const TOOLTIP_COLLISION_PADDING_PX = 8;
