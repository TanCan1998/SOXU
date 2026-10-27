//! 内存预算：阈值、空闲释放窗口与采样间隔。
//!
//! 默认值只针对「Windows 16 GB / 3 Agent」基准场景校准（见
//! `docs/development/memory-budget.md`），不是所有机器的通用结论：
//! - 阈值判定用工作集/RSS（实时压力），私有提交用于解释与基准报告；
//! - 3 个活跃 Agent 的进程树通常在 1.5–2.5 GiB 量级，SOXU 自身约 0.3–0.6 GiB；
//! - 预警线留出足够余量给系统缓存，避免把机器逼到换页。

use std::time::Duration;

use crate::error::{ErrorCode, MonitorError, Result};

const MIB: u64 = 1024 * 1024;
const GIB: u64 = 1024 * MIB;

/// 采样与释放策略的全部可调参数。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryBudget {
    /// 预期同时活跃的 Agent 数量，仅用于诊断与容量规划，不作为硬限制。
    pub max_active_agents: usize,
    /// 采样间隔；太小会浪费 CPU，太大会错过短时峰值。
    pub sample_interval: Duration,
    /// 进入预警的总工作集阈值。
    pub warn_bytes: u64,
    /// 进入严重级别的总工作集阈值。
    pub critical_bytes: u64,
    /// 退出预警的回落阈值（滞回，避免在阈值附近反复报警）。
    pub recover_bytes: u64,
    /// 单个 runtime 进程树的预警阈值。
    pub runtime_warn_bytes: u64,
    /// runtime 空闲多久之后，「在压力下」允许释放。
    pub idle_after: Duration,
    /// runtime 空闲多久之后，「即使没有压力」也释放（长时间空转的会话）。
    pub idle_reclaim_after: Duration,
    /// 释放一个空闲 runtime 至少能回收多少内存，低于此值不做无意义重启。
    pub idle_reclaim_min_bytes: u64,
    /// 同一 runtime 两次释放请求的最小间隔。
    pub reclaim_cooldown: Duration,
    /// 释放失败后的冷却时间（失败只会降级为预警，绝不升级为强杀）。
    pub failed_cooldown: Duration,
    /// 单次采样最多请求释放几个 runtime，避免一次性停掉所有空闲会话。
    pub max_reclaims_per_tick: usize,
}

impl MemoryBudget {
    /// Windows 16 GB / 3 Agent 基准场景的默认预算。
    pub fn for_16gb() -> Self {
        Self {
            max_active_agents: 3,
            sample_interval: Duration::from_secs(5),
            warn_bytes: 4 * GIB,
            critical_bytes: 6 * GIB,
            recover_bytes: 3 * GIB + 400 * MIB,
            runtime_warn_bytes: 900 * MIB,
            idle_after: Duration::from_secs(300),
            idle_reclaim_after: Duration::from_secs(1800),
            idle_reclaim_min_bytes: 128 * MIB,
            reclaim_cooldown: Duration::from_secs(600),
            failed_cooldown: Duration::from_secs(1800),
            max_reclaims_per_tick: 1,
        }
    }

    /// 拒绝会永久误报或误释放的自相矛盾配置。
    pub fn validate(&self) -> Result<()> {
        let fail = |detail: &str| {
            Err(MonitorError::with_detail(
                ErrorCode::InvalidBudget,
                "memory budget rejected",
                detail,
            ))
        };
        if self.warn_bytes == 0 {
            return fail("warn_bytes must be > 0");
        }
        if self.critical_bytes <= self.warn_bytes {
            return fail("critical_bytes must be greater than warn_bytes");
        }
        if self.recover_bytes >= self.warn_bytes {
            return fail("recover_bytes must be lower than warn_bytes");
        }
        if self.sample_interval < Duration::from_secs(1) {
            return fail("sample_interval below 1s would make sampling a hot loop");
        }
        if self.max_reclaims_per_tick == 0 {
            return fail("max_reclaims_per_tick must be > 0");
        }
        if self.idle_reclaim_after < self.idle_after {
            return fail("idle_reclaim_after must not be shorter than idle_after");
        }
        if self.reclaim_cooldown < self.sample_interval {
            return fail("reclaim_cooldown must be at least one sample interval");
        }
        Ok(())
    }

    /// 压力等级判定所需的阈值对。
    pub fn thresholds(&self) -> (u64, u64, u64) {
        (self.recover_bytes, self.warn_bytes, self.critical_bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn has_small_default() {
        assert_eq!(MemoryBudget::for_16gb().max_active_agents, 3)
    }

    #[test]
    fn default_budget_is_self_consistent() {
        assert!(MemoryBudget::for_16gb().validate().is_ok());
    }

    #[test]
    fn rejects_critical_below_warn() {
        let mut budget = MemoryBudget::for_16gb();
        budget.critical_bytes = budget.warn_bytes;
        let error = budget.validate().unwrap_err();
        assert_eq!(error.code(), ErrorCode::InvalidBudget);
    }

    #[test]
    fn rejects_hot_loop_interval() {
        let mut budget = MemoryBudget::for_16gb();
        budget.sample_interval = Duration::from_millis(50);
        assert_eq!(
            budget.validate().unwrap_err().code(),
            ErrorCode::InvalidBudget
        );
    }

    #[test]
    fn rejects_zero_reclaim_cap() {
        let mut budget = MemoryBudget::for_16gb();
        budget.max_reclaims_per_tick = 0;
        assert!(budget.validate().is_err());
    }
}
