//! 会话内搜索：文本缓存 + 线性扫描（Issue #109）。
//!
//! 边界与取舍：
//! - **不建倒排索引**。会话 JSONL 持续追加，倒排需要增量重建与一致性校验；
//!   10 MiB 文本的线性扫描在毫秒级，搜索是低频操作。
//! - 缓存只存正文，不存 JSON 原文；单会话 8 MiB、全局 24 MiB 两级硬上限，
//!   超限淘汰最久未使用的会话，绝不无边界增长。
//! - 单次查询超过 50 ms 记一条诊断，不静默变慢。
//! - 只读：本模块绝不写回会话文件。

mod cache;
mod matcher;

use std::path::Path;
use std::time::Instant;

use crate::entry::{EntryKind, MessageRole};
use crate::error::{CatalogError, ErrorCode, Result};
use crate::identity::SessionId;

pub use cache::{MAX_CACHED_ENTRY_CHARS, OVERSIZED_KEEP_CHARS, SessionSearchCache, SyncOutcome};
pub use matcher::{MAX_MATCHES_PER_ENTRY, SNIPPET_CONTEXT_CHARS};

/// 查询长度上限（字符）。更长的输入不是搜索，是误粘贴。
pub const MAX_QUERY_CHARS: usize = 200;
/// 单次查询返回的命中条目上限。
pub const MAX_SEARCH_HITS: usize = 200;
/// 调用方不指定 limit 时的默认值。
pub const DEFAULT_SEARCH_HITS: usize = 50;
/// 单次查询耗时告警阈值（毫秒）：超过即记诊断。
pub const SLOW_QUERY_MS: u64 = 50;
/// 诊断环形缓冲的容量。
pub const MAX_SEARCH_DIAGNOSTICS: usize = 32;

/// 缓存预算。数值来自 Issue #109 的硬约束，测试可以注入更小的值。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SearchBudget {
    /// 单会话正文缓存上限。
    pub per_session_bytes: usize,
    /// 全部会话合计上限。
    pub global_bytes: usize,
    /// 单次查询耗时告警阈值。
    pub slow_query_ms: u64,
}

impl Default for SearchBudget {
    fn default() -> Self {
        Self {
            per_session_bytes: 8 * 1024 * 1024,
            global_bytes: 24 * 1024 * 1024,
            slow_query_ms: SLOW_QUERY_MS,
        }
    }
}

impl SearchBudget {
    /// 测试与低内存场景：缩小预算，保持「单会话 < 全局」的不变量。
    pub fn with_limits(per_session_bytes: usize, global_bytes: usize) -> Self {
        let per_session_bytes = per_session_bytes.max(1);
        Self {
            per_session_bytes,
            global_bytes: global_bytes.max(per_session_bytes),
            slow_query_ms: SLOW_QUERY_MS,
        }
    }
}

/// 一条命中条目。片段与偏移都由后端给出，前端不重新计算匹配位置。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchHit {
    pub ordinal: u64,
    pub kind: EntryKind,
    pub role: Option<MessageRole>,
    /// 命中位置前后各 `SNIPPET_CONTEXT_CHARS` 个字符（边界对齐到字符）。
    pub snippet: String,
    /// `snippet` 内命中的起始**字符**偏移。
    pub match_start: usize,
    /// `snippet` 内命中的结束字符偏移（左闭右开）。
    pub match_end: usize,
    /// 该条目内的命中次数（上限 `MAX_MATCHES_PER_ENTRY`）。
    pub total_matches: usize,
    /// 该条目的正文被裁剪过（超长条目或预算淘汰），片段不是全文。
    pub truncated: bool,
}

/// 一次查询的原始结果（未做耗时统计与预算检查）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchOutcome {
    pub hits: Vec<SearchHit>,
    pub total_hits: usize,
    pub scanned_entries: usize,
    pub truncated: bool,
}

/// 对外的一次查询结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionSearchResult {
    pub hits: Vec<SearchHit>,
    /// 会话内命中条目总数，与 `limit`/分页无关。
    pub total_hits: usize,
    pub scanned_entries: usize,
    /// 命中数超过 `limit`（还有下一页）。
    pub truncated: bool,
    /// 缓存因预算丢弃了部分正文：结果可能不完整，界面必须如实说明。
    pub degraded: bool,
    pub took_ms: u64,
    /// 本次调用是否重建了缓存（验收用：追加不应触发重建）。
    pub rebuilt: bool,
}

/// 一条慢查询诊断，由调用方写进日志/诊断面板。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchDiagnostic {
    pub session: String,
    pub took_ms: u64,
    pub scanned_entries: usize,
    pub message: String,
}

/// 多会话正文缓存：按最近使用排序（队首最旧），全局预算超限时淘汰队首。
#[derive(Debug)]
pub struct SearchCache {
    /// 队尾是最近使用的会话；队首永远不会是刚查询过的会话（长度 > 1 时）。
    sessions: Vec<SessionSearchCache>,
    bytes: usize,
    budget: SearchBudget,
    diagnostics: Vec<SearchDiagnostic>,
}

