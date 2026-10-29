//! 按需读取单条会话条目的完整正文。
//!
//! 索引分页只给出 240 字符的预览（见 `soxu_session_index::PREVIEW_CHARS`），
//! 聊天界面需要完整消息时用 `HistoryEntry` 的 `offset`/`length` 定位到这里读取。
//! 读取有双重预算：单条上限与批次上限，且不信任前端传入的范围（必须落在文件内）。
//!
//! 正文提取复用 `soxu_session_index::text`：会话内搜索缓存用同一份实现，
//! 否则会出现「界面显示的内容搜不到 / 搜到的内容界面不显示」。

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
///
/// 与搜索缓存的单条正文上限共用同一个常量：两边口径不同会让「看得到」与
/// 「搜得到」出现缝隙。
pub const MAX_TEXT_CHARS: usize = soxu_session_index::MAX_CACHED_ENTRY_CHARS;

/// 与搜索缓存共用的正文提取：角色保留 Pi 原始字符串（如 `bashExecution`）。
pub use soxu_session_index::extract_text;

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

/// 按字符截断，避免一个巨型工具输出撑爆 Vue 状态。
pub fn truncate(text: &str) -> (String, bool) {
    soxu_session_index::truncate_chars(text, MAX_TEXT_CHARS)
}

#[cfg(test)]
mod tests {
    use super::*;

    // 提取逻辑本身在 `soxu_session_index::text` 里有完整单测；这里只验证
    // 桌面端经适配层拿到的形状没有变化（角色原文 + 正文）。
    #[test]
    fn adapter_keeps_role_and_text_shape() {
        let line = r#"{"type":"message","message":{"role":"user","content":"你好"}}"#;
        assert_eq!(
            extract_text(line),
            (Some("user".to_owned()), "你好".to_owned())
        );
    }

    #[test]
    fn adapter_renders_shell_execution_records() {
        let line = r#"{"type":"message","message":{"role":"bashExecution","command":"dir","output":"a\nb"}}"#;
        assert_eq!(
            extract_text(line),
            (Some("bashExecution".to_owned()), "$ dir\na\nb".to_owned())
        );
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
