//! 单会话正文缓存：JSONL 追加即缓存，搜索时线性扫描。
//!
//! 为什么不做倒排索引：会话 JSONL 持续追加，倒排需要增量重建 + 一致性校验；
//! 而 10 MiB 文本的线性扫描在毫秒级，搜索又是低频操作（不是每帧）。
//!
//! 三条不变量：
//! 1. **序号与分页索引同源**：跳过空行、超长行与损坏行都按同样规则产生条目，
//!    因此 `CachedEntry.ordinal` 与 `EntryView.ordinal` 一一对应，命中可以直接翻页定位。
//! 2. **只缓存正文**：不缓存 JSON 原文，不缓存预览；超出预算时丢最旧条目的正文，
//!    条目本身保留（序号不能因为预算而错位）。
//! 3. **追加不重建**：文件变大时只解析新字节；变小或 mtime 倒退才整份重建。

use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use crate::entry::{EntryKind, MessageRole};
use crate::error::{CatalogError, ErrorCode, Result};
use crate::identity::SessionId;
use crate::search::matcher::{self, MAX_MATCHES_PER_ENTRY};
use crate::search::{SearchBudget, SearchHit, SearchOutcome};
use crate::text;

/// 单条正文进入缓存前的字符上限（与桌面端 `entry_text::MAX_TEXT_CHARS` 一致）。
pub const MAX_CACHED_ENTRY_CHARS: usize = 20_000;
/// 超长条目只保留的字符数：够定位，不够刷屏。
pub const OVERSIZED_KEEP_CHARS: usize = 200;
/// 与 `index::MAX_LINE_BYTES` 对齐：超过即视为超长行，只记元数据。
const MAX_LINE_BYTES: usize = 8 * 1024 * 1024;
const READ_CHUNK: usize = 64 * 1024;
/// 每条缓存条目的固定开销估算（序号 / 类型 / 角色 / 标志 + Vec 槽位）。
const ENTRY_OVERHEAD_BYTES: usize = 48;

/// 文件指纹：(mtime 毫秒, 文件字节数)。用于判断能否追加、是否必须重建。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Fingerprint {
    pub mtime_ms: u64,
    pub size: u64,
}

/// 一次同步的结果，供调用方判断「是追加还是重建」。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SyncOutcome {
    /// 本次新增的条目数。
    pub appended: usize,
    /// 是否发生了整份重建。
    pub rebuilt: bool,
}

#[derive(Debug, Clone)]
struct CachedEntry {
    ordinal: u64,
    kind: EntryKind,
    role: Option<MessageRole>,
    /// `None`：超长行、损坏行，或正文因预算被丢弃。
    text: Option<String>,
    /// 正文被裁剪（超长条目 / 预算淘汰），命中时要告诉用户「这不是全文」。
    truncated: bool,
}

/// 单个会话的正文缓存。生命周期由 `SearchCache` 持有，无后台线程。
#[derive(Debug)]
pub struct SessionSearchCache {
    session: SessionId,
    path: PathBuf,
    entries: Vec<CachedEntry>,
    bytes: usize,
    fingerprint: Option<Fingerprint>,
    /// 已解析到文件中的哪个字节位置；未以 LF 结束的尾部留给下一次同步。
    read_position: u64,
    /// 预算淘汰游标：条目只追加，淘汰只从前往后推进，避免 O(n²)。
    evict_cursor: usize,
    dropped: usize,
    rebuilds: u64,
    appends: u64,
}

impl SessionSearchCache {
    pub fn new(session: SessionId, path: impl Into<PathBuf>) -> Self {
        Self {
            session,
            path: path.into(),
            entries: Vec::new(),
            bytes: 0,
            fingerprint: None,
            read_position: 0,
            evict_cursor: 0,
            dropped: 0,
            rebuilds: 0,
            appends: 0,
        }
    }

