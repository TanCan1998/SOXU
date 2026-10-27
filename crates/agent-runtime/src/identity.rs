//! 运行时身份：sessionId 稳定，runtimeId + generation 只代表一次执行。

/// 一个 Pi 进程的执行身份。
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct RuntimeIdentity {
    /// 跨重启稳定的会话标识，由 SOXU 与 Pi 共享。
    pub session_id: String,
    /// 单次进程的临时标识，仅用于日志与 owner 查找。
    pub runtime_id: String,
    /// 单调递增的代数；旧代数的事件必须丢弃。
    pub generation: u64,
}

impl RuntimeIdentity {
    pub fn new(
        session_id: impl Into<String>,
        runtime_id: impl Into<String>,
        generation: u64,
    ) -> Self {
        Self {
            session_id: session_id.into(),
            runtime_id: runtime_id.into(),
            generation,
        }
    }

    /// 迟到/越界事件的判定入口。
    pub fn matches(&self, session_id: &str, generation: u64) -> bool {
        self.session_id == session_id && self.generation == generation
    }

    pub fn same_session(&self, other: &Self) -> bool {
        self.session_id == other.session_id
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity() -> RuntimeIdentity {
        RuntimeIdentity::new("s", "r-2", 2)
    }

    #[test]
    fn rejects_late_event() {
        assert!(!identity().matches("s", 1));
        assert!(identity().matches("s", 2));
    }

    #[test]
    fn rejects_other_session_with_same_generation() {
        assert!(!identity().matches("other", 2));
    }
}
