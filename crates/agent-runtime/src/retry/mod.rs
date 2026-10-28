//! 网络超时与瞬时故障的**有界重试预算**，以及「结果不确定」的副作用防护。
//!
//! 依据 PRD P-05 与 TASK-007，这里的规则是硬约束而不是建议：
//!
//! - 只有**瞬时传输故障**与**超时**允许自动重试；429/额度不足、鉴权失败、
//!   用户中止、程序缺失等一律不重试，只能暂停并等人工恢复。
//! - 预算写进可序列化的 `RetryLedger`，由调用方持久化：进程重启后
//!   已用次数与「已耗尽」都不会被重置，恢复入口无法绕过预算。
//! - 重试**复用同一个 PiProgram**：SOXU 不切换模型，也不改 Provider/凭据。
//!   每次重试都可能再次计费，因此状态里固定带上费用提示。
//! - 可能产生外部副作用的操作（创建 PR、推送分支等）先登记在
//!   `SideEffectLedger`；结果未知时只允许「先查证」，绝不盲目重放。
//! - 退避窗口可被 `RetryCancel` 打断：用户在等待期间点「停止」时立即收手，
//!   不再多拉起一次子进程，也不再多一次可能的计费请求。
//!
//! 本模块不做 IO：持久化由上层（桌面端 retry_store）负责，测试因此完全离线。

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::Notify;

use crate::config::PiProgram;
use crate::error::{SupervisorError, SupervisorResult};
use crate::handle::RuntimeHandle;
use crate::supervisor::PiSupervisor;

/// 单次运行最多允许的自动重试次数上限；调大需要单独评审预算风险。
pub const MAX_ATTEMPTS_LIMIT: u32 = 5;
/// 副作用台账条目上限：超过后不再登记新操作，由调用方暂停而不是冒险。
pub const MAX_SIDE_EFFECT_ENTRIES: usize = 64;
/// 持久化快照的协议版本；不匹配时拒绝恢复，不猜测旧格式语义。
pub const RETRY_SCHEMA_VERSION: u32 = 1;
/// 重试状态里始终展示的费用提示（AC：重试必须明示可能产生费用）。
pub const COST_NOTICE: &str =
    "重试会重新发起模型请求，可能产生新的模型费用；模型与 Provider 固定不变，也不切换凭据。";

/// 失败分类：决定「能不能自动重试」的唯一口径。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureKind {
    /// 可重试的瞬时传输故障（连接重置、断流、5xx）。
    Transient,
    /// 超时：握手、命令、事件在预算内没有回应。
    Timeout,
    /// 429 / 额度 / 余额不足：可能已计费，重试只会继续烧钱。
    RateLimited,
    /// 鉴权失败：重试不会改变凭据状态。
    Auth,
    /// 用户中止（Ctrl+C、主动 cancel）。
    Cancelled,
    /// 确定性失败：程序缺失、协议不兼容、非法状态迁移等。
    Permanent,
    /// 已发出但结果未知：必须先查证再决定能否重放。
    Uncertain,
}

impl FailureKind {
    /// 只有瞬时故障与超时进入自动重试路径。
    pub fn is_retryable(self) -> bool {
        matches!(self, Self::Transient | Self::Timeout)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Transient => "transient",
            Self::Timeout => "timeout",
            Self::RateLimited => "rate_limited",
            Self::Auth => "auth",
            Self::Cancelled => "cancelled",
            Self::Permanent => "permanent",
            Self::Uncertain => "uncertain",
        }
    }
}

impl std::fmt::Display for FailureKind {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// 结构化失败信号。上游把已知事实映射成变体，**不解析自由文本**。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureSignal {
    /// 管道断开、连接重置、连接被拒等传输层故障。
    Transport,
    /// 在预算内没有回应。
    Timeout,
    /// Provider 或 Pi 给出的明确 HTTP 状态码。
    HttpStatus(u16),
    /// 额度/余额不足（含 rate limit 语义）。
    Quota,
    /// 凭据缺失或无效。
    Auth,
    /// 用户中止。
    Cancelled,
    /// 已发出、结果未知。
    Uncertain,
}

