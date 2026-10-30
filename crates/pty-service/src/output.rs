//! PTY 输出的合并与推送（16ms 节流）。
//!
//! 为什么要节流：`read()` 的粒度是内核管道缓冲（常见 4–8 KiB），而 `echo` 一条
//! 几十字节的输出往往分成多次 read。逐次 `emit` 会把 WebView 的 IPC 队列打满，
//! 表现为「大输出时界面卡住」。这里把窗口内的分片合并成一次推送：
//!
//! - 正常路径：合并线程每 [`FLUSH_INTERVAL`]（16ms，约 60 次/秒）取一次；
//! - 突发路径：累计超过 [`MAX_PENDING_BYTES`] 立刻强制推送，避免大输出把内存顶穿；
//! - 尾部路径：读取线程结束后 `finish()` 把剩余字节（含不完整的 UTF-8 尾巴）一次性交出。
//!
//! UTF-8 边界：一个多字节字符可能横跨两次 `read`。若按分片各自解码，半个汉字会变成
//! U+FFFD（看起来就是「乱码」）。所以 `flush()` 只交出**完整**的字符前缀，
//! 不完整的尾部留在缓冲里等下一个分片补齐。

use std::time::Duration;

/// 合并窗口：16ms ≈ 60 次/秒，与显示器刷新同量级，肉眼无延迟感。
pub const FLUSH_INTERVAL: Duration = Duration::from_millis(16);

/// 单次合并的硬上限（256 KiB）。超限立刻推送，保证内存有界。
pub const MAX_PENDING_BYTES: usize = 256 * 1024;

/// 一次推送的内容。`seq` 单调递增，供前端发现丢包或乱序（当前仅做诊断用）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PtyOutput {
    pub pty_id: String,
    pub seq: u64,
    pub data: String,
}

/// 有界的输出合并器。非线程安全：由合并线程独占，不需要内部加锁。
#[derive(Debug)]
pub struct OutputThrottle {
    pty_id: String,
    seq: u64,
    pending: Vec<u8>,
    max_pending: usize,
}

impl OutputThrottle {
    pub fn new(pty_id: impl Into<String>, max_pending: usize) -> Self {
        Self {
            pty_id: pty_id.into(),
            seq: 0,
            pending: Vec::new(),
            // 上限至少要有意义：0 会让每一次 push 都强制推送，等于没有节流。
            max_pending: max_pending.max(1),
        }
    }

    /// 收下一个分片。只有累计超过硬上限时才返回可推送内容（强制出队）。
    pub fn push(&mut self, chunk: &[u8]) -> Option<PtyOutput> {
        self.pending.extend_from_slice(chunk);
        if self.pending.len() >= self.max_pending {
            self.emit_complete()
        } else {
            None
        }
    }

    /// 定时窗口到点：交出当前**完整**字符前缀；只剩不完整尾巴时返回 `None`。
    pub fn flush(&mut self) -> Option<PtyOutput> {
        self.emit_complete()
    }

    /// 流结束：把剩余字节（含不完整的 UTF-8 尾巴，按 lossy 解码）一次性交出。
    pub fn finish(&mut self) -> Option<PtyOutput> {
        if self.pending.is_empty() {
            return None;
        }
        let bytes = std::mem::take(&mut self.pending);
        Some(self.wrap(String::from_utf8_lossy(&bytes).into_owned()))
    }

    pub fn pending_len(&self) -> usize {
        self.pending.len()
    }

    pub fn is_empty(&self) -> bool {
        self.pending.is_empty()
    }

    fn emit_complete(&mut self) -> Option<PtyOutput> {
        let end = self.complete_prefix();
        if end == 0 {
            return None;
        }
        let bytes: Vec<u8> = self.pending.drain(..end).collect();
        Some(self.wrap(String::from_utf8_lossy(&bytes).into_owned()))
    }

    /// 缓冲里「可以安全解码」的前缀长度。
    fn complete_prefix(&self) -> usize {
        match std::str::from_utf8(&self.pending) {
            Ok(_) => self.pending.len(),
            Err(error) => {
                let valid = error.valid_up_to();
                match error.error_len() {
                    // 真实的非法字节：连它一起交出去（lossy 解码成 U+FFFD）。
                    // 否则它会被当成「不完整序列」永久扣在缓冲里，输出就停住了。
                    Some(len) => valid + len,
                    // 尾部是不完整的 UTF-8 序列：扣住等下一个分片，避免半个汉字变乱码。
                    None => valid,
                }
            }
        }
    }

