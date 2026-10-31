/**
 * 扩展页的只读说明数据。
 *
 * 每条只有「名字 + 一句用途」：开关状态、技能文件数、MCP 工具数与连接状态都是
 * 本机真实状态，SOXU 目前还没有读取它们的通道。用常量编一个数字或默认开关，
 * 用户会以为那是自己的机器实况——所以这里一个都不放。
 * 真实数据接入后换成后端返回值即可，组件结构不用改。
 */

/** 一个扩展条目：名称 + 一句用途。 */
export interface ExtensionEntry {
  name: string;
  description: string;
}

/** 技能条目：名称 + 一句用途。 */
export interface SkillEntry {
  name: string;
  description: string;
}

/** MCP 服务条目：名称 + 一句用途。 */
export interface McpServiceEntry {
  name: string;
  description: string;
}

/**
 * 12 个扩展。顺序即界面顺序：前四个是会话主链路上最常用的，
 * 后面是文件类与下载类的扩展。
 */
export const EXTENSION_ENTRIES: readonly ExtensionEntry[] = Object.freeze([
  { name: "context-mode", description: "把大输出收进索引，只把结论带回上下文" },
  { name: "pi-subagents", description: "派发子代理、并行工作流、worktree 隔离" },
  { name: "pi-web-access", description: "网页搜索与抓取" },
  { name: "pi-cache-optimizer", description: "缓存命中统计与提示前缀优化" },
  { name: "moli-webfetch", description: "抓取需要 JavaScript 渲染的页面" },
  { name: "moli-cdp-server", description: "对外提供 CDP 端点，供 Playwright 连接" },
  { name: "fluxdown-download", description: "大文件断点续传与校验" },
  { name: "docx-craft", description: "Word 文档的读写与排版" },
  { name: "pdf-craft", description: "PDF 合并、拆分、表单填充与 OCR" },
  { name: "quarkclouddrive", description: "夸克网盘上传下载与批量重命名" },
  { name: "rust-skills", description: "Rust 所有权、并发、错误处理等主题技能" },
  { name: "usage-probe", description: "排查供应商的用量与额度查询接口" },
]);

/** 技能列表：按需加载，因此只在用到时读入上下文。 */
export const SKILL_ENTRIES: readonly SkillEntry[] = Object.freeze([
  { name: "docx / pdf", description: "Word 与 PDF 的读写、合并、表单填充" },
  { name: "rust-skills", description: "Rust 所有权、并发、错误处理等 20+ 主题" },
  { name: "moli-webfetch", description: "真实渲染、截图与网络诊断" },
  { name: "resume-cn", description: "中文简历按 JD 重写与审查" },
]);

/** MCP 服务列表。 */
export const MCP_SERVICE_ENTRIES: readonly McpServiceEntry[] = Object.freeze([
  { name: "github", description: "仓库 / PR / issue / actions" },
  { name: "context7", description: "库文档检索" },
  { name: "rea", description: "逆向工程与运行时可观测" },
  { name: "playwright", description: "浏览器自动化" },
]);
