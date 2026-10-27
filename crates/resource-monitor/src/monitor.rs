//! 采样编排：受管 Pi 进程树 + SOXU 自身，产出可解释的样本与有界历史。
//!
//! 这里**没有后台线程或定时器**：采样由调用方既有的 tick 驱动
//! （`due()` → `sample()`），因此「注册定时器的一方负责释放」的约束天然成立，
//! 也不会因为监控自身引入常驻进程。
//!
//! 一次采样只取一次系统级父子快照，再把每个受管 root 的子树单独聚合；同一次采样里
//! 其它受管 root 会被排除，避免父/子关系导致同一份内存被算两次。

use std::collections::{HashMap, HashSet, VecDeque};
use std::time::{Duration, Instant};

use crate::budget::MemoryBudget;
use crate::error::{ErrorCode, MonitorError, Result};
use crate::metrics::{Capabilities, TreeUsage};
use crate::platform::Sampler;
use crate::sample::{RuntimeSample, Sample, Target};

/// 采样节奏与历史容量。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MonitorConfig {
    pub interval: Duration,
    /// 保留多少个历史样本（有界，防止诊断数据无限增长）。
    pub history: usize,
    /// 代表「SOXU 自身」的 PID；测试可覆盖。
    pub self_pid: u32,
}

impl MonitorConfig {
    pub fn from_budget(budget: &MemoryBudget) -> Self {
        Self {
            interval: budget.sample_interval,
            history: 60,
            self_pid: std::process::id(),
        }
    }

    pub fn with_history(mut self, history: usize) -> Self {
        self.history = history.max(1);
        self
    }
}

/// 有界历史采样器。`sample` 需要 `&mut self`，因此天然是单 owner。
pub struct Monitor {
    config: MonitorConfig,
    capabilities: Capabilities,
    last_sample_at: Option<Instant>,
    tick: u64,
    history: VecDeque<Sample>,
}

impl Monitor {
    pub fn new(sampler: &dyn Sampler, config: MonitorConfig) -> Self {
        Self {
            capabilities: sampler.capabilities().clone(),
            config,
            last_sample_at: None,
            tick: 0,
            history: VecDeque::new(),
        }
    }

    /// 使用真实平台能力与给定预算构造。
    pub fn for_platform(budget: &MemoryBudget) -> Self {
        Self::new(
            &crate::platform::SystemSampler::new(),
            MonitorConfig::from_budget(budget),
        )
    }

    pub fn config(&self) -> &MonitorConfig {
        &self.config
    }

    pub fn capabilities(&self) -> &Capabilities {
        &self.capabilities
    }

    /// 是否到了下一个采样时刻。
    pub fn due(&self, now: Instant) -> bool {
        match self.last_sample_at {
            None => true,
            Some(last) => now.saturating_duration_since(last) >= self.config.interval,
        }
    }

    pub fn next_sample_at(&self) -> Option<Instant> {
        self.last_sample_at
            .and_then(|last| last.checked_add(self.config.interval))
    }

    pub fn last_sample(&self) -> Option<&Sample> {
        self.history.back()
    }

    pub fn history(&self) -> &VecDeque<Sample> {
        &self.history
    }

    /// 一次采样：自身进程 + 每个 target 的进程树。
    pub fn sample(&mut self, sampler: &dyn Sampler, now: Instant, targets: &[Target]) -> Sample {
        let started = Instant::now();
        let self_pid = self.config.self_pid;
        let mut sample = Sample {
            at: now,
            tick: self.tick + 1,
            platform: self.capabilities.platform,
            degradation: self.capabilities.degradation(),
            self_usage: None,
            self_error: None,
            runtimes: Vec::with_capacity(targets.len()),
            total_resident_bytes: 0,
            total_private_bytes: Some(0),
            sample_cost: Duration::ZERO,
        };

        match sampler.sample_process(self_pid) {
            Ok(usage) => {
                sample.total_resident_bytes = sample
                    .total_resident_bytes
                    .saturating_add(usage.resident_bytes);
                sample.total_private_bytes =
                    add_private(sample.total_private_bytes, usage.private_bytes);
                sample.self_usage = Some(usage);
            }
            Err(error) => sample.self_error = Some(error),
        }

        // 一次快照服务所有 target；快照不可用时每个 target 都记录失败，不做释放判断。
        let snapshot = if self.capabilities.has_tree() {
            sampler.parent_map()
        } else {
            Err(MonitorError::new(
                ErrorCode::PlatformUnsupported,
                "process_tree unsupported on this platform",
            ))
        };

        let roots: Vec<u32> = targets.iter().map(|target| target.pid).collect();
        for (index, target) in targets.iter().enumerate() {
            let exclude: Vec<u32> = roots
                .iter()
                .enumerate()
                .filter(|(other, _)| *other != index)
                .map(|(_, pid)| *pid)
                .collect();
            let outcome = match &snapshot {
                Ok(parents) => self.aggregate(sampler, parents, target.pid, &exclude),
                Err(error) => Err(error.clone()),
            };
            match outcome {
                Ok(usage) => {
                    sample.total_resident_bytes = sample
                        .total_resident_bytes
                        .saturating_add(usage.resident_bytes);
                    sample.total_private_bytes =
                        add_private(sample.total_private_bytes, usage.private_bytes);
                    sample.runtimes.push(RuntimeSample {
                        key: target.key.clone(),
                        pid: target.pid,
                        activity: target.activity,
                        usage: Some(usage),
                        error: None,
                    });
                }
                Err(error) => sample.runtimes.push(RuntimeSample {
                    key: target.key.clone(),
                    pid: target.pid,
                    activity: target.activity,
                    usage: None,
                    error: Some(error),
                }),
            }
        }

        sample.sample_cost = started.elapsed();
        self.tick = sample.tick;
        self.last_sample_at = Some(now);
        if self.config.history > 0 {
            if self.history.len() >= self.config.history {
                self.history.pop_front();
            }
            self.history.push_back(sample.clone());
        }
        sample
    }

