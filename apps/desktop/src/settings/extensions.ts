/**
 * 扩展页的只读说明数据。
 *
 * 每条只有「名字 + 一句用途」：开关状态、技能文件数、MCP 工具数与连接状态都是
 * 本机真实状态，SOXU 目前还没有读取它们的通道。用常量编一个数字或默认开关，
 * 用户会以为那是自己的机器实况——所以这里一个都不放。
 * 真实数据接入后换成后端返回值即可，组件结构不用改。
 *
 * Issue #145：每条带一个稳定 `id`（小写点分段，直接拼成语言包 key），
 * 界面按当前语言解析用途说明；`name` 是产品名（Pi 扩展 / MCP 服务的真实标识），
 * `description` 保留为基准中文，语言包缺 key 时回退它，界面不会空白。
 */

/** 一个扩展条目：稳定 id + 名称 + 一句用途。 */
export interface ExtensionEntry {
  /** 语言包 key 的片段（settings.extensions.extension.<id>.description）。 */
  id: string;
  name: string;
  description: string;
}

/** 技能条目：名称 + 一句用途。 */
export interface SkillEntry {
  id: string;
  name: string;
  description: string;
}

/** MCP 服务条目：名称 + 一句用途。 */
export interface McpServiceEntry {
  id: string;
  name: string;
  description: string;
}

/**
 * 12 个扩展。顺序即界面顺序：前四个是会话主链路上最常用的，
 * 后面是文件类与下载类的扩展。
 */
export const EXTENSION_ENTRIES: readonly ExtensionEntry[] = Object.freeze([
  { id: "context.mode", name: "context-mode", description: "把大输出收进索引，只把结论带回上下文" },
  { id: "pi.subagents", name: "pi-subagents", description: "派发子代理、并行工作流、worktree 隔离" },
  { id: "pi.web.access", name: "pi-web-access", description: "网页搜索与抓取" },
  {
    id: "pi.cache.optimizer",
    name: "pi-cache-optimizer",
    description: "缓存命中统计与提示前缀优化",
  },
  { id: "moli.webfetch", name: "moli-webfetch", description: "抓取需要 JavaScript 渲染的页面" },
  { id: "moli.cdp.server", name: "moli-cdp-server", description: "对外提供 CDP 端点，供 Playwright 连接" },
  { id: "flux.download", name: "fluxdown-download", description: "大文件断点续传与校验" },
  { id: "docx.craft", name: "docx-craft", description: "Word 文档的读写与排版" },
  { id: "pdf.craft", name: "pdf-craft", description: "PDF 合并、拆分、表单填充与 OCR" },
  { id: "quark.cloud.drive", name: "quarkclouddrive", description: "夸克网盘上传下载与批量重命名" },
  { id: "rust.skills", name: "rust-skills", description: "Rust 所有权、并发、错误处理等主题技能" },
  { id: "usage.probe", name: "usage-probe", description: "排查供应商的用量与额度查询接口" },
]);

/** 技能列表：按需加载，因此只在用到时读入上下文。 */
export const SKILL_ENTRIES: readonly SkillEntry[] = Object.freeze([
  { id: "docx.pdf", name: "docx / pdf", description: "Word 与 PDF 的读写、合并、表单填充" },
  { id: "rust.skills", name: "rust-skills", description: "Rust 所有权、并发、错误处理等 20+ 主题" },
  { id: "moli.webfetch", name: "moli-webfetch", description: "真实渲染、截图与网络诊断" },
  { id: "resume.cn", name: "resume-cn", description: "中文简历按 JD 重写与审查" },
]);

/** MCP 服务列表。 */
export const MCP_SERVICE_ENTRIES: readonly McpServiceEntry[] = Object.freeze([
  { id: "github", name: "github", description: "仓库 / PR / issue / actions" },
  { id: "context7", name: "context7", description: "库文档检索" },
  { id: "rea", name: "rea", description: "逆向工程与运行时可观测" },
  { id: "playwright", name: "playwright", description: "浏览器自动化" },
]);
