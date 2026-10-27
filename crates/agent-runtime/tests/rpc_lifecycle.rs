//! 生命周期集成测试：真实子进程 + NDJSON 管道，覆盖握手、粘包/拆包、并发关联、
//! 超时、取消、异常退出、诊断脱敏与重复启动。
mod support;

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use soxu_agent_runtime::{
    PiCommand, PiSupervisor, RuntimeState, SupervisorConfig, SupervisorError, SupervisorEvent,
};
use support::{agent_kinds, fake_pi, settle};

fn supervisor() -> PiSupervisor {
    PiSupervisor::new(SupervisorConfig::fast())
}

fn brief_wait() -> Duration {
    Duration::from_secs(5)
}

/// fragment 夹具按 2 字节切片写出，需要比 fast 更宽的响应预算。
fn fragment_supervisor() -> PiSupervisor {
    PiSupervisor::new(SupervisorConfig {
        response_timeout: Duration::from_secs(3),
        ..SupervisorConfig::fast()
    })
}

#[tokio::test]
async fn handshake_reports_idle_and_rejects_empty_session() {
    let supervisor = supervisor();
    let error = supervisor
        .start("   ", &fake_pi("ok", "x"))
        .await
        .unwrap_err();
    assert_eq!(error, SupervisorError::EmptySessionId);
    assert!(supervisor.is_empty(), "被拒绝的启动不能留下运行记录");

    let handle = supervisor
        .start("session-handshake", &fake_pi("ok", "h"))
        .await
        .expect("handshake with fake pi");
    assert_eq!(handle.state(), RuntimeState::Idle);
    assert_eq!(handle.identity().generation, 1);
    assert!(
        handle
            .identity()
            .runtime_id
            .starts_with("session-handshake#")
    );
    assert!(handle.get_state().await.unwrap().success);
    assert!(
        supervisor
            .shutdown()
            .await
            .iter()
            .all(|(_, outcome)| outcome.is_ok())
    );
    assert!(supervisor.is_empty());
}

#[tokio::test]
async fn coalesced_and_fragmented_frames_round_trip() {
    let supervisor = fragment_supervisor();
    let mut handle = supervisor
        .start("session-framing", &fake_pi("fragment", "框架"))
        .await
        .unwrap();
    let response = handle.prompt("你好\n第二行").await.unwrap();
    assert!(response.success);
    assert_eq!(
        response.data.as_ref().unwrap()["sessionId"],
        serde_json::json!("框架"),
        "跨读取边界的多字节字符必须完整还原"
    );
    let events = settle(&mut handle, brief_wait()).await;
    assert_eq!(agent_kinds(&events), ["agent_start"]);
    assert_eq!(
        handle.diagnostics().pending_requests,
        0,
        "粘包/拆包不能留下未关联的 response"
    );
    let exit = handle.stop().await.unwrap();
    assert_eq!(exit.reason.as_str(), "child_exited");
    supervisor.shutdown().await;
}

