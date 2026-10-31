//! 扩展领域 DTO（Issue #135 语言包、Issue #147 扩展页真数据）。
//!
//! 字段与 apps/desktop/src/services/localePacks.ts、apps/desktop/src/services/extensions.ts
//! 的 TypeScript 类型一一对应；改动必须同步两侧。

use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalePackList {
    /// 语言包目录的绝对路径（设置页展示，用户据此备份或分享）。
    pub directory: String,
    /// 已导入的语言标签，后端已按字母序排好。
    pub tags: Vec<String>,
}

/// 扩展页的一次完整快照（Issue #147）。
///
/// 三份列表分开返回而不是合成一个带 kind 的大列表：界面按区块渲染，
/// 前端不必在渲染时再分组，也不会把「扩展」与「技能」的字段语义混在一起。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionCatalog {
    /// 实际读取的 Pi 配置目录（用户据此确认 SOXU 读的是哪一份配置）。
    pub agent_dir: String,
    pub extensions: Vec<ExtensionItem>,
    pub skills: Vec<SkillItem>,
    pub mcp_servers: Vec<McpServerItem>,
}

/// 来源：Pi 自带的扩展，或用户自己安装的（文件 / npm 包）。
#[derive(Debug, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ExtensionSource {
    Builtin,
    User,
}

/// 一条扩展。id 由后端生成（形如 builtin:mcp / extension:rtk / package:pi-subagents），
/// 前端只把它当不透明标识回传给 read_extension_detail，不拼路径。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionItem {
    pub id: String,
    /// 展示名：内置扩展名、扩展文件名或 npm 包名。
    pub name: String,
    pub source: ExtensionSource,
    /// Pi 的默认行为是加载；settings 里的 -path / !pattern / -builtin:x 才会关掉。
    pub enabled: bool,
    /// 真实描述（目前只有 npm 包的 package.json 提供）；没有就是 null，不编。
    pub description: Option<String>,
    /// 本地入口路径；只有 settings 里的远程声明时为 null。
    pub path: Option<String>,
}

/// 一条技能：来自 agent 目录的 skills/ 或某个 Pi 包。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillItem {
    pub id: String,
    /// SKILL.md frontmatter 里声明的名字，缺省时用目录名。
    pub name: String,
    /// frontmatter 的 description；没有 frontmatter 就是 null。
    pub description: Option<String>,
    pub enabled: bool,
    /// 技能目录的绝对路径。
    pub path: String,
}

/// MCP 连接状态。只读扫描拿不到真实连接结果，因此只有「未知」一种取值，
/// 界面据此显示「未知」而不是伪造「已连接」。
#[derive(Debug, Serialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum McpStatus {
    Unknown,
}

/// 一条 MCP 服务。headers / env / args 属于凭据与进程细节，不进 DTO。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerItem {
    pub id: String,
    pub name: String,
    /// stdio / http / sse；mcp.json 没写 type 时按 url 或 command 推断。
    pub transport: Option<String>,
    pub description: Option<String>,
    pub status: McpStatus,
}

/// 按需展开的详情（目前是技能目录的真实文件数）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionDetail {
    pub id: String,
    pub name: String,
    pub path: String,
    /// 目录里的文件数（不跟随目录链接，最多统计 2000 个）。
    pub file_count: u32,
    /// 达到统计上限时为 true，界面显示「≥ N」而不是一个假装精确的数字。
    pub file_count_truncated: bool,
    pub description: Option<String>,
}
