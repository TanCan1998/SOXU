//! NDJSON 分帧：只按 0x0A 切分，绝不把 U+2028/U+2029 当行分隔符。
//!
//! 支持任意切分的读入（粘包、拆包、跨块的多字节字符），并对超长半行设上限。

/// 与协议层一致的单条记录上限。
pub const DEFAULT_MAX_FRAME_BYTES: usize = soxu_pi_protocol::MAX_RECORD_BYTES;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FrameError {
    /// 半行超过上限：流已失步，调用方必须终止进程。
    TooLarge { limit: usize },
    /// 完整行不是合法 UTF-8：说明对端写坏了字节。
    InvalidUtf8 { preview: String },
}

impl std::fmt::Display for FrameError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TooLarge { limit } => {
                write!(formatter, "ndjson frame exceeded {limit} bytes")
            }
            Self::InvalidUtf8 { preview } => {
                write!(formatter, "ndjson frame is not valid utf-8: {preview}")
            }
        }
    }
}

impl std::error::Error for FrameError {}

/// 增量分帧器。唯一 owner 是读取任务，不会跨线程共享。
#[derive(Debug)]
pub struct LineFramer {
    pending: Vec<u8>,
    max_frame_bytes: usize,
}

impl LineFramer {
    pub fn new(max_frame_bytes: usize) -> Self {
        Self {
            pending: Vec::new(),
            max_frame_bytes: max_frame_bytes.max(1),
        }
    }

    /// 喂入一段字节，返回本次凑齐的完整行（已去掉 LF 与可选的 CR）。
    ///
    /// 空行被忽略：真实 CLI 偶尔会多输出一个换行，不应被当成协议错误。
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<String>, FrameError> {
        if chunk.is_empty() {
            return Ok(Vec::new());
        }
        self.pending.extend_from_slice(chunk);
        self.drain_lines()
    }

    /// 流结束时调用：把末尾没有换行的残行也交出去。
    pub fn finish(&mut self) -> Result<Option<String>, FrameError> {
        if self.pending.is_empty() {
            return Ok(None);
        }
        if self.pending.len() > self.max_frame_bytes {
            self.pending.clear();
            return Err(FrameError::TooLarge {
                limit: self.max_frame_bytes,
            });
        }
        let bytes = std::mem::take(&mut self.pending);
        decode_line(trim_carriage_return(&bytes)).map(Some)
    }

    /// 尚未凑成完整行的字节数（供内存上界诊断）。
    pub fn buffered_bytes(&self) -> usize {
        self.pending.len()
    }

    fn drain_lines(&mut self) -> Result<Vec<String>, FrameError> {
        let mut lines = Vec::new();
        let mut consumed = 0usize;
        let mut oversized = false;
        while let Some(offset) = self.pending[consumed..]
            .iter()
            .position(|byte| *byte == b'\n')
        {
            let end = consumed + offset;
            let raw = &self.pending[consumed..end];
            let stripped = trim_carriage_return(raw);
            consumed = end + 1;
            // 完整行也要卡上限：超长单行同样说明流已失步，不能交给上层解析。
            if stripped.len() > self.max_frame_bytes {
                oversized = true;
                break;
            }
            if !stripped.is_empty() {
                lines.push(decode_line(stripped)?);
            }
        }
        if consumed > 0 {
            self.pending.drain(..consumed);
        }
        if oversized {
            let limit = self.max_frame_bytes;
            self.pending.clear();
            return Err(FrameError::TooLarge { limit });
        }
        if self.pending.len() > self.max_frame_bytes {
            let limit = self.max_frame_bytes;
            self.pending.clear();
            return Err(FrameError::TooLarge { limit });
        }
        Ok(lines)
    }
}

fn trim_carriage_return(bytes: &[u8]) -> &[u8] {
    match bytes.split_last() {
        Some((b'\r', rest)) => rest,
        _ => bytes,
    }
}