/// 把结构化信号映射成失败分类。
///
/// 408/425 视为超时（可重试），5xx 视为瞬时；429 归入额度/限流，
/// 因为它通常意味着「已经计入配额」，继续重试属于烧钱。
pub fn classify(signal: FailureSignal) -> FailureKind {
    match signal {
        FailureSignal::Transport => FailureKind::Transient,
        FailureSignal::Timeout => FailureKind::Timeout,
        FailureSignal::HttpStatus(status) => match status {
            408 | 425 => FailureKind::Timeout,
            500..=599 => FailureKind::Transient,
            429 => FailureKind::RateLimited,
            401 | 403 => FailureKind::Auth,
            _ => FailureKind::Permanent,
        },
        FailureSignal::Quota => FailureKind::RateLimited,
        FailureSignal::Auth => FailureKind::Auth,
        FailureSignal::Cancelled => FailureKind::Cancelled,
        FailureSignal::Uncertain => FailureKind::Uncertain,
    }
}

/// `SupervisorError` 的默认分类：只有握手/命令/事件超时算可重试。
///
/// 进程在等待中结束（`RuntimeEnded`）与协议错误一律按确定性失败处理：
/// 盲目重启只会在同一处再失败一次，浪费额度。
pub fn classify_error(error: &SupervisorError) -> FailureKind {
    match error {
        SupervisorError::HandshakeTimeout { .. }
        | SupervisorError::ResponseTimeout { .. }
        | SupervisorError::EventTimeout { .. } => FailureKind::Timeout,
        _ => FailureKind::Permanent,
    }
}

/// 退避策略。次数上限受 MAX_ATTEMPTS_LIMIT 约束，避免「有界」被配置失效。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RetryPolicy {
    max_attempts: u32,
    base_delay: Duration,
    max_delay: Duration,
}

impl RetryPolicy {
    /// 默认策略：最多重试 2 次，退避 500ms 起步、单次不超过 8 秒。
    pub const fn conservative() -> Self {
        Self {
            max_attempts: 2,
            base_delay: Duration::from_millis(500),
            max_delay: Duration::from_secs(8),
        }
    }

    /// 不重试：瞬时故障也只报错，用于需要完全手动的场景。
    pub const fn none() -> Self {
        Self {
            max_attempts: 0,
            base_delay: Duration::from_millis(0),
            max_delay: Duration::from_millis(0),
        }
    }

    /// 构造策略；次数被夹到 `0..=MAX_ATTEMPTS_LIMIT`，`max_delay` 不小于 `base_delay`。
    pub const fn new(max_attempts: u32, base_delay: Duration, max_delay: Duration) -> Self {
        let attempts = if max_attempts > MAX_ATTEMPTS_LIMIT {
            MAX_ATTEMPTS_LIMIT
        } else {
            max_attempts
        };
        let cap = if max_delay.as_millis() < base_delay.as_millis() {
            base_delay
        } else {
            max_delay
        };
        Self {
            max_attempts: attempts,
            base_delay,
            max_delay: cap,
        }
    }

    pub fn max_attempts(&self) -> u32 {
        self.max_attempts
    }

    pub fn base_delay(&self) -> Duration {
        self.base_delay
    }

    pub fn max_delay(&self) -> Duration {
        self.max_delay
    }

    /// 第 `attempt` 次重试（1 起）前的退避：指数增长并夹在 `max_delay` 内。
    pub fn delay_for(&self, attempt: u32) -> Duration {
        if attempt == 0 {
            return self.base_delay;
        }
        let mut delay = self.base_delay;
        for _ in 1..attempt {
            if delay >= self.max_delay {
                return self.max_delay;
            }
            delay = delay.saturating_mul(2);
        }
        delay.min(self.max_delay)
    }
}

