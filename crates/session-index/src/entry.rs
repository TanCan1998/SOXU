//! Pi JSONL 单行解析：轻量元数据 + 有界预览。
//!
//! 只解析索引需要的字段，其余字段交给 serde 跳过，避免把巨型工具输出读进内存。
//! 预览只在分页时按预算生成，扫描阶段一律不生成。

use serde::{Deserialize, Serialize};

use crate::hash::fnv1a64;

pub(crate) const FLAG_CORRUPT: u8 = 0b0000_0001;
pub(crate) const FLAG_OVERSIZED: u8 = 0b0000_0010;

/// 预览最多保留的字符数（按字符截断，绝不撕裂 UTF-8）。
pub const PREVIEW_CHARS: usize = 240;
/// 生成预览前允许解析的最大行长度；更大的行只返回元数据。
const PREVIEW_LINE_LIMIT: usize = 64 * 1024;

/// Pi 会话条目的类型，未知类型保留为 Unknown 而不是丢弃。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EntryKind {
    Session,
    Message,
    Compaction,
    BranchSummary,
    ContextEdit,
    Usage,
    Custom,
    CustomMessage,
    Label,
    SessionInfo,
    ModelChange,
    ThinkingLevelChange,
    #[default]
    Unknown,
}

impl EntryKind {
    pub fn from_pi_type(value: &str) -> Self {
        match value {
            "session" => Self::Session,
            "message" => Self::Message,
            "compaction" => Self::Compaction,
            "branch_summary" => Self::BranchSummary,
            "context_edit" => Self::ContextEdit,
            "usage" => Self::Usage,
            "custom" => Self::Custom,
            "custom_message" => Self::CustomMessage,
            "label" => Self::Label,
            "session_info" => Self::SessionInfo,
            "model_change" => Self::ModelChange,
            "thinking_level_change" => Self::ThinkingLevelChange,
            _ => Self::Unknown,
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Session => "session",
            Self::Message => "message",
            Self::Compaction => "compaction",
            Self::BranchSummary => "branch_summary",
            Self::ContextEdit => "context_edit",
            Self::Usage => "usage",
            Self::Custom => "custom",
            Self::CustomMessage => "custom_message",
            Self::Label => "label",
            Self::SessionInfo => "session_info",
            Self::ModelChange => "model_change",
            Self::ThinkingLevelChange => "thinking_level_change",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MessageRole {
    System,
    User,
    Assistant,
    ToolResult,
    Custom,
    Unknown,
}

impl MessageRole {
    pub fn from_pi_role(value: &str) -> Self {
        match value {
            "system" => Self::System,
            "user" => Self::User,
            "assistant" => Self::Assistant,
            "toolResult" => Self::ToolResult,
            "custom" => Self::Custom,
            _ => Self::Unknown,
        }
    }
}

/// 会话头部（文件第一行的 session 条目）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionHeader {
    pub version: u32,
    pub id: Option<String>,
    pub timestamp: Option<String>,
    pub cwd: Option<String>,
    pub parent_session: Option<String>,
    /// 头部行原始字节的指纹，用于无 id 的旧会话派生稳定 SessionId 与迁移匹配。
    pub fingerprint: u64,
}

/// 索引中每条记录的固定开销内容：不含正文，不含预览。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct EntryMeta {
    pub offset: u64,
    pub len: u32,
    pub kind: EntryKind,
    pub role: Option<MessageRole>,
    pub flags: u8,
}

impl EntryMeta {
    pub fn is_oversized(self) -> bool {
        self.flags & FLAG_OVERSIZED != 0
    }

    pub fn is_corrupt(self) -> bool {
        self.flags & FLAG_CORRUPT != 0
    }

