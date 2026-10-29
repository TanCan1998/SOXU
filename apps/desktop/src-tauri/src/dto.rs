//! Rust ⇄ Vue 的数据契约。
//!
//! 所有结构使用 camelCase 序列化，字段与 `apps/desktop/src/workspace/types.ts`
//! 中的 TypeScript 类型一一对应；改动必须同步两侧与文档。

use std::path::Path;

use serde::{Deserialize, Serialize};
use soxu_agent_runtime::retry::RetryStatus;
use soxu_session_index::{EntryKind, MessageRole, TemporarySession};

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

/// 临时会话视图：`mode` 恒为 `temporary`，`file` 是已绑定的 Pi 会话文件。
///
/// 临时会话只活在 Rust 进程内存里：重启后不存在，也不会出现在 `ProjectSummary.sessions`。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemporarySessionView {
    pub session_id: String,
    pub project_id: String,
    pub worktree_id: String,
    pub mode: &'static str,
    pub file: Option<String>,
    /// 是否已绑定 Pi 会话文件；未绑定时没有可持久化的内容（转正会明确失败）。
    pub bound: bool,
}

impl TemporarySessionView {
    pub fn from_record(record: &TemporarySession) -> Self {
        Self {
            session_id: record.session.to_string(),
            project_id: record.project.to_string(),
            worktree_id: record.worktree.to_string(),
            mode: "temporary",
            file: record.file.clone(),
            bound: record.is_bound(),
        }
    }
}

/// 转正结果：`sessionId` 是转正后的**持久化**身份（取 Pi 会话头部的 id，不是 ses_tmp_*），
/// 前端必须把 Tab 切到这个身份，否则后续分页仍指向已消失的临时会话。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromotedSession {
    pub session_id: String,
    pub project: ProjectSummary,
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
    /// 本次启动用掉/还剩多少自动重试额度；持久化后重启不会重置。
    pub retry: RetryStatus,
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
    /// 重试预算快照；没有记录时为 None（控制台显示「未发生重试」）。
    pub retry: Option<RetryStatus>,
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

/// 发送投递方式（V4-S1，Issue #111）。
///
/// 三个内部名沿用 PiDeck（`docs/design/UIUX/V4/interaction-decisions.md` 第一节），
/// 与前端 `SendMode` 一一对应。本切片只做参数管道：命令层接收并校验，
/// 运行时语义（steer 注入 / followUp 排队 / parallel 并行会话）由后续切片实现。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PromptMode {
    Steer,
    FollowUp,
    Parallel,
}

/// 思考强度（`send_prompt` 的可选参数）。同样是先接收、暂不改变行为。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ThinkingLevel {
    Low,
    Medium,
    High,
}

#[cfg(test)]
mod tests {
    use super::{PromptMode, ThinkingLevel};

    /// 前端传的就是这三个字符串（camelCase），拼错必须在反序列化阶段暴露。
    #[test]
    fn prompt_mode_accepts_the_three_ui_values() {
        for (raw, expected) in [
            ("\"steer\"", PromptMode::Steer),
            ("\"followUp\"", PromptMode::FollowUp),
            ("\"parallel\"", PromptMode::Parallel),
        ] {
            let parsed: PromptMode = serde_json::from_str(raw).expect(raw);
            assert_eq!(parsed, expected);
        }
        assert!(serde_json::from_str::<PromptMode>("\"next\"").is_err());
        assert!(serde_json::from_str::<PromptMode>("\"\"").is_err());
    }

    #[test]
    fn thinking_level_accepts_low_medium_high() {
        for (raw, expected) in [
            ("\"low\"", ThinkingLevel::Low),
            ("\"medium\"", ThinkingLevel::Medium),
            ("\"high\"", ThinkingLevel::High),
        ] {
            let parsed: ThinkingLevel = serde_json::from_str(raw).expect(raw);
            assert_eq!(parsed, expected);
        }
        assert!(serde_json::from_str::<ThinkingLevel>("\"max\"").is_err());
    }

    /// 可选参数：前端不传时必须是 None（旧客户端/默认投递不受影响）。
    #[test]
    fn optional_prompt_parameters_default_to_none() {
        let mode: Option<PromptMode> = serde_json::from_str("null").expect("null");
        assert!(mode.is_none());
        let thinking: Option<ThinkingLevel> = serde_json::from_str("null").expect("null");
        assert!(thinking.is_none());
    }
}
