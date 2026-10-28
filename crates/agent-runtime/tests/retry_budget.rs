//! TASK-007：网络超时的有界重试与安全恢复。
//!
//! 全部用例都是**离线注入**：假 Pi（`fake-pi.mjs` 的 `mute` 模式）不回复握手，
//! 因此不需要网络、不调用模型、不产生任何费用。尝试次数通过夹具写的日志文件
//! 精确统计，不依赖计时猜测。

mod support;

use std::ffi::OsString;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use soxu_agent_runtime::retry::{
    FailureKind, MAX_ATTEMPTS_LIMIT, RetryCancel, RetryLedger, RetryPolicy, start_with_retry,
    start_with_retry_cancellable,
};
use soxu_agent_runtime::{PiProgram, PiSupervisor, SupervisorConfig, SupervisorError};

use support::fake_pi;

/// 短握手预算：让「超时 → 重试」的用例在毫秒级完成。
fn config() -> SupervisorConfig {
    config_with_handshake(Duration::from_millis(120))
}

/// 指定握手预算；取消类用例需要更短的首刺，才能把等待落在退避窗口里。
fn config_with_handshake(handshake_timeout: Duration) -> SupervisorConfig {
    SupervisorConfig {
        handshake_timeout,
        ..SupervisorConfig::fast()
    }
}

/// 每次重试的退避压到 1ms，避免测试等待真实指数退避。
fn policy(max_attempts: u32) -> RetryPolicy {
    RetryPolicy::new(
        max_attempts,
        Duration::from_millis(1),
        Duration::from_millis(2),
    )
}

/// 夹具日志路径：唯一、可清理，用于统计真实尝试次数。
struct AttemptLog {
    path: PathBuf,
}

impl AttemptLog {
    fn new(tag: &str) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!("soxu-retry-{tag}-{nanos}.log"));
        let _ = std::fs::remove_file(&path);
        Self { path }
    }

    fn program(&self, mode: &str) -> PiProgram {
        let node = std::env::var("NODE_BINARY").unwrap_or_else(|_| "node".to_owned());
        let script: PathBuf = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join("fake-pi.mjs");
        let args: Vec<OsString> = vec![
            script.into_os_string(),
            mode.into(),
            "retry-fixture".into(),
            self.path.clone().into_os_string(),
        ];
        PiProgram::new(node).with_args(args)
    }

    /// 夹具进程被拉起的次数（不含「收到命令」的行）。
    fn starts(&self) -> usize {
        let text = std::fs::read_to_string(&self.path).unwrap_or_default();
        text.lines().filter(|line| *line == "start").count()
    }
}

