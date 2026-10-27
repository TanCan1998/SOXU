//! 未实现平台的降级实现（当前包括 macOS）。
//!
//! 降级的语义是「明确说不知道」，不是「假装是 0」：
//! - 采样返回 `E_PLATFORM_UNSUPPORTED`，聚合不会得到任何数字；
//! - 预算判定因此不会产生释放动作（见 governor：采样失败一律不释放）；
//! - 上层仍可展示降级原因，让用户知道当前平台没有内存诊断。

use crate::error::{ErrorCode, MonitorError, Result};
use crate::metrics::{Capabilities, MetricSupport, Platform, ProcessUsage};

const TRIM_REASON: &str = "没有裁剪自有进程工作集的等价入口";
const NO_PROC: &str =
    "该平台没有实现进程树采样（macOS 需要 libproc/proc_pidinfo，尚未实现且有实机验证门槛）";

pub(crate) fn capabilities() -> Capabilities {
    Capabilities {
        platform: Platform::current(),
        resident: MetricSupport::Unsupported(NO_PROC),
        private: MetricSupport::Unsupported(NO_PROC),
        process_tree: MetricSupport::Unsupported(NO_PROC),
        trim_working_set: MetricSupport::Unsupported(TRIM_REASON),
    }
}

pub(crate) fn sample_process(_pid: u32) -> Result<ProcessUsage> {
    Err(unsupported("sample_process"))
}

pub(crate) fn parent_map() -> Result<Vec<(u32, u32)>> {
    Err(unsupported("parent_map"))
}

pub(crate) fn trim_working_set(_pid: u32) -> Result<()> {
    Err(MonitorError::with_detail(
        ErrorCode::TrimUnsupported,
        "trim_working_set",
        TRIM_REASON,
    ))
}

fn unsupported(operation: &str) -> MonitorError {
    MonitorError::with_detail(
        ErrorCode::PlatformUnsupported,
        operation,
        format!("platform={}", Platform::current().as_str()),
    )
}
