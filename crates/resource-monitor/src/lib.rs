//! 系统资源预算原型。
#[derive(Debug, Clone, Copy)]
pub struct MemoryBudget {
    pub max_active_agents: usize,
}
impl MemoryBudget {
    pub fn for_16gb() -> Self {
        Self {
            max_active_agents: 3,
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn has_small_default() {
        assert_eq!(MemoryBudget::for_16gb().max_active_agents, 3)
    }
}
