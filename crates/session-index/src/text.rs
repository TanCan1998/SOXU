//! 从 Pi JSONL 单行提取可显示、可搜索的正文。
//!
//! 索引扫描阶段不碰正文（只看元数据）；只有「按需读全文」（桌面端 entry_text）与
//! 「会话内搜索」（search）需要它。两处共用同一实现，避免出现
//! 「UI 显示的内容搜不到 / 搜到的内容 UI 不显示」这种分歧。
//!
//! 提取规则（与 UI 展示口径一致）：
//! - `message.content` 是字符串：原样返回；
//! - `message.content` 是块数组：只拼接 text 块正文，thinking / toolCall / image
//!   用占位标记——不把模型内部推理与工具参数塞进正文预算；
//! - bashExecution 一类消息：`$ 命令` + 输出；
//! - 非消息条目退回 summary / name / label / content 等常见字段；
//! - 结构不认识时返回空正文而不是报错：搜索与展示都不该因为一行怪数据失败。

use serde_json::Value;

use crate::entry::{EntryKind, MessageRole};

/// 一条 JSONL 记录里对 UI 与搜索都可见的内容。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtractedText {
    pub kind: EntryKind,
    /// 归一化后的角色；未知角色归为 `Unknown`。
    pub role: Option<MessageRole>,
    /// Pi 原始角色字符串（如 `bashExecution`），界面直接展示原文。
    pub role_raw: Option<String>,
    pub text: String,
}

/// 解析一行 JSONL 并提取正文；非法 JSON 返回 None。
///
/// 调用方负责先做 UTF-8 校验：本函数只接受 `&str`，因此不会吞掉编码错误。
pub fn extract_entry(line: &str) -> Option<ExtractedText> {
    let value: Value = serde_json::from_str(line.trim_end_matches(['\r', '\n'])).ok()?;
    let kind = value
        .get("type")
        .and_then(Value::as_str)
        .map(EntryKind::from_pi_type)
        .unwrap_or(EntryKind::Unknown);
    let message = value.get("message");
    let role_raw = message
        .and_then(|message| message.get("role"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let role = role_raw.as_deref().map(MessageRole::from_pi_role);
    let text = match message {
        Some(message) => message_text(message),
        None => fallback_text(&value, kind),
    };
    Some(ExtractedText {
        kind,
        role,
        role_raw,
        text,
    })
}

/// 兼容旧调用点：只要角色与正文。
pub fn extract_text(line: &str) -> (Option<String>, String) {
    match extract_entry(line) {
        Some(extracted) => (extracted.role_raw, extracted.text),
        None => (None, String::new()),
    }
}

/// 按字符截断，保证结果仍是合法 UTF-8；截断时追加省略号。
pub fn truncate_chars(text: &str, limit: usize) -> (String, bool) {
    if text.chars().count() <= limit {
        return (text.to_owned(), false);
    }
    let kept: String = text.chars().take(limit).collect();
    (format!("{kept}…"), true)
}

fn message_text(message: &Value) -> String {
    match message.get("content") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(blocks)) => join_blocks(blocks),
        _ => shell_text(message),
    }
}

fn join_blocks(blocks: &[Value]) -> String {
    let mut parts: Vec<String> = Vec::new();
    for block in blocks {
        let kind = block.get("type").and_then(Value::as_str).unwrap_or("");
        match kind {
            "text" => {
                if let Some(text) = block.get("text").and_then(Value::as_str) {
                    parts.push(text.to_owned());
                }
            }
            "thinking" => parts.push("[思考]".to_owned()),
            "toolCall" | "tool_call" => {
                let name = block.get("name").and_then(Value::as_str).unwrap_or("tool");
                parts.push(format!("[工具调用：{name}]"));
            }
            "image" => parts.push("[图片]".to_owned()),
            _ => {}
        }
    }
    parts.join("\n")
}

/// bashExecution 一类消息把正文放在 message.command / message.output。
fn shell_text(message: &Value) -> String {
    let command = message.get("command").and_then(Value::as_str);
    let output = message.get("output").and_then(Value::as_str);
    match (command, output) {
        (Some(command), Some(output)) => format!("$ {command}\n{output}"),
        (Some(command), None) => format!("$ {command}"),
        (None, Some(output)) => output.to_owned(),
        (None, None) => String::new(),
    }
}

fn fallback_text(value: &Value, kind: EntryKind) -> String {
    let field = match kind {
        EntryKind::Compaction => "summary",
        EntryKind::SessionInfo => "name",
        EntryKind::Label => "label",
        EntryKind::CustomMessage => "content",
        EntryKind::ModelChange => "modelId",
        _ => "",
    };
    let candidate = if field.is_empty() {
        ["summary", "name", "label", "content"]
            .iter()
            .find_map(|key| value.get(*key))
    } else {
        value.get(field)
    };
    candidate
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_user_string_content() {
        let line = r#"{"type":"message","message":{"role":"user","content":"你好"}}"#;
        assert_eq!(
            extract_text(line),
            (Some("user".to_owned()), "你好".to_owned())
        );
    }

    #[test]
    fn joins_block_content_and_marks_thinking() {
        let line = r#"{"type":"message","message":{"role":"assistant","content":[{"type":"thinking","thinking":"内部"},{"type":"text","text":"答复"},{"type":"toolCall","name":"read"}]}}"#;
        assert_eq!(
            extract_text(line),
            (
                Some("assistant".to_owned()),
                "[思考]\n答复\n[工具调用：read]".to_owned()
            )
        );
    }

    #[test]
    fn renders_shell_execution_records() {
        let line = r#"{"type":"message","message":{"role":"bashExecution","command":"dir","output":"a\nb"}}"#;
        assert_eq!(
            extract_text(line),
            (Some("bashExecution".to_owned()), "$ dir\na\nb".to_owned())
        );
    }

    #[test]
    fn falls_back_to_summary_for_non_message_entries() {
        let line = r#"{"type":"compaction","summary":"早期对话摘要"}"#;
        let extracted = extract_entry(line).unwrap_or_else(|| panic!("compaction 应能解析"));
        assert_eq!(extracted.kind, EntryKind::Compaction);
        assert_eq!(extracted.role, None);
        assert_eq!(extracted.text, "早期对话摘要");
    }

    #[test]
    fn broken_json_yields_empty_text_instead_of_panicking() {
        assert_eq!(extract_text("not json"), (None, String::new()));
    }

    #[test]
    fn truncate_is_char_safe_and_flagged() {
        let long = "汉".repeat(30);
        let (text, clipped) = truncate_chars(&long, 20);
        assert!(clipped);
        assert_eq!(text.chars().count(), 21);
        let (short, not_clipped) = truncate_chars("短", 20);
        assert!(!not_clipped);
        assert_eq!(short, "短");
    }
}
