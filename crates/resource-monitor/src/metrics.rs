//! 指标语义：每个数字都带平台解释，避免跨平台误读。
//!
//! 两个主指标刻意不做「统一改名」：
//! - `resident_bytes`：Windows WorkingSetSize / Linux VmRSS。含共享页与可被系统裁剪的页，
//!   因此会随系统压力波动，用来做实时压力判定。
//! - `private_bytes`：Windows PROCESS_MEMORY_COUNTERS_EX.PrivateUsage（私有提交）/
//!   Linux smaps_rollup 的 Private_Clean + Private_Dirty。不含共享页，用来解释「这台机器
//!   因 SOXU 增加了多少不可共享内存」，也是 P-07 资源比较应公布的数字。

use std::time::Duration;

/// 采样来源平台。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Windows,
    Linux,
    MacOs,
    Other,
}

impl Platform {
    pub const fn current() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else if cfg!(target_os = "linux") {
            Self::Linux
        } else if cfg!(target_os = "macos") {
            Self::MacOs
        } else {
            Self::Other
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Windows => "windows",
            Self::Linux => "linux",
            Self::MacOs => "macos",
            Self::Other => "other",
        }
    }
}

/// 单个指标的可用性：可用时必须附带「这个数字来自哪里」。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MetricSupport {
    Supported(&'static str),
    Unsupported(&'static str),
}

impl MetricSupport {
    pub const fn is_supported(self) -> bool {
        matches!(self, Self::Supported(_))
    }

    /// 来源说明（可用）或不可用原因（不可用）。
    pub const fn reason(self) -> &'static str {
        match self {
            Self::Supported(source) | Self::Unsupported(source) => source,
        }
    }
}

/// 平台能力清单；降级处理以此为唯一依据。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Capabilities {
    pub platform: Platform,
    pub resident: MetricSupport,
    pub private: MetricSupport,
    pub process_tree: MetricSupport,
    pub trim_working_set: MetricSupport,
}

impl Capabilities {
    pub fn has_private(&self) -> bool {
        self.private.is_supported()
    }

    pub fn has_tree(&self) -> bool {
        self.process_tree.is_supported()
    }

    /// 需要展示给用户的降级项；顺序稳定，便于断言与日志比对。
    pub fn degradation(&self) -> Vec<Degradation> {
        let entries = [
            ("resident_bytes", self.resident),
            ("private_bytes", self.private),
            ("process_tree", self.process_tree),
            ("trim_working_set", self.trim_working_set),
        ];
        entries
            .into_iter()
            .filter(|(_, support)| !support.is_supported())
            .map(|(metric, support)| Degradation {
                metric: metric.to_owned(),
                detail: support.reason().to_owned(),
            })
            .collect()
    }
}

/// 一条降级说明：哪个指标不可用、为什么。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Degradation {
    pub metric: String,
    pub detail: String,
}

/// 单进程采样结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessUsage {
    pub pid: u32,
    pub resident_bytes: u64,
    /// 平台不支持私有提交时为 `None`，不做估算。
    pub private_bytes: Option<u64>,
}

/// 一棵进程树的聚合结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TreeUsage {
    pub root_pid: u32,
    /// 参与聚合的进程数（含 root，不含被排除的子树）。
    pub processes: usize,
    pub resident_bytes: u64,
    /// 只要有一个进程拿不到私有提交，聚合值就是 `None`（不拿部分值冒充全量）。
    pub private_bytes: Option<u64>,
    /// 采样时已退出/无权限的进程数；>0 表示这次聚合不完整。
    pub missing_processes: usize,
    /// 本次采样的实际开销，用于验证采样本身不成为负担。
    pub sample_cost: Duration,
}

impl TreeUsage {
    pub fn is_complete(&self) -> bool {
        self.missing_processes == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn caps(private: MetricSupport) -> Capabilities {
        Capabilities {
            platform: Platform::Other,
            resident: MetricSupport::Supported("test-resident"),
            private,
            process_tree: MetricSupport::Supported("test-tree"),
            trim_working_set: MetricSupport::Unsupported("no trim"),
        }
    }

    #[test]
    fn degradation_lists_only_unsupported_metrics() {
        let list = caps(MetricSupport::Unsupported("no private")).degradation();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].metric, "private_bytes");
        assert_eq!(list[1].metric, "trim_working_set");
    }

    #[test]
    fn fully_supported_has_no_degradation() {
        let capabilities = Capabilities {
            platform: Platform::Other,
            resident: MetricSupport::Supported("test-resident"),
            private: MetricSupport::Supported("test-private"),
            process_tree: MetricSupport::Supported("test-tree"),
            trim_working_set: MetricSupport::Supported("test-trim"),
        };
        assert!(capabilities.degradation().is_empty());
    }

    #[test]
    fn platform_names_are_stable() {
        assert_eq!(Platform::current().as_str(), Platform::current().as_str());
    }
}