#[tokio::test]
async fn concurrent_requests_are_correlated_by_id_not_arrival_order() {
    let supervisor = supervisor();
    let handle = supervisor
        .start("session-concurrent", &fake_pi("reverse", "c"))
        .await
        .unwrap();

    // reverse 模式先收到的命令后回复，两个 future 必须各自拿到自己的 response。
    let order = Arc::new(Mutex::new(Vec::<&'static str>::new()));
    let (state_order, prompt_order) = (order.clone(), order.clone());
    let state_future = async {
        let response = handle
            .request(
                PiCommand::GetState {
                    id: "fixed-state".into(),
                },
                brief_wait(),
            )
            .await;
        state_order.lock().unwrap().push("state");
        response
    };
    let prompt_future = async {
        let response = handle
            .request(
                PiCommand::Prompt {
                    id: "fixed-prompt".into(),
                    message: "hi".into(),
                },
                brief_wait(),
            )
            .await;
        prompt_order.lock().unwrap().push("prompt");
        response
    };
    let (state, prompt) = tokio::join!(state_future, prompt_future);

    assert_eq!(
        order.lock().unwrap().as_slice(),
        ["prompt", "state"],
        "夹具必须真的乱序回复，否则本用例没有证明力"
    );
    let state = state.unwrap();
    assert_eq!(state.id, "fixed-state");
    assert_eq!(state.command.as_deref(), Some("get_state"));
    let prompt = prompt.unwrap();
    assert_eq!(prompt.id, "fixed-prompt");
    assert_eq!(prompt.command.as_deref(), Some("prompt"));
    supervisor.shutdown().await;
}

#[tokio::test]
async fn duplicate_request_id_is_rejected_without_dropping_the_in_flight_request() {
    let supervisor = supervisor();
    let handle = supervisor
        .start("session-duplicate", &fake_pi("noreply", "d"))
        .await
        .unwrap();

    let in_flight = async {
        handle
            .request(
                PiCommand::Prompt {
                    id: "same-id".into(),
                    message: "first".into(),
                },
                Duration::from_millis(400),
            )
            .await
    };
    let duplicate = async {
        tokio::time::sleep(Duration::from_millis(50)).await;
        handle
            .request(
                PiCommand::Prompt {
                    id: "same-id".into(),
                    message: "second".into(),
                },
                Duration::from_millis(400),
            )
            .await
    };
    let (in_flight, duplicate) = tokio::join!(in_flight, duplicate);

    assert_eq!(
        duplicate.unwrap_err(),
        SupervisorError::DuplicateRequestId {
            request_id: "same-id".into()
        }
    );
    assert!(
        matches!(
            in_flight.unwrap_err(),
            SupervisorError::ResponseTimeout { .. }
        ),
        "重复 id 不能顶掉在途请求"
    );
    assert_eq!(handle.diagnostics().pending_requests, 0);
    supervisor.shutdown().await;
}

#[tokio::test]
async fn timeout_then_stop_then_restart_stays_consistent() {
    let supervisor = supervisor();
    let mut handle = supervisor
        .start("session-timeout", &fake_pi("noreply", "t"))
        .await
        .unwrap();

    let error = handle.prompt("never answered").await.unwrap_err();
    assert!(
        matches!(error, SupervisorError::ResponseTimeout { .. }),
        "unexpected error: {error:?}"
    );
    let diagnostics = handle.diagnostics();
    assert_eq!(diagnostics.pending_requests, 0, "超时后必须移除 pending");
    assert_eq!(diagnostics.state, RuntimeState::Idle);

    let exit = handle.stop().await.unwrap();
    assert_eq!(exit.reason.as_str(), "child_exited");
    assert_eq!(handle.state(), RuntimeState::Exited);

    // 同一 session 必须可以重复启动，generation 单调递增，旧进程已回收。
    let mut restarted = supervisor
        .start("session-timeout", &fake_pi("ok", "t2"))
        .await
        .unwrap();
    assert_eq!(restarted.identity().generation, 2);
    assert_eq!(restarted.state(), RuntimeState::Idle);
    assert!(restarted.prompt("again").await.unwrap().success);
    assert_eq!(
        agent_kinds(&settle(&mut restarted, brief_wait()).await),
        ["agent_start"]
    );
    supervisor.shutdown().await;
}

#[tokio::test]
async fn cancel_ends_the_turn_and_keeps_the_runtime_usable() {
    let supervisor = supervisor();
    let mut handle = supervisor
        .start("session-cancel", &fake_pi("slow", "cancel"))
        .await
        .unwrap();
    assert!(handle.prompt("long task").await.unwrap().success);
    assert!(handle.cancel().await.unwrap().success);
    let events = settle(&mut handle, brief_wait()).await;
    assert_eq!(agent_kinds(&events), ["agent_start"]);
    assert_eq!(
        handle.state(),
        RuntimeState::Idle,
        "settled 后必须回到 Idle"
    );
    let exit = handle.stop().await.unwrap();
    assert_eq!(exit.reason.as_str(), "child_exited");
    supervisor.shutdown().await;
}

#[tokio::test]
async fn abrupt_exit_fails_pending_requests_and_stop_is_idempotent() {
    let supervisor = supervisor();
    let mut handle = supervisor
        .start("session-crash", &fake_pi("crash", "crash"))
        .await
        .unwrap();

    let error = handle.prompt("boom").await.unwrap_err();
    assert_eq!(error.code(), "request_channel_closed");
    assert_eq!(handle.diagnostics().pending_requests, 0);

    let exit = handle.stop().await.unwrap();
    assert_eq!(exit.code, Some(7), "异常退出码必须被保留");
    assert_eq!(handle.stop().await.unwrap(), exit, "stop 必须幂等");
    assert!(handle.wait_exit(Duration::from_millis(50)).await.is_ok());
    assert_eq!(handle.state(), RuntimeState::Exited);
    assert_eq!(handle.diagnostics().exit, Some(exit));

    // 重复启动同名 session 不受崩溃影响。
    let restarted = supervisor
        .start("session-crash", &fake_pi("ok", "after"))
        .await
        .unwrap();
    assert_eq!(restarted.identity().generation, 2);
    supervisor.shutdown().await;
}

#[tokio::test]
async fn stderr_diagnostics_are_bounded_and_redacted() {
    let config = SupervisorConfig::fast();
    let ring = config.stderr_ring;
    let supervisor = PiSupervisor::new(config);
    let handle = supervisor
        .start("session-noisy", &fake_pi("noisy", "noisy"))
        .await
        .unwrap();

    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        let diagnostics = handle.diagnostics();
        assert!(
            diagnostics.stderr_tail.len() <= ring,
            "stderr 环必须有界：{} > {ring}",
            diagnostics.stderr_tail.len()
        );
        assert!(
            diagnostics
                .stderr_tail
                .iter()
                .all(|line| !line.contains("ghp_")),
            "密钥形态不得进入诊断: {:?}",
            diagnostics.stderr_tail
        );
        if diagnostics.stderr_tail.len() == ring || Instant::now() > deadline {
            assert!(!diagnostics.stderr_tail.is_empty(), "必须保留诊断尾部");
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    supervisor.shutdown().await;
}

#[tokio::test]
async fn malformed_records_and_extension_ui_requests_warn_but_keep_the_stream() {
    let supervisor = supervisor();
    let mut handle = supervisor
        .start("session-garbage", &fake_pi("garbage", "g"))
        .await
        .unwrap();
    assert!(handle.get_state().await.unwrap().success);
    assert!(handle.prompt("still works").await.unwrap().success);
    let events = settle(&mut handle, brief_wait()).await;

    assert_eq!(agent_kinds(&events), ["agent_start"]);
    assert!(
        events.iter().any(|event| matches!(
            event,
            SupervisorEvent::UnhandledRecord { kind } if kind == "extension_ui_request"
        )),
        "扩展 UI 请求必须显式上报: {events:?}"
    );
    let diagnostics = handle.diagnostics();
    assert!(
        diagnostics
            .last_protocol_warning
            .as_deref()
            .is_some_and(|warning| warning.contains("denied")),
        "未实现的扩展 UI 必须显式警告并按拒绝处理: {:?}",
        diagnostics.last_protocol_warning
    );
    assert!(diagnostics.dropped_events == 0, "事件通道不应溢出");
    supervisor.shutdown().await;
}

#[tokio::test]
async fn shutdown_reclaims_every_runtime() {
    let supervisor = supervisor();
    let _first = supervisor
        .start("session-a", &fake_pi("ok", "a"))
        .await
        .unwrap();
    let _second = supervisor
        .start("session-b", &fake_pi("ok", "b"))
        .await
        .unwrap();
    assert_eq!(supervisor.active_identities().len(), 2);

    let results = supervisor.shutdown().await;
    assert_eq!(results.len(), 2);
    for (runtime_id, outcome) in results {
        let info = outcome.unwrap_or_else(|error| panic!("{runtime_id} 未能回收: {error}"));
        assert_eq!(info.reason.as_str(), "child_exited");
    }
    assert!(supervisor.is_empty());
    assert_eq!(
        supervisor.stop("missing#1").await.unwrap_err(),
        SupervisorError::UnknownRuntime {
            runtime_id: "missing#1".into()
        }
    );
}
