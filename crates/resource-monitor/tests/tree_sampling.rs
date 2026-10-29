//! 真实平台采样验收：进程树、私有提交、采样开销与排除规则。
//!
//! 需要 Node（已批准的测试期依赖，与 agent-runtime 夹具一致）；缺失时显式跳过并说明，
//! 不能把「没跑」说成「通过」。

mod support;

use std::time::{Duration, Instant};

use soxu_resource_monitor::{
    Activity, MemoryBudget, Monitor, MonitorConfig, Sampler, SystemSampler, Target, collect_tree,
};

use support::Hog;

const MIB: u64 = 1024 * 1024;

#[test]
fn own_process_reports_platform_metrics() {
    let sampler = SystemSampler::new();
    let capabilities = sampler.capabilities();
    assert_eq!(
        capabilities.platform,
        soxu_resource_monitor::Platform::current()
    );

    if !capabilities.resident.is_supported() {
        // 降级平台（当前是 macOS）：必须明确报「不支持」，而不是返回 0 冒充可用。
        let error = sampler
            .sample_process(std::process::id())
            .expect_err("降级平台不应给出内存数字");
        assert_eq!(
            error.code(),
            soxu_resource_monitor::ErrorCode::PlatformUnsupported
        );
        eprintln!("skip: 平台没有内存指标，已验证降级错误码");
        return;
    }

    let usage = sampler
        .sample_process(std::process::id())
        .expect("自身进程必须可采样");
    assert!(usage.resident_bytes > 0);
    if capabilities.has_private() {
        assert!(
            usage.private_bytes.unwrap_or(0) > 0,
            "声明支持私有提交时不该返回 0"
        );
    } else {
        assert!(
            usage.private_bytes.is_none(),
            "不支持时必须给 None，不能估算"
        );
    }
}

#[test]
fn system_snapshot_lists_own_process() {
    let sampler = SystemSampler::new();
    if !sampler.capabilities().has_tree() {
        eprintln!("skip: 平台没有进程树采样");
        return;
    }
    let parents = sampler.parent_map().expect("进程快照应可用");
    assert!(parents.iter().any(|(pid, _)| *pid == std::process::id()));
}

#[test]
fn tree_sums_parent_and_grandchild() {
    if !support::node_available() {
        eprintln!("skip: node 不可用（测试期依赖）");
        return;
    }
    let sampler = SystemSampler::new();
    if !sampler.capabilities().has_tree() {
        eprintln!("skip: 平台没有进程树采样");
        return;
    }
    let budget = MemoryBudget::for_16gb();
    let monitor = Monitor::new(&sampler, MonitorConfig::from_budget(&budget));

    let mut hog = Hog::spawn(32, 30_000, 1);
    hog.wait_ready();

    // 子进程的分配晚于 ready 行，轮询到内存真正落下再断言。
    let deadline = Instant::now() + Duration::from_secs(15);
    let mut usage = monitor
        .tree_usage(&sampler, hog.pid(), &[])
        .expect("进程树可采样");
    // 父进程与子进程各承诺分配 32 MiB，工作集之和的下界是 64 MiB。
    // 上限取决于分配器与 /proc 统计口径：Linux CI 实测约 97 MiB，旧断言写死
    // 100 MiB 会随 runner 镜像更新而假失败（见 #80 的 CI）。
    while usage.resident_bytes < 64 * MIB && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(100));
        usage = monitor
            .tree_usage(&sampler, hog.pid(), &[])
            .expect("进程树可采样");
    }

    eprintln!(
        "进程树: processes={} resident={} private={:?} missing={} cost={:?}",
        usage.processes,
        support::mib(usage.resident_bytes),
        usage.private_bytes.map(support::mib),
        usage.missing_processes,
        usage.sample_cost
    );

    assert!(usage.processes >= 2, "父进程 + 子进程都应计入：{usage:?}");
    assert!(
        usage.resident_bytes >= 64 * MIB,
        "父进程 + 子进程各 32 MiB，工作集之和不应低于 64 MiB：{usage:?}"
    );
    assert!(usage.is_complete(), "不应有采样不到的进程：{usage:?}");
    #[cfg(windows)]
    assert!(usage.private_bytes.is_some(), "Windows 必须给出私有提交");
}

#[test]
fn excluded_subtree_is_not_counted_twice() {
    if !support::node_available() {
        eprintln!("skip: node 不可用（测试期依赖）");
        return;
    }
    let sampler = SystemSampler::new();
    if !sampler.capabilities().has_tree() {
        eprintln!("skip: 平台没有进程树采样");
        return;
    }
    let monitor = Monitor::new(
        &sampler,
        MonitorConfig::from_budget(&MemoryBudget::for_16gb()),
    );

    let mut hog = Hog::spawn(16, 30_000, 1);
    hog.wait_ready();
    let parents = sampler.parent_map().expect("进程快照应可用");
    let pids = collect_tree(hog.pid(), &parents, &[]);
    assert!(pids.len() >= 2, "夹具必须真的拉起子进程：{pids:?}");
    let child = *pids
        .iter()
        .find(|pid| **pid != hog.pid())
        .expect("至少有一个子进程");

    let full = monitor.tree_usage(&sampler, hog.pid(), &[]).unwrap();
    let root_only = monitor.tree_usage(&sampler, hog.pid(), &[child]).unwrap();
    eprintln!(
        "整树={} 仅 root={}",
        support::mib(full.resident_bytes),
        support::mib(root_only.resident_bytes)
    );

    assert_eq!(root_only.processes, 1);
    assert!(
        root_only.resident_bytes < full.resident_bytes,
        "排除子树后必须更小：{root_only:?} vs {full:?}"
    );
}

#[test]
fn sampling_overhead_stays_small() {
    let sampler = SystemSampler::new();
    let budget = MemoryBudget::for_16gb();
    let mut monitor = Monitor::new(&sampler, MonitorConfig::from_budget(&budget));
    let targets = [Target::new("self", std::process::id(), Activity::Active)];

    let mut total = Duration::ZERO;
    let mut worst = Duration::ZERO;
    let rounds: u32 = 100;
    for _ in 0..rounds {
        let now = Instant::now();
        let sample = monitor.sample(&sampler, now, &targets);
        total += sample.sample_cost;
        worst = worst.max(sample.sample_cost);
    }
    let mean = total / rounds;
    eprintln!(
        "采样开销: rounds={rounds} mean={:?} worst={:?} platform={}",
        mean,
        worst,
        sampler.capabilities().platform.as_str()
    );
    assert!(
        mean < Duration::from_millis(50),
        "平均采样开销过高: {mean:?}"
    );
    assert!(
        monitor.history().len() <= monitor.config().history,
        "历史必须有界"
    );
}
