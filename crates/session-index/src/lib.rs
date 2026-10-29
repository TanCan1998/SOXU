//! # soxu-session-index
//!
//! SOXU 的项目 / Worktree / Runtime / Session 目录（catalog）与 Pi JSONL 会话索引。
//!
//! ## 边界
//! - Pi 拥有会话文件与格式；本 crate **只读** JSONL，绝不写回。
//! - 以稳定的 SessionId 建模；文件路径只是当前落点，可迁移。
//! - RuntimeLink（runtimeId + generation）是临时执行身份，重启后不恢复，只用于丢弃迟到事件。
//! - 索引只保存每行的字节偏移与轻量元数据；分页按字节预算裁剪，不一次性加载整个文件。
//! - 会话内搜索用「正文缓存 + 线性扫描」，不建倒排索引；缓存有两级字节上限（见 `search`）。
//! - 截断、替换、损坏行、超长行都有明确的可恢复路径与证据（见 ScanReport / ScanWarning）。
//! - 临时会话只登记在内存（TemporaryRegistry），默认不进入持久化历史；显式转正后才写入。
//!
//! 身份关系与错误码契约见 docs/architecture/session-catalog.md。

mod catalog;
mod entry;
mod error;
mod hash;
mod identity;
mod index;
mod records;
mod search;
mod snapshot;
mod store;
mod temporary;
mod text;

pub use catalog::{CatalogConfig, ProjectCatalog, RebuildNote, Relocation, SyncReport};
pub use entry::{
    EntryKind, EntryMeta, EntryPage, EntryView, MessageRole, PREVIEW_CHARS, SessionHeader,
};
pub use error::{CatalogError, ErrorCode, Result};
pub use identity::{
    ProjectId, RuntimeId, RuntimeLink, SessionId, SessionIdentity, WorktreeId, is_within,
    normalize_path, strip_verbatim,
};
pub use index::{INLINE_ENTRY_BYTES, MAX_PAGE_BYTES, MAX_PAGE_ENTRIES, SessionLog, SessionPage};
pub use records::{
    CatalogSnapshot, ProjectRecord, SessionRecord, SessionState, WorktreeRecord,
    default_sessions_root, project_sessions_dir_name,
};
pub use search::{
    DEFAULT_SEARCH_HITS, MAX_CACHED_ENTRY_CHARS, MAX_MATCHES_PER_ENTRY, MAX_QUERY_CHARS,
    MAX_SEARCH_HITS, OVERSIZED_KEEP_CHARS, SLOW_QUERY_MS, SNIPPET_CONTEXT_CHARS, SearchBudget,
    SearchCache, SearchDiagnostic, SearchHit, SessionSearchCache, SessionSearchResult, SyncOutcome,
};
pub use snapshot::{
    CATALOG_SCHEMA_VERSION, IndexSnapshot, MAX_WARNINGS, RebuildReason, ScanReport, ScanWarning,
    SnapshotLoad, WarningKind,
};
pub use temporary::{MAX_TEMPORARY_SESSIONS, TemporarySession};
pub use text::{ExtractedText, extract_entry, extract_text, truncate_chars};
