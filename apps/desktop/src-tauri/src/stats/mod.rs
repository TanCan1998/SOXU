//! 会话统计（Issue #119 / TASK-027）：session_stats 命令的业务层。
//!
//! 数据来源只有两处，**不新增任何轮询**：
//!
//! 1. **已有事件流**：driver 在消费 supervisor 事件的同一条路径上顺手累加
//!    （StatsStore），因此浮窗里的轮次/首 token/耗时/速度/缓存命中与消息流同源；
//! 2. **runtime_status**：执行身份与重试预算（持久化记录，不由事件推导）。
//!
//! 进程资源是**按需单次采样**（用户打开浮窗时），不是后台定时器：
//! docs/product/prd.md 的 P-07 要求低资源占用，多一个常驻采样线程就等于多一份成本。
//!
//! 进程采样复用 soxu-resource-monitor（与内存预算同一套平台实现），
//! 口径见 docs/development/memory-budget.md。

mod accumulator;
mod store;
mod usage;

pub use accumulator::StatsSnapshot;
pub use store::{DEFAULT_CAPACITY, StatsStore};
pub use usage::{UsageSample, has_text_delta, parse_context_window, parse_usage};

use std::time::Instant;

use soxu_resource_monitor::collect_tree;
use soxu_resource_monitor::platform::SystemSampler;
use soxu_resource_monitor::{Sampler, TreeUsage};
use soxu_session_index::SessionId;

use crate::dto::{
    ContextStats, ProcessStats, RuntimeStatus, SessionStats, SessionStatsInfo, TurnStats,
};
use crate::session_runtime;
use crate::state::{AppState, lock};

/// 采样降级时给界面的稳定标识（前端据此显示说明，不显示假数字）。
pub const DEGRADED_RUNTIME_NOT_RUNNING: &str = "runtime_not_running";
pub const DEGRADED_SAMPLE_FAILED: &str = "process_sample_failed";
pub const DEGRADED_PARTIAL_TREE: &str = "process_tree_partial";
pub const DEGRADED_CPU_UNSUPPORTED: &str = "cpu_unsupported";

/// 采集一个会话的统计快照。
pub async fn collect(state: &AppState, session_id: &str) -> Result<SessionStats, String> {
    let session_id = session_id.trim();
    if session_id.is_empty() {
        return Err("sessionId 不能为空".to_owned());
    }
    let now = Instant::now();
    let runtime = session_runtime::status(state, session_id).await;
    let (snapshot, updated_at_ms) = {
        let store = lock(&state.stats);
        match store.snapshot(session_id, now) {
            Some(snapshot) => {
                let updated = snapshot.updated_at.map(|at| store.wall_ms(at));
                (snapshot, updated)
            }
            None => (StatsSnapshot::default(), None),
        }
    };
    let (entries_total, worktree) = session_identity(state, session_id).await;
    let process = sample_process(state, runtime.as_ref()).await;

    Ok(SessionStats {
        session_id: session_id.to_owned(),
        runtime_id: runtime.as_ref().map(|status| status.runtime_id.clone()),
        generation: runtime.as_ref().map(|status| status.generation),
        context: ContextStats {
            used: snapshot.context_used,
            total: snapshot.context_total,
            percent: snapshot.context_percent,
        },
        turn: TurnStats {
            turns: snapshot.turns,
            in_flight: snapshot.in_flight,
            first_token_ms: snapshot.first_token_ms,
            duration_ms: snapshot.duration_ms,
            stream_tokens_per_sec: snapshot.stream_tokens_per_sec,
            avg_tokens_per_sec: snapshot.avg_tokens_per_sec,
            cache_hit_pct: snapshot.cache_hit_pct,
        },
        process,
        session: SessionStatsInfo {
            entries_total,
            worktree,
            input_tokens: snapshot.input_tokens,
            output_tokens: snapshot.output_tokens,
            // 预算来自持久化记录（唯一真源），与 runtime_status 完全一致。
            retry: runtime.and_then(|status| status.retry),
        },
        updated_at_ms,
    })
}

/// 会话身份信息：条目总数与所属工作树路径。临时会话/未登记返回 (None, None)。
async fn session_identity(state: &AppState, session_id: &str) -> (Option<u64>, Option<String>) {
    let session = SessionId::new(session_id);
    let catalog = state.catalog.lock().await;
    for project in catalog.projects() {
        let Some(record) = project.session(&session) else {
            continue;
        };
        // 工作树路径比 id 可读；索引里查不到时退回 id，不编造路径。
        let worktree = project
            .worktree(&record.worktree)
            .map(|worktree| worktree.path.clone())
            .unwrap_or_else(|| record.worktree.to_string());
        return (Some(record.entry_count as u64), Some(worktree));
    }
    (None, None)
}