    pub fn session(&self) -> &SessionId {
        &self.session
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// 当前占用字节数（正文 + 固定开销），用于全局预算与验收证据。
    pub fn bytes(&self) -> usize {
        self.bytes
    }

    pub fn entry_count(&self) -> usize {
        self.entries.len()
    }

    /// 因预算被丢弃正文的条目数；非零表示搜索结果可能不完整。
    pub fn dropped_entries(&self) -> usize {
        self.dropped
    }

    pub fn rebuilds(&self) -> u64 {
        self.rebuilds
    }

    pub fn appends(&self) -> u64 {
        self.appends
    }

    /// 会话文件换落点（迁移 / 绑定变化）：缓存作废，下次同步重建。
    pub fn relocate(&mut self, path: impl Into<PathBuf>) {
        self.path = path.into();
        self.reset();
    }

    fn reset(&mut self) {
        self.entries.clear();
        self.bytes = 0;
        self.fingerprint = None;
        self.read_position = 0;
        self.evict_cursor = 0;
        self.dropped = 0;
    }

    /// 让缓存与磁盘一致：能追加就只追加，指纹异常才重建。
    ///
    /// 判定顺序（先看体积，再看时间，避免 mtime 精度问题把追加误判成改写）：
    /// - 没有指纹 → 重建；
    /// - 变小或 mtime 倒退 → 重建（截断 / 替换 / 时钟回拨）；
    /// - 等长但 mtime 变了 → 重建（外部等长改写，内容已不可信）；
    /// - 变大 → 只解析新增字节；
    /// - 完全一致 → 什么都不做。
    pub fn sync(&mut self, budget: &SearchBudget) -> Result<SyncOutcome> {
        let metadata = fs::metadata(&self.path).map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound => CatalogError::io(
                ErrorCode::SessionFileMissing,
                format!("会话文件不存在：{}", self.path.display()),
                &error,
            ),
            _ => CatalogError::io(
                ErrorCode::IoFailure,
                format!("无法读取会话文件属性：{}", self.path.display()),
                &error,
            ),
        })?;
        let size = metadata.len();
        let mtime_ms = modified_ms(&metadata);
        let Some(fingerprint) = self.fingerprint else {
            return self.rebuild(size, mtime_ms, budget);
        };
        if size < fingerprint.size || mtime_ms < fingerprint.mtime_ms {
            return self.rebuild(size, mtime_ms, budget);
        }
        if size == fingerprint.size {
            return if mtime_ms == fingerprint.mtime_ms {
                Ok(SyncOutcome::default())
            } else {
                self.rebuild(size, mtime_ms, budget)
            };
        }
        self.append(size, mtime_ms, budget)
    }

    fn rebuild(&mut self, size: u64, mtime_ms: u64, budget: &SearchBudget) -> Result<SyncOutcome> {
        self.reset();
        let mut sink = EntrySink::new(budget.per_session_bytes);
        let read_position = scan_file(&self.path, 0, &mut sink)?;
        let appended = sink.entries.len();
        self.entries = sink.entries;
        self.bytes = sink.bytes;
        self.dropped = sink.dropped;
        self.evict_cursor = sink.evict_cursor;
        self.read_position = read_position;
        self.fingerprint = Some(Fingerprint { mtime_ms, size });
        self.rebuilds += 1;
        Ok(SyncOutcome {
            appended,
            rebuilt: true,
        })
    }

    fn append(&mut self, size: u64, mtime_ms: u64, budget: &SearchBudget) -> Result<SyncOutcome> {
        let before = self.entries.len();
        let previous = std::mem::take(&mut self.entries);
        let mut sink = EntrySink::resume(
            budget.per_session_bytes,
            previous,
            self.bytes,
            self.dropped,
            self.evict_cursor,
        );
        match scan_file(&self.path, self.read_position, &mut sink) {
            Ok(read_position) => {
                let appended = sink.entries.len().saturating_sub(before);
                self.entries = sink.entries;
                self.bytes = sink.bytes;
                self.dropped = sink.dropped;
                self.evict_cursor = sink.evict_cursor;
                self.read_position = read_position;
                self.fingerprint = Some(Fingerprint { mtime_ms, size });
                self.appends += 1;
                Ok(SyncOutcome {
                    appended,
                    rebuilt: false,
                })
            }
            Err(error) => {
                // 追加途中失败：缓存不再可信，标记为待重建，绝不返回半份结果。
                self.reset();
                Err(error)
            }
        }
    }

    /// 线性扫描缓存条目；大小写不敏感子串匹配。
    ///
    /// `after_ordinal` 只影响本次返回的条目，不影响 `total_hits`：
    /// 界面要显示「共 N 条命中」，翻页不应该改变这个数字。
    pub fn search(&self, query: &str, limit: usize, after_ordinal: Option<u64>) -> SearchOutcome {
        let mut outcome = SearchOutcome {
            hits: Vec::new(),
            total_hits: 0,
            scanned_entries: self.entries.len(),
            truncated: false,
        };
        for entry in &self.entries {
            let Some(text) = entry.text.as_deref() else {
                continue;
            };
            let spans = matcher::find_all(text, query, MAX_MATCHES_PER_ENTRY);
            let Some(first) = spans.first().copied() else {
                continue;
            };
            outcome.total_hits += 1;
            if let Some(after) = after_ordinal
                && entry.ordinal <= after
            {
                continue;
            }
            if outcome.hits.len() >= limit {
                outcome.truncated = true;
                continue;
            }
            let snippet = matcher::snippet(text, first);
            outcome.hits.push(SearchHit {
                ordinal: entry.ordinal,
                kind: entry.kind,
                role: entry.role,
                snippet: snippet.text,
                match_start: snippet.match_start,
                match_end: snippet.match_end,
                total_matches: spans.len(),
                truncated: entry.truncated,
            });
        }
        outcome
    }
}

