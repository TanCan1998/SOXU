//! 预算策略：预警、空闲释放请求、失败降级。
//!
//! 不可协商的规则（对应 TASK-004 验收「超限仅采取安全可恢复的释放/预警策略」）：
//! 1. 只有 `Activity::Idle` 且空闲足够久的 runtime 会被请求释放；
//! 2. 「释放」是**优雅停止请求**，不是强杀——本模块没有、也不允许有 kill 语义的指令；
//! 3. 采样失败或不完整的 runtime 一律跳过：宁可少释放，也不误判；
//! 4. 释放失败只降级为预警并拉长冷却，绝不升级为强杀；
//! 5. 单次采样最多请求 `max_reclaims_per_tick` 个释放，避免一次性停掉所有空闲会话；
//! 6. 压力等级只在变化时上报（滞回），避免日志刷屏。

use std::collections::{BTreeSet, HashMap};
use std::time::{Duration, Instant};

use crate::budget::MemoryBudget;
use crate::error::ErrorCode;
use crate::sample::{Activity, Sample};

/// 压力等级。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum PressureLevel {
    Normal,
    Warn,
    Critical,
}

impl PressureLevel {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Normal => "normal",
            Self::Warn => "warn",
            Self::Critical => "critical",
        }
    }
}

/// 采样后的可执行结论。全部是「预警」或「优雅释放请求」，没有强制终止。
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum Directive {
    /// 压力等级发生变化（仅变化时发出）。
    Pressure {
        level: PressureLevel,
        previous: PressureLevel,
        total_resident_bytes: u64,
        threshold_bytes: u64,
        over_bytes: u64,
    },
    /// 单个 runtime 进程树超过单实例预警线（进入时发出一次）。
    RuntimeWarning {
        key: String,
        resident_bytes: u64,
        threshold_bytes: u64,
    },
    /// 通过 `PiSupervisor::stop` 优雅释放空闲 runtime；会话 JSONL 不丢，可恢复。
    ReleaseIdleRuntime {
        key: String,
        idle_for: Duration,
        reclaimable_bytes: u64,
    },
    /// 上一次释放请求失败：只降级为预警。
    ReclaimFailed {
        key: String,
        code: ErrorCode,
        detail: String,
    },
    /// 指标在当前平台不可用或降级（每次运行只报一遍）。
    Degraded { metric: String, detail: String },
    /// 已进入严重级别：需要人工介入（不会自动杀进程）。
    NeedsAttention {
        level: PressureLevel,
        total_resident_bytes: u64,
        detail: String,
    },
}

/// 上层执行释放后的结果回报。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReclaimOutcome {
    /// 已通过优雅停止回收（进程已退出）。
    Released,
    /// 释放失败（超时、权限、上层拒绝等）。
    Failed { code: ErrorCode, detail: String },
}

/// 策略运行统计，供诊断展示。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GovernorStats {
    pub level: PressureLevel,
    pub releases_requested: u64,
    pub releases_failed: u64,
}

/// 无 IO、无时钟的确定性策略机：同一份样本序列必然产出同一份指令序列。
pub struct Governor {
    budget: MemoryBudget,
    level: PressureLevel,
    warned: BTreeSet<String>,
    cooldown_until: HashMap<String, Instant>,
    failures: Vec<(String, ErrorCode, String)>,
    degradation_reported: bool,
    releases_requested: u64,
    releases_failed: u64,
}

impl Governor {
    pub fn new(budget: MemoryBudget) -> Self {
        Self {
            budget,
            level: PressureLevel::Normal,
            warned: BTreeSet::new(),
            cooldown_until: HashMap::new(),
            failures: Vec::new(),
            degradation_reported: false,
            releases_requested: 0,
            releases_failed: 0,
        }
    }

    pub fn budget(&self) -> &MemoryBudget {
        &self.budget
    }

    pub fn stats(&self) -> GovernorStats {
        GovernorStats {
            level: self.level,
            releases_requested: self.releases_requested,
            releases_failed: self.releases_failed,
        }
    }

    /// 上报一次释放结果；失败只会拉长该 runtime 的冷却并产生预警。
    pub fn record_release(&mut self, key: &str, outcome: ReclaimOutcome, at: Instant) {
        let window = match outcome {
            ReclaimOutcome::Released => self.budget.reclaim_cooldown,
            ReclaimOutcome::Failed { .. } => {
                self.releases_failed += 1;
                self.budget.failed_cooldown
            }
        };
        if let ReclaimOutcome::Failed { code, detail } = outcome {
            self.failures.push((key.to_owned(), code, detail));
        }
        self.cooldown_until
            .insert(key.to_owned(), clamp_add(at, window));
    }

