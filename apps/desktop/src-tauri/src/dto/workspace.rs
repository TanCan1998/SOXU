//! 项目与工作区相关的 DTO：项目摘要、会话摘要、临时会话视图与转正结果。

use std::path::Path;

use serde::Serialize;
use soxu_session_index::TemporarySession;

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