fn modified_ms(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

/// 从 `from` 开始流式解析，返回「已消费到」的文件偏移（未结束的尾部不算）。
fn scan_file(path: &Path, from: u64, sink: &mut EntrySink) -> Result<u64> {
    let mut file = File::open(path).map_err(|error| {
        CatalogError::io(
            ErrorCode::SessionFileMissing,
            format!("会话文件不存在：{}", path.display()),
            &error,
        )
    })?;
    if from > 0 {
        file.seek(SeekFrom::Start(from))
            .map_err(|error| CatalogError::io(ErrorCode::IoFailure, "定位会话文件失败", &error))?;
    }
    let mut reader = LineReader::new(from);
    let mut buffer = vec![0_u8; READ_CHUNK];
    let mut position = from;
    loop {
        match file.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => {
                reader.push(&buffer[..read], position, sink);
                position += read as u64;
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => {
                return Err(CatalogError::io(
                    ErrorCode::IoFailure,
                    format!("读取会话文件失败：{}", path.display()),
                    &error,
                ));
            }
        }
    }
    Ok(reader.read_position())
}

/// 按行切分并把每条记录交给 `EntrySink`。
///
/// 超长行（> `MAX_LINE_BYTES`）不缓冲正文：只记行起点，等换行到达后补一个空正文条目，
/// 保证序号与索引一致。
#[derive(Debug)]
struct LineReader {
    pending: Vec<u8>,
    pending_start: u64,
    skip_start: Option<u64>,
}

impl LineReader {
    fn new(start: u64) -> Self {
        Self {
            pending: Vec::new(),
            pending_start: start,
            skip_start: None,
        }
    }

    /// 已消费到的位置：未以 LF 结束的尾部留在这里等下一次同步。
    fn read_position(&self) -> u64 {
        self.pending_start
    }

    fn push(&mut self, chunk: &[u8], chunk_start: u64, sink: &mut EntrySink) {
        let mut cursor = 0_usize;
        while cursor < chunk.len() {
            if self.skip_start.is_some() {
                match chunk[cursor..].iter().position(|byte| *byte == b'\n') {
                    Some(relative) => {
                        sink.push(None);
                        self.skip_start = None;
                        self.pending_start = chunk_start + (cursor + relative) as u64 + 1;
                        cursor += relative + 1;
                    }
                    None => {
                        self.pending_start = chunk_start + chunk.len() as u64;
                        cursor = chunk.len();
                    }
                }
                continue;
            }
            debug_assert_eq!(
                self.pending_start + self.pending.len() as u64,
                chunk_start + cursor as u64,
                "行缓冲位置与读取位置不一致"
            );
            self.pending.extend_from_slice(&chunk[cursor..]);
            cursor = chunk.len();
            self.drain_lines(sink);
            if self.pending.len() > MAX_LINE_BYTES {
                self.skip_start = Some(self.pending_start);
                self.pending_start += self.pending.len() as u64;
                self.pending.clear();
            }
        }
    }

    fn drain_lines(&mut self, sink: &mut EntrySink) {
        let mut consumed = 0_usize;
        while let Some(relative) = self.pending[consumed..]
            .iter()
            .position(|byte| *byte == b'\n')
        {
            let line_feed = consumed + relative;
            let line = &self.pending[consumed..line_feed];
            let body = line.strip_suffix(b"\r").unwrap_or(line);
            if !body.is_empty() {
                sink.push(Some(body));
            }
            consumed = line_feed + 1;
        }
        if consumed > 0 {
            self.pending.drain(..consumed);
            self.pending_start += consumed as u64;
        }
    }
}

/// 追加写入的条目收集器：负责正文裁剪与单会话字节预算。
struct EntrySink {
    entries: Vec<CachedEntry>,
    bytes: usize,
    dropped: usize,
    evict_cursor: usize,
    budget: usize,
}

impl EntrySink {
    fn new(budget: usize) -> Self {
        Self::resume(budget, Vec::new(), 0, 0, 0)
    }

    fn resume(
        budget: usize,
        entries: Vec<CachedEntry>,
        bytes: usize,
        dropped: usize,
        evict_cursor: usize,
    ) -> Self {
        Self {
            entries,
            bytes,
            dropped,
            evict_cursor,
            budget,
        }
    }

    /// `body` 为 None 表示超长行：只保留序号，不留正文。
    fn push(&mut self, body: Option<&[u8]>) {
        let ordinal = self.entries.len() as u64;
        let (kind, role, text, truncated) = match body {
            None => (EntryKind::Unknown, None, None, true),
            Some(raw) => match std::str::from_utf8(raw).ok().and_then(text::extract_entry) {
                Some(extracted) => {
                    let (text, truncated) = clip_text(extracted.text);
                    (extracted.kind, extracted.role, text, truncated)
                }
                // 损坏行：与索引一样保留条目（序号不能错位），但没有可搜正文。
                None => (EntryKind::Unknown, None, None, false),
            },
        };
        self.bytes += text.as_ref().map_or(0, String::len) + ENTRY_OVERHEAD_BYTES;
        self.entries.push(CachedEntry {
            ordinal,
            kind,
            role,
            text,
            truncated,
        });
        self.enforce_budget();
    }

    /// 超出单会话预算时丢**最旧**条目的正文；条目本身保留，序号不错位。
    fn enforce_budget(&mut self) {
        while self.bytes > self.budget && self.evict_cursor < self.entries.len() {
            let index = self.evict_cursor;
            if let Some(text) = self.entries[index].text.take() {
                self.bytes -= text.len() + ENTRY_OVERHEAD_BYTES;
                self.entries[index].truncated = true;
                self.dropped += 1;
            }
            self.evict_cursor += 1;
        }
    }
}

/// 超长正文只留前 `OVERSIZED_KEEP_CHARS` 个字符，并标记 truncated。
fn clip_text(text: String) -> (Option<String>, bool) {
    if text.is_empty() {
        return (None, false);
    }
    if text.chars().count() <= MAX_CACHED_ENTRY_CHARS {
        return (Some(text), false);
    }
    let kept: String = text.chars().take(OVERSIZED_KEEP_CHARS).collect();
    (Some(format!("{kept}…")), true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sink(budget: usize) -> EntrySink {
        EntrySink::new(budget)
    }

    #[test]
    fn clips_oversized_text_but_keeps_entry() {
        let long = format!("扩散{}", "汉".repeat(MAX_CACHED_ENTRY_CHARS));
        let line = serde_json::json!({
            "type": "message",
            "message": { "role": "assistant", "content": long },
        })
        .to_string();
        let mut sink = sink(8 * 1024 * 1024);
        sink.push(Some(line.as_bytes()));
        let entry = &sink.entries[0];
        assert!(entry.truncated, "超长条目必须标记 truncated");
        let text = entry.text.as_deref().unwrap_or_default();
        assert_eq!(text.chars().count(), OVERSIZED_KEEP_CHARS + 1);
        assert!(text.starts_with("扩散"));
    }

    #[test]
    fn budget_drops_oldest_text_but_keeps_ordinals() {
        let mut sink = sink(ENTRY_OVERHEAD_BYTES * 2 + 64);
        for index in 0..6 {
            let line = serde_json::json!({
                "type": "message",
                "message": { "role": "user", "content": format!("消息 {index} 扩散") },
            })
            .to_string();
            sink.push(Some(line.as_bytes()));
        }
        assert_eq!(sink.entries.len(), 6, "条目不能因为预算消失");
        assert!(sink.dropped > 0, "预算必须真的淘汰正文");
        assert!(
            sink.bytes <= ENTRY_OVERHEAD_BYTES * 2 + 64,
            "缓存占用必须回到预算内：{}",
            sink.bytes
        );
        assert_eq!(
            sink.entries[5]
                .text
                .as_deref()
                .map(|text| text.contains("扩散")),
            Some(true),
            "最新条目必须留在缓存里"
        );
        for (index, entry) in sink.entries.iter().enumerate() {
            assert_eq!(entry.ordinal, index as u64, "序号必须与位置一致");
        }
    }

    #[test]
    fn corrupt_line_keeps_ordinal_without_text() {
        let mut sink = sink(1024 * 1024);
        sink.push(Some(b"not json"));
        assert_eq!(sink.entries.len(), 1);
        assert!(sink.entries[0].text.is_none());
        assert!(!sink.entries[0].truncated, "损坏行不是被裁剪");
    }

    #[test]
    fn line_reader_waits_for_complete_lines() {
        let mut sink = sink(1024 * 1024);
        let mut reader = LineReader::new(0);
        reader.push(b"{\"type\":\"mess", 0, &mut sink);
        assert_eq!(sink.entries.len(), 0, "未结束的行不能进缓存");
        assert_eq!(reader.read_position(), 0);
        reader.push(b"age\"}\n{\"type\":\"label\"}\n", 13, &mut sink);
        assert_eq!(sink.entries.len(), 2);
        assert_eq!(reader.read_position(), 36);
    }
}
