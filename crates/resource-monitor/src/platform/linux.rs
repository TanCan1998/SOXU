//! Linux 采样实现（procfs）。
//!
//! 指标解释：
//! - resident = `/proc/<pid>/status` 的 VmRSS，等价于常说的 RSS，含共享页；
//! - private = `/proc/<pid>/smaps_rollup` 的 Private_Clean + Private_Dirty，不含共享页；
//!   读取该文件需要 PTRACE_MODE_READ 权限，读不到时返回 `None`（不估算、不猜）。
//! - 进程树 = `/proc/<pid>/stat` 的 ppid 字段。
//!
//! 已知限制：没有等价于 Windows `EmptyWorkingSet` 的「裁剪自有进程工作集」入口，
//! 因此 `trim_working_set` 显式降级为不支持（见 `docs/development/memory-budget.md`）。

use std::fs;
use std::io;

use crate::error::{ErrorCode, MonitorError, Result};
use crate::metrics::{Capabilities, MetricSupport, Platform, ProcessUsage};

pub(crate) fn capabilities() -> Capabilities {
    Capabilities {
        platform: Platform::Linux,
        resident: MetricSupport::Supported("/proc/<pid>/status VmRSS"),
        private: MetricSupport::Supported(
            "/proc/<pid>/smaps_rollup Private_Clean + Private_Dirty（需读权限，读不到时该进程置空）",
        ),
        process_tree: MetricSupport::Supported("/proc/<pid>/stat ppid"),
        trim_working_set: MetricSupport::Unsupported(
            "Linux 没有裁剪自有进程工作集的等价入口；madvise 需要逐段跟踪，未实现",
        ),
    }
}

pub(crate) fn sample_process(pid: u32) -> Result<ProcessUsage> {
    let status =
        fs::read_to_string(format!("/proc/{pid}/status")).map_err(|error| map_io(error, pid))?;
    let resident_bytes = status
        .lines()
        .find_map(|line| line.strip_prefix("VmRSS:"))
        .and_then(parse_kb)
        .ok_or_else(|| {
            MonitorError::new(
                ErrorCode::ProcessUnavailable,
                format!("VmRSS 缺失于 /proc/{pid}/status"),
            )
        })?;
    Ok(ProcessUsage {
        pid,
        resident_bytes,
        private_bytes: read_private_bytes(pid),
    })
}

/// smaps_rollup 只在有读权限时可用；读不到就返回 None，让聚合明确标记为「私有指标不完整」。
fn read_private_bytes(pid: u32) -> Option<u64> {
    let rollup = fs::read_to_string(format!("/proc/{pid}/smaps_rollup")).ok()?;
    let mut total = 0u64;
    let mut found = false;
    for line in rollup.lines() {
        let value = line
            .strip_prefix("Private_Clean:")
            .or_else(|| line.strip_prefix("Private_Dirty:"));
        if let Some(value) = value {
            total = total.saturating_add(parse_kb(value)?);
            found = true;
        }
    }
    found.then_some(total)
}

/// 解析形如 `1234 kB` 的 procfs 数值，统一成字节。
fn parse_kb(text: &str) -> Option<u64> {
    let digits = text.split_whitespace().next()?;
    let kb: u64 = digits.parse().ok()?;
    Some(kb.saturating_mul(1024))
}

pub(crate) fn parent_map() -> Result<Vec<(u32, u32)>> {
    let entries = fs::read_dir("/proc")
        .map_err(|error| MonitorError::io(ErrorCode::SnapshotFailed, "read_dir /proc", &error))?;
    let mut pairs = Vec::with_capacity(512);
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(pid) = name.to_str().and_then(|name| name.parse::<u32>().ok()) else {
            continue;
        };
        // 进程在我们遍历时退出是正常现象，跳过即可，不当成快照失败。
        let Ok(stat) = fs::read_to_string(format!("/proc/{pid}/stat")) else {
            continue;
        };
        if let Some(ppid) = parse_ppid(&stat) {
            pairs.push((pid, ppid));
        }
    }
    Ok(pairs)
}

/// stat 的第 4 个字段是 ppid；comm 允许空格与括号，所以从最后一个 ')' 之后开始数。
fn parse_ppid(stat: &str) -> Option<u32> {
    let after_comm = stat.rsplit_once(')')?.1;
    after_comm.split_whitespace().nth(1)?.parse().ok()
}

pub(crate) fn trim_working_set(_pid: u32) -> Result<()> {
    Err(MonitorError::new(
        ErrorCode::TrimUnsupported,
        capabilities().trim_working_set.reason(),
    ))
}

fn map_io(error: io::Error, pid: u32) -> MonitorError {
    let code = match error.kind() {
        io::ErrorKind::PermissionDenied => ErrorCode::PermissionDenied,
        io::ErrorKind::NotFound => ErrorCode::ProcessUnavailable,
        _ => ErrorCode::IoFailure,
    };
    MonitorError::io(code, format!("/proc/{pid}"), &error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process;

    #[test]
    fn samples_own_process() {
        let usage = sample_process(process::id()).expect("当前进程一定可采样");
        assert!(usage.resident_bytes > 0, "VmRSS 不应为 0");
    }

    #[test]
    fn parses_ppid_from_stat_with_spaces_in_comm() {
        let stat = "42 (node (worker) x) S 7 42 42 0 -1";
        assert_eq!(parse_ppid(stat), Some(7));
    }

    #[test]
    fn snapshot_contains_own_process() {
        let pairs = parent_map().expect("/proc 应可读");
        let own = process::id();
        assert!(pairs.iter().any(|(pid, _)| *pid == own));
    }

    #[test]
    fn missing_process_is_recoverable() {
        let error = sample_process(u32::MAX).unwrap_err();
        assert!(error.recoverable());
    }

    #[test]
    fn trim_is_reported_unsupported() {
        let error = trim_working_set(process::id()).unwrap_err();
        assert_eq!(error.code(), ErrorCode::TrimUnsupported);
    }
}
