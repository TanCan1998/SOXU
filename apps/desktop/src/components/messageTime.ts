/**
 * 消息时间戳格式化（Issue #116 · V4-S2，Issue #144 改走 Intl）。
 *
 * 只做两件事：
 * 1. 判断这条消息该不该显示时间（空值/非法值返回 null，界面据此不渲染 ——
 *    老会话里没有 createdAt 的条目不该显示 "NaN"）；
 * 2. 把合法时间交给**当前语言**的 `formatDateTime`（locales/index.ts 的 Intl 封装），
 *    不在组件里写死 "HH:mm" 这种格式串：中文是 09:05，英文是 09:05 AM，
 *    两者的差异交给 Intl，而不是让每个组件各拼一次。
 *
 * 纯函数（格式化器由调用方注入），Node 里可直接断言，不依赖运行环境的时区与语言。
 */

/** 时间戳的显示格式：只到时分的短格式；顺序与 12/24 小时制由语言决定。 */
export const MESSAGE_TIME_OPTIONS: Intl.DateTimeFormatOptions = Object.freeze({
  hour: "2-digit",
  minute: "2-digit",
});

/** 语言运行时提供的日期格式化器签名（与 LocaleRuntime.formatDateTime 一致）。 */
export type DateTimeFormatter = (
  value: string | number | Date,
  options?: Intl.DateTimeFormatOptions,
) => string;

export function formatMessageTime(
  createdAt: string | null | undefined,
  formatDateTime: DateTimeFormatter,
): string | null {
  if (!createdAt) return null;
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return null;
  // formatDateTime 对非法值返回空串：这里同样退化成「不渲染」，不产生半个时间戳。
  const text = formatDateTime(date, MESSAGE_TIME_OPTIONS);
  return text === "" ? null : text;
}
