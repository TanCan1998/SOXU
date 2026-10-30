//! Git 抽屉相关的 DTO（Issue #121）。
//!
//! 字段与 apps/desktop/src/workspace/types.ts 的 Git* 类型一一对应；
//! 所有视图都带 projectId / worktreeId，前端据此丢弃切换项目后的迟到响应。

use serde::Serialize;

/// 更改列表里的一个文件。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitChangeFile {
    pub path: String,
    /// 徽章字母：A 新增（含未跟踪）、M 修改、D 删除、U 冲突。
    pub status: String,
    pub staged: bool,
    pub unstaged: bool,
    pub untracked: bool,
    pub conflict: bool,
    /// 增删行数；二进制与未跟踪文件没有统计。
    pub added: Option<u64>,
    pub removed: Option<u64>,
    pub binary: bool,
}

/// 更改列表视图：分支、上游、领先/落后与逐文件徽章。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusView {
    pub project_id: String,
    /// 观察的工作树；null 表示项目主工作树（项目根目录）。
    pub worktree_id: Option<String>,
    pub root: String,
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: usize,
    pub behind: usize,
    pub files: Vec<GitChangeFile>,
    /// 文件总数（files 被上限裁剪时仍然完整）。
    pub total_files: usize,
    pub truncated: bool,
    pub index_locked: bool,
    pub operation: Option<String>,
}

/// 单文件 diff：补丁正文原样来自 git diff。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileDiffView {
    pub path: String,
    pub staged: bool,
    pub patch: String,
    pub truncated: bool,
    pub bytes_read: usize,
    pub added: Option<u64>,
    pub removed: Option<u64>,
    pub binary: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLogEntry {
    pub hash: String,
    pub short_hash: String,
    pub author: String,
    pub date: String,
    pub subject: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLogView {
    pub project_id: String,
    pub worktree_id: Option<String>,
    pub entries: Vec<GitLogEntry>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchEntry {
    pub name: String,
    pub head: String,
    pub upstream: Option<String>,
    pub current: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchesView {
    pub project_id: String,
    pub worktree_id: Option<String>,
    pub current: Option<String>,
    pub branches: Vec<GitBranchEntry>,
    pub truncated: bool,
}

/// 提交结果：同时带回提交后的状态，避免前端再发一次 status。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitView {
    pub hash: String,
    pub short_hash: String,
    pub subject: String,
    pub status: GitStatusView,
}

/// 推送/拉取结果：operation 为 push / pull，output 是 git 的标准输出（已裁剪）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRemoteView {
    pub operation: String,
    pub output: String,
    pub status: GitStatusView,
}
