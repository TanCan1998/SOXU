//! 测试替身：确定性的内存/进程树输入。
//!
//! 只用于自动化测试与策略演练，**不会**被产品路径使用。未知 PID 返回可预测的
//! 1 MiB 合成值，避免测试关心机器上真实存在的进程。

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::error::{ErrorCode, MonitorError, Result};
use crate::metrics::{Capabilities, MetricSupport, Platform, ProcessUsage};
use crate::platform::Sampler;

const FAKE_DEFAULT_BYTES: u64 = 1024 * 1024;

/// 可编排的采样器。
#[derive(Debug)]
pub struct FakeSampler {
    capabilities: Capabilities,
    processes: HashMap<u32, ProcessUsage>,
    failing: HashSet<u32>,
    parents: Vec<(u32, u32)>,
    trimmed: Mutex<Vec<u32>>,
    sample_calls: AtomicU64,
    snapshot_failure: Option<String>,
}

impl FakeSampler {
    /// 所有指标都「可用」的替身，便于验证完整策略路径。
    pub fn new() -> Self {
        Self::with_capabilities(Capabilities {
            platform: Platform::Other,
            resident: MetricSupport::Supported("fake resident"),
            private: MetricSupport::Supported("fake private"),
            process_tree: MetricSupport::Supported("fake tree"),
            trim_working_set: MetricSupport::Supported("fake trim"),
        })
    }

    /// 私有指标不可用的替身，用于验证降级路径。
    pub fn degraded() -> Self {
        Self::with_capabilities(Capabilities {
            platform: Platform::Other,
            resident: MetricSupport::Supported("fake resident"),
            private: MetricSupport::Unsupported("fake: 该平台没有私有提交指标"),
            process_tree: MetricSupport::Supported("fake tree"),
            trim_working_set: MetricSupport::Unsupported("fake: 无法裁剪工作集"),
        })
    }

    pub fn with_capabilities(capabilities: Capabilities) -> Self {
        Self {
            capabilities,
            processes: HashMap::new(),
            failing: HashSet::new(),
            parents: Vec::new(),
            trimmed: Mutex::new(Vec::new()),
            sample_calls: AtomicU64::new(0),
            snapshot_failure: None,
        }
    }

    /// 指定进程的合成用量（私有提交默认与工作集相同）。
    pub fn with_usage(mut self, pid: u32, resident_bytes: u64) -> Self {
        self.processes.insert(
            pid,
            ProcessUsage {
                pid,
                resident_bytes,
                private_bytes: Some(resident_bytes),
            },
        );
        self
    }

    /// 运行中调整某个进程的合成用量（用于验证预警回落/滞回）。
    pub fn set_usage(&mut self, pid: u32, resident_bytes: u64) {
        self.processes.insert(
            pid,
            ProcessUsage {
                pid,
                resident_bytes,
                private_bytes: Some(resident_bytes),
            },
        );
    }

    /// 指定进程采样失败（模拟采样瞬间已退出）。
    pub fn with_failing_process(mut self, pid: u32) -> Self {
        self.failing.insert(pid);
        self
    }

    /// 指定父子关系：`parents` 为 (pid, ppid)。
    pub fn with_parents(mut self, parents: &[(u32, u32)]) -> Self {
        self.parents = parents.to_vec();
        self
    }

    /// 让整棵进程树快照失败（模拟平台不支持/权限不足）。
    pub fn with_snapshot_failure(mut self, detail: &str) -> Self {
        self.snapshot_failure = Some(detail.to_owned());
        self
    }

    pub fn trimmed(&self) -> Vec<u32> {
        self.trimmed
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    pub fn sample_calls(&self) -> u64 {
        self.sample_calls.load(Ordering::SeqCst)
    }
}

impl Default for FakeSampler {
    fn default() -> Self {
        Self::new()
    }
}

impl Sampler for FakeSampler {
    fn capabilities(&self) -> &Capabilities {
        &self.capabilities
    }

    fn sample_process(&self, pid: u32) -> Result<ProcessUsage> {
        self.sample_calls.fetch_add(1, Ordering::SeqCst);
        if self.failing.contains(&pid) {
            return Err(MonitorError::new(
                ErrorCode::ProcessUnavailable,
                format!("fake process {pid} exited"),
            ));
        }
        Ok(self.processes.get(&pid).cloned().unwrap_or(ProcessUsage {
            pid,
            resident_bytes: FAKE_DEFAULT_BYTES,
            private_bytes: Some(FAKE_DEFAULT_BYTES),
        }))
    }

    fn parent_map(&self) -> Result<Vec<(u32, u32)>> {
        match &self.snapshot_failure {
            Some(detail) => Err(MonitorError::with_detail(
                ErrorCode::SnapshotFailed,
                "fake parent_map",
                detail.clone(),
            )),
            None => Ok(self.parents.clone()),
        }
    }

    fn trim_working_set(&self, pid: u32) -> Result<()> {
        if !self.capabilities.trim_working_set.is_supported() {
            return Err(MonitorError::new(
                ErrorCode::TrimUnsupported,
                "fake: trim unsupported",
            ));
        }
        self.trimmed
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push(pid);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_process_gets_predictable_default() {
        let sampler = FakeSampler::new();
        let usage = sampler.sample_process(4242).unwrap();
        assert_eq!(usage.resident_bytes, FAKE_DEFAULT_BYTES);
        assert_eq!(sampler.sample_calls(), 1);
    }

    #[test]
    fn failing_process_reports_recoverable_error() {
        let sampler = FakeSampler::new().with_failing_process(7);
        let error = sampler.sample_process(7).unwrap_err();
        assert!(error.recoverable());
    }

    #[test]
    fn snapshot_failure_is_surfaced() {
        let sampler = FakeSampler::new().with_snapshot_failure("no permission");
        assert_eq!(
            sampler.parent_map().unwrap_err().detail(),
            Some("no permission")
        );
    }
}