    /// 消费一个样本，产出最多一批指令（不修改任何进程）。
    pub fn evaluate(&mut self, sample: &Sample) -> Vec<Directive> {
        let mut directives = Vec::new();

        if !self.degradation_reported && !sample.degradation.is_empty() {
            for entry in &sample.degradation {
                directives.push(Directive::Degraded {
                    metric: entry.metric.clone(),
                    detail: entry.detail.clone(),
                });
            }
            self.degradation_reported = true;
        }

        for (key, code, detail) in std::mem::take(&mut self.failures) {
            directives.push(Directive::ReclaimFailed { key, code, detail });
        }

        let total = sample.total_resident_bytes;
        let level = self.classify(total);
        let previous = self.level;
        self.level = level;
        if level != previous {
            let threshold_bytes = self.threshold_for(level);
            directives.push(Directive::Pressure {
                level,
                previous,
                total_resident_bytes: total,
                threshold_bytes,
                over_bytes: total.saturating_sub(threshold_bytes),
            });
        }
        let escalated_to_critical =
            level == PressureLevel::Critical && previous < PressureLevel::Critical;

        for runtime in &sample.runtimes {
            let Some(usage) = &runtime.usage else {
                continue;
            };
            if usage.resident_bytes >= self.budget.runtime_warn_bytes {
                if self.warned.insert(runtime.key.clone()) {
                    directives.push(Directive::RuntimeWarning {
                        key: runtime.key.clone(),
                        resident_bytes: usage.resident_bytes,
                        threshold_bytes: self.budget.runtime_warn_bytes,
                    });
                }
            } else {
                self.warned.remove(&runtime.key);
            }
        }

        let candidates = self.candidates(sample);
        for (key, idle_for, reclaimable_bytes) in candidates
            .into_iter()
            .take(self.budget.max_reclaims_per_tick)
        {
            self.cooldown_until.insert(
                key.clone(),
                clamp_add(sample.at, self.budget.reclaim_cooldown),
            );
            self.releases_requested += 1;
            directives.push(Directive::ReleaseIdleRuntime {
                key,
                idle_for,
                reclaimable_bytes,
            });
        }

        if escalated_to_critical {
            directives.push(Directive::NeedsAttention {
                level,
                total_resident_bytes: total,
                detail: format!(
                    "总工作集 {} 超过严重阈值 {}；只做预警，不强制终止活跃 Agent",
                    total, self.budget.critical_bytes
                ),
            });
        }

        directives
    }

    /// 可安全释放的候选，按可回收内存从大到小排序。
    fn candidates(&self, sample: &Sample) -> Vec<(String, Duration, u64)> {
        let under_pressure = self.level >= PressureLevel::Warn;
        let mut list = Vec::new();
        for runtime in &sample.runtimes {
            let Activity::Idle { since } = runtime.activity else {
                continue;
            };
            let Some(usage) = &runtime.usage else {
                continue;
            };
            // 不完整的聚合说明有进程没采到，不能当作释放依据。
            if !usage.is_complete() {
                continue;
            }
            let idle_for = sample.at.saturating_duration_since(since);
            if idle_for < self.budget.idle_after {
                continue;
            }
            if !under_pressure && idle_for < self.budget.idle_reclaim_after {
                continue;
            }
            if usage.resident_bytes < self.budget.idle_reclaim_min_bytes {
                continue;
            }
            if self.in_cooldown(&runtime.key, sample.at) {
                continue;
            }
            list.push((runtime.key.clone(), idle_for, usage.resident_bytes));
        }
        list.sort_by(|left, right| right.2.cmp(&left.2).then_with(|| left.0.cmp(&right.0)));
        list
    }

    fn in_cooldown(&self, key: &str, now: Instant) -> bool {
        self.cooldown_until
            .get(key)
            .is_some_and(|until| now < *until)
    }

    fn classify(&self, total: u64) -> PressureLevel {
        let (recover, warn, critical) = self.budget.thresholds();
        match self.level {
            PressureLevel::Normal => {
                if total >= critical {
                    PressureLevel::Critical
                } else if total >= warn {
                    PressureLevel::Warn
                } else {
                    PressureLevel::Normal
                }
            }
            // 预警必须回落到 recover_bytes 才解除，避免在阈值附近反复报警。
            PressureLevel::Warn => {
                if total >= critical {
                    PressureLevel::Critical
                } else if total <= recover {
                    PressureLevel::Normal
                } else {
                    PressureLevel::Warn
                }
            }
            // 严重级别要回到预警线以下才解除。
            PressureLevel::Critical => {
                if total >= warn {
                    PressureLevel::Critical
                } else {
                    PressureLevel::Normal
                }
            }
        }
    }

    fn threshold_for(&self, level: PressureLevel) -> u64 {
        match level {
            PressureLevel::Normal => self.budget.recover_bytes,
            PressureLevel::Warn => self.budget.warn_bytes,
            PressureLevel::Critical => self.budget.critical_bytes,
        }
    }
}

/// Instant 加法的防御包装：极端时长不应 panic。
fn clamp_add(at: Instant, window: Duration) -> Instant {
    at.checked_add(window).unwrap_or(at)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_with_hysteresis() {
        let budget = MemoryBudget::for_16gb();
        let mut governor = Governor::new(budget.clone());
        assert_eq!(governor.classify(budget.warn_bytes), PressureLevel::Warn);
        assert_eq!(
            governor.classify(budget.critical_bytes),
            PressureLevel::Critical
        );
        // 进入 Warn 后，只有回落到 recover 才解除。
        governor.level = PressureLevel::Warn;
        assert_eq!(
            governor.classify(budget.warn_bytes - 1),
            PressureLevel::Warn
        );
        assert_eq!(
            governor.classify(budget.recover_bytes),
            PressureLevel::Normal
        );
    }

    #[test]
    fn critical_reports_its_own_threshold() {
        let budget = MemoryBudget::for_16gb();
        let governor = Governor::new(budget.clone());
        assert_eq!(
            governor.threshold_for(PressureLevel::Critical),
            budget.critical_bytes
        );
    }

    #[test]
    fn cooldown_expires_exactly_at_deadline() {
        let budget = MemoryBudget::for_16gb();
        let mut governor = Governor::new(budget.clone());
        let now = Instant::now();
        governor.record_release("r1", ReclaimOutcome::Released, now);
        assert!(governor.in_cooldown("r1", now));
        assert!(governor.in_cooldown(
            "r1",
            now + budget.reclaim_cooldown - Duration::from_millis(1)
        ));
        assert!(!governor.in_cooldown("r1", now + budget.reclaim_cooldown));
    }
}
