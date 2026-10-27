//! 策略层验收：只有明确空闲的 runtime 会被优雅释放，超限只预警、失败只降级。
//!
//! 这一组用确定性替身（`FakeSampler`）驱动，零真实进程、零等待，因此可以在 CI 上
//! 稳定复现「长时间空闲」「反复超限」「释放失败」等在真实时间里等不到的场景。

mod support;

use std::time::{Duration, Instant};

use soxu_resource_monitor::{
    Activity, Directive, FakeSampler, Governor, MemoryBudget, Monitor, MonitorConfig,
    PressureLevel, ReclaimOutcome, Target,
};

const MIB: u64 = 1024 * 1024;
const SELF_PID: u32 = 999_999;

/// 便于在测试里表达「几百 MiB」的场景，阈值全部按比例缩放。
fn test_budget() -> MemoryBudget {
    let mut budget = MemoryBudget::for_16gb();
    budget.warn_bytes = 512 * MIB;
    budget.critical_bytes = 1024 * MIB;
    budget.recover_bytes = 400 * MIB;
    budget.runtime_warn_bytes = 256 * MIB;
    budget.idle_after = Duration::from_secs(300);
    budget.idle_reclaim_after = Duration::from_secs(1800);
    budget.idle_reclaim_min_bytes = 16 * MIB;
    budget.reclaim_cooldown = Duration::from_secs(600);
    budget.failed_cooldown = Duration::from_secs(1800);
    budget.max_reclaims_per_tick = 1;
    budget
        .validate()
        .expect("测试预算必须自洽（阈值顺序、间隔与冷却）");
    budget
}

struct Harness {
    sampler: FakeSampler,
    monitor: Monitor,
    governor: Governor,
    now: Instant,
}

impl Harness {
    fn new(sampler: FakeSampler, self_bytes: u64) -> Self {
        let budget = test_budget();
        let sampler = sampler.with_usage(SELF_PID, self_bytes);
        let monitor = Monitor::new(
            &sampler,
            MonitorConfig {
                interval: budget.sample_interval,
                history: 4,
                self_pid: SELF_PID,
            },
        );
        Self {
            sampler,
            monitor,
            governor: Governor::new(budget),
            now: Instant::now(),
        }
    }

    fn advance(&mut self, duration: Duration) -> Instant {
        self.now += duration;
        self.now
    }

    fn tick(&mut self, targets: &[Target]) -> Vec<Directive> {
        let sample = self.monitor.sample(&self.sampler, self.now, targets);
        self.governor.evaluate(&sample)
    }
}

fn released_keys(directives: &[Directive]) -> Vec<String> {
    directives
        .iter()
        .filter_map(|directive| match directive {
            Directive::ReleaseIdleRuntime { key, .. } => Some(key.clone()),
            _ => None,
        })
        .collect()
}

fn pressure_levels(directives: &[Directive]) -> Vec<(PressureLevel, PressureLevel)> {
    directives
        .iter()
        .filter_map(|directive| match directive {
            Directive::Pressure {
                level, previous, ..
            } => Some((*previous, *level)),
            _ => None,
        })
        .collect()
}

#[test]
fn active_runtime_is_never_released_even_over_critical() {
    let mut harness = Harness::new(
        FakeSampler::new().with_usage(1001, 1000 * MIB),
        // 自身 100 MiB + 活跃 Agent 1000 MiB = 1100 MiB，越过了 1024 MiB 的严重阈值
        100 * MIB,
    );
    let targets = [Target::new("agent-active", 1001, Activity::Active)];
    let directives = harness.tick(&targets);

    assert!(
        released_keys(&directives).is_empty(),
        "活跃 Agent 不得被释放"
    );
    assert_eq!(
        pressure_levels(&directives),
        vec![(PressureLevel::Normal, PressureLevel::Critical)],
        "超限必须升级到严重级别并预警：{directives:?}"
    );
    assert!(
        directives
            .iter()
            .any(|directive| matches!(directive, Directive::NeedsAttention { .. })),
        "只做预警，必须显式报告需要人工介入：{directives:?}"
    );

    // 即使再过一小时、持续超限，活跃 Agent 仍然不会被释放。
    harness.advance(Duration::from_secs(3600));
    let directives = harness.tick(&targets);
    assert!(released_keys(&directives).is_empty());
}

