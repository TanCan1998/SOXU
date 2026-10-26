//! 进程状态原型：M1 扩展为 Tokio Pi Supervisor。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeState {
    Starting,
    Idle,
    Running,
    Stopping,
    Exited,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeIdentity {
    pub session_id: String,
    pub runtime_id: String,
    pub generation: u64,
}
impl RuntimeIdentity {
    pub fn matches(&self, session_id: &str, generation: u64) -> bool {
        self.session_id == session_id && self.generation == generation
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_late_event() {
        let id = RuntimeIdentity {
            session_id: "s".into(),
            runtime_id: "r".into(),
            generation: 2,
        };
        assert!(!id.matches("s", 1));
    }
}
