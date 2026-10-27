//! 压力场景：3 个并发 Agent + 长时间空闲。
//!
//! 分两段，各自给出自己的证据：
//! 1. **真实段**：3 个真实子进程树（每个都带一个子进程），连续采样 20 拍，验证指标、
//!    采样开销，并确认活跃进程在采样期间没有被干扰（策略只产出指令，不碰进程）。
//! 2. **虚拟段**：用同一批真实测得的体量，按 5 秒一拍模拟 4 小时空闲，验证「只有空闲的
//!    那个 Agent 会被优雅释放、活跃 Agent 一次都不会被选中」。
//!
//! 真实时间里等不到 4 小时，所以长时空闲用虚拟时钟；这不是伪造通过——真实段与虚拟段
//! 的断言都在同一个测试里跑，且真实段的数字是实测的。

mod support;

use std::collections::HashSet;
use std::time::{Duration, Instant};

use soxu_resource_monitor::{
    Activity, Directive, FakeSampler, Governor, MemoryBudget, Monitor, MonitorConfig, Sampler,
    SystemSampler, Target,
};

use support::Hog;

const MIB: u64 = 1024 * 1024;
const FAKE_SELF_PID: u32 = 999_998;

fn skip_reason() -> Option<&'static str> {
    if !support::node_available() {
        return Some("node 不可用（测试期依赖）");
    }
    if !SystemSampler::new().capabilities().has_tree() {
        return Some("平台没有进程树采样");
    }
    None
}

#[test]
fn three_agents_survive_sampling_and_only_the_idle_one_is_released() {
    if let Some(reason) = skip_reason() {
        eprintln!("skip: {reason}");
        return;
    }

    let sampler = SystemSampler::new();
    let platform_budget = MemoryBudget::for_16gb();
    let mut monitor = Monitor::new(
        &sampler,
        MonitorConfig {
            interval: platform_budget.sample_interval,
            history: 8,
            self_pid: std::process::id(),
        },
    );

    // 3 个并发 Agent，每个都是「父 + 子」两进程树；自带 15 秒兜底退出。
    let mut agents: Vec<Hog> = (0..3)
        .map(|_| {
            let mut hog = Hog::spawn(32, 15_000, 1);
            hog.wait_ready();
            hog
        })
        .collect();
    let targets: Vec<Target> = agents
        .iter()
        .enumerate()
        .map(|(index, hog)| Target::new(format!("agent-{index}"), hog.pid(), Activity::Active))
        .collect();

    // ---- 真实段：连续 20 拍真实采样 ----
    let mut total_cost = Duration::ZERO;
    let mut worst_cost = Duration::ZERO;
    let mut last = None;
    for _ in 0..20 {
        let sample = monitor.sample(&sampler, Instant::now(), &targets);
        total_cost += sample.sample_cost;
        worst_cost = worst_cost.max(sample.sample_cost);
        last = Some(sample);
        std::thread::sleep(Duration::from_millis(25));
    }
    let sample = last.expect("至少采样过一次");
    eprintln!(
        "3 Agent 实时采样: total={} mean={:?} worst={:?} 样本总量={}",
        support::mib(sample.total_resident_bytes),
        total_cost / 20,
        worst_cost,
        support::mib(sample.total_resident_bytes)
    );

    assert!(!sample.has_failures(), "3 个 Agent 都应能采样：{sample:?}");
    assert_eq!(sample.runtimes.len(), 3);
    for runtime in &sample.runtimes {
        let usage = runtime
            .usage
            .as_ref()
            .unwrap_or_else(|| panic!("{} 采样失败: {:?}", runtime.key, runtime.error));
        assert!(usage.processes >= 2, "每个 Agent 都应是两进程树：{usage:?}");
        assert!(
            usage.resident_bytes >= 48 * MIB,
            "两进程树的工作集不应低于 48 MiB：{usage:?}"
        );
    }
    assert!(
        total_cost / 20 < Duration::from_millis(50),
        "采样开销过高，会干扰被测对象"
    );
    // 采样本身绝不动进程。
    for agent in &mut agents {
        assert!(agent.is_running(), "采样期间活跃 Agent 必须仍在运行");
    }

    // ---- 虚拟段：4 小时空闲（5 秒一拍） ----
    let mut budget = MemoryBudget::for_16gb();
    budget.warn_bytes = 400 * MIB;
    budget.critical_bytes = 800 * MIB;
    budget.recover_bytes = 350 * MIB;
    budget.runtime_warn_bytes = 200 * MIB;
    budget.idle_reclaim_min_bytes = 16 * MIB;
    budget.max_reclaims_per_tick = 1;
    budget.validate().expect("压测预算必须自洽");

    let self_bytes = sample
        .self_usage
        .as_ref()
        .map(|usage| usage.resident_bytes)
        .unwrap_or(100 * MIB);
    let sizes: Vec<u64> = sample
        .runtimes
        .iter()
        .map(|runtime| {
            runtime
                .usage
                .as_ref()
                .map(|usage| usage.resident_bytes)
                .unwrap_or(100 * MIB)
        })
        .collect();

    let mut fake = FakeSampler::new().with_usage(FAKE_SELF_PID, self_bytes);
    for (index, size) in sizes.iter().enumerate() {
        fake = fake.with_usage(2000 + index as u32, *size);
    }
    let mut virtual_monitor = Monitor::new(
        &fake,
        MonitorConfig {
            interval: budget.sample_interval,
            history: 8,
            self_pid: FAKE_SELF_PID,
        },
    );
    let mut governor = Governor::new(budget.clone());

    let started = Instant::now();
    let idle_since = started;
    let mut released: HashSet<String> = HashSet::new();
    let mut releases: Vec<(String, Duration)> = Vec::new();
    let ticks = 4 * 60 * 60 / 5; // 4 小时，5 秒一拍
    for step in 0..ticks {
        let now = started + Duration::from_secs(step as u64 * 5);
        // 被释放的 runtime 从下一拍起不再受管（上层 stop 后即回收）。
        let mut targets = Vec::new();
        for (index, _) in sizes.iter().enumerate() {
            let key = format!("agent-{index}");
            if released.contains(&key) {
                continue;
            }
            let activity = if index == 2 {
                Activity::Idle { since: idle_since }
            } else {
                Activity::Active
            };
            targets.push(Target::new(key, 2000 + index as u32, activity));
        }

        let sample = virtual_monitor.sample(&fake, now, &targets);
        for directive in governor.evaluate(&sample) {
            if let Directive::ReleaseIdleRuntime { key, idle_for, .. } = directive {
                released.insert(key.clone());
                releases.push((key, idle_for));
            }
        }
        assert!(
            virtual_monitor.history().len() <= 8,
            "长时间运行后历史必须有界"
        );
    }

    eprintln!(
        "虚拟 4 小时空闲: ticks={ticks} releases={releases:?} stats={:?}",
        governor.stats()
    );
    assert_eq!(releases.len(), 1, "只应释放唯一空闲的 Agent：{releases:?}");
    assert_eq!(releases[0].0, "agent-2");
    assert!(
        releases[0].1 >= Duration::from_secs(300),
        "空闲时间没到就不该释放"
    );
    assert_eq!(governor.stats().releases_requested, 1);

    // 真实世界的活跃进程仍然在跑：策略只输出指令，不会顺手杀进程。
    for agent in &mut agents {
        assert!(agent.is_running(), "活跃 Agent 不得被监控策略影响");
    }
}