#[test]
fn idle_runtime_is_released_only_after_idle_after_under_pressure() {
    // 自身 100 MiB + 空闲 Agent 500 MiB = 600 MiB，已进入 512 MiB 预警线。
    let mut harness = Harness::new(FakeSampler::new().with_usage(2001, 500 * MIB), 100 * MIB);
    let idle_since = harness.now;
    let targets = [Target::new(
        "agent-idle",
        2001,
        Activity::Idle { since: idle_since },
    )];

    // 刚空闲：总量已进入预警，但空闲时间不够，不释放。
    let directives = harness.tick(&targets);
    assert!(released_keys(&directives).is_empty());

    harness.advance(Duration::from_secs(299));
    assert!(released_keys(&harness.tick(&targets)).is_empty());

    harness.advance(Duration::from_secs(2));
    assert_eq!(released_keys(&harness.tick(&targets)), vec!["agent-idle"]);
}

#[test]
fn long_idle_runtime_is_released_without_pressure() {
    // 自身 100 MiB + 空闲 300 MiB = 400 MiB，低于 512 MiB 预警线。
    let mut harness = Harness::new(FakeSampler::new().with_usage(2002, 300 * MIB), 100 * MIB);
    let idle_since = harness.now;
    let targets = [Target::new(
        "agent-long-idle",
        2002,
        Activity::Idle { since: idle_since },
    )];

    harness.advance(Duration::from_secs(600));
    assert!(
        released_keys(&harness.tick(&targets)).is_empty(),
        "没有压力时，10 分钟空闲还不够触发释放"
    );

    harness.advance(Duration::from_secs(1200));
    assert_eq!(
        released_keys(&harness.tick(&targets)),
        vec!["agent-long-idle"],
        "30 分钟以上的长空闲即使没有压力也要回收"
    );
}

#[test]
fn unknown_activity_is_never_released() {
    let mut harness = Harness::new(FakeSampler::new().with_usage(2003, 900 * MIB), 100 * MIB);
    let targets = [Target::new("agent-unknown", 2003, Activity::Unknown)];
    harness.advance(Duration::from_secs(7200));
    assert!(released_keys(&harness.tick(&targets)).is_empty());
}

#[test]
fn releases_are_rate_limited_and_back_off_after_success() {
    // 自身 100 MiB + 3 × 200 MiB = 700 MiB，处于预警档。
    let mut harness = Harness::new(
        FakeSampler::new()
            .with_usage(3001, 200 * MIB)
            .with_usage(3002, 200 * MIB)
            .with_usage(3003, 200 * MIB),
        100 * MIB,
    );
    let idle_since = harness.now;
    let targets = [
        Target::new("a1", 3001, Activity::Idle { since: idle_since }),
        Target::new("a2", 3002, Activity::Idle { since: idle_since }),
        Target::new("a3", 3003, Activity::Idle { since: idle_since }),
    ];

    harness.advance(Duration::from_secs(600));
    // 每拍最多一个，避免一次性停掉所有空闲会话。
    assert_eq!(released_keys(&harness.tick(&targets)).len(), 1);
    assert_eq!(released_keys(&harness.tick(&targets)).len(), 1);
    let third = released_keys(&harness.tick(&targets));
    assert_eq!(third.len(), 1);
    assert!(
        released_keys(&harness.tick(&targets)).is_empty(),
        "三个都已在冷却中，不应继续请求"
    );
}

#[test]
fn failed_release_downgrades_to_warning_and_extends_cooldown() {
    let mut harness = Harness::new(FakeSampler::new().with_usage(4001, 500 * MIB), 100 * MIB);
    let idle_since = harness.now;
    let targets = [Target::new(
        "agent-idle",
        4001,
        Activity::Idle { since: idle_since },
    )];

    harness.advance(Duration::from_secs(600));
    assert_eq!(released_keys(&harness.tick(&targets)), vec!["agent-idle"]);

    let at = harness.now;
    harness.governor.record_release(
        "agent-idle",
        ReclaimOutcome::Failed {
            code: soxu_resource_monitor::ErrorCode::ProcessUnavailable,
            detail: "优雅停止超时".to_owned(),
        },
        at,
    );

    let directives = harness.tick(&targets);
    assert!(
        directives
            .iter()
            .any(|directive| matches!(directive, Directive::ReclaimFailed { key, .. } if key == "agent-idle")),
        "释放失败必须显式上报：{directives:?}"
    );
    assert!(released_keys(&directives).is_empty());

    // 失败冷却（30 分钟）内不再重复请求，也绝不升级为强杀。
    harness.advance(Duration::from_secs(1700));
    assert!(released_keys(&harness.tick(&targets)).is_empty());

    harness.advance(Duration::from_secs(200));
    assert_eq!(released_keys(&harness.tick(&targets)), vec!["agent-idle"]);
    assert_eq!(harness.governor.stats().releases_failed, 1);
}

