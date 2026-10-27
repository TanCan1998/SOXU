//! 集成测试共用的夹具启动、事件收集与断言工具。
#![allow(dead_code)]

use std::ffi::OsString;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use soxu_agent_runtime::{PiProgram, RuntimeHandle, SupervisorEvent};

/// 启动 `tests/fixtures/fake-pi.mjs`。
///
/// 用 Node（已批准基线 Node >= 24）跑夹具，避免为测试往产品 crate 里塞假二进制。
pub fn fake_pi(mode: &str, label: &str) -> PiProgram {
    let node = std::env::var("NODE_BINARY").unwrap_or_else(|_| "node".to_owned());
    let script: PathBuf = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("fake-pi.mjs");
    let args: Vec<OsString> = vec![script.into_os_string(), mode.into(), label.into()];
    PiProgram::new(node).with_args(args)
}

/// 读取事件直到 agent_settled；返回 settled 之前的事件（含诊断与状态事件）。
pub async fn settle(handle: &mut RuntimeHandle, wait: Duration) -> Vec<SupervisorEvent> {
    let deadline = Instant::now() + wait;
    let mut seen = Vec::new();
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        assert!(
            !remaining.is_zero(),
            "等待 agent_settled 超时，已收到 {seen:?}"
        );
        let event = handle
            .recv_timeout(remaining)
            .await
            .unwrap_or_else(|error| panic!("读取事件失败: {error}，已收到 {seen:?}"));
        match event {
            Some(SupervisorEvent::Settled) => return seen,
            Some(SupervisorEvent::Exit { info }) => {
                panic!("进程提前退出: {info:?}，已收到 {seen:?}")
            }
            Some(event) => seen.push(event),
            None => panic!("事件流提前结束，已收到 {seen:?}"),
        }
    }
}

/// 取出 agent 事件名序列，便于断言顺序。
pub fn agent_kinds(events: &[SupervisorEvent]) -> Vec<String> {
    events
        .iter()
        .filter_map(|event| match event {
            SupervisorEvent::AgentEvent { kind, .. } => Some(kind.clone()),
            _ => None,
        })
        .collect()
}

/// 取出所有 agent 事件里的 sessionId 标记，用于证明会话没有串线。
pub fn session_labels(events: &[SupervisorEvent]) -> Vec<String> {
    events
        .iter()
        .filter_map(|event| match event {
            SupervisorEvent::AgentEvent { data, .. } => data
                .as_ref()
                .and_then(|data| data.get("sessionId"))
                .and_then(|label| label.as_str())
                .map(str::to_owned),
            _ => None,
        })
        .collect()
}
