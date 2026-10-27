//! Session/generation 隔离集成测试：两个独立会话不得串线，
//! 同一会话重复启动后旧 generation 的迟到事件必须被丢弃。
mod support;

use std::time::{Duration, Instant};

use soxu_agent_runtime::{PiSupervisor, RuntimeState, SupervisorConfig, SupervisorError};
use support::{agent_kinds, fake_pi, session_labels, settle};

fn supervisor() -> PiSupervisor {
    PiSupervisor::new(SupervisorConfig::fast())
}

#[tokio::test]
async fn independent_sessions_never_cross_wire_events() {
    let supervisor = supervisor();
    let mut first = supervisor
        .start("session-a", &fake_pi("chatty", "a"))
        .await
        .unwrap();
    let mut second = supervisor
        .start("session-b", &fake_pi("chatty", "b"))
        .await
        .unwrap();
    assert_ne!(
        first.identity().runtime_id,
        second.identity().runtime_id,
        "每个会话必须有独立的运行进程"
    );

    first.prompt("for a").await.unwrap();
    second.prompt("for b").await.unwrap();

    let first_events = settle(&mut first, Duration::from_secs(10)).await;
    let second_events = settle(&mut second, Duration::from_secs(10)).await;

    assert!(agent_kinds(&first_events).len() >= 40);
    assert!(agent_kinds(&second_events).len() >= 40);
    let first_labels = session_labels(&first_events);
    let second_labels = session_labels(&second_events);
    assert!(
        first_labels.iter().all(|label| label == "a"),
        "{first_labels:?}"
    );
    assert!(
        second_labels.iter().all(|label| label == "b"),
        "{second_labels:?}"
    );

    // 两个会话都退出后，各自的退出事件不会被对方观察。
    let first_exit = first.stop().await.unwrap();
    let second_exit = second.stop().await.unwrap();
    assert_eq!(first_exit.reason.as_str(), "child_exited");
    assert_eq!(second_exit.reason.as_str(), "child_exited");
    supervisor.shutdown().await;
}

#[tokio::test]
async fn late_events_of_a_replaced_generation_are_dropped() {
    let supervisor = supervisor();
    let mut old = supervisor
        .start("session-gen", &fake_pi("chatty", "old"))
        .await
        .unwrap();
    old.prompt("turn 1").await.unwrap();
    let first_event = old.recv_timeout(Duration::from_secs(3)).await.unwrap();
    assert!(first_event.is_some(), "旧运行时必须真的在流式输出");

    let mut new = supervisor
        .start("session-gen", &fake_pi("ok", "new"))
        .await
        .unwrap();
    assert_eq!(new.identity().generation, old.identity().generation + 1);

    // 旧 handle 之后只能拿到 Superseded，不能再交出任何旧事件。
    let error = old.recv_timeout(Duration::from_secs(3)).await.unwrap_err();
    assert!(
        matches!(error, SupervisorError::Superseded { active_generation, .. } if active_generation == 2),
        "unexpected error: {error:?}"
    );
    assert_eq!(old.recv().await, Ok(None), "被取代后事件流必须关闭");
    assert!(old.recv().await.is_ok());

    // 新 generation 正常完成，且事件只带新标记。
    new.prompt("turn 2").await.unwrap();
    let events = settle(&mut new, Duration::from_secs(5)).await;
    assert_eq!(agent_kinds(&events), ["agent_start"]);
    assert!(
        session_labels(&events).iter().all(|label| label == "new"),
        "旧会话事件泄漏到新会话: {:?}",
        session_labels(&events)
    );
    supervisor.shutdown().await;
}

#[tokio::test]
async fn restarting_a_session_reclaims_the_previous_process() {
    let supervisor = supervisor();
    let first = supervisor
        .start("session-restart", &fake_pi("ok", "r1"))
        .await
        .unwrap();
    let previous_runtime = first.identity().runtime_id.clone();
    let mut second = supervisor
        .start("session-restart", &fake_pi("ok", "r2"))
        .await
        .unwrap();
    assert_ne!(second.identity().runtime_id, previous_runtime);

    // 旧进程由后台任务回收；等待期间不得出现两个同一会话的运行记录。
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let identities = supervisor.active_identities();
        if identities.len() == 1 && identities[0].runtime_id == second.identity().runtime_id {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "旧运行时没有被回收: {identities:?}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(
        supervisor.runtime_state(&previous_runtime),
        Some(RuntimeState::Exited)
    );
    assert_eq!(
        supervisor.runtime_state(&second.identity().runtime_id),
        Some(RuntimeState::Idle)
    );

    let exit = second.stop().await.unwrap();
    assert_eq!(exit.reason.as_str(), "child_exited");
    assert!(
        supervisor
            .shutdown()
            .await
            .iter()
            .all(|(_, outcome)| outcome.is_ok())
    );
    assert!(supervisor.is_empty());

    // 旧 handle 的公开接口不会挂起：要么已被取代，要么事件流已结束。
    let mut first = first;
    assert!(matches!(
        first.recv().await,
        Ok(None) | Err(SupervisorError::Superseded { .. })
    ));
}