/// 可持久化的预算快照。字段名与 JSON 契约绑定，改动必须升 schemaVersion。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetrySnapshot {
    pub schema_version: u32,
    /// 已经用掉的自动重试次数（不含首次尝试）。
    pub attempts: u32,
    /// 预算已耗尽：即使进程重启也不得继续自动重试。
    pub exhausted: bool,
    #[serde(default)]
    pub last_failure: Option<FailureKind>,
}

/// 恢复预算时遇到的问题；一律保守处理（拒绝恢复快照）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RetryStateError {
    /// 快照不是合法 JSON。
    Malformed(String),
    /// 快照版本不受支持，不能猜测旧语义。
    UnsupportedVersion(u32),
}

impl std::fmt::Display for RetryStateError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Malformed(detail) => write!(formatter, "重试预算快照无法解析：{detail}"),
            Self::UnsupportedVersion(version) => {
                write!(formatter, "不支持的重试预算版本 {version}")
            }
        }
    }
}

impl std::error::Error for RetryStateError {}

/// 给 UI / 控制台用的只读快照。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetryStatus {
    /// 已用自动重试次数。
    pub attempts: u32,
    pub max_attempts: u32,
    pub remaining: u32,
    pub exhausted: bool,
    pub last_failure: Option<String>,
    /// 下一次重试前的退避；已耗尽时为 None。
    pub next_delay_ms: Option<u64>,
    pub cost_notice: String,
}

/// 一次运行的重试预算。
///
/// 语义：`attempts` 只统计**已授予的重试**（不含首次尝试）。`exhausted` 一旦为真
/// 就只有 `record_success` 能解除——这是「恢复入口不能绕过预算」的实现。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RetryLedger {
    policy: RetryPolicy,
    attempts: u32,
    exhausted: bool,
    last: Option<FailureKind>,
}

impl RetryLedger {
    pub fn new(policy: RetryPolicy) -> Self {
        Self {
            policy,
            attempts: 0,
            exhausted: false,
            last: None,
        }
    }

    /// 从持久化快照恢复。已用次数只增不减：调小策略也不会退回历史预算。
    pub fn restore(policy: RetryPolicy, snapshot: &RetrySnapshot) -> Self {
        Self {
            policy,
            attempts: snapshot.attempts,
            exhausted: snapshot.exhausted,
            last: snapshot.last_failure,
        }
    }

    /// 解析 JSON 快照并恢复；不支持的版本与坏 JSON 都拒绝，交由上层按暂停处理。
    pub fn decode(policy: RetryPolicy, json: &str) -> Result<Self, RetryStateError> {
        let snapshot: RetrySnapshot = serde_json::from_str(json)
            .map_err(|error| RetryStateError::Malformed(error.to_string()))?;
        if snapshot.schema_version != RETRY_SCHEMA_VERSION {
            return Err(RetryStateError::UnsupportedVersion(snapshot.schema_version));
        }
        Ok(Self::restore(policy, &snapshot))
    }

    pub fn policy(&self) -> RetryPolicy {
        self.policy
    }

    pub fn attempts(&self) -> u32 {
        self.attempts
    }

    pub fn is_exhausted(&self) -> bool {
        self.exhausted
    }

    pub fn last_failure(&self) -> Option<FailureKind> {
        self.last
    }

    /// 还有没有自动重试额度。
    pub fn may_attempt(&self) -> bool {
        !self.exhausted && self.attempts < self.policy.max_attempts
    }

    pub fn snapshot(&self) -> RetrySnapshot {
        RetrySnapshot {
            schema_version: RETRY_SCHEMA_VERSION,
            attempts: self.attempts,
            exhausted: self.exhausted,
            last_failure: self.last,
        }
    }

    pub fn encode(&self) -> String {
        serde_json::to_string(&self.snapshot()).unwrap_or_else(|_| {
            // 结构固定且字段都可序列化，理论不可达；退化成「已耗尽」而不是放行重试。
            format!(
                "{{\"schemaVersion\":{RETRY_SCHEMA_VERSION},\"attempts\":{},\"exhausted\":true}}",
                self.attempts
            )
        })
    }

