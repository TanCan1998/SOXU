//! 文件抽屉的数据契约（Issue #120 / TASK-028）。
//!
//! 字段与 `apps/desktop/src/workspace/types.ts` 中的同名 TypeScript 类型一一对应；
//! 所有路径都是**项目内相对路径**（统一 `/` 分隔）：界面不需要、也不应该拿到绝对路径。

use serde::Serialize;

/// 目录里的一个条目。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    /// 相对项目根目录的路径（`/` 分隔），同时是前端树节点的唯一键。
    pub path: String,
    pub name: String,
    /// `dir` / `file` / `symlink` / `other`。
    pub kind: String,
    pub size: u64,
    pub modified_at_ms: Option<u64>,
    /// 以 `.` 开头（跨平台的可见隐藏约定；Windows 隐藏属性不参与判断）。
    pub hidden: bool,
    /// 条目本身是符号链接：只读预览会跟随（并受根目录守卫约束），写操作一律拒绝。
    pub symlink: bool,
}

/// 单层目录枚举结果（懒加载：只读一层）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirListing {
    pub project_id: String,
    /// 被枚举的目录（相对路径；根目录为空字符串）。
    pub path: String,
    pub entries: Vec<FileEntry>,
    /// 本层实际条目总数（含被上限裁掉的部分）。
    pub total: usize,
    /// 条目数超过上限，只返回了前 `MAX_DIR_ENTRIES` 条。
    pub truncated: bool,
}

/// 只读预览结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub path: String,
    /// 文本正文；`binary` 为真时为空字符串（界面显示「二进制文件」而不是乱码）。
    pub text: String,
    /// 磁盘上的完整字节数。
    pub size: u64,
    /// 实际读取的字节数（`truncated` 为真时小于 `size`）。
    pub bytes_read: u64,
    pub truncated: bool,
    pub binary: bool,
    pub modified_at_ms: Option<u64>,
}

/// 写操作（新建/写入/重命名/删除）的结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMutation {
    /// 操作后的相对路径（重命名时是新路径）。
    pub path: String,
    /// `file` / `dir`。
    pub kind: String,
    pub size: u64,
}

/// 文件内搜索的一条命中。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSearchHit {
    pub path: String,
    /// 1 起算的行号。
    pub line: u64,
    /// 命中行的预览（已去掉行首缩进，最多 160 字符）。
    pub preview: String,
    /// 预览内命中的起始**字符**偏移；被截断到无法定位时为 0。
    pub match_start: u32,
    pub match_end: u32,
}

/// 文件内搜索的结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSearchResult {
    pub query: String,
    pub hits: Vec<FileSearchHit>,
    pub scanned_files: u64,
    /// 被跳过或读失败的文件/目录数（符号链接、二进制、超深目录、构建产物）。
    pub skipped_files: u64,
    /// 触到上限：结果不完整，界面必须如实说明。
    pub truncated: bool,
    pub took_ms: u64,
}
