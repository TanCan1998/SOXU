/**
 * 消息时间戳格式化（Issue #116 · V4-S2）。
 *
 * 只做一件事：把 Pi 写入的 ISO 时间转成本地时区的 HH:mm。
 * - 用 getHours/getMinutes 而不是手写 UTC 偏移：会话时间必须按用户所在时区显示；
 * - 空值/非法值返回 null，界面据此不渲染 —— 老会话里没有 createdAt 的条目不该显示 "NaN"。
 *
 * 纯函数，Node 里可直接断言（测试用本地时间构造输入，不依赖运行环境的时区）。
 */
export function formatMessageTime(createdAt: string | null | undefined): string | null {
  if (!createdAt) return null;
  const date = new Date(createdAt);
  const time = date.getTime();
  if (Number.isNaN(time)) return null;
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}