#[test]
fn degraded_platform_reports_once_and_still_warns() {
    let mut harness = Harness::new(
        FakeSampler::degraded().with_usage(5001, 600 * MIB),
        100 * MIB,
    );
    let targets = [Target::new("agent", 5001, Activity::Active)];

    let first = harness.tick(&targets);
    let degraded: Vec<_> = first
        .iter()
        .filter(|directive| matches!(directive, Directive::Degraded { .. }))
        .collect();
    assert_eq!(
        degraded.len(),
        2,
        "私有提交与工作集裁剪都不可用时应各报一条降级"
    );

    harness.advance(Duration::from_secs(5));
    let second = harness.tick(&targets);
    assert!(
        !second
            .iter()
            .any(|directive| matches!(directive, Directive::Degraded { .. })),
        "降级说明每次运行只报一遍"
    );
    // 降级不影响「用可用指标做预警」。
    assert_eq!(
        harness.governor.stats().level,
        PressureLevel::Warn,
        "工作集仍可用时必须继续预警"
    );
}

#[test]
fn incomplete_tree_is_not_used_as_release_evidence() {
    // 自身 100 MiB + 500 MiB 候选，已经超预警线；但子进程采样失败 → 聚合不完整。
    let sampler = FakeSampler::new()
        .with_usage(6001, 500 * MIB)
        .with_parents(&[(6001, 1), (6002, 6001)])
        .with_failing_process(6002);
    let mut harness = Harness::new(sampler, 100 * MIB);
    let idle_since = harness.now;
    let targets = [Target::new(
        "agent-partial",
        6001,
        Activity::Idle { since: idle_since },
    )];

    harness.advance(Duration::from_secs(3600));
    let sample = harness
        .monitor
        .sample(&harness.sampler, harness.now, &targets);
    let usage = sample.runtimes[0].usage.as_ref().expect("root 仍可采样");
    assert_eq!(usage.missing_processes, 1);
    assert!(!usage.is_complete());

    let directives = harness.governor.evaluate(&sample);
    assert!(
        released_keys(&directives).is_empty(),
        "聚合不完整时不允许据此释放"
    );
}

#[test]
fn snapshot_failure_blocks_release() {
    let sampler = FakeSampler::new().with_snapshot_failure("权限不足");
    // 自身 600 MiB：已经超预警线，唯一的阻塞理由只能是「快照失败」。
    let mut harness = Harness::new(sampler, 600 * MIB);
    let idle_since = harness.now;
    let targets = [Target::new(
        "agent",
        7001,
        Activity::Idle { since: idle_since },
    )];

    harness.advance(Duration::from_secs(3600));
    let sample = harness
        .monitor
        .sample(&harness.sampler, harness.now, &targets);
    assert!(sample.has_failures());
    assert!(released_keys(&harness.governor.evaluate(&sample)).is_empty());
}

#[test]
fn pressure_alerts_use_hysteresis() {
    let mut harness = Harness::new(FakeSampler::new().with_usage(8001, 600 * MIB), 100 * MIB);
    let targets = [Target::new("agent", 8001, Activity::Active)];

    let first = harness.tick(&targets);
    assert_eq!(
        pressure_levels(&first),
        vec![(PressureLevel::Normal, PressureLevel::Warn)]
    );

    harness.advance(Duration::from_secs(5));
    assert!(
        pressure_levels(&harness.tick(&targets)).is_empty(),
        "同一等级不重复报警"
    );

    // 回落到 recover（400 MiB）之上：仍停在预警档，不抖动。
    harness.sampler.set_usage(8001, 450 * MIB);
    harness.advance(Duration::from_secs(5));
    assert!(pressure_levels(&harness.tick(&targets)).is_empty());
    assert_eq!(harness.governor.stats().level, PressureLevel::Warn);

    // 回落到 recover 之下：解除预警，只报一次。
    harness.sampler.set_usage(8001, 200 * MIB);
    harness.advance(Duration::from_secs(5));
    assert_eq!(
        pressure_levels(&harness.tick(&targets)),
        vec![(PressureLevel::Warn, PressureLevel::Normal)]
    );
    harness.advance(Duration::from_secs(5));
    assert!(pressure_levels(&harness.tick(&targets)).is_empty());
}

#[test]
fn monitor_history_stays_bounded() {
    let mut harness = Harness::new(FakeSampler::new().with_usage(9001, 10 * MIB), 10 * MIB);
    let targets = [Target::new("agent", 9001, Activity::Active)];
    for _ in 0..50 {
        harness.advance(Duration::from_secs(5));
        let _ = harness.tick(&targets);
    }
    assert_eq!(harness.monitor.history().len(), 4);
    assert_eq!(harness.monitor.last_sample().map(|s| s.tick), Some(50));
}
