//! Pi JSONL 会话的增量索引与有界分页。
//!
//! 设计要点：
//! - 只保存每行的字节偏移与轻量元数据，正文永不常驻内存。
//! - 扫描以 64 KiB 分块推进，未以 LF 结束的尾部留在 pending 中，等 Pi 写完再索引。
//! - 超过 MAX_LINE_BYTES 的单行进入跳过模式：只记录长度与告警，不缓冲正文。
//! - 文件被截断或替换（头部指纹变化）时整体重建，而不是继续错位读取。
//!
//! 分页实现在 page 子模块：读取预算是会话级参数，与扫描状态共享同一份偏移表。

mod page;

use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

pub use page::{INLINE_ENTRY_BYTES, MAX_PAGE_BYTES, MAX_PAGE_ENTRIES, SessionPage};

use crate::entry::{self, EntryKind, EntryMeta, SessionHeader};
use crate::error::{CatalogError, ErrorCode, Result};
use crate::hash::fnv1a64;
use crate::snapshot::{
    CATALOG_SCHEMA_VERSION, IndexSnapshot, MAX_WARNINGS, RebuildReason, ScanReport, ScanWarning,
    SnapshotLoad, WarningKind,
};
use crate::store;

/// 单行缓冲上限；超过即进入跳过模式。
pub(crate) const MAX_LINE_BYTES: usize = 8 * 1024 * 1024;
const SCAN_CHUNK: usize = 64 * 1024;
const HEAD_BYTES: u64 = 4096;
const GROWTH_ROUNDS: usize = 8;

/// 单个会话文件的索引状态。生命周期归调用方所有，无后台线程。
#[derive(Debug)]
pub struct SessionLog {
    path: PathBuf,
    entries: Vec<EntryMeta>,
    indexed_bytes: u64,
    head_len: u64,
    head_fingerprint: u64,
    header: Option<SessionHeader>,
    warnings: Vec<ScanWarning>,
    corrupt_lines: u64,
    oversized_lines: u64,
    pending: Vec<u8>,
    skip_start: Option<u64>,
    pending_rebuild: Option<RebuildReason>,
    bytes_read: u64,
    dirty: bool,
}