impl Drop for AttemptLog {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

#[tokio::test]
async fn handshake_timeouts_are_retried_then_the_run_pauses() {
    let log = AttemptLog::new("retry-then-pause");
    let supervisor = PiSupervisor::new(config());
    let mut ledger = RetryLedger::new(policy(2));

    let error = start_with_retry(
        &supervisor,
        "session-retry",
        &log.program("mute"),
        &mut ledger,
    )
    .await
    .expect_err("握手一直不回应时不能成功");

    // 1 次首试 + 2 次有界重试，然后暂停。
    assert_eq!(log.starts(), 3);
    assert_eq!(ledger.attempts(), 2);
    assert!(ledger.is_exhausted());
    assert_eq!(ledger.last_failure(), Some(FailureKind::Timeout));
    assert!(matches!(
        error,
        SupervisorError::RetryBudgetExhausted {
            attempts: 2,
            ref last,
        } if last == "timeout"
    ));
    assert_eq!(error.code(), "retry_budget_exhausted");
    // 暂停路径必须回收进程，不能留下孤儿 Pi。
    assert!(supervisor.processes().is_empty(), "暂停后不应留下受管进程");
}

#[tokio::test]
async fn exhausted_budget_from_a_previous_process_allows_only_one_attempt() {
    // 模拟「上一次运行已经耗尽预算」：持久化 → 进程重启 → 恢复。
    let persisted = {
        let mut previous = RetryLedger::new(policy(2));
        previous.record_failure(FailureKind::Timeout);
        previous.record_failure(FailureKind::Timeout);
        assert_eq!(previous.record_failure(FailureKind::Timeout), None);
        previous.encode()
    };

    let log = AttemptLog::new("restart-budget");
    let supervisor = PiSupervisor::new(config());
    let mut ledger = RetryLedger::decode(policy(2), &persisted).expect("快照应可解析");
    assert!(!ledger.may_attempt(), "重启后预算不得重置");

    let error = start_with_retry(
        &supervisor,
        "session-restart",
        &log.program("mute"),
        &mut ledger,
    )
    .await
    .expect_err("预算已耗尽时不得自动继续");

    // 仍然允许一次「人工恢复」尝试，但绝不会再自动重试。
    assert_eq!(log.starts(), 1);
    assert_eq!(ledger.attempts(), 2);
    assert!(matches!(
        error,
        SupervisorError::RetryBudgetExhausted { attempts: 2, .. }
    ));
}

#[tokio::test]
async fn configured_attempts_cannot_exceed_the_hard_cap() {
    let log = AttemptLog::new("hard-cap");
    let supervisor = PiSupervisor::new(config());
    // 传入 99 次：被夹到 MAX_ATTEMPTS_LIMIT，避免「有界」被配置失效。
    let mut ledger = RetryLedger::new(policy(99));
    assert_eq!(ledger.policy().max_attempts(), MAX_ATTEMPTS_LIMIT);

    let _ = start_with_retry(
        &supervisor,
        "session-cap",
        &log.program("mute"),
        &mut ledger,
    )
    .await
    .expect_err("握手一直不回应时不能成功");

    assert_eq!(log.starts(), MAX_ATTEMPTS_LIMIT as usize + 1);
    assert_eq!(ledger.attempts(), MAX_ATTEMPTS_LIMIT);
}

#[tokio::test]
async fn permanent_start_failures_are_not_retried_and_block_recovery() {
    let supervisor = PiSupervisor::new(config());
    let mut ledger = RetryLedger::new(policy(3));
    let program = PiProgram::new("soxu-missing-pi-binary-for-retry-test");

    let error = start_with_retry(&supervisor, "session-spawn", &program, &mut ledger)
        .await
        .expect_err("程序不存在时必须失败");

    assert!(matches!(error, SupervisorError::Spawn { .. }));
    // 确定性失败不消耗预算，但会把预算钉死，恢复入口不能再自动重试。
    assert_eq!(ledger.attempts(), 0);
    assert!(ledger.is_exhausted());
    assert_eq!(ledger.last_failure(), Some(FailureKind::Permanent));
}

#[tokio::test]
async fn a_successful_start_unblocks_the_next_run() {
    let supervisor = PiSupervisor::new(config());
    let mut ledger = RetryLedger::new(policy(2));
    ledger.record_failure(FailureKind::Timeout);
    assert_eq!(ledger.attempts(), 1);

    let mut handle = start_with_retry(
        &supervisor,
        "session-ok",
        &fake_pi("ok", "retry-ok"),
        &mut ledger,
    )
    .await
    .expect("正常夹具应能完成握手");

    // 新运行重新授予完整额度，且不残留上次失败记录。
    assert_eq!(ledger.attempts(), 0);
    assert_eq!(ledger.last_failure(), None);
    assert!(!ledger.is_exhausted());
    assert!(ledger.may_attempt());

    let _ = handle.stop().await;
}

#[tokio::test]
async fn status_keeps_the_observed_retry_count_after_a_retry() {
    // 先让一轮运行用满 2 次重试：控制台必须能看到真实次数，而不是被静默清零。
    let log = AttemptLog::new("observed-count");
    let supervisor = PiSupervisor::new(config());
    let mut ledger = RetryLedger::new(policy(2));

    let _ = start_with_retry(
        &supervisor,
        "session-count",
        &log.program("mute"),
        &mut ledger,
    )
    .await
    .expect_err("mute 夹具不会握手成功");

    let status = ledger.status();
    assert_eq!(status.attempts, 2);
    assert_eq!(status.max_attempts, 2);
    assert!(status.exhausted);
    assert_eq!(status.last_failure.as_deref(), Some("timeout"));
    assert_eq!(status.next_delay_ms, None);
    // 控制台必须能明确提示「重试可能产生费用」。
    assert!(status.cost_notice.contains("费用"));
}

#[tokio::test]
async fn retry_status_is_visible_and_warns_about_cost() {
    let log = AttemptLog::new("status");
    let supervisor = PiSupervisor::new(config());
    let mut ledger = RetryLedger::new(policy(1));

    let _ = start_with_retry(
        &supervisor,
        "session-status",
        &log.program("mute"),
        &mut ledger,
    )
    .await
    .expect_err("握手一直不回应时不能成功");

    let status = ledger.status();
    assert_eq!(status.attempts, 1);
    assert_eq!(status.max_attempts, 1);
    assert_eq!(status.remaining, 0);
    assert!(status.exhausted);
    assert_eq!(status.last_failure.as_deref(), Some("timeout"));
    assert!(status.cost_notice.contains("费用"));
}

#[tokio::test]
async fn terminal_snapshot_fails_closed_without_granting_a_retry() {
    // Review 回归：exhausted=true 但 attempts<max 的终态快照（429/鉴权/中止/损坏文件）
    // 曾经还能换回一次自动重试，与文档承诺的「失败关闭」自相矛盾。
    let persisted =
        r#"{"schemaVersion":1,"attempts":1,"exhausted":true,"lastFailure":"rate_limited"}"#;

    let log = AttemptLog::new("terminal-snapshot");
    let supervisor = PiSupervisor::new(config());
    let mut ledger = RetryLedger::decode(policy(4), persisted).expect("快照应可解析");
    assert!(ledger.is_exhausted());
    // 额度看起来还剩 3 次，但耗尽标志是权威的：不能授予任何自动重试。
    assert!(!ledger.may_attempt());
    assert_eq!(
        ledger.record_failure(FailureKind::Timeout),
        None,
        "已耗尽的预算不得因为 attempts < max_attempts 而再次授予重试"
    );
    assert_eq!(ledger.attempts(), 1, "失败关闭不得虚构已用次数");

    let error = start_with_retry(
        &supervisor,
        "session-terminal",
        &log.program("mute"),
        &mut ledger,
    )
    .await
    .expect_err("终态预算下不得自动重试");

    assert_eq!(log.starts(), 1, "只允许一次人工尝试，不允许自动重试");
    assert_eq!(ledger.attempts(), 1);
    assert!(matches!(
        error,
        SupervisorError::RetryBudgetExhausted { attempts: 1, .. }
    ));
    assert!(supervisor.processes().is_empty());
}

#[tokio::test]
async fn cancelling_before_the_first_attempt_never_spawns_a_process() {
    let log = AttemptLog::new("cancel-early");
    let supervisor = PiSupervisor::new(config());
    let mut ledger = RetryLedger::new(policy(2));
    let cancel = RetryCancel::new();
    cancel.cancel();

    let error = start_with_retry_cancellable(
        &supervisor,
        "session-cancel-early",
        &log.program("mute"),
        &mut ledger,
        &cancel,
    )
    .await
    .expect_err("已取消时不应启动");

    assert!(matches!(
        error,
        SupervisorError::RetryCancelled { attempts: 0 }
    ));
    assert_eq!(error.code(), "retry_cancelled");
    assert_eq!(log.starts(), 0, "取消后不得拉起子进程");
    // 用户中止不重试：预算钉死，恢复入口不能自动继续。
    assert!(ledger.is_exhausted());
    assert!(!ledger.may_attempt());
    assert_eq!(ledger.last_failure(), Some(FailureKind::Cancelled));
}

#[tokio::test]
async fn cancelling_during_the_backoff_window_stops_without_another_attempt() {
    let log = AttemptLog::new("cancel-backoff");
    let supervisor = PiSupervisor::new(config_with_handshake(Duration::from_millis(60)));
    // 退避拉到 2 秒：如果窗口不可取消，这个用例会真的等满 2 秒。
    let mut ledger = RetryLedger::new(RetryPolicy::new(
        3,
        Duration::from_secs(2),
        Duration::from_secs(2),
    ));
    let cancel = RetryCancel::new();
    let trigger = cancel.clone();
    let canceller = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(250)).await;
        trigger.cancel();
    });

    let started = std::time::Instant::now();
    let error = start_with_retry_cancellable(
        &supervisor,
        "session-cancel-backoff",
        &log.program("mute"),
        &mut ledger,
        &cancel,
    )
    .await
    .expect_err("退避期间被取消时不能成功");
    let elapsed = started.elapsed();
    let _ = canceller.await;

    assert!(matches!(
        error,
        SupervisorError::RetryCancelled { attempts: 1 }
    ));
    assert_eq!(error.code(), "retry_cancelled");
    assert_eq!(log.starts(), 1, "取消后不得再发起第二次尝试");
    assert!(
        elapsed < Duration::from_millis(1500),
        "取消必须打断退避窗口，而不是等满 2 秒（实测 {elapsed:?}）"
    );
    // 已授予的那次重试仍然记入预算，并因中止而钉死。
    assert_eq!(ledger.attempts(), 1);
    assert!(ledger.is_exhausted());
    assert_eq!(ledger.last_failure(), Some(FailureKind::Cancelled));
    assert!(supervisor.processes().is_empty(), "取消后不应留下受管进程");
}
