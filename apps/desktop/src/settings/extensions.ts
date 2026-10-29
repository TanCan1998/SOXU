/**
 * 扩展页的占位数据（Issue #116 · V4-S2）。
 *
 * **本切片只做静态列表渲染**：真实数据要等后端提供 `list_extensions` 命令，
 * 那属于后续切片（V4-S7，同时被 #112 的后端命令层拆分挡住）。
 * 这里的数据是「让界面结构与原型对齐」的常量，不读磁盘、不读 Pi 配置、不发 IPC，
 * 因此列表里的数量与开关状态都不代表本机真实情况——设置面板的说明文案如实写了这一点。
 *
 * TODO(V4-S7): 改成调用 `list_extensions`，删除本文件的常量与 enabled 字段。
 */

/** 一个扩展条目：名称 + 一句用途 + 默认开关状态（占位）。 */
export interface ExtensionEntry {
  name: string;
  description: string;
  /** 占位默认值，真实状态由后续切片的 `list_extensions` 提供。 */
  enabled: boolean;
}

/** 技能条目：名称 + 用途 + 文件数（占位）。 */
export interface SkillEntry {
  name: string;
  description: string;
  fileCount: number;
}

/** MCP 服务条目：名称 + 用途 + 工具数 + 连接状态（占位）。 */
export interface McpServiceEntry {
  name: string;
  description: string;
  toolCount: number;
  connected: boolean;
}

/**
 * 12 个扩展（占位）。顺序即界面顺序：前四个是会话主链路上最常用的，
 * 后面是文件类与下载类的扩展。
 */
export const EXTENSION_ENTRIES: readonly ExtensionEntry[] = Object.freeze([
  { name: "context-mode", description: "把大输出收进索引，只把结论带回上下文", enabled: true },
  { name: "pi-subagents", description: "派发子代理、并行工作流、worktree 隔离", enabled: true },
  { name: "pi-web-access", description: "网页搜索与抓取", enabled: true },
  { name: "pi-cache-optimizer", description: "缓存命中统计与提示前缀优化", enabled: false },
  { name: "moli-webfetch", description: "抓取需要 JavaScript 渲染的页面", enabled: true },
  { name: "moli-cdp-server", description: "对外提供 CDP 端点，供 Playwright 连接", enabled: false },
  { name: "fluxdown-download", description: "大文件断点续传与校验", enabled: true },
  { name: "docx-craft", description: "Word 文档的读写与排版", enabled: true },
  { name: "pdf-craft", description: "PDF 合并、拆分、表单填充与 OCR", enabled: true },
  { name: "quarkclouddrive", description: "夸克网盘上传下载与批量重命名", enabled: false },
  { name: "rust-skills", description: "Rust 所有权、并发、错误处理等主题技能", enabled: true },
  { name: "usage-probe", description: "排查供应商的用量与额度查询接口", enabled: false },
]);

/** 技能列表（占位）：按需加载，因此只在用到时读入上下文。 */
export const SKILL_ENTRIES: readonly SkillEntry[] = Object.freeze([
  { name: "docx / pdf", description: "Word 与 PDF 的读写、合并、表单填充", fileCount: 4 },
  { name: "rust-skills", description: "Rust 所有权、并发、错误处理等 20+ 主题", fileCount: 28 },
  { name: "moli-webfetch", description: "真实渲染、截图与网络诊断", fileCount: 6 },
  { name: "resume-cn", description: "中文简历按 JD 重写与审查", fileCount: 3 },
]);

/** MCP 服务列表（占位）：工具数只是展示用的静态数字，不代表本机配置。 */
export const MCP_SERVICE_ENTRIES: readonly McpServiceEntry[] = Object.freeze([
  { name: "github", description: "仓库 / PR / issue / actions", toolCount: 49, connected: true },
  { name: "context7", description: "库文档检索", toolCount: 2, connected: true },
  { name: "rea", description: "逆向工程与运行时可观测", toolCount: 207, connected: false },
  { name: "playwright", description: "浏览器自动化", toolCount: 25, connected: false },
]);
