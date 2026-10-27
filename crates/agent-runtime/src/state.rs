//! 运行时状态机。非法迁移必须报错，而不是静默改写状态。

use std::sync::atomic::{AtomicU8, Ordering};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeState {
    /// 进程已拉起，尚未完成 get_state 握手。
    Starting,
    /// 握手完成且没有进行中的任务。
    Idle,
    /// 已接受 prompt，等待 agent_settled。
    Running,
    /// 已请求停止，正在回收子进程。
    Stopping,
    /// 进程已退出；再次使用必须新建 runtime。
    Exited,
}

impl RuntimeState {
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Exited)
    }

    /// 是否允许迁移；同状态视为允许（幂等上报）。
    pub fn can_transition_to(self, next: Self) -> bool {
        if self == next {
            return true;
        }
        matches!(
            (self, next),
            (Self::Starting, Self::Idle)
                | (Self::Starting, Self::Stopping)
                | (Self::Starting, Self::Exited)
                | (Self::Idle, Self::Running)
                | (Self::Idle, Self::Stopping)
                | (Self::Idle, Self::Exited)
                | (Self::Running, Self::Idle)
                | (Self::Running, Self::Stopping)
                | (Self::Running, Self::Exited)
                | (Self::Stopping, Self::Exited)
        )
    }

    fn as_u8(self) -> u8 {
        match self {
            Self::Starting => 0,
            Self::Idle => 1,
            Self::Running => 2,
            Self::Stopping => 3,
            Self::Exited => 4,
        }
    }

    fn from_u8(value: u8) -> Self {
        match value {
            0 => Self::Starting,
            1 => Self::Idle,
            2 => Self::Running,
            3 => Self::Stopping,
            _ => Self::Exited,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Idle => "idle",
            Self::Running => "running",
            Self::Stopping => "stopping",
            Self::Exited => "exited",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IllegalTransition {
    pub from: RuntimeState,
    pub to: RuntimeState,
}

impl std::fmt::Display for IllegalTransition {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "illegal runtime transition {} -> {}",
            self.from.as_str(),
            self.to.as_str()
        )
    }
}

impl std::error::Error for IllegalTransition {}

/// 并发安全的状态单元；所有迁移走 compare_exchange，避免两个任务同时改写。
pub(crate) struct StateCell {
    value: AtomicU8,
}

impl StateCell {
    pub(crate) fn new() -> Self {
        Self {
            value: AtomicU8::new(RuntimeState::Starting.as_u8()),
        }
    }

    pub(crate) fn get(&self) -> RuntimeState {
        RuntimeState::from_u8(self.value.load(Ordering::SeqCst))
    }

    /// 迁移成功返回旧状态；非法迁移返回结构化错误且不改写状态。
    pub(crate) fn try_transition(
        &self,
        next: RuntimeState,
    ) -> Result<RuntimeState, IllegalTransition> {
        let mut current = self.value.load(Ordering::SeqCst);
        loop {
            let from = RuntimeState::from_u8(current);
            if !from.can_transition_to(next) {
                return Err(IllegalTransition { from, to: next });
            }
            match self.value.compare_exchange(
                current,
                next.as_u8(),
                Ordering::SeqCst,
                Ordering::SeqCst,
            ) {
                Ok(_) => return Ok(from),
                Err(observed) => current = observed,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cell() -> StateCell {
        StateCell::new()
    }

    #[test]
    fn happy_path_walks_starting_idle_running_idle() {
        let cell = cell();
        assert_eq!(
            cell.try_transition(RuntimeState::Idle).unwrap(),
            RuntimeState::Starting
        );
        assert_eq!(
            cell.try_transition(RuntimeState::Running).unwrap(),
            RuntimeState::Idle
        );
        assert_eq!(
            cell.try_transition(RuntimeState::Idle).unwrap(),
            RuntimeState::Running
        );
    }

    #[test]
    fn exited_is_terminal() {
        let cell = cell();
        cell.try_transition(RuntimeState::Exited).unwrap();
        let error = cell.try_transition(RuntimeState::Idle).unwrap_err();
        assert_eq!(error.from, RuntimeState::Exited);
        assert_eq!(cell.get(), RuntimeState::Exited);
    }

    #[test]
    fn running_cannot_be_skipped_from_starting() {
        let cell = cell();
        let error = cell.try_transition(RuntimeState::Running).unwrap_err();
        assert_eq!(
            error,
            IllegalTransition {
                from: RuntimeState::Starting,
                to: RuntimeState::Running
            }
        );
    }

    #[test]
    fn same_state_is_idempotent() {
        let cell = cell();
        cell.try_transition(RuntimeState::Idle).unwrap();
        assert_eq!(
            cell.try_transition(RuntimeState::Idle).unwrap(),
            RuntimeState::Idle
        );
    }
}
