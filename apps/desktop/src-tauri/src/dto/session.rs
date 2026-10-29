//! 会话、历史与运行时相关的 DTO。
//!
//! 历史分页、正文按需读取与会话内搜索的结构也在这里：它们描述的都是
//! 「一个会话内部」的数据形状，与项目/工作树的归属视图分开维护。

use serde::{Deserialize, Serialize};
use soxu_agent_runtime::retry::RetryStatus;
use soxu_session_index::{EntryKind, MessageRole};

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

/// 会话内搜索的一条命中：片段与偏移都由后端给出，前端不重新计算匹配位置。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSearchHit {
    pub ordinal: u64,
    pub kind: EntryKind,
    pub role: Option<MessageRole>,
    /// 命中位置前后各 40 个字符（边界对齐到字符，不是字节）。
    pub snippet: String,
    /// `snippet` 内命中的起始字符偏移。
    pub match_start: usize,
    /// `snippet` 内命中的结束字符偏移（左闭右开）。
    pub match_end: usize,
    /// 该条目内的命中次数（后端上限 20）。
    pub total_matches: usize,
    /// 该条目正文被裁剪过（超长条目或缓存预算淘汰），片段不是全文。
    pub truncated: bool,
}

/// 一次会话内搜索的结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSearchResult {
    pub session_id: String,
    pub hits: Vec<SessionSearchHit>,
    /// 会话内命中条目总数，与 `limit` / 分页无关。
    pub total_hits: usize,
    pub scanned_entries: usize,
    /// 命中数超过 `limit`（还有下一页）。
    pub truncated: bool,
    /// 缓存因预算丢弃了部分正文：结果可能不完整，界面必须如实说明。
    pub degraded: bool,
    pub took_ms: u64,
    /// 本次调用是否重建了缓存（验收用：追加不应触发重建）。
    pub rebuilt: bool,
}

impl SessionSearchResult {
    pub fn from_outcome(
        session_id: &str,
        result: &soxu_session_index::SessionSearchResult,
    ) -> Self {
        Self {
            session_id: session_id.to_owned(),
            hits: result
                .hits
                .iter()
                .map(|hit| SessionSearchHit {
                    ordinal: hit.ordinal,
                    kind: hit.kind,
                    role: hit.role,
                    snippet: hit.snippet.clone(),
                    match_start: hit.match_start,
                    match_end: hit.match_end,
                    total_matches: hit.total_matches,
                    truncated: hit.truncated,
                })
                .collect(),
            total_hits: result.total_hits,
            scanned_entries: result.scanned_entries,
            truncated: result.truncated,
            degraded: result.degraded,
            took_ms: result.took_ms,
            rebuilt: result.rebuilt,
        }
    }
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