    /// 记录一次可重试失败；返回下一次退避，`None` 表示预算耗尽（应暂停并保留现场）。
    ///
    /// 传入不可重试分类时同样返回 `None` 并标记耗尽：调用方必须把它当暂停处理。
    ///
    /// **已耗尽的预算一律返回 `None`**，即使 `attempts < max_attempts`：
    /// 终态分类（429/鉴权/中止/不确定）与损坏快照都会写出
    /// `exhausted: true, attempts: 0`，如果这里只看次数，重启后的那次「零次已用」
    /// 就会换回一次自动重试，把失败关闭变成静默放行。
    pub fn record_failure(&mut self, kind: FailureKind) -> Option<Duration> {
        self.last = Some(kind);
        if self.exhausted {
            return None;
        }
        if !kind.is_retryable() {
            self.exhausted = true;
            return None;
        }
        if self.attempts >= self.policy.max_attempts {
            self.exhausted = true;
            return None;
        }
        self.attempts += 1;
        Some(self.policy.delay_for(self.attempts))
    }

    /// 记录一次确定性失败（429/鉴权/用户中止）：直接钉死预算，等人工恢复。
    pub fn record_terminal(&mut self, kind: FailureKind) {
        self.last = Some(kind);
        self.exhausted = true;
    }

    /// 开始一次新的运行：只有「上一次运行没有被判为耗尽」时才重置计数。
    ///
    /// 已耗尽的预算**不因重启或新运行而清零**，恢复入口因此无法绕过限制；
    /// 只有某次运行真正成功（[`Self::record_success`]）才解除封锁。
    pub fn begin_run(&mut self) {
        if self.exhausted {
            return;
        }
        self.attempts = 0;
        self.last = None;
    }

    /// 一次运行成功：解除耗尽封锁，但**保留**本次用掉的次数，控制台仍能看到真实重试次数。
    /// 下一次运行由 [`Self::begin_run`] 重新授予完整额度。
    pub fn record_success(&mut self) {
        self.exhausted = false;
    }

    pub fn status(&self) -> RetryStatus {
        RetryStatus {
            attempts: self.attempts,
            max_attempts: self.policy.max_attempts,
            remaining: self.policy.max_attempts.saturating_sub(self.attempts),
            exhausted: self.exhausted,
            last_failure: self.last.map(|kind| kind.as_str().to_owned()),
            next_delay_ms: if self.may_attempt() {
                Some(self.policy.delay_for(self.attempts + 1).as_millis() as u64)
            } else {
                None
            },
            cost_notice: COST_NOTICE.to_owned(),
        }
    }
}

mod side_effect;
#[cfg(test)]
mod tests;

pub use side_effect::{ReplayDecision, SideEffectLedger};

/// 重试窗口的取消句柄：让「等待退避」的时间片也能被用户中止。
///
/// 只管一件事——把 `cancel()` 变成重试循环里可 `select!` 的分支。
/// 克隆廉价（内部共享同一个原子标志与唤醒器），可跨任务共享；取消是单向且粘滞的。
#[derive(Debug, Clone)]
pub struct RetryCancel {
    inner: Arc<CancelState>,
}

#[derive(Debug, Default)]
struct CancelState {
    cancelled: AtomicBool,
    notify: Notify,
}

impl RetryCancel {
    pub fn new() -> Self {
        Self::default()
    }

    /// 请求取消。幂等：重复调用不会产生额外影响。
    pub fn cancel(&self) {
        self.inner.cancelled.store(true, Ordering::SeqCst);
        // 先通知已在等待的任务，再补一个「许可」：即使此刻还没有等待者注册，
        // 随后调用 `cancelled()` 也会立刻返回，不存在丢失唤醒的窗口。
        self.inner.notify.notify_waiters();
        self.inner.notify.notify_one();
    }

