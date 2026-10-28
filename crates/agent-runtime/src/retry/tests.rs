//! `retry` 纯逻辑单测：分类、退避、预算持久化与副作用台账。
//! 全部离线，不发起任何模型请求。

use super::*;

fn policy(max_attempts: u32) -> RetryPolicy {
    RetryPolicy::new(
        max_attempts,
        Duration::from_millis(100),
        Duration::from_millis(400),
    )
}

#[test]
fn only_transient_and_timeout_are_retryable() {
    assert!(classify(FailureSignal::Transport).is_retryable());
    assert!(classify(FailureSignal::Timeout).is_retryable());
    assert!(classify(FailureSignal::HttpStatus(500)).is_retryable());
    assert!(classify(FailureSignal::HttpStatus(503)).is_retryable());
    assert!(classify(FailureSignal::HttpStatus(408)).is_retryable());
    // 429 / 额度 / 鉴权 / 中止 / 未知结果都不得自动重试。
    for signal in [
        FailureSignal::HttpStatus(429),
        FailureSignal::Quota,
        FailureSignal::HttpStatus(401),
        FailureSignal::HttpStatus(403),
        FailureSignal::Auth,
        FailureSignal::Cancelled,
        FailureSignal::Uncertain,
    ] {
        assert!(
            !classify(signal).is_retryable(),
            "{signal:?} 不应被自动重试"
        );
    }
}

#[test]
fn supervisor_timeouts_are_retryable_but_others_are_not() {
    assert_eq!(
        classify_error(&SupervisorError::HandshakeTimeout {
            runtime_id: "r1".to_owned(),
            timeout_ms: 1500,
        }),
        FailureKind::Timeout
    );
    assert_eq!(
        classify_error(&SupervisorError::ResponseTimeout {
            request_id: "r1:p:1".to_owned(),
            timeout_ms: 500,
        }),
        FailureKind::Timeout
    );
    assert_eq!(
        classify_error(&SupervisorError::Spawn {
            program: "pi".to_owned(),
            detail: "not found".to_owned(),
        }),
        FailureKind::Permanent
    );
    assert_eq!(
        classify_error(&SupervisorError::Protocol("unsupported".to_owned())),
        FailureKind::Permanent
    );
}

#[test]
fn backoff_grows_exponentially_and_is_capped() {
    let policy = policy(5);
    assert_eq!(policy.delay_for(0), Duration::from_millis(100));
    assert_eq!(policy.delay_for(1), Duration::from_millis(100));
    assert_eq!(policy.delay_for(2), Duration::from_millis(200));
    assert_eq!(policy.delay_for(3), Duration::from_millis(400));
    // 被 max_delay 夹住，不会指数爆炸。
    assert_eq!(policy.delay_for(9), Duration::from_millis(400));
}

#[test]
fn attempt_limit_cannot_exceed_hard_cap() {
    assert_eq!(policy(99).max_attempts(), MAX_ATTEMPTS_LIMIT);
    assert_eq!(RetryPolicy::conservative().max_attempts(), 2);
    assert_eq!(RetryPolicy::none().max_attempts(), 0);
    // max_delay 小于 base_delay 时被抬到 base_delay。
    let clamped = RetryPolicy::new(1, Duration::from_millis(300), Duration::from_millis(10));
    assert_eq!(clamped.max_delay(), Duration::from_millis(300));
}

#[test]
fn transient_failures_consume_budget_then_exhaust() {
    let mut ledger = RetryLedger::new(policy(2));
    assert_eq!(
        ledger.record_failure(FailureKind::Timeout),
        Some(Duration::from_millis(100))
    );
    assert_eq!(
        ledger.record_failure(FailureKind::Transient),
        Some(Duration::from_millis(200))
    );
    // 两次重试都已授予：额度用尽，但还没被判为「已耗尽」。
    assert!(!ledger.may_attempt());
    assert!(!ledger.is_exhausted());
    // 第三次失败：预算用尽，必须暂停。
    assert_eq!(ledger.record_failure(FailureKind::Timeout), None);
    assert!(ledger.is_exhausted());
    assert!(!ledger.may_attempt());
    assert_eq!(ledger.attempts(), 2);
}

