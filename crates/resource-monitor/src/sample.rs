//! 采样结果的数据结构：活动状态、受测目标、单个 runtime 的样本与整次采样。
//!
//! 这些类型只描述「测到了什么」，不含策略；策略在 `governor`，采集在 `platform`。

use std::time::{Duration, Instant};

use crate::error::MonitorError;
use crate::metrics::{Degradation, Platform, ProcessUsage, TreeUsage};

/// runtime 的活动状态；只有明确空闲的 runtime 才可能被释放。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Activity {
    /// 正在执行任务（含工具调用）。
    Active,
    /// 空闲，`since` 为进入空闲的时刻。
    Idle { since: Instant },
    /// 状态未知（例如状态事件丢失），一律按「不可释放」处理。
    Unknown,
}

impl Activity {
    pub fn idle_for(self, now: Instant) -> Option<Duration> {
        match self {
            Self::Idle { since } => Some(now.saturating_duration_since(since)),
            _ => None,
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Idle { .. } => "idle",
            Self::Unknown => "unknown",
        }
    }
}

/// 一个需要监控的对象：受管 runtime（或产品自身）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    /// 稳定键：建议直接用 `runtimeId`（会话身份仍由 sessionId 表达）。
    pub key: String,
    pub pid: u32,
    pub activity: Activity,
}

impl Target {
    pub fn new(key: impl Into<String>, pid: u32, activity: Activity) -> Self {
        Self {
            key: key.into(),
            pid,
            activity,
        }
    }
}

/// 单个受管对象的采样结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeSample {
    pub key: String,
    pub pid: u32,
    pub activity: Activity,
    pub usage: Option<TreeUsage>,
    /// 采样失败原因；失败只做诊断，不触发任何释放。
    pub error: Option<MonitorError>,
}

/// 一次完整采样。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sample {
    pub at: Instant,
    pub tick: u64,
    pub platform: Platform,
    /// 当前平台不可用的指标（每样本重新给出，便于上层展示）。
    pub degradation: Vec<Degradation>,
    pub self_usage: Option<ProcessUsage>,
    pub self_error: Option<MonitorError>,
    pub runtimes: Vec<RuntimeSample>,
    /// 受测对象工作集之和（自身进程 + 各 runtime 进程树）。
    pub total_resident_bytes: u64,
    /// 受测对象私有提交之和；任一分量缺失即为 `None`。
    pub total_private_bytes: Option<u64>,
    pub sample_cost: Duration,
}

impl Sample {
    pub fn runtime(&self, key: &str) -> Option<&RuntimeSample> {
        self.runtimes.iter().find(|runtime| runtime.key == key)
    }

    /// 是否有任何受管对象采样失败（失败样本不参与释放决策）。
    pub fn has_failures(&self) -> bool {
        self.self_error.is_some() || self.runtimes.iter().any(|runtime| runtime.error.is_some())
    }

    /// 一行诊断摘要：给日志与本地仪表盘直接展示，不含路径、会话内容或密钥。
    pub fn summary(&self) -> String {
        let private = match self.total_private_bytes {
            Some(bytes) => format!("{:.1} MiB private", mebibytes(bytes)),
            None => "private n/a".to_owned(),
        };
        let failures = self
            .runtimes
            .iter()
            .filter(|runtime| runtime.error.is_some())
            .count()
            + usize::from(self.self_error.is_some());
        let mut summary = format!(
            "mem tick={} platform={} total={:.1} MiB resident / {private} runtimes={} cost={:.2}ms",
            self.tick,
            self.platform.as_str(),
            mebibytes(self.total_resident_bytes),
            self.runtimes.len(),
            self.sample_cost.as_secs_f64() * 1000.0,
        );
        if failures > 0 {
            summary.push_str(&format!(" failures={failures}"));
        }
        if !self.degradation.is_empty() {
            let metrics: Vec<&str> = self
                .degradation
                .iter()
                .map(|entry| entry.metric.as_str())
                .collect();
            summary.push_str(&format!(" degraded={}", metrics.join(",")));
        }
        summary
    }
}

fn mebibytes(bytes: u64) -> f64 {
    bytes as f64 / (1024.0 * 1024.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idle_activity_reports_elapsed() {
        let now = Instant::now();
        let activity = Activity::Idle { since: now };
        assert_eq!(activity.idle_for(now), Some(Duration::ZERO));
        assert_eq!(Activity::Active.idle_for(now), None);
        assert_eq!(Activity::Unknown.idle_for(now), None);
    }

    #[test]
    fn summary_mentions_platform_totals_and_degradation() {
        let sampler = crate::platform::FakeSampler::degraded().with_usage(1, 4 * 1024 * 1024);
        let mut monitor = crate::monitor::Monitor::new(
            &sampler,
            crate::monitor::MonitorConfig {
                interval: Duration::from_secs(5),
                history: 2,
                self_pid: 1,
            },
        );
        let sample = monitor.sample(&sampler, Instant::now(), &[]);
        let summary = sample.summary();
        assert!(summary.contains("platform=other"), "{summary}");
        assert!(
            summary.contains("degraded=private_bytes,trim_working_set"),
            "{summary}"
        );
        assert!(summary.contains("4.0 MiB"), "{summary}");
    }
}
