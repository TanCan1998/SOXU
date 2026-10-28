//! 报告脱敏：把当前用户主目录前缀替换成 "~"。
//!
//! 证据文件会入库，里面可能带临时会话路径（含用户名）。路径本身不影响判据，
//! 但没必要把本机私有目录结构写进仓库，因此统一在写盘前替换。

import { homedir } from "node:os";

/** Windows 下 JSON 会把反斜杠转义，所以用序列化后的片段做匹配。 */
export function redactHome(value, home = homedir()) {
  if (!home) return value;
  const escaped = JSON.stringify(home).slice(1, -1);
  if (!escaped) return value;
  return JSON.parse(JSON.stringify(value).split(escaped).join("~"));
}
