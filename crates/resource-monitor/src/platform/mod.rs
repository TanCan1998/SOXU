//! 平台采样入口。
//!
//! 只在 `imp` 里做 `#[cfg]` 分派，上层（`monitor`/`governor`）永远面对同一组
//! `Sampler` 方法，因此降级路径与真实路径走完全相同的策略代码。

pub mod testing;

#[cfg(windows)]
#[path = "windows.rs"]
mod imp;
#[cfg(target_os = "linux")]
#[path = "linux.rs"]
mod imp;
#[cfg(not(any(windows, target_os = "linux")))]
#[path = "unsupported.rs"]
mod imp;

pub use testing::FakeSampler;

use crate::error::Result;
use crate::metrics::{Capabilities, ProcessUsage};

/// 采样内核。实现必须无阻塞长 IO、自行限幅，并且不持有跨采样状态。
pub trait Sampler: Send + Sync {
    fn capabilities(&self) -> &Capabilities;
    /// 单进程采样；进程已退出或权限不足时返回可恢复错误。
    fn sample_process(&self, pid: u32) -> Result<ProcessUsage>;
    /// 一次系统级 (pid, ppid) 快照，用来还原进程树。
    fn parent_map(&self) -> Result<Vec<(u32, u32)>>;
    /// 裁剪某个进程的工作集（只允许用于自有进程，数据不丢）。
    fn trim_working_set(&self, pid: u32) -> Result<()>;
}

/// 真实平台采样器；构造成本可忽略，可以长期持有。
#[derive(Debug, Clone)]
pub struct SystemSampler {
    capabilities: Capabilities,
}

impl SystemSampler {
    pub fn new() -> Self {
        Self {
            capabilities: imp::capabilities(),
        }
    }
}

impl Default for SystemSampler {
    fn default() -> Self {
        Self::new()
    }
}

impl Sampler for SystemSampler {
    fn capabilities(&self) -> &Capabilities {
        &self.capabilities
    }

    fn sample_process(&self, pid: u32) -> Result<ProcessUsage> {
        imp::sample_process(pid)
    }

    fn parent_map(&self) -> Result<Vec<(u32, u32)>> {
        imp::parent_map()
    }

    fn trim_working_set(&self, pid: u32) -> Result<()> {
        imp::trim_working_set(pid)
    }
}

/// 当前平台是否具备真实采样能力（只依据能力清单，不做探测 IO）。
pub fn is_supported() -> bool {
    SystemSampler::new().capabilities().resident.is_supported()
}