#[test]
fn terminal_failures_never_consume_budget_but_block_retry() {
    for kind in [
        FailureKind::RateLimited,
        FailureKind::Auth,
        FailureKind::Cancelled,
        FailureKind::Uncertain,
        FailureKind::Permanent,
    ] {
        let mut ledger = RetryLedger::new(policy(3));
        assert_eq!(ledger.record_failure(kind), None, "{kind} 不得被重试");
        assert_eq!(ledger.attempts(), 0, "{kind} 不应消耗预算");
        assert!(ledger.is_exhausted());
        assert_eq!(ledger.last_failure(), Some(kind));
    }
}

#[test]
fn restart_cannot_reset_the_budget() {
    let mut ledger = RetryLedger::new(policy(2));
    ledger.record_failure(FailureKind::Timeout);
    ledger.record_failure(FailureKind::Timeout);
    assert_eq!(ledger.record_failure(FailureKind::Timeout), None);
    let persisted = ledger.encode();

    // 进程重启：重新加载同一快照，预算仍是「已耗尽」。
    let restored = RetryLedger::decode(policy(2), &persisted).expect("快照应可解析");
    assert!(restored.is_exhausted());
    assert!(!restored.may_attempt());
    assert_eq!(restored.attempts(), 2);
    assert_eq!(restored.last_failure(), Some(FailureKind::Timeout));
}

#[test]
fn restored_attempts_are_monotonic_even_with_smaller_policy() {
    let mut ledger = RetryLedger::new(policy(3));
    ledger.record_failure(FailureKind::Timeout);
    ledger.record_failure(FailureKind::Timeout);
    ledger.record_failure(FailureKind::Timeout);
    let restored = RetryLedger::decode(policy(1), &ledger.encode()).expect("快照应可解析");
    // 历史已用 3 次，调小策略不会把预算「退回」。
    assert_eq!(restored.attempts(), 3);
    assert!(!restored.may_attempt());
}

#[test]
fn success_keeps_the_observed_count_but_unblocks_the_next_run() {
    let mut ledger = RetryLedger::new(policy(2));
    ledger.record_failure(FailureKind::Timeout);
    ledger.record_success();
    // 成功不抹掉「这次用掉了 1 次重试」的事实：控制台要显示真实次数。
    assert_eq!(ledger.attempts(), 1);
    assert!(!ledger.is_exhausted());
    assert!(ledger.may_attempt());

    // 下一次运行重新拥有完整额度。
    ledger.begin_run();
    assert_eq!(ledger.attempts(), 0);
    assert_eq!(ledger.last_failure(), None);
}

#[test]
fn begin_run_never_clears_an_exhausted_budget() {
    let mut ledger = RetryLedger::new(policy(1));
    ledger.record_failure(FailureKind::Timeout);
    assert_eq!(ledger.record_failure(FailureKind::Timeout), None);
    assert!(ledger.is_exhausted());
    ledger.begin_run();
    assert!(ledger.is_exhausted(), "新运行不得绕过已耗尽的预算");
    assert_eq!(ledger.attempts(), 1);
    assert!(!ledger.may_attempt());
}

#[test]
fn an_exhausted_budget_never_grants_a_retry_even_with_attempts_left() {
    // 终态分类与损坏快照都会写成 exhausted=true、attempts=0：如果只看次数，
    // 这里就会换回一次自动重试，把「失败关闭」变成静默放行（Review 指出的一致性问题）。
    let mut ledger = RetryLedger::new(policy(3));
    ledger.record_terminal(FailureKind::Auth);
    assert!(ledger.is_exhausted());
    assert_eq!(ledger.attempts(), 0);
    assert!(!ledger.may_attempt());
    assert_eq!(
        ledger.record_failure(FailureKind::Timeout),
        None,
        "已耗尽的预算不得因为 attempts < max_attempts 而再次授予重试"
    );
    assert_eq!(ledger.attempts(), 0, "失败关闭不应把次数算成已用");

    // 快照恢复出来的同一状态必须表现一致：重试预算不能靠重启「找回」。
    let restored = RetryLedger::decode(
        policy(3),
        r#"{"schemaVersion":1,"attempts":0,"exhausted":true,"lastFailure":"auth"}"#,
    )
    .expect("快照应可解析");
    let mut restored = restored;
    assert_eq!(restored.record_failure(FailureKind::Transient), None);
    assert_eq!(restored.attempts(), 0);
    assert_eq!(restored.last_failure(), Some(FailureKind::Transient));
    assert!(restored.is_exhausted());
}

