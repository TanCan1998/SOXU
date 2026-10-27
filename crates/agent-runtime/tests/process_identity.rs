//! 资源监控集成点验收：受管运行时必须给出可采样的进程树根 PID 与可靠的活动状态。
//!
//! 这一层是 TASK-004 与 TASK-001 的接缝：`soxu-resource-monitor` 不依赖本 crate，
//! 由上层把 `PiSupervisor::processes()` 映射成监控 `Target`。因此必须保证
//! PID 真实、唯一，且「执行中」不会被误判成「空闲」。

mod support;

use soxu_agent_runtime::{PiSupervisor, RuntimeState, SupervisorConfig};
use support::fake_pi;

fn supervisor() -> PiSupervisor {
    PiSupervisor::new(SupervisorConfig::fast())
}

#[tokio::test]
async fn managed_runtimes_expose_distinct_samplable_pids() {
    let supervisor = supervisor();
    let idle = supervisor
        .start("session-idle", &fake_pi("ok", "idle"))
        .await
        .expect("启动空闲运行时");
    let mut busy = supervisor
        .start("session-busy", &fake_pi("slow", "busy"))
        .await
        .expect("启动忙碌运行时");

    let processes = supervisor.processes();
    assert_eq!(processes.len(), 2);
    let mut pids: Vec<u32> = processes
        .iter()
        .map(|process| process.pid.expect("受管运行时必须给出 PID"))
        .collect();
    pids.sort_unstable();
    pids.dedup();
    assert_eq!(pids.len(), 2, "两个运行时不能共用同一个 PID");
    assert!(
        processes
            .iter()
            .all(|process| process.is_samplable() && process.is_idle())
    );

    // handle 与 processes() 必须指向同一个进程，诊断快照也要带上 PID。
    let idle_pid = idle.pid().expect("handle 必须给出 PID");
    assert_eq!(idle.diagnostics().pid, Some(idle_pid));
    let from_supervisor = processes
        .iter()
        .find(|process| process.identity.runtime_id == idle.identity().runtime_id)
        .expect("进程视图里必须有这个 runtime");
    assert_eq!(from_supervisor.pid, Some(idle_pid));

    // 进入执行态后，监控侧必须看到「可能在忙」，不能把它当空闲候选。
    busy.prompt("执行一个长任务")
        .await
        .expect("prompt 应被接受");
    assert_eq!(busy.state(), RuntimeState::Running);
    let processes = supervisor.processes();
    let busy_view = processes
        .iter()
        .find(|process| process.identity.runtime_id == busy.identity().runtime_id)
        .expect("忙碌运行时仍在受管集合里");
    assert_eq!(busy_view.state, RuntimeState::Running);
    assert!(busy_view.may_be_busy());
    assert!(!busy_view.is_idle(), "执行中的 runtime 不得被当作空闲");
    assert_eq!(
        processes
            .iter()
            .find(|process| process.identity.runtime_id == idle.identity().runtime_id)
            .map(|process| process.state),
        Some(RuntimeState::Idle)
    );

    // 释放（优雅停止）后立刻从监控集合里消失，PID 不会留在诊断里冒充活跃进程。
    let exit = busy.stop().await.expect("优雅停止应成功");
    assert!(exit.code.is_some(), "夹具应以退出码结束：{exit:?}");
    let processes = supervisor.processes();
    assert_eq!(processes.len(), 1, "停止后只剩一个受管进程");
    assert!(
        processes
            .iter()
            .all(|process| process.identity.runtime_id != busy.identity().runtime_id)
    );

    supervisor.shutdown().await;
    assert!(supervisor.processes().is_empty(), "关闭后不应残留受管进程");
    assert!(idle.state().is_terminal());
}
