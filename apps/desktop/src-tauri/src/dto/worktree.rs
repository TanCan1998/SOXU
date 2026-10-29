//! 工作树相关的 DTO：工作树集合、单个工作树视图、创建/差异/删除视图。

use serde::{Deserialize, Serialize};

/// 工作树集合：一次枚举返回视图、失效记录与清理令牌。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeWorkspace {
    pub project_id: String,
    pub root: String,
    pub worktrees: Vec<WorktreeSummary>,
    /// git 标记为 prunable 的工作树路径（异常退出/手工删除后的残留）。
    pub stale: Vec<String>,
    /// 清理失效记录需要的确认令牌。
    pub prune_token: String,
}

/// 单个工作树的视图：Git 事实 + 会话关联 + 删除安全状态。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeSummary {
    pub id: String,
    pub project_id: String,
    pub path: String,
    pub name: String,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub primary: bool,
    /// 目录不存在或 git 已标记 prunable。
    pub missing: bool,
    pub locked: Option<String>,
    pub prunable: Option<String>,
    pub dirty: bool,
    pub staged: usize,
    pub unstaged: usize,
    pub untracked: usize,
    pub conflicts: usize,
    /// 文件清单因上限被裁剪（计数仍然是完整的）。
    pub changes_truncated: bool,
    pub index_locked: bool,
    pub operation: Option<String>,
    pub session_ids: Vec<String>,
    /// 该工作树下仍有运行时挂载的会话；非空时禁止删除。
    pub active_session_ids: Vec<String>,
    /// 阻止删除的原因（稳定标识，见 soxu-git-worktree 的 RemovalBlocker）。
    pub blockers: Vec<String>,
    pub removable: bool,
    /// 删除确认令牌：与当前 Git 状态绑定，状态一变即失效。
    pub token: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateWorktreeInput {
    pub branch: String,
    /// true：新建分支（-b）；false：检出既有分支。
    #[serde(default)]
    pub new_branch: bool,
    /// 新建分支的起点（默认 HEAD）。
    #[serde(default)]
    pub base: Option<String>,
    /// 目标目录；省略时使用项目旁的 <项目名>-worktrees/<分支>。
    #[serde(default)]
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeDiffFile {
    pub status: String,
    pub path: String,
    pub added: Option<u64>,
    pub removed: Option<u64>,
    pub binary: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeDiffView {
    pub worktree_id: String,
    pub staged: bool,
    pub files: Vec<WorktreeDiffFile>,
    pub total_files: usize,
    pub patch: String,
    pub truncated: bool,
    pub bytes_read: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRemovalView {
    pub project_id: String,
    pub worktree_id: String,
    pub path: String,
    pub branch: Option<String>,
}