#[test]
fn restored_terminal_snapshot_keeps_the_exhausted_flag_authoritative() {
    // 正常写出的终态快照：只有成功（record_success）能解除封锁。
    let mut ledger = RetryLedger::new(policy(2));
    ledger.record_terminal(FailureKind::RateLimited);
    let restored = RetryLedger::decode(policy(2), &ledger.encode()).expect("快照应可解析");
    assert!(restored.is_exhausted());
    assert!(!restored.may_attempt());
    assert_eq!(restored.status().next_delay_ms, None);

    let mut unblocked = restored.clone();
    unblocked.record_success();
    assert!(!unblocked.is_exhausted());
    assert!(unblocked.may_attempt());
}

#[test]
fn cancellation_is_sticky_and_shared_between_handles() {
    let cancel = RetryCancel::new();
    assert!(!cancel.is_cancelled());
    let clone = cancel.clone();
    clone.cancel();
    assert!(cancel.is_cancelled(), "克隆句柄必须与原件共享取消状态");
    // 幂等：重复取消不会产生额外影响。
    cancel.cancel();
    assert!(clone.is_cancelled());
    // 默认构造与 new() 等价。
    assert!(!RetryCancel::default().is_cancelled());
}

#[tokio::test]
async fn cancelled_future_stays_pending_until_cancelled() {
    let cancel = RetryCancel::new();
    assert!(
        tokio::time::timeout(Duration::from_millis(50), cancel.cancelled())
            .await
            .is_err(),
        "未取消时必须挂起，不能误报已取消"
    );
    let trigger = cancel.clone();
    tokio::spawn(async move {
        trigger.cancel();
    });
    tokio::time::timeout(Duration::from_secs(1), cancel.cancelled())
        .await
        .expect("取消后应立即返回");
}

#[test]
fn decode_rejects_bad_or_future_payloads() {
    assert!(matches!(
        RetryLedger::decode(policy(1), "not json"),
        Err(RetryStateError::Malformed(_))
    ));
    assert_eq!(
        RetryLedger::decode(
            policy(1),
            r#"{"schemaVersion":2,"attempts":0,"exhausted":false}"#
        ),
        Err(RetryStateError::UnsupportedVersion(2))
    );
    // 缺少 lastFailure 的旧快照仍可恢复（serde default）。
    let restored = RetryLedger::decode(
        policy(1),
        r#"{"schemaVersion":1,"attempts":1,"exhausted":false}"#,
    )
    .expect("旧快照应可解析");
    assert_eq!(restored.attempts(), 1);
    assert_eq!(restored.last_failure(), None);
}

#[test]
fn status_reports_counts_and_cost_notice() {
    let mut ledger = RetryLedger::new(policy(2));
    ledger.record_failure(FailureKind::Timeout);
    let status = ledger.status();
    assert_eq!(status.attempts, 1);
    assert_eq!(status.max_attempts, 2);
    assert_eq!(status.remaining, 1);
    assert!(!status.exhausted);
    assert_eq!(status.last_failure.as_deref(), Some("timeout"));
    assert_eq!(status.next_delay_ms, Some(200));
    assert_eq!(status.cost_notice, COST_NOTICE);

    ledger.record_failure(FailureKind::Timeout);
    assert_eq!(ledger.record_failure(FailureKind::Timeout), None);
    let exhausted = ledger.status();
    assert!(exhausted.exhausted);
    assert_eq!(exhausted.remaining, 0);
    assert_eq!(exhausted.next_delay_ms, None);
}

