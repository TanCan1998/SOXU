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