    pub fn end(self) -> u64 {
        self.offset.saturating_add(u64::from(self.len))
    }
}

/// 分页返回的单条视图。正文只以有界预览出现。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EntryView {
    pub ordinal: u64,
    pub offset: u64,
    pub byte_len: u32,
    pub kind: EntryKind,
    pub role: Option<MessageRole>,
    pub entry_id: Option<String>,
    pub parent_id: Option<String>,
    pub timestamp: Option<String>,
    pub preview: Option<String>,
    pub oversized: bool,
    pub corrupt: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EntryPage {
    /// 本次实际返回的条目。
    pub entries: Vec<EntryView>,
    /// 请求的起始序号。
    pub offset: u64,
    /// 索引中的条目总数。
    pub total: usize,
    /// 下一页起始序号；None 表示已经到底。
    pub next: Option<u64>,
    /// 本次实际从磁盘读取的字节数，用于验证内存与 IO 有界。
    pub bytes_read: u64,
    /// 是否因为字节预算提前截断（next 会指向未返回的第一条）。
    pub clipped: bool,
}

#[derive(Debug, Deserialize)]
struct RawMessage {
    #[serde(default)]
    role: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawEntry {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    id: Option<String>,
    #[serde(default, rename = "parentId")]
    parent_id: Option<String>,
    #[serde(default)]
    timestamp: Option<String>,
    #[serde(default)]
    message: Option<RawMessage>,
}

#[derive(Debug, Deserialize)]
struct RawHeader {
    #[serde(default)]
    version: Option<u32>,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    timestamp: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default, rename = "parentSession")]
    parent_session: Option<String>,
}

#[derive(Debug, Default)]
pub(crate) struct ParsedLine {
    pub kind: EntryKind,
    pub role: Option<MessageRole>,
    pub entry_id: Option<String>,
    pub parent_id: Option<String>,
    pub timestamp: Option<String>,
    pub preview: Option<String>,
    pub flags: u8,
}

fn corrupt_line() -> ParsedLine {
    ParsedLine {
        kind: EntryKind::Unknown,
        flags: FLAG_CORRUPT,
        ..ParsedLine::default()
    }
}

pub(crate) fn parse_line(bytes: &[u8], want_preview: bool) -> ParsedLine {
    let text = match std::str::from_utf8(bytes) {
        Ok(text) => text,
        Err(_) => return corrupt_line(),
    };
    let raw: RawEntry = match serde_json::from_str(text) {
        Ok(raw) => raw,
        Err(_) => return corrupt_line(),
    };
    let kind = EntryKind::from_pi_type(&raw.kind);
    let role = raw
        .message
        .as_ref()
        .and_then(|message| message.role.as_deref())
        .map(MessageRole::from_pi_role);
    ParsedLine {
        kind,
        role,
        entry_id: raw.id,
        parent_id: raw.parent_id,
        timestamp: raw.timestamp,
        preview: if want_preview {
            preview_from_text(text, kind)
        } else {
            None
        },
        flags: 0,
    }
}

pub(crate) fn parse_header(bytes: &[u8]) -> Option<SessionHeader> {
    let raw: RawHeader = serde_json::from_slice(bytes).ok()?;
    Some(SessionHeader {
        version: raw.version.unwrap_or(1),
        id: raw.id,
        timestamp: raw.timestamp,
        cwd: raw.cwd,
        parent_session: raw.parent_session,
        fingerprint: fnv1a64(bytes),
    })
}

