//! 跨平台命令启动计划：Windows 上 npm 的 .cmd 包装必须经 cmd.exe。
//!
//! 只做纯字符串/数组处理，便于离线测试；不启动任何进程。

/** cmd.exe 需要的最小引号处理：含空白或双引号时加引号，内部双引号转义为 "。 */
export function quoteForCmd(value) {
  const text = String(value);
  if (!/[\s"]/.test(text)) return text;
  return '"' + text.replace(/"/g, '\\"') + '"';
}

/**
 * 返回 { command, args }。
 * - 非 Windows：直接执行。
 * - Windows：.exe 直接执行，其它（如 npm 安装的 pi/pnpm 的 .cmd）经 cmd.exe /d /s /c。
 */
export function commandPlan(bin, args, platform = process.platform) {
  const name = String(bin);
  const argv = args.map(String);
  if (platform !== "win32") return { command: name, args: argv };
  if (/\.(exe|com)$/i.test(name)) return { command: name, args: argv };
  const line = [name, ...argv].map(quoteForCmd).join(" ");
  return { command: "cmd.exe", args: ["/d", "/s", "/c", line] };
}
