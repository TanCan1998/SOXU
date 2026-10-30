//! 会话统计的有界存储：每个会话一份累加器，超出容量按「最久未更新」淘汰。
//!
//! 为什么需要上限：统计表按 sessionId 增长，而工作区可以打开成百上千个会话。
//! 每个条目只是几十字节的计数与时间点，但没有上限的内存表迟早会变成泄漏；
//! 这里与 `watch::EventFanout`、`state::titles` 一样按「有界小表」管理，
//! 淘汰只丢统计（事件流可重建），不影响会话文件与历史。
//!
//! 单一 owner：只有 `driver` 写（observe / note_prompt / begin_generation），
//! `session_stats` 命令只读快照。

use std::collections::HashMap;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use crate::events::RuntimeEventKind;

use super::accumulator::{StatsAccumulator, StatsSnapshot};

/// 默认容量：够覆盖多项目并行工作区，又不会无限增长。
pub const DEFAULT_CAPACITY: usize = 64;

struct Entry {
    accumulator: StatsAccumulator,
    /// 最近一次被写入的时间：容量溢出时淘汰它最小的那条。
    touched: Instant,
}

/// 统计表。
pub struct StatsStore {
    entries: HashMap<String, Entry>,
    capacity: usize,
    /// 单调时钟锚点与对应的 Unix 毫秒：用来把 `Instant` 换算成可展示的时间戳，
    /// 避免在每条事件里读一次系统时钟。
    anchor: Instant,
    anchor_wall_ms: u64,
    /// 容量为 0 时的落点：写入被接受但立刻丢弃，不需要给「不保留统计」开特例分支。
    scratch: StatsAccumulator,
}

impl StatsStore {
    pub fn new() -> Self {
        Self::with_clock(Instant::now(), now_wall_ms(), DEFAULT_CAPACITY)
    }

    pub fn with_capacity(capacity: usize) -> Self {
        Self::with_clock(Instant::now(), now_wall_ms(), capacity)
    }

    /// 测试用：显式给定时钟锚点与容量，快照时间戳因此可确定。
    pub fn with_clock(anchor: Instant, anchor_wall_ms: u64, capacity: usize) -> Self {
        Self {
            entries: HashMap::new(),
            capacity,
            anchor,
            anchor_wall_ms,
            scratch: StatsAccumulator::default(),
        }
    }

    /// 把单调时间换算成 Unix 毫秒（用于 DTO 的 `updatedAtMs`）。
    pub fn wall_ms(&self, at: Instant) -> u64 {
        let delta = at.saturating_duration_since(self.anchor).as_millis();
        self.anchor_wall_ms
            .saturating_add(u64::try_from(delta).unwrap_or(u64::MAX))
    }

    pub fn begin_generation(&mut self, session_id: &str, generation: u64, now: Instant) {
        self.entry(session_id, now)
            .begin_generation(generation, now);
    }

    pub fn note_prompt(&mut self, session_id: &str, now: Instant) {
        self.entry(session_id, now).note_prompt(now);
    }

    pub fn observe(&mut self, session_id: &str, kind: &RuntimeEventKind, now: Instant) {
        self.entry(session_id, now).observe(kind, now);
    }

    pub fn snapshot(&self, session_id: &str, now: Instant) -> Option<StatsSnapshot> {
        self.entries
            .get(session_id)
            .map(|entry| entry.accumulator.snapshot(now))
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn capacity(&self) -> usize {
        self.capacity
    }

    fn entry(&mut self, session_id: &str, now: Instant) -> &mut StatsAccumulator {
        if self.capacity == 0 {
            return &mut self.scratch;
        }
        if !self.entries.contains_key(session_id) {
            self.evict_for_insert();
            self.entries.insert(
                session_id.to_owned(),
                Entry {
                    accumulator: StatsAccumulator::default(),
                    touched: now,
                },
            );
        }
        let entry = self
            .entries
            .get_mut(session_id)
            .expect("刚插入的条目必须存在");
        entry.touched = now;
        &mut entry.accumulator
    }

    /// 容量满时按「最久未更新」淘汰。
    fn evict_for_insert(&mut self) {
        while self.entries.len() >= self.capacity {
            let oldest = self
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.touched)
                .map(|(session_id, _)| session_id.clone());
            let Some(oldest) = oldest else { break };
            self.entries.remove(&oldest);
        }
    }
}

impl Default for StatsStore {
    fn default() -> Self {
        Self::new()
    }
}

fn now_wall_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|delta| u64::try_from(delta.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn stream(data: serde_json::Value) -> RuntimeEventKind {
        RuntimeEventKind::Stream {
            event: "message_update".to_owned(),
            data: Some(data),
        }
    }

    #[test]
    fn unknown_session_has_no_snapshot() {
        let store = StatsStore::new();
        assert!(store.snapshot("ses_missing", Instant::now()).is_none());
        assert!(store.is_empty());
    }

    #[test]
    fn statistics_are_bounded_and_evict_the_least_recently_updated() {
        let base = Instant::now();
        let mut store = StatsStore::with_capacity(2);
        store.note_prompt("ses_a", base);
        store.note_prompt("ses_b", base + std::time::Duration::from_millis(10));
        // 再更新一次 a：a 变成最近使用，溢出时应该淘汰 b。
        store.note_prompt("ses_a", base + std::time::Duration::from_millis(20));
        store.note_prompt("ses_c", base + std::time::Duration::from_millis(30));

        assert_eq!(store.len(), 2);
        assert!(store.snapshot("ses_a", base).is_some());
        assert!(store.snapshot("ses_c", base).is_some());
        assert!(
            store.snapshot("ses_b", base).is_none(),
            "最久未更新的会话被淘汰"
        );
    }

    #[test]
    fn zero_capacity_keeps_nothing() {
        let base = Instant::now();
        let mut store = StatsStore::with_capacity(0);
        store.note_prompt("ses_a", base);
        assert!(store.is_empty());
    }

    #[test]
    fn timestamps_are_derived_from_the_monotonic_anchor() {
        let base = Instant::now();
        let mut store = StatsStore::with_clock(base, 1_700_000_000_000, 4);
        store.observe(
            "ses_a",
            &stream(json!({ "delta": "a" })),
            base + std::time::Duration::from_millis(1_500),
        );
        let snapshot = store.snapshot("ses_a", base).expect("snapshot");
        let updated = snapshot.updated_at.expect("观测过就有时间");
        assert_eq!(store.wall_ms(updated), 1_700_000_001_500);
    }
}