fn decode_line(bytes: &[u8]) -> Result<String, FrameError> {
    std::str::from_utf8(bytes)
        .map(str::to_owned)
        .map_err(|err| FrameError::InvalidUtf8 {
            preview: err.to_string(),
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn framer() -> LineFramer {
        LineFramer::new(DEFAULT_MAX_FRAME_BYTES)
    }

    #[test]
    fn coalesced_frames_are_split() {
        let mut framer = framer();
        let lines = framer.push(b"{\"a\":1}\n{\"b\":2}\n{\"c\":3}\n").unwrap();
        assert_eq!(lines, vec!["{\"a\":1}", "{\"b\":2}", "{\"c\":3}"]);
        assert_eq!(framer.buffered_bytes(), 0);
    }

    #[test]
    fn fragmented_frame_is_reassembled() {
        let mut framer = framer();
        assert!(framer.push(b"{\"ty").unwrap().is_empty());
        assert!(framer.push(b"pe\":\"ev").unwrap().is_empty());
        let lines = framer.push(b"ent\"}\n").unwrap();
        assert_eq!(lines, vec!["{\"type\":\"event\"}"]);
    }

    #[test]
    fn multi_byte_character_split_across_reads_is_preserved() {
        let mut framer = framer();
        let payload = "{\"text\":\"中文标记\"}\n".as_bytes();
        let cut = 12; // 落在“中”字的 UTF-8 字节中间
        assert!(framer.push(&payload[..cut]).unwrap().is_empty());
        let lines = framer.push(&payload[cut..]).unwrap();
        assert_eq!(lines, vec!["{\"text\":\"中文标记\"}"]);
    }

    #[test]
    fn carriage_return_is_stripped_for_windows_producers() {
        let mut framer = framer();
        let lines = framer.push(b"{\"a\":1}\r\n{\"b\":2}\r\n").unwrap();
        assert_eq!(lines, vec!["{\"a\":1}", "{\"b\":2}"]);
    }

    #[test]
    fn blank_lines_are_ignored() {
        let mut framer = framer();
        let lines = framer.push(b"\n\r\n{\"a\":1}\n\n").unwrap();
        assert_eq!(lines, vec!["{\"a\":1}"]);
    }

    #[test]
    fn unicode_line_separator_is_not_a_delimiter() {
        let mut framer = framer();
        let payload = "{\"a\":\"x\u{2028}y\u{2029}z\"}\n".as_bytes();
        let lines = framer.push(payload).unwrap();
        assert_eq!(lines.len(), 1, "U+2028/U+2029 不能切分记录");
        assert!(lines[0].contains("y"));
    }

    #[test]
    fn oversized_partial_frame_fails_instead_of_buffering_forever() {
        let mut framer = LineFramer::new(16);
        let error = framer.push(&[b'a'; 32]).unwrap_err();
        assert_eq!(error, FrameError::TooLarge { limit: 16 });
        assert_eq!(framer.buffered_bytes(), 0, "失步后必须释放缓冲");
    }

    #[test]
    fn oversized_frame_after_valid_lines_still_surfaces_error() {
        let mut framer = LineFramer::new(8);
        let error = framer.push(b"short\n0123456789").unwrap_err();
        assert_eq!(error, FrameError::TooLarge { limit: 8 });
        assert_eq!(framer.buffered_bytes(), 0, "失步后必须释放缓冲");
    }

    #[test]
    fn oversized_complete_line_is_rejected_even_with_trailing_newline() {
        let mut framer = LineFramer::new(8);
        let error = framer.push(b"0123456789\n{\"a\":1}\n").unwrap_err();
        assert_eq!(error, FrameError::TooLarge { limit: 8 });
    }

    #[test]
    fn finish_returns_trailing_line_without_newline() {
        let mut framer = framer();
        assert!(framer.push(b"{\"tail\":true}").unwrap().is_empty());
        assert_eq!(framer.finish().unwrap().as_deref(), Some("{\"tail\":true}"));
        assert_eq!(framer.finish().unwrap(), None);
    }

    #[test]
    fn invalid_utf8_is_reported() {
        let mut framer = framer();
        let error = framer.push(b"\xff\xfe\n").unwrap_err();
        assert!(matches!(error, FrameError::InvalidUtf8 { .. }));
    }
}
