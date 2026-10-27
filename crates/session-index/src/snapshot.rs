//! 索引快照、扫描报告与告警类型。
//!
//! 快照是可丢弃的缓存：任何不一致都应重建索引，而不是让 UI 看到错误历史。

use serde::{Deserialize, Serialize};

use crate::entry::{EntryMeta, SessionHeader};

/// 快照结构版本；与代码不一致时重建索引。
pub const CATALOG_SCHEMA_VERSION: u32 = 1;

/// 索引被整体重建的原因，用于验收证据与诊断。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RebuildReason {
    /// 文件被截断（长度小于已索引位置）。
    Truncated,
    /// 文件被替换（头部字节变化）。
    Replaced,
    /// 快照结构版本不匹配。
    SnapshotSchemaMismatch,
    /// 快照内容自相矛盾（偏移非法等）。
    SnapshotCorrupt,
    /// 主动重建（测试与维护入口）。
    Manual,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WarningKind {
    CorruptLine,
    OversizedLine,
    HeaderMissing,
    UnsupportedVersion,
    CwdMismatch,
    DuplicateSessionFile,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScanWarning {
    pub kind: WarningKind,
    pub offset: u64,
    pub message: String,
}

/// 告警列表有界：超出后只累计计数，不无限增长。
pub const MAX_WARNINGS: usize = 64;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScanReport {
    pub file_len: u64,
    pub scanned_bytes: u64,
    pub pending_bytes: u64,
    pub appended_entries: usize,
    pub total_entries: usize,
    pub rebuild: Option<RebuildReason>,
    pub corrupt_lines: u64,
    pub oversized_lines: u64,
    pub new_warnings: usize,
}

/// 索引快照：只含偏移与轻量元数据，可安全落盘与重建。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexSnapshot {
    pub schema: u32,
    pub path_hint: String,
    pub file_len: u64,
    pub indexed_bytes: u64,
    pub head_len: u64,
    pub head_fingerprint: u64,
    pub header: Option<SessionHeader>,
    pub entries: Vec<EntryMeta>,
    pub warnings: Vec<ScanWarning>,
    pub corrupt_lines: u64,
    pub oversized_lines: u64,
}

/// 载入快照的结果。accepted=false 时下一次 refresh 会重建并报告 reason。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SnapshotLoad {
    pub accepted: bool,
    pub reason: Option<RebuildReason>,
}

impl SnapshotLoad {
    pub fn fresh() -> Self {
        Self {
            accepted: false,
            reason: None,
        }
    }

    pub fn rejected(reason: RebuildReason) -> Self {
        Self {
            accepted: false,
            reason: Some(reason),
        }
    }

    pub fn accepted() -> Self {
        Self {
            accepted: true,
            reason: None,
        }
    }
}