fn preview_from_text(text: &str, kind: EntryKind) -> Option<String> {
    if text.len() > PREVIEW_LINE_LIMIT {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    let from_content = value
        .get("message")
        .and_then(|message| match message.get("content") {
            Some(serde_json::Value::String(text)) => text_preview(text),
            Some(serde_json::Value::Array(blocks)) => blocks
                .iter()
                .find_map(block_preview)
                .and_then(|text| text_preview(&text)),
            _ => None,
        });
    if from_content.is_some() {
        return from_content;
    }
    let fallback = match kind {
        EntryKind::Compaction => value.get("summary"),
        EntryKind::SessionInfo => value.get("name"),
        EntryKind::Label => value.get("label"),
        EntryKind::CustomMessage => value.get("content"),
        EntryKind::ModelChange => value.get("modelId"),
        _ => None,
    };
    fallback
        .and_then(|item| item.as_str())
        .and_then(text_preview)
}

fn block_preview(block: &serde_json::Value) -> Option<String> {
    let kind = block.get("type").and_then(|value| value.as_str())?;
    match kind {
        "text" => block
            .get("text")
            .and_then(|value| value.as_str())
            .map(str::to_string),
        "thinking" => Some("[thinking]".to_string()),
        "toolCall" | "tool_call" => block
            .get("name")
            .and_then(|value| value.as_str())
            .map(|name| format!("[tool: {name}]")),
        "image" => Some("[image]".to_string()),
        other => Some(format!("[{other}]")),
    }
}

/// 按字符截断并折叠换行，保证预览既短又是合法 UTF-8。
fn text_preview(value: &str) -> Option<String> {
    let mut preview = String::new();
    for (index, character) in value.chars().enumerate() {
        if index >= PREVIEW_CHARS {
            preview.push('…');
            break;
        }
        preview.push(if character == '\n' { ' ' } else { character });
    }
    if preview.is_empty() {
        None
    } else {
        Some(preview)
    }
}

pub(crate) fn view_from(ordinal: u64, meta: EntryMeta, bytes: &[u8]) -> EntryView {
    let parsed = parse_line(bytes, true);
    EntryView {
        ordinal,
        offset: meta.offset,
        byte_len: meta.len,
        kind: parsed.kind,
        role: parsed.role,
        entry_id: parsed.entry_id,
        parent_id: parsed.parent_id,
        timestamp: parsed.timestamp,
        preview: parsed.preview,
        oversized: meta.is_oversized(),
        corrupt: meta.is_corrupt() || parsed.flags & FLAG_CORRUPT != 0,
    }
}

/// 超出内联读取预算的条目只给出占位视图，绝不整段读入内存。
pub(crate) fn placeholder_from(ordinal: u64, meta: EntryMeta) -> EntryView {
    EntryView {
        ordinal,
        offset: meta.offset,
        byte_len: meta.len,
        kind: meta.kind,
        role: meta.role,
        entry_id: None,
        parent_id: None,
        timestamp: None,
        preview: None,
        oversized: meta.is_oversized(),
        corrupt: meta.is_corrupt(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_message_metadata_without_content() {
        let line = br#"{"type":"message","id":"a1","parentId":null,"timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"hello","timestamp":1}}"#;
        let parsed = parse_line(line, true);
        assert_eq!(parsed.kind, EntryKind::Message);
        assert_eq!(parsed.role, Some(MessageRole::User));
        assert_eq!(parsed.entry_id.as_deref(), Some("a1"));
        assert_eq!(parsed.preview.as_deref(), Some("hello"));
        assert_eq!(parsed.flags, 0);
    }

    #[test]
    fn marks_broken_lines_as_corrupt() {
        assert_eq!(parse_line(b"not json", false).flags, FLAG_CORRUPT);
        assert_eq!(parse_line(&[0xff, 0xfe], false).flags, FLAG_CORRUPT);
    }

    #[test]
    fn preview_is_char_bounded() {
        let long = "汉".repeat(PREVIEW_CHARS * 2);
        let preview = text_preview(&long).unwrap_or_else(|| panic!("preview should exist"));
        assert_eq!(preview.chars().count(), PREVIEW_CHARS + 1);
        assert!(preview.ends_with('…'));
    }

    #[test]
    fn header_fingerprint_is_reproducible() {
        let line = br#"{"type":"session","version":3,"id":"abc","cwd":"/repo"}"#;
        let first = parse_header(line).unwrap_or_else(|| panic!("header should parse"));
        let second = parse_header(line).unwrap_or_else(|| panic!("header should parse"));
        assert_eq!(first, second);
        assert_eq!(first.version, 3);
    }
}
