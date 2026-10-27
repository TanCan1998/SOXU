//! Windows 采样实现（Win32 psapi + Toolhelp32）。
//!
//! 指标解释：
//! - resident = `PROCESS_MEMORY_COUNTERS_EX.WorkingSetSize`：工作集，含共享页与可被系统
//!   回收的 standby 页，会随系统压力波动；
//! - private = `PROCESS_MEMORY_COUNTERS_EX.PrivateUsage`：私有提交（commit），不含共享页，
//!   是「SOXU 让这台机器多用了多少」的解释口径；
//! - 进程树 = 单次 Toolhelp32 快照的 parent PID 关系。
//!
//! 已知误差：快照与逐进程采样不是同一瞬间；采样期间新退出/新建的进程会体现在
//! `missing_processes` 里。理论上 PID 复用会让新进程被当成旧进程的子进程，但快照是按
//! 父 PID 关系一次性取回的，误判窗口只有一个采样周期，且不会导致任何释放动作。

use std::io;
use std::mem::size_of;
use std::process;

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::ProcessStatus::{
    EmptyWorkingSet, GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX,
};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_QUOTA,
};

use crate::error::{ErrorCode, MonitorError, Result};
use crate::metrics::{Capabilities, MetricSupport, Platform, ProcessUsage};

const ERROR_ACCESS_DENIED: i32 = 5;
const ERROR_INVALID_PARAMETER: i32 = 87;

/// 句柄唯一 owner：任何返回路径都会 CloseHandle，采样失败也不泄漏句柄。
struct OwnedHandle(HANDLE);

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        // SAFETY: 句柄由 OpenProcess/CreateToolhelp32Snapshot 成功返回，且只在这里关闭一次。
        unsafe {
            CloseHandle(self.0);
        }
    }
}

/// 打开进程并在闭包内使用句柄；当前进程用伪句柄，不能（也不需要）关闭。
fn with_process<R>(pid: u32, access: u32, action: impl FnOnce(HANDLE) -> Result<R>) -> Result<R> {
    if pid == process::id() {
        // SAFETY: GetCurrentProcess 返回伪句柄，始终有效，且不得 CloseHandle。
        return action(unsafe { GetCurrentProcess() });
    }
    // SAFETY: 参数来自公开 Win32 契约，失败返回空句柄。
    let raw = unsafe { OpenProcess(access, 0, pid) };
    if raw.is_null() {
        return Err(map_last_error(pid));
    }
    let guard = OwnedHandle(raw);
    action(guard.0)
}

fn map_last_error(pid: u32) -> MonitorError {
    let error = io::Error::last_os_error();
    let code = match error.raw_os_error() {
        Some(ERROR_ACCESS_DENIED) => ErrorCode::PermissionDenied,
        Some(ERROR_INVALID_PARAMETER) => ErrorCode::ProcessUnavailable,
        _ => ErrorCode::ProcessUnavailable,
    };
    MonitorError::io(code, format!("OpenProcess(pid={pid})"), &error)
}

pub(crate) fn capabilities() -> Capabilities {
    Capabilities {
        platform: Platform::Windows,
        resident: MetricSupport::Supported("Win32 WorkingSetSize (psapi GetProcessMemoryInfo)"),
        private: MetricSupport::Supported("Win32 PrivateUsage commit (PROCESS_MEMORY_COUNTERS_EX)"),
        process_tree: MetricSupport::Supported("Toolhelp32 snapshot parent PID"),
        trim_working_set: MetricSupport::Supported(
            "psapi EmptyWorkingSet（仅用于自有进程，可随时重读）",
        ),
    }
}

pub(crate) fn sample_process(pid: u32) -> Result<ProcessUsage> {
    with_process(pid, PROCESS_QUERY_LIMITED_INFORMATION, |handle| {
        // SAFETY: PROCESS_MEMORY_COUNTERS_EX 是 POD，全零是合法初始状态（cb 随后填写）。
        let mut counters: PROCESS_MEMORY_COUNTERS_EX = unsafe { std::mem::zeroed() };
        counters.cb = size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32;
        // SAFETY: 句柄有 QUERY_LIMITED_INFORMATION 权限；EX 结构以 PROCESS_MEMORY_COUNTERS
        // 前缀开头，按 cb 传长度是 psapi 的既有用法。
        let ok = unsafe {
            GetProcessMemoryInfo(
                handle,
                &mut counters as *mut PROCESS_MEMORY_COUNTERS_EX as *mut PROCESS_MEMORY_COUNTERS,
                counters.cb,
            )
        };
        if ok == 0 {
            return Err(MonitorError::io(
                ErrorCode::ProcessUnavailable,
                format!("GetProcessMemoryInfo(pid={pid})"),
                &io::Error::last_os_error(),
            ));
        }
        Ok(ProcessUsage {
            pid,
            resident_bytes: counters.WorkingSetSize as u64,
            private_bytes: Some(counters.PrivateUsage as u64),
        })
    })
}

pub(crate) fn parent_map() -> Result<Vec<(u32, u32)>> {
    // SAFETY: 传 0 表示当前进程，返回快照句柄或 INVALID_HANDLE_VALUE。
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(MonitorError::io(
            ErrorCode::SnapshotFailed,
            "CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS)",
            &io::Error::last_os_error(),
        ));
    }
    let guard = OwnedHandle(snapshot);
    let mut entry = PROCESSENTRY32W {
        dwSize: size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    let mut pairs = Vec::with_capacity(256);
    // SAFETY: 每次调用都会写回 entry；dwSize 已按结构大小设置，循环在返回 0 时结束。
    let mut ok = unsafe { Process32FirstW(guard.0, &mut entry) };
    while ok != 0 {
        if entry.th32ProcessID != 0 {
            pairs.push((entry.th32ProcessID, entry.th32ParentProcessID));
        }
        // SAFETY: 同上，entry 复用是 psapi 文档支持的用法。
        ok = unsafe { Process32NextW(guard.0, &mut entry) };
    }
    Ok(pairs)
}

pub(crate) fn trim_working_set(pid: u32) -> Result<()> {
    with_process(
        pid,
        PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SET_QUOTA,
        |handle| {
            // SAFETY: EmptyWorkingSet 只是把页移出工作集，数据仍然有效，不会丢状态。
            let ok = unsafe { EmptyWorkingSet(handle) };
            if ok == 0 {
                return Err(MonitorError::io(
                    ErrorCode::TrimUnsupported,
                    format!("EmptyWorkingSet(pid={pid})"),
                    &io::Error::last_os_error(),
                ));
            }
            Ok(())
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn samples_own_process_with_both_metrics() {
        let usage = sample_process(process::id()).expect("当前进程一定可采样");
        assert!(usage.resident_bytes > 0, "工作集不应为 0");
        assert!(usage.private_bytes.unwrap_or(0) > 0, "私有提交不应为 0");
    }

    #[test]
    fn snapshot_contains_own_process_and_parents() {
        let pairs = parent_map().expect("进程快照应可用");
        let own = process::id();
        let entry = pairs
            .iter()
            .find(|(pid, _)| *pid == own)
            .expect("快照必须包含当前进程");
        assert_ne!(entry.1, own, "当前进程的父进程不应是自己");
    }

    #[test]
    fn missing_process_reports_recoverable_error() {
        // 0 号 PID 是 System Idle，普通权限打不开，必定失败。
        let error = sample_process(0).unwrap_err();
        assert!(error.recoverable());
        assert!(matches!(
            error.code(),
            ErrorCode::ProcessUnavailable | ErrorCode::PermissionDenied
        ));
    }
}
