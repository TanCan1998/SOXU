//! 受管进程的对外只读视图。
//!
//! 资源监控需要「哪个 runtime、哪个 PID、什么状态」这三件事，但不需要管道、
//! 事件通道或命令入口；把最小信息单独暴露，避免监控模块反向依赖 supervisor 内部结构。
//!
//! 这里的 `pid` 是**进程树根**：Pi 可能再拉起自己的子进程，采样必须按树而不是单进程，
//! 具体口径见 `docs/development/memory-budget.md`。

use crate::identity::RuntimeIdentity;
use crate::state::RuntimeState;

/// 一个受管运行时的进程视图。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeProcess {
    pub identity: RuntimeIdentity,
    /// 子进程 PID；握手失败或进程已回收时为 `None`。
    pub pid: Option<u32>,
    pub state: RuntimeState,
}

impl RuntimeProcess {
    /// 进程是否仍在 SOXU 管理下（可以采样）。
    pub fn is_samplable(&self) -> bool {
        self.pid.is_some() && !self.state.is_terminal()
    }

    /// 是否明确空闲：只有这种状态才可能被资源预算释放。
    pub fn is_idle(&self) -> bool {
        self.state == RuntimeState::Idle
    }

    /// 是否可能正在执行任务（含启动与停止中），此类 runtime 绝不能被释放。
    pub fn may_be_busy(&self) -> bool {
        matches!(
            self.state,
            RuntimeState::Starting | RuntimeState::Running | RuntimeState::Stopping
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn process(state: RuntimeState) -> RuntimeProcess {
        RuntimeProcess {
            identity: RuntimeIdentity::new("session", "session#1", 1),
            pid: Some(4242),
            state,
        }
    }

    #[test]
    fn only_idle_runtime_counts_as_releasable() {
        assert!(process(RuntimeState::Idle).is_idle());
        for state in [
            RuntimeState::Starting,
            RuntimeState::Running,
            RuntimeState::Stopping,
            RuntimeState::Exited,
        ] {
            assert!(!process(state).is_idle(), "{state:?} 不应被视为空闲");
        }
    }

    #[test]
    fn exited_runtime_is_not_samplable() {
        let exited = RuntimeProcess {
            pid: Some(1),
            state: RuntimeState::Exited,
            ..process(RuntimeState::Exited)
        };
        assert!(!exited.is_samplable());
        assert!(process(RuntimeState::Running).may_be_busy());
    }
}