impl SessionLog {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            entries: Vec::new(),
            indexed_bytes: 0,
            head_len: 0,
            head_fingerprint: 0,
            header: None,
            warnings: Vec::new(),
            corrupt_lines: 0,
            oversized_lines: 0,
            pending: Vec::new(),
            skip_start: None,
            pending_rebuild: None,
            bytes_read: 0,
            dirty: false,
        }
    }

    /// 从快照恢复。快照不可信时返回全新索引，并让下一次 refresh 重建并说明原因。
    pub fn from_snapshot(
        path: impl Into<PathBuf>,
        snapshot: IndexSnapshot,
    ) -> (Self, SnapshotLoad) {
        let path = path.into();
        if snapshot.schema != CATALOG_SCHEMA_VERSION {
            return Self::rejected(path, RebuildReason::SnapshotSchemaMismatch);
        }
        let mut log = Self::new(path.clone());
        log.entries = snapshot.entries;
        log.indexed_bytes = snapshot.indexed_bytes;
        log.head_len = snapshot.head_len;
        log.head_fingerprint = snapshot.head_fingerprint;
        log.header = snapshot.header;
        log.warnings = snapshot.warnings;
        log.corrupt_lines = snapshot.corrupt_lines;
        log.oversized_lines = snapshot.oversized_lines;
        if !log.snapshot_is_consistent() {
            return Self::rejected(path, RebuildReason::SnapshotCorrupt);
        }
        (log, SnapshotLoad::accepted())
    }

    fn rejected(path: PathBuf, reason: RebuildReason) -> (Self, SnapshotLoad) {
        let mut log = Self::new(path);
        // 记录原因，下一次 refresh 会真正重建并把 reason 报给调用方。
        log.pending_rebuild = Some(reason);
        (log, SnapshotLoad::rejected(reason))
    }

    pub fn load_snapshot(path: &Path) -> Result<Option<IndexSnapshot>> {
        match store::read_json::<IndexSnapshot>(path) {
            Ok(snapshot) => Ok(snapshot),
            // 坏快照等同于没有快照：重建即可，不让用户看到错误历史。
            Err(error) if error.code() == ErrorCode::MetadataCorrupt => Ok(None),
            Err(error) => Err(error),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn entry_count(&self) -> usize {
        self.entries.len()
    }

    pub fn indexed_bytes(&self) -> u64 {
        self.indexed_bytes
    }

    pub fn header(&self) -> Option<&SessionHeader> {
        self.header.as_ref()
    }

    /// 文件头部指纹：用于旧会话的稳定身份与迁移匹配。
    pub fn head_fingerprint(&self) -> u64 {
        self.head_fingerprint
    }

    pub fn warnings(&self) -> &[ScanWarning] {
        &self.warnings
    }

    pub fn corrupt_lines(&self) -> u64 {
        self.corrupt_lines
    }

    pub fn oversized_lines(&self) -> u64 {
        self.oversized_lines
    }

    /// 累计实际读取字节数（不含 4 KiB 头部读），用于验证有界性。
    pub fn bytes_read(&self) -> u64 {
        self.bytes_read
    }

    pub fn clear_stats(&mut self) {
        self.bytes_read = 0;
    }

    pub fn is_dirty(&self) -> bool {
        self.dirty
    }

    pub fn pending_bytes(&self) -> u64 {
        self.pending.len() as u64
    }

    pub fn snapshot(&self) -> IndexSnapshot {
        IndexSnapshot {
            schema: CATALOG_SCHEMA_VERSION,
            path_hint: self.path.to_string_lossy().to_string(),
            file_len: self.read_position(),
            indexed_bytes: self.indexed_bytes,
            head_len: self.head_len,
            head_fingerprint: self.head_fingerprint,
            header: self.header.clone(),
            entries: self.entries.clone(),
            warnings: self.warnings.clone(),
            corrupt_lines: self.corrupt_lines,
            oversized_lines: self.oversized_lines,
        }
    }

    pub fn save_snapshot(&mut self, path: &Path) -> Result<()> {
        store::write_json(path, &self.snapshot())?;
        self.dirty = false;
        Ok(())
    }

    /// 增量刷新。返回本次扫描报告；文件不存在时返回 E_SESSION_FILE_MISSING。
    pub fn refresh(&mut self) -> Result<ScanReport> {
        let file_len = match fs::metadata(&self.path) {
            Ok(metadata) => metadata.len(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(CatalogError::io(
                    ErrorCode::SessionFileMissing,
                    format!("会话文件不存在：{}", self.path.display()),
                    &error,
                ));
            }
            Err(error) => {
                return Err(CatalogError::io(
                    ErrorCode::IoFailure,
                    format!("无法读取会话文件属性：{}", self.path.display()),
                    &error,
                ));
            }
        };
        let head = self.read_head(file_len)?;
        let mut report = ScanReport {
            file_len,
            ..ScanReport::default()
        };
        report.new_warnings = 0;
        let mut rebuild = self.pending_rebuild.take();
        if let Some(reason) = self.invalidation(&head, file_len) {
            rebuild = Some(reason);
        }
        if rebuild.is_some() {
            self.reset_index();
        }
        self.update_head(&head);
        let entries_before = self.entries.len();
        let warnings_before = self.warnings.len();
        let mut rounds = 0;
        loop {
            rounds += 1;
            let read = self.read_new_bytes()?;
            report.scanned_bytes += read;
            let len_now = fs::metadata(&self.path)
                .map(|meta| meta.len())
                .unwrap_or(file_len);
            // 写者可能在我们读到 EOF 之后继续追加；有界地再追一轮。
            if len_now <= self.read_position() || rounds >= GROWTH_ROUNDS {
                break;
            }
        }
        if self.header.is_none() && !self.entries.is_empty() {
            self.warn_once(
                WarningKind::HeaderMissing,
                0,
                "会话没有可识别的 session 头部行，按旧格式处理".to_string(),
            );
        }
        self.dirty = true;
        report.rebuild = rebuild;
        report.appended_entries = self.entries.len() - entries_before;
        report.total_entries = self.entries.len();
        report.pending_bytes = self.pending_bytes();
        report.corrupt_lines = self.corrupt_lines;
        report.oversized_lines = self.oversized_lines;
        report.new_warnings = self.warnings.len().saturating_sub(warnings_before);
        Ok(report)
    }

    pub fn save_if_dirty(&mut self, path: &Path) -> Result<bool> {
        if !self.dirty {
            return Ok(false);
        }
        self.save_snapshot(path)?;
        Ok(true)
    }

    fn read_position(&self) -> u64 {
        self.indexed_bytes.saturating_add(self.pending.len() as u64)
    }

    fn read_head(&self, file_len: u64) -> Result<Vec<u8>> {
        let want = file_len.min(HEAD_BYTES);
        if want == 0 {
            return Ok(Vec::new());
        }
        let file = File::open(&self.path).map_err(|error| {
            CatalogError::io(
                ErrorCode::SessionFileMissing,
                format!("会话文件不存在：{}", self.path.display()),
                &error,
            )
        })?;
        let mut buffer = Vec::with_capacity(usize::try_from(want).unwrap_or(0));
        file.take(want).read_to_end(&mut buffer).map_err(|error| {
            CatalogError::io(ErrorCode::IoFailure, "读取会话文件头部失败", &error)
        })?;
        Ok(buffer)
    }

    fn head_matches(&self, head: &[u8]) -> bool {
        if self.head_len == 0 {
            return true;
        }
        let len = usize::try_from(self.head_len.min(head.len() as u64)).unwrap_or(0);
        fnv1a64(&head[..len]) == self.head_fingerprint
    }

    fn invalidation(&self, head: &[u8], file_len: u64) -> Option<RebuildReason> {
        let had_index = self.indexed_bytes > 0 || !self.entries.is_empty();
        if file_len < self.read_position() {
            return Some(RebuildReason::Truncated);
        }
        if had_index && self.head_len > 0 && !self.head_matches(head) {
            return Some(RebuildReason::Replaced);
        }
        None
    }

    fn update_head(&mut self, head: &[u8]) {
        let head_len = head.len() as u64;
        if head_len == 0 {
            return;
        }
        if self.head_len == 0 || head_len > self.head_len {
            self.head_len = head_len;
            self.head_fingerprint = fnv1a64(head);
        }
    }

    fn reset_index(&mut self) {
        self.entries.clear();
        self.indexed_bytes = 0;
        self.pending.clear();
        self.skip_start = None;
        self.header = None;
        self.warnings.clear();
        self.corrupt_lines = 0;
        self.oversized_lines = 0;
    }

    fn snapshot_is_consistent(&self) -> bool {
        if self.head_len > HEAD_BYTES {
            return false;
        }
        let mut previous_end = 0_u64;
        for meta in &self.entries {
            if meta.offset < previous_end {
                return false;
            }
            if meta.end() > self.indexed_bytes {
                return false;
            }
            previous_end = meta.offset;
        }
        true
    }

    fn read_new_bytes(&mut self) -> Result<u64> {
        let start = self.read_position();
        let mut file = File::open(&self.path).map_err(|error| {
            CatalogError::io(
                ErrorCode::SessionFileMissing,
                format!("会话文件不存在：{}", self.path.display()),
                &error,
            )
        })?;
        file.seek(SeekFrom::Start(start))
            .map_err(|error| CatalogError::io(ErrorCode::IoFailure, "定位会话文件失败", &error))?;
        let mut buffer = vec![0_u8; SCAN_CHUNK];
        let mut position = start;
        let mut total = 0_u64;
        loop {
            match file.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => {
                    self.feed(&buffer[..read], position);
                    position += read as u64;
                    total += read as u64;
                }
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(error) => {
                    return Err(CatalogError::io(
                        ErrorCode::IoFailure,
                        format!("读取会话文件失败：{}", self.path.display()),
                        &error,
                    ));
                }
            }
        }
        self.bytes_read += total;
        debug_assert_eq!(self.read_position(), position, "读取位置与缓冲状态不一致");
        Ok(total)
    }

    fn feed(&mut self, chunk: &[u8], chunk_start: u64) {
        let mut cursor = 0_usize;
        while cursor < chunk.len() {
            if let Some(skip_start) = self.skip_start {
                match chunk[cursor..].iter().position(|byte| *byte == b'\n') {
                    Some(relative) => {
                        let line_feed = chunk_start + (cursor + relative) as u64;
                        let len = line_feed.saturating_sub(skip_start);
                        self.push_entry(
                            skip_start,
                            len,
                            EntryKind::Unknown,
                            None,
                            entry::FLAG_OVERSIZED,
                        );
                        self.oversized_lines += 1;
                        self.warn(
                            WarningKind::OversizedLine,
                            skip_start,
                            format!("跳过长行 {len} 字节，仅记录位置"),
                        );
                        self.indexed_bytes = line_feed + 1;
                        self.skip_start = None;
                        self.pending.clear();
                        cursor += relative + 1;
                    }
                    None => {
                        self.indexed_bytes = chunk_start + chunk.len() as u64;
                        cursor = chunk.len();
                    }
                }
                continue;
            }
            let absolute = chunk_start + cursor as u64;
            debug_assert_eq!(absolute, self.read_position(), "扫描位置与 pending 不一致");
            self.pending.extend_from_slice(&chunk[cursor..]);
            cursor = chunk.len();
            self.consume_complete_lines();
            if self.pending.len() > MAX_LINE_BYTES {
                // 单行超限：丢弃已缓冲的头部，只保留行起点用于记录长度。
                self.skip_start = Some(self.indexed_bytes);
                self.indexed_bytes += self.pending.len() as u64;
                self.pending.clear();
            }
        }
    }

    fn consume_complete_lines(&mut self) {
        let mut buffer = std::mem::take(&mut self.pending);
        let mut consumed = 0_usize;
        while let Some(relative) = buffer[consumed..].iter().position(|byte| *byte == b'\n') {
            let line_feed = consumed + relative;
            let line = &buffer[consumed..line_feed];
            let body = line.strip_suffix(b"\r").unwrap_or(line);
            let offset = self.indexed_bytes + consumed as u64;
            if !body.is_empty() {
                self.record_line(offset, body);
            }
            consumed = line_feed + 1;
        }
        if consumed > 0 {
            self.indexed_bytes += consumed as u64;
            self.pending = buffer.split_off(consumed);
        } else {
            self.pending = buffer;
        }
    }

    fn record_line(&mut self, offset: u64, body: &[u8]) {
        let parsed = entry::parse_line(body, false);
        if parsed.kind == EntryKind::Session && self.header.is_none() {
            self.header = entry::parse_header(body);
            if let Some(header) = &self.header
                && header.version > 3
            {
                self.warn_once(
                    WarningKind::UnsupportedVersion,
                    offset,
                    format!("会话版本 {} 高于已知版本 3", header.version),
                );
            }
        }
        if parsed.flags & entry::FLAG_CORRUPT != 0 {
            self.corrupt_lines += 1;
            self.warn(
                WarningKind::CorruptLine,
                offset,
                "该行不是合法 JSON 或不是 UTF-8，已跳过内容解析".to_string(),
            );
        }
        self.push_entry(
            offset,
            body.len() as u64,
            parsed.kind,
            parsed.role,
            parsed.flags,
        );
    }

    fn push_entry(
        &mut self,
        offset: u64,
        len: u64,
        kind: EntryKind,
        role: Option<entry::MessageRole>,
        flags: u8,
    ) {
        let len = u32::try_from(len).unwrap_or(u32::MAX);
        self.entries.push(EntryMeta {
            offset,
            len,
            kind,
            role,
            flags,
        });
    }

    fn warn(&mut self, kind: WarningKind, offset: u64, message: String) {
        if self.warnings.len() >= MAX_WARNINGS {
            return;
        }
        self.warnings.push(ScanWarning {
            kind,
            offset,
            message,
        });
    }

    fn warn_once(&mut self, kind: WarningKind, offset: u64, message: String) {
        if self.warnings.iter().any(|warning| warning.kind == kind) {
            return;
        }
        self.warn(kind, offset, message);
    }
}