impl Default for SearchCache {
    fn default() -> Self {
        Self::new()
    }
}

impl SearchCache {
    pub fn new() -> Self {
        Self::with_budget(SearchBudget::default())
    }

    pub fn with_budget(budget: SearchBudget) -> Self {
        Self {
            sessions: Vec::new(),
            bytes: 0,
            budget,
            diagnostics: Vec::new(),
        }
    }

    pub fn budget(&self) -> SearchBudget {
        self.budget
    }

    /// 当前占用的全部缓存字节数。
    pub fn bytes(&self) -> usize {
        self.bytes
    }

    pub fn session_count(&self) -> usize {
        self.sessions.len()
    }

    pub fn cached_session(&self, session: &SessionId) -> Option<&SessionSearchCache> {
        self.sessions
            .iter()
            .find(|cache| cache.session() == session)
    }

    /// 丢弃某个会话的缓存（会话关闭、文件被判定为不可信时使用）。
    pub fn invalidate(&mut self, session: &SessionId) {
        if let Some(index) = self
            .sessions
            .iter()
            .position(|cache| cache.session() == session)
        {
            let removed = self.sessions.remove(index);
            self.bytes = self.bytes.saturating_sub(removed.bytes());
        }
    }

    /// 取出并清空诊断（调用方负责记录，缓存本身不写日志）。
    pub fn take_diagnostics(&mut self) -> Vec<SearchDiagnostic> {
        std::mem::take(&mut self.diagnostics)
    }

    /// 在某个会话里搜索。
    ///
    /// 空查询返回空结果而不是错误：清空输入框不该弹错误提示。
    /// 超过 `MAX_QUERY_CHARS` 的查询返回稳定错误码，绝不截断后"假装搜过"。
    pub fn search(
        &mut self,
        session: &SessionId,
        path: &Path,
        query: &str,
        limit: usize,
        after_ordinal: Option<u64>,
    ) -> Result<SessionSearchResult> {
        let query = query.trim();
        if query.chars().count() > MAX_QUERY_CHARS {
            return Err(CatalogError::new(
                ErrorCode::SearchQueryTooLong,
                format!(
                    "查询长度 {} 字符超过上限 {MAX_QUERY_CHARS}",
                    query.chars().count()
                ),
            ));
        }
        let limit = limit.clamp(1, MAX_SEARCH_HITS);
        let budget = self.budget;
        let index = self.touch(session, path);
        let started = Instant::now();
        let (outcome, sync) = {
            let cache = &mut self.sessions[index];
            let sync = cache.sync(&budget)?;
            let outcome = if query.is_empty() {
                SearchOutcome {
                    hits: Vec::new(),
                    total_hits: 0,
                    scanned_entries: cache.entry_count(),
                    truncated: false,
                }
            } else {
                cache.search(query, limit, after_ordinal)
            };
            (outcome, sync)
        };
        let took_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
        let degraded = self.sessions[index].dropped_entries() > 0;
        self.enforce_global_budget();
        if took_ms > budget.slow_query_ms {
            self.record_diagnostic(SearchDiagnostic {
                session: session.to_string(),
                took_ms,
                scanned_entries: outcome.scanned_entries,
                message: format!(
                    "会话内搜索耗时 {took_ms} ms 超过 {} ms 阈值（扫描 {} 条，缓存 {} 字节）",
                    budget.slow_query_ms, outcome.scanned_entries, self.bytes
                ),
            });
        }
        Ok(SessionSearchResult {
            hits: outcome.hits,
            total_hits: outcome.total_hits,
            scanned_entries: outcome.scanned_entries,
            truncated: outcome.truncated,
            degraded,
            took_ms,
            rebuilt: sync.rebuilt,
        })
    }

    /// 把会话移到队尾（最近使用）；路径变化时缓存作废。
    fn touch(&mut self, session: &SessionId, path: &Path) -> usize {
        if let Some(index) = self
            .sessions
            .iter()
            .position(|cache| cache.session() == session)
        {
            let mut cache = self.sessions.remove(index);
            if cache.path() != path {
                cache.relocate(path);
            }
            self.sessions.push(cache);
            return self.sessions.len() - 1;
        }
        self.sessions
            .push(SessionSearchCache::new(session.clone(), path));
        self.sessions.len() - 1
    }

    /// 全局预算：淘汰最久未使用的会话。队首在长度 > 1 时一定不是当前会话。
    fn enforce_global_budget(&mut self) {
        self.bytes = self.sessions.iter().map(SessionSearchCache::bytes).sum();
        while self.bytes > self.budget.global_bytes && self.sessions.len() > 1 {
            let removed = self.sessions.remove(0);
            self.bytes = self.bytes.saturating_sub(removed.bytes());
        }
    }

    fn record_diagnostic(&mut self, diagnostic: SearchDiagnostic) {
        if self.diagnostics.len() >= MAX_SEARCH_DIAGNOSTICS {
            self.diagnostics.remove(0);
        }
        self.diagnostics.push(diagnostic);
    }
}
