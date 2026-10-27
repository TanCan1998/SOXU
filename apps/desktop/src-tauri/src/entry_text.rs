//! 按需读取单条会话条目的完整正文。
//!
//! 索引分页只给出 240 字符的预览（见 `soxu_session_index::PREVIEW_CHARS`），
//! 聊天界面需要完整消息时用 `HistoryEntry` 的 `offset`/`length` 定位到这里读取。
//! 读取有双重预算：单条上限与批次上限，且不信任前端传入的范围（必须落在文件内）。

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use crate::dto::{EntryRefInput, EntryText};
use soxu_session_index::INLINE_ENTRY_BYTES;

/// 单条条目允许读取的最大字节数；超过 `INLINE_ENTRY_BYTES` 的条目索引只给占位视图。
pub const MAX_ENTRY_BYTES: u32 = INLINE_ENTRY_BYTES;
/// 一次 IPC 批次最多读取的条目数，避免前端一次拉爆内存。
pub const MAX_BATCH_TEXTS: usize = 40;
/// 单条消息进入 UI 前的字符上限（按字符截断，UTF-8 安全）。
pub const MAX_TEXT_CHARS: usize = 20_000;

/// 校验前端提交的定位信息，任何越界都拒绝而不是猜测。
pub fn validate_range(offset: u64, length: u32, file_len: u64) -> Result<(), String> {
    if length == 0 {
        return Err("条目长度为 0".to_owned());
    }
    if length > MAX_ENTRY_BYTES {
        return Err(format!(
            "条目过大（{length} 字节 > {MAX_ENTRY_BYTES}），请使用占位视图"
        ));
    }
    let end = offset
        .checked_add(u64::from(length))
        .ok_or_else(|| "条目范围溢出".to_owned())?;
    if end > file_len {
        return Err(format!("条目范围 {offset}..{end} 超出文件长度 {file_len}"));
    }
    Ok(())
}

/// 读取并解析一条条目的完整正文。
pub fn read_entry_text(
    file: &Path,
    file_len: u64,
    reference: &EntryRefInput,
) -> Result<EntryText, String> {
    validate_range(reference.offset, reference.length, file_len)?;
    let mut handle = File::open(file).map_err(|error| format!("打开会话文件失败：{error}"))?;
    handle
        .seek(SeekFrom::Start(reference.offset))
        .map_err(|error| format!("定位会话条目失败：{error}"))?;
    let mut buffer = vec![0_u8; reference.length as usize];
    handle
        .read_exact(&mut buffer)
        .map_err(|error| format!("读取会话条目失败：{error}"))?;
    let line = String::from_utf8_lossy(&buffer);
    let (role, text) = extract_text(&line);
    let (text, clipped) = truncate(&text);
    Ok(EntryText {
        ordinal: reference.ordinal,
        role,
        text,
        clipped,
    })
}

/// 从一条 JSONL 记录里提取角色与可显示正文；未知结构返回空文本而不是报错。
pub fn extract_text(line: &str) -> (Option<String>, String) {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(line.trim_end_matches(['\r', '\n']))
    else {
        return (None, String::new());
    };
    let Some(message) = value.get("message") else {
        // compaction / session_info 等非消息条目：退回常见文本字段。
        let fallback = ["summary", "name", "label", "content"]
            .iter()
            .find_map(|key| value.get(*key).and_then(|item| item.as_str()))
            .unwrap_or_default();
        return (None, fallback.to_owned());
    };
    let role = message
        .get("role")
        .and_then(|item| item.as_str())
        .map(str::to_owned);
    let text = match message.get("content") {
        Some(serde_json::Value::String(text)) => text.clone(),
        Some(serde_json::Value::Array(blocks)) => join_blocks(blocks),
        _ => shell_text(message),
    };
    (role, text)
}

fn join_blocks(blocks: &[serde_json::Value]) -> String {
    let mut parts: Vec<String> = Vec::new();
    for block in blocks {
        let kind = block
            .get("type")
            .and_then(|item| item.as_str())
            .unwrap_or("");
        match kind {
            "text" => {
                if let Some(text) = block.get("text").and_then(|item| item.as_str()) {
                    parts.push(text.to_owned());
                }
            }
            "thinking" => parts.push("[思考]".to_owned()),
            "toolCall" | "tool_call" => {
                let name = block
                    .get("name")
                    .and_then(|item| item.as_str())
                    .unwrap_or("tool");
                parts.push(format!("[工具调用：{name}]"));
            }
            "image" => parts.push("[图片]".to_owned()),
            _ => {}
        }
    }
    parts.join("\n")
}

/// bashExecution 一类消息把正文放在 message.command / message.output。
fn shell_text(message: &serde_json::Value) -> String {
    let command = message.get("command").and_then(|item| item.as_str());
    let output = message.get("output").and_then(|item| item.as_str());
    match (command, output) {
        (Some(command), Some(output)) => format!("$ {command}\n{output}"),
        (Some(command), None) => format!("$ {command}"),
        (None, Some(output)) => output.to_owned(),
        (None, None) => String::new(),
    }
}

/// 按字符截断，避免一个巨型工具输出撑爆 Vue 状态。
pub fn truncate(text: &str) -> (String, bool) {
    if text.chars().count() <= MAX_TEXT_CHARS {
        return (text.to_owned(), false);
    }
    let kept: String = text.chars().take(MAX_TEXT_CHARS).collect();
    (format!("{kept}…"), true)
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
    fn broken_json_yields_empty_text_instead_of_panicking() {
        assert_eq!(extract_text("not json"), (None, String::new()));
    }

    #[test]
    fn truncate_is_char_safe_and_flagged() {
        let long = "汉".repeat(MAX_TEXT_CHARS + 5);
        let (text, clipped) = truncate(&long);
        assert!(clipped);
        assert_eq!(text.chars().count(), MAX_TEXT_CHARS + 1);
        let (short, not_clipped) = truncate("短");
        assert!(!not_clipped);
        assert_eq!(short, "短");
    }

    #[test]
    fn range_validation_rejects_untrusted_input() {
        assert!(validate_range(0, 10, 10).is_ok());
        assert!(validate_range(5, 10, 10).is_err(), "越界必须拒绝");
        assert!(validate_range(0, 0, 10).is_err(), "零长度无意义");
        assert!(
            validate_range(0, MAX_ENTRY_BYTES + 1, u64::from(MAX_ENTRY_BYTES) + 10).is_err(),
            "超过单条预算必须拒绝"
        );
        assert!(
            validate_range(u64::MAX, 2, u64::MAX).is_err(),
            "溢出范围必须拒绝"
        );
    }
}