#[test]
fn status_serialises_to_camel_case_for_the_ui() {
    let value = serde_json::to_value(RetryLedger::new(policy(2)).status()).expect("可序列化");
    assert_eq!(value["maxAttempts"], 2);
    assert_eq!(value["attempts"], 0);
    assert_eq!(value["costNotice"], COST_NOTICE);
    assert_eq!(value["exhausted"], false);
}

#[test]
fn side_effects_require_verification_before_replay() {
    let mut side_effects = SideEffectLedger::new();
    // 未登记：可以安全执行。
    assert_eq!(
        side_effects.decision("pr:create"),
        ReplayDecision::SafeToReplay
    );
    // 已发出但没拿到结果：必须先查证，不得重复创建 PR。
    assert!(side_effects.mark_sent("pr:create"));
    assert_eq!(
        side_effects.decision("pr:create"),
        ReplayDecision::VerifyFirst
    );
    assert!(side_effects.has_unresolved());
    // 查证后确认已创建：禁止重复创建。
    assert!(side_effects.resolve("pr:create", true));
    assert_eq!(
        side_effects.decision("pr:create"),
        ReplayDecision::NeverReplay
    );
    assert!(!side_effects.has_unresolved());
}

#[test]
fn side_effects_confirmed_absent_may_be_retried_once() {
    let mut side_effects = SideEffectLedger::new();
    side_effects.mark_sent("branch:push");
    // 查证后确认远端没有该分支：允许再次执行。
    assert!(side_effects.resolve("branch:push", false));
    assert_eq!(
        side_effects.decision("branch:push"),
        ReplayDecision::SafeToReplay
    );
    // 找不到条目时 resolve 返回 false，不静默创建记录。
    assert!(!side_effects.resolve("never-sent", true));
    assert_eq!(
        side_effects.decision("never-sent"),
        ReplayDecision::SafeToReplay
    );
}

#[test]
fn side_effect_ledger_refuses_to_forget_unresolved_entries() {
    let mut side_effects = SideEffectLedger::new();
    for index in 0..MAX_SIDE_EFFECT_ENTRIES {
        assert!(side_effects.mark_sent(format!("op-{index}")));
    }
    // 全部未落定：满了以后拒绝登记，而不是丢掉证据让重放变成「安全」。
    assert!(!side_effects.mark_sent("op-overflow"));
    assert_eq!(side_effects.len(), MAX_SIDE_EFFECT_ENTRIES);

    // 落定一条后即可继续登记，并回收最旧的已落定条目。
    assert!(side_effects.resolve("op-0", false));
    assert!(side_effects.mark_sent("op-overflow"));
    assert_eq!(side_effects.len(), MAX_SIDE_EFFECT_ENTRIES);
    assert_eq!(
        side_effects.decision("op-0"),
        ReplayDecision::SafeToReplay,
        "已落定且被回收的条目不再要求查证"
    );
}

#[test]
fn resume_after_exhaustion_requires_a_successful_run() {
    let mut ledger = RetryLedger::new(RetryPolicy::none());
    // 策略为 0 次重试：第一次瞬时失败就必须暂停。
    assert_eq!(ledger.record_failure(FailureKind::Timeout), None);
    assert!(ledger.is_exhausted());
    // 恢复入口读同一份持久化快照：仍然不允许自动重试。
    let mut restored =
        RetryLedger::decode(RetryPolicy::none(), &ledger.encode()).expect("快照应可解析");
    assert!(!restored.may_attempt());
    restored.begin_run();
    assert!(!restored.may_attempt(), "恢复入口同样不能绕过耗尽状态");
}

#[test]
fn multi_attempt_budget_is_reported_on_every_failure() {
    let mut ledger = RetryLedger::new(RetryPolicy::new(
        3,
        Duration::from_millis(250),
        Duration::from_secs(5),
    ));
    let mut granted = Vec::new();
    for _ in 0..3 {
        granted.push(ledger.record_failure(FailureKind::Transient));
    }
    assert_eq!(
        granted,
        vec![
            Some(Duration::from_millis(250)),
            Some(Duration::from_millis(500)),
            Some(Duration::from_secs(1)),
        ]
    );
    assert_eq!(ledger.status().attempts, 3);
    assert_eq!(ledger.record_failure(FailureKind::Timeout), None);
}