    pub fn is_cancelled(&self) -> bool {
        self.inner.cancelled.load(Ordering::SeqCst)
    }

    /// 等到被取消为止。未被取消时永远挂起，不会误报「已取消」。
    pub async fn cancelled(&self) {
        loop {
            if self.is_cancelled() {
                return;
            }
            self.inner.notify.notified().await;
            // 被唤醒后重新检查标志：唤醒可能是许可或并发取消留下的，不能直接当成已取消。
            if self.is_cancelled() {
                return;
            }
        }
    }
}

impl Default for RetryCancel {
    fn default() -> Self {
        Self {
            inner: Arc::new(CancelState::default()),
        }
    }
}

/// 等待一次退避；返回 `true` 表示期间被取消（调用方应停止重试）。
async fn wait_backoff(backoff: Duration, cancel: &RetryCancel) -> bool {
    if cancel.is_cancelled() {
        return true;
    }
    if backoff.is_zero() {
        return false;
    }
    tokio::select! {
        () = tokio::time::sleep(backoff) => cancel.is_cancelled(),
        () = cancel.cancelled() => true,
    }
}

/// 在预算内重试 `PiSupervisor::start`（不可取消版本）。
///
/// 没有「停止」入口的调用方（测试、命令行工具）可以直接用这个；
/// 桌面端必须用 `start_with_retry_cancellable`，否则退避窗口无法中止。
pub async fn start_with_retry(
    supervisor: &PiSupervisor,
    session_id: &str,
    program: &PiProgram,
    ledger: &mut RetryLedger,
) -> SupervisorResult<RuntimeHandle> {
    start_with_retry_cancellable(supervisor, session_id, program, ledger, &RetryCancel::new()).await
}

/// 在预算内重试 `PiSupervisor::start`，并允许 `cancel` 打断退避窗口。
///
/// 只有 `FailureKind::is_retryable` 的失败会重试；其余立即返回原错误，
/// 并把预算钉死（`record_terminal`），使恢复入口无法再次自动重试。
/// 预算耗尽时返回 `SupervisorError::RetryBudgetExhausted`；用户中止（含退避期间中止）
/// 返回 `SupervisorError::RetryCancelled`，并把预算钉死为 `cancelled`，
/// 避免「中止后又被自动拉起」。保留检查点与工作树是上层责任——本函数不清理任何用户数据。
pub async fn start_with_retry_cancellable(
    supervisor: &PiSupervisor,
    session_id: &str,
    program: &PiProgram,
    ledger: &mut RetryLedger,
    cancel: &RetryCancel,
) -> SupervisorResult<RuntimeHandle> {
    // 新运行开始：未被判为耗尽时重新授予完整额度（耗尽状态不因重启而清除）。
    ledger.begin_run();
    loop {
        // 每次尝试前先看取消：已中止就不该再拉起子进程、再发一次可能计费的请求。
        if cancel.is_cancelled() {
            ledger.record_terminal(FailureKind::Cancelled);
            return Err(SupervisorError::RetryCancelled {
                attempts: ledger.attempts(),
            });
        }
        match supervisor.start(session_id, program).await {
            Ok(handle) => {
                ledger.record_success();
                return Ok(handle);
            }
            Err(error) => {
                let kind = classify_error(&error);
                if !kind.is_retryable() {
                    ledger.record_terminal(kind);
                    return Err(error);
                }
                match ledger.record_failure(kind) {
                    Some(backoff) => {
                        // 退避窗口可取消：用户点「停止」时立刻收手，不再多拉起一次子进程。
                        if wait_backoff(backoff, cancel).await {
                            ledger.record_terminal(FailureKind::Cancelled);
                            return Err(SupervisorError::RetryCancelled {
                                attempts: ledger.attempts(),
                            });
                        }
                    }
                    None => {
                        return Err(SupervisorError::RetryBudgetExhausted {
                            attempts: ledger.attempts(),
                            last: kind.as_str().to_owned(),
                        });
                    }
                }
            }
        }
    }
}
