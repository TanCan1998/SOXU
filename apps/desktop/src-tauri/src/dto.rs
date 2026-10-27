//! Rust ⇄ Vue 的数据契约。
//!
//! 所有结构使用 camelCase 序列化，字段与 `apps/desktop/src/workspace/types.ts`
//! 中的 TypeScript 类型一一对应；改动必须同步两侧与文档。

use std::path::Path;

use serde::{Deserialize, Serialize};
use soxu_session_index::{EntryKind, MessageRole};

/// 项目条目：只包含目录引用与会话摘要，不含会话正文。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub id: String,
    pub name: String,
    pub root: String,
    pub worktree_count: usize,
    pub sessions: Vec<SessionSummary>,
}

/// 会话摘要：标题为空时前端回退到文件名，不伪造「最近消息」。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: String,
    pub project_id: String,
    /// 会话所属工作树：切换工作树不会改写会话归属。
    pub worktree_id: String,
    pub title: String,
    pub file_name: String,
    pub entry_count: usize,
    pub updated_at_ms: u64,
    pub missing: bool,
    pub runtime_id: Option<String>,
    pub generation: u64,
}

impl SessionSummary {
    pub fn file_name(file: &str) -> String {
        Path::new(file)
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| file.to_owned())
    }
}

/// 历史分页中的单条条目视图：正文只有有界预览，完整正文走 `read_session_texts`。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub ordinal: u64,
    pub offset: u64,
    pub length: u32,
    pub kind: EntryKind,
    pub role: Option<MessageRole>,
    pub preview: Option<String>,
    pub timestamp: Option<String>,
    pub oversized: bool,
    pub corrupt: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPage {
    pub session_id: String,
    pub entries: Vec<HistoryEntry>,
    pub offset: u64,
    pub total: usize,
    pub next: Option<u64>,
    pub bytes_read: u64,
    pub clipped: bool,
}

/// 按需读取完整正文时前端提交的定位信息（来自 HistoryEntry）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryRefInput {
    pub ordinal: u64,
    pub offset: u64,
    pub length: u32,
}

/// 一条条目的完整文本。`role` 保留 Pi 原始角色字符串（如 `bashExecution`）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryText {
    pub ordinal: u64,
    pub role: Option<String>,
    pub text: String,
    pub clipped: bool,
}

/// 启动运行时的返回值：每次执行都有新的 runtimeId + generation。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStarted {
    pub session_id: String,
    pub runtime_id: String,
    pub generation: u64,
    pub state: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeExit {
    pub code: Option<i32>,
    pub reason: String,
}

/// 运行时当前状态；订阅被释放后前端可用它重新对齐 UI。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub session_id: String,
    pub runtime_id: String,
    pub generation: u64,
    pub state: String,
    pub exit: Option<RuntimeExit>,
}

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