    /// 单独测量任意进程树（例如「SOXU 完整进程树 - 受管 Agent 子树」，用于 P-07 基准）。
    pub fn tree_usage(
        &self,
        sampler: &dyn Sampler,
        root: u32,
        exclude: &[u32],
    ) -> Result<TreeUsage> {
        let parents = sampler.parent_map()?;
        self.aggregate(sampler, &parents, root, exclude)
    }

    /// 裁剪自身工作集（仅当平台支持且调用方明确启用时使用；数据不丢，只是把页换出）。
    pub fn trim_self_working_set(&self, sampler: &dyn Sampler) -> Result<()> {
        sampler.trim_working_set(self.config.self_pid)
    }

    fn aggregate(
        &self,
        sampler: &dyn Sampler,
        parents: &[(u32, u32)],
        root: u32,
        exclude: &[u32],
    ) -> Result<TreeUsage> {
        let started = Instant::now();
        let pids = collect_tree(root, parents, exclude);
        let Some(&first) = pids.first() else {
            return Err(MonitorError::new(
                ErrorCode::ProcessUnavailable,
                format!("process tree of {root} not found"),
            ));
        };
        debug_assert_eq!(first, root, "collect_tree 必须把 root 放在首位");

        let mut resident_bytes = 0u64;
        let mut private_bytes = Some(0u64);
        let mut missing_processes = 0usize;
        for pid in &pids {
            match sampler.sample_process(*pid) {
                Ok(usage) => {
                    resident_bytes = resident_bytes.saturating_add(usage.resident_bytes);
                    private_bytes = add_private(private_bytes, usage.private_bytes);
                }
                Err(error) if *pid == root => return Err(error),
                Err(_) => missing_processes += 1,
            }
        }

        Ok(TreeUsage {
            root_pid: root,
            processes: pids.len(),
            resident_bytes,
            private_bytes,
            missing_processes,
            sample_cost: started.elapsed(),
        })
    }
}

/// 只在每个分量都有私有提交时才累加，否则整体降级为 `None`（不拿部分值冒充全量）。
fn add_private(total: Option<u64>, component: Option<u64>) -> Option<u64> {
    match (total, component) {
        (Some(total), Some(component)) => Some(total.saturating_add(component)),
        _ => None,
    }
}

/// 还原从 `root` 开始的整棵子树，按「先 root 后子孙」的顺序返回，跳过 `exclude` 子树。
pub fn collect_tree(root: u32, parents: &[(u32, u32)], exclude: &[u32]) -> Vec<u32> {
    let excluded: HashSet<u32> = exclude.iter().copied().collect();
    if excluded.contains(&root) {
        return Vec::new();
    }
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for &(pid, ppid) in parents {
        children.entry(ppid).or_default().push(pid);
    }
    let mut seen = HashSet::new();
    let mut collected = Vec::new();
    let mut stack = vec![root];
    // seen 是防御：真实快照里不应有环，但坏数据不能让采样陷入死循环。
    while let Some(pid) = stack.pop() {
        if excluded.contains(&pid) || !seen.insert(pid) {
            continue;
        }
        collected.push(pid);
        if let Some(kids) = children.get(&pid) {
            stack.extend(kids.iter().copied());
        }
    }
    collected
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parents() -> Vec<(u32, u32)> {
        // 100 ← 200 ← 300, 100 ← 400, 500 ← 600
        vec![
            (100, 1),
            (200, 100),
            (300, 200),
            (400, 100),
            (500, 1),
            (600, 500),
        ]
    }

    #[test]
    fn collects_full_subtree_without_other_branches() {
        let mut tree = collect_tree(100, &parents(), &[]);
        tree.sort_unstable();
        assert_eq!(tree, vec![100, 200, 300, 400]);
    }

    #[test]
    fn excluded_subtree_and_its_children_are_skipped() {
        let mut tree = collect_tree(100, &parents(), &[200]);
        tree.sort_unstable();
        assert_eq!(tree, vec![100, 400]);
    }

    #[test]
    fn excluded_root_yields_empty_tree() {
        assert!(collect_tree(100, &parents(), &[100]).is_empty());
    }

    #[test]
    fn cyclic_snapshot_does_not_loop_forever() {
        let cyclic = vec![(1, 1), (2, 1)];
        let tree = collect_tree(1, &cyclic, &[]);
        assert_eq!(tree.len(), 2);
    }
}