    fn wrap(&mut self, data: String) -> PtyOutput {
        self.seq += 1;
        PtyOutput {
            pty_id: self.pty_id.clone(),
            seq: self.seq,
            data,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn throttle() -> OutputThrottle {
        OutputThrottle::new("pty_1", MAX_PENDING_BYTES)
    }

    #[test]
    fn flush_interval_is_sixteen_milliseconds() {
        // 验收要求「后端 16ms 合并一次」：这个常量是唯一来源，改动必须是有意的。
        assert_eq!(FLUSH_INTERVAL, Duration::from_millis(16));
    }

    #[test]
    fn chunks_are_not_pushed_one_by_one() {
        let mut throttle = throttle();
        for index in 0..500 {
            let chunk = format!("line-{index}\n");
            assert_eq!(
                throttle.push(chunk.as_bytes()),
                None,
                "单个分片不得立刻推送"
            );
        }
        let merged = throttle.flush().expect("窗口到点必须推送");
        assert_eq!(merged.seq, 1);
        assert_eq!(merged.pty_id, "pty_1");
        assert!(merged.data.starts_with("line-0\n"));
        assert!(merged.data.ends_with("line-499\n"));
        // 一次推送里包含全部分片，顺序不变。
        assert_eq!(merged.data.lines().count(), 500);
        assert!(throttle.flush().is_none(), "空缓冲不得产生空事件");
    }

    #[test]
    fn burst_over_the_cap_is_forced_out_before_the_window() {
        let mut throttle = OutputThrottle::new("pty_cap", 8);
        assert_eq!(
            throttle.push(b"12345678"),
            Some(PtyOutput {
                pty_id: "pty_cap".to_owned(),
                seq: 1,
                data: "12345678".to_owned(),
            })
        );
        assert_eq!(throttle.pending_len(), 0);
    }

    #[test]
    fn utf8_split_across_chunks_is_reassembled_without_replacement_chars() {
        let text = "终端输出不乱码";
        let bytes = text.as_bytes();
        let mut throttle = throttle();
        // 逐字节喂入：每个多字节字符都会被切开。
        let mut pushed = Vec::new();
        for byte in bytes {
            if let Some(output) = throttle.push(std::slice::from_ref(byte)) {
                pushed.push(output.data);
            }
            if let Some(output) = throttle.flush() {
                pushed.push(output.data);
            }
        }
        if let Some(output) = throttle.finish() {
            pushed.push(output.data);
        }
        let joined = pushed.concat();
        assert_eq!(joined, text);
        assert!(
            !joined.contains('\u{FFFD}'),
            "半个字符被解码成替换字符就是乱码"
        );
    }

    #[test]
    fn incomplete_tail_waits_for_the_next_chunk() {
        let mut throttle = throttle();
        let bytes = "汉".as_bytes();
        // 前两个字节不足以解码出一个完整字符：窗口到点也不能推出半个。
        assert_eq!(throttle.push(&bytes[..2]), None);
        assert_eq!(throttle.flush(), None);
        assert_eq!(throttle.pending_len(), 2, "不完整的尾巴必须留在缓冲里");
        // 补齐第三个字节后一次推出完整字符。
        assert_eq!(throttle.push(&bytes[2..]), None);
        let output = throttle.flush().expect("补齐后可以推送");
        assert_eq!(output.data, "汉");
    }

    #[test]
    fn invalid_bytes_are_emitted_instead_of_stalling() {
        let mut throttle = throttle();
        // 0xFF 永远不是合法 UTF-8：不能当成「等下一个分片」而永久卡住。
        assert_eq!(throttle.push(&[b'a', 0xFF]), None);
        let output = throttle.flush().expect("非法字节必须被推出");
        assert!(output.data.starts_with('a'));
        assert!(output.data.contains('\u{FFFD}'));
        assert_eq!(throttle.pending_len(), 0);
    }

    #[test]
    fn finish_flushes_the_lossy_tail() {
        let mut throttle = throttle();
        let bytes = "汉".as_bytes();
        assert_eq!(throttle.push(&bytes[..1]), None);
        let output = throttle.finish().expect("流结束必须交出尾巴");
        assert!(
            output.data.contains('\u{FFFD}'),
            "残缺字节按 lossy 处理，不静默丢弃"
        );
        assert!(throttle.finish().is_none(), "finish 之后缓冲为空");
    }

    #[test]
    fn sequence_numbers_are_monotonic_across_pushes() {
        let mut throttle = OutputThrottle::new("pty_seq", 4);
        let first = throttle.push(b"aaaa").expect("到上限立刻推送");
        let second = throttle.push(b"bbbb").expect("到上限立刻推送");
        let third = throttle.push(b"cccc").expect("到上限立刻推送");
        assert_eq!((first.seq, second.seq, third.seq), (1, 2, 3));
    }
}
