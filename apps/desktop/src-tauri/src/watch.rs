//! 事件过滤与订阅生命周期的纯逻辑。
//!
//! 两个注册表都是进程内的有界小表，不含会话正文：
//! - `GenerationGate`：每个 sessionId 只接受最新 generation 的事件（迟到事件丢弃）。
//! - `EventFanout`：每个 sessionId 的订阅计数；计数为 0 时不再向后端 emit，
//!   但状态注册表照常更新，前端重新订阅后可用 `runtime_status` 对齐。

use std::collections::HashMap;
use std::sync::Mutex;

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[derive(Debug, Default)]
pub struct GenerationGate {
    latest: Mutex<HashMap<String, u64>>,
}

impl GenerationGate {
    pub fn new() -> Self {
        Self::default()
    }

    /// 登记一次启动。比已记录的值旧时返回 false（调用方不应启动该运行时）。
    pub fn begin(&self, session_id: &str, generation: u64) -> bool {
        let mut latest = lock(&self.latest);
        match latest.get(session_id) {
            Some(current) if *current > generation => false,
            _ => {
                latest.insert(session_id.to_owned(), generation);
                true
            }
        }
    }

    pub fn current(&self, session_id: &str) -> Option<u64> {
        lock(&self.latest).get(session_id).copied()
    }

    /// 只接受当前 generation 的事件：迟到或过期的执行身份一律丢弃。
    pub fn accept(&self, session_id: &str, generation: u64) -> bool {
        self.current(session_id) == Some(generation)
    }

    /// 结束一次运行时：水位只增不减，旧 generation 之后仍会被拒绝。
    pub fn retire(&self, session_id: &str, generation: u64) {
        let mut latest = lock(&self.latest);
        let entry = latest.entry(session_id.to_owned()).or_insert(generation);
        if *entry < generation {
            *entry = generation;
        }
    }
}

#[derive(Debug, Default)]
pub struct EventFanout {
    subscribers: Mutex<HashMap<String, usize>>,
}

impl EventFanout {
    pub fn new() -> Self {
        Self::default()
    }

    /// 某个视图开始观察会话；返回当前订阅数。
    pub fn attach(&self, session_id: &str) -> usize {
        let mut subscribers = lock(&self.subscribers);
        let count = subscribers.entry(session_id.to_owned()).or_insert(0);
        *count = count.saturating_add(1);
        *count
    }

    /// 视图卸载/关闭时释放；返回剩余订阅数，永不为负。
    pub fn detach(&self, session_id: &str) -> usize {
        let mut subscribers = lock(&self.subscribers);
        let count = subscribers.entry(session_id.to_owned()).or_insert(0);
        *count = count.saturating_sub(1);
        let remaining = *count;
        if remaining == 0 {
            subscribers.remove(session_id);
        }
        remaining
    }

    /// 是否还有视图在观察该会话；false 时后端跳过 emit，避免无人消费的事件流。
    pub fn wants(&self, session_id: &str) -> bool {
        lock(&self.subscribers)
            .get(session_id)
            .is_some_and(|count| *count > 0)
    }

    #[cfg(test)]
    pub fn subscribers(&self, session_id: &str) -> usize {
        lock(&self.subscribers)
            .get(session_id)
            .copied()
            .unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gate_keeps_only_the_newest_generation() {
        let gate = GenerationGate::new();
        assert!(gate.begin("ses_a", 1));
        assert!(gate.accept("ses_a", 1));
        assert!(gate.begin("ses_a", 2));
        assert!(!gate.accept("ses_a", 1), "旧 generation 必须被丢弃");
        assert!(gate.accept("ses_a", 2));
        assert!(!gate.begin("ses_a", 1), "不能回退到旧 generation");
        assert!(gate.accept("ses_a", 2));
    }

    #[test]
    fn gate_is_scoped_per_session() {
        let gate = GenerationGate::new();
        assert!(gate.begin("ses_a", 1));
        assert!(gate.begin("ses_b", 1));
        assert!(!gate.accept("ses_b", 2));
        assert!(gate.begin("ses_b", 3));
        assert!(gate.accept("ses_a", 1), "多会话互不影响");
        assert!(gate.accept("ses_b", 3));
    }

    #[test]
    fn retire_never_lowers_the_watermark() {
        let gate = GenerationGate::new();
        assert!(gate.begin("ses_a", 4));
        gate.retire("ses_a", 2);
        assert!(
            !gate.accept("ses_a", 2),
            "retire 之后旧 generation 仍不得复活"
        );
        assert_eq!(gate.current("ses_a"), Some(4));
    }

    #[test]
    fn fanout_tracks_attach_and_release() {
        let fanout = EventFanout::new();
        assert!(!fanout.wants("ses_a"));
        assert_eq!(fanout.attach("ses_a"), 1);
        assert_eq!(fanout.attach("ses_a"), 2);
        assert!(fanout.wants("ses_a"));
        assert_eq!(fanout.detach("ses_a"), 1);
        assert!(fanout.wants("ses_a"), "还有一个视图在观察");
        assert_eq!(fanout.detach("ses_a"), 0);
        assert!(!fanout.wants("ses_a"));
        assert_eq!(fanout.detach("ses_a"), 0, "重复释放不会变成负数");
        assert_eq!(fanout.subscribers("ses_a"), 0);
    }
}