/// 对受管 Pi 进程树做一次采样（不轮询）。
///
/// 采样是若干次系统调用，放到 spawn_blocking 里，避免在异步线程上做可能阻塞的枚举
/// （Windows 的进程快照、Linux 的 /proc 遍历）。
async fn sample_process(state: &AppState, runtime: Option<&RuntimeStatus>) -> ProcessStats {
    let Some(runtime) = runtime else {
        return ProcessStats {
            degraded: vec![DEGRADED_RUNTIME_NOT_RUNNING.to_owned()],
            ..ProcessStats::default()
        };
    };
    let pid = state
        .supervisor
        .processes()
        .into_iter()
        .find(|process| process.identity.runtime_id == runtime.runtime_id && process.is_samplable())
        .and_then(|process| process.pid);
    let Some(pid) = pid else {
        // 运行时已登记但没有可采样的进程（正在退出/已退出）：如实降级。
        return ProcessStats {
            degraded: vec![DEGRADED_RUNTIME_NOT_RUNNING.to_owned()],
            ..ProcessStats::default()
        };
    };

    let sampled = tauri::async_runtime::spawn_blocking(move || sample_tree(pid))
        .await
        .unwrap_or_else(|error| Err(format!("采样任务失败：{error}")));

    match sampled {
        Ok(tree) => {
            let mut degraded = Vec::new();
            if !tree.is_complete() {
                degraded.push(DEGRADED_PARTIAL_TREE.to_owned());
            }
            // 当前平台的采样器不提供 CPU 占用：如实说明，不编造 0%。
            degraded.push(DEGRADED_CPU_UNSUPPORTED.to_owned());
            ProcessStats {
                rss_mb: Some(round1(tree.resident_bytes as f64 / 1_048_576.0)),
                cpu_pct: None,
                child_count: Some(u32::try_from(tree.processes.saturating_sub(1)).unwrap_or(0)),
                degraded,
            }
        }
        Err(detail) => ProcessStats {
            degraded: vec![DEGRADED_SAMPLE_FAILED.to_owned(), detail],
            ..ProcessStats::default()
        },
    }
}

/// 同步采样进程树：root 进程已退出时返回错误（不拿 0 冒充成功）。
fn sample_tree(root_pid: u32) -> Result<TreeUsage, String> {
    let sampler = SystemSampler::new();
    if !sampler.capabilities().resident.is_supported() {
        return Err(format!(
            "当前平台不支持内存采样：{}",
            sampler.capabilities().resident.reason()
        ));
    }
    let parents = sampler.parent_map().map_err(|error| error.to_string())?;
    let pids = collect_tree(root_pid, &parents, &[]);
    if pids.is_empty() {
        return Err(format!("进程树 {root_pid} 不存在"));
    }
    let started = Instant::now();
    // 根进程拿不到就说明这棵树已经不存在：报错，而不是拿 0 MB 冒充成功。
    let root = sampler
        .sample_process(root_pid)
        .map_err(|error| format!("进程 {root_pid} 采样失败：{error}"))?;
    let mut resident_bytes = root.resident_bytes;
    let mut missing_processes = 0usize;
    for pid in pids.iter().filter(|pid| **pid != root_pid) {
        match sampler.sample_process(*pid) {
            Ok(usage) => resident_bytes = resident_bytes.saturating_add(usage.resident_bytes),
            Err(_) => missing_processes += 1,
        }
    }
    Ok(TreeUsage {
        root_pid,
        processes: pids.len(),
        resident_bytes,
        // 本命令不展示私有提交；保持 None，避免把部分值冒充全量。
        private_bytes: None,
        missing_processes,
        sample_cost: started.elapsed(),
    })
}

fn round1(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sampling_a_missing_process_reports_an_error_instead_of_zero() {
        // 用一个几乎不可能存在的 PID：必须报错，不能返回 0 MB。
        let result = sample_tree(u32::MAX - 7);
        assert!(result.is_err(), "不存在的进程树不能采样成功");
    }

    #[test]
    fn sampling_the_current_process_tree_reports_real_memory() {
        // 支持采样的平台上，采样「当前测试进程」必须成功且给出非零常驻内存：
        // 这条用例把 collect_tree + sample_process 的真实调用链跑通，
        // 而不是只验证几个数字的加减。
        let sampler = SystemSampler::new();
        if !sampler.capabilities().resident.is_supported() {
            return; // macOS 等未实现平台：如实跳过（对应实现会返回降级说明）。
        }
        let tree = sample_tree(std::process::id()).expect("当前进程树必须可采样");
        assert_eq!(tree.root_pid, std::process::id());
        assert!(tree.processes >= 1, "至少包含根进程");
        assert!(tree.resident_bytes > 0, "常驻内存不可能为 0");
    }
}
