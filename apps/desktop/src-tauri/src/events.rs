//! 运行时事件 → 前端事件的映射。
//!
//! 每个事件都携带 (sessionId, runtimeId, generation)：前端按 generation 丢弃迟到事件，
//! 后端在 emit 之前已经按同一规则过滤过一次（双保险，见 `watch::GenerationGate`）。

use serde::Serialize;
use serde_json::Value;
use soxu_agent_runtime::SupervisorEvent;

/// 前端监听的事件名。
pub const RUNTIME_EVENT_NAME: &str = "soxu://runtime-event";

/// 事件体。`type` 为判别字段，与 `RuntimeEventKind` 的 snake_case 变体名一致。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RuntimeEventKind {
    State { state: String },
    Stream { event: String, data: Option<Value> },
    Settled,
    Stderr { line: String },
    Warning { detail: String },
    Exit { code: Option<i32>, reason: String },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeEvent {
    pub session_id: String,
    pub runtime_id: String,
    pub generation: u64,
    #[serde(flatten)]
    pub kind: RuntimeEventKind,
}

impl RuntimeEvent {
    pub fn new(
        session_id: impl Into<String>,
        runtime_id: impl Into<String>,
        generation: u64,
        kind: RuntimeEventKind,
    ) -> Self {
        Self {
            session_id: session_id.into(),
            runtime_id: runtime_id.into(),
            generation,
            kind,
        }
    }
}

/// 把 supervisor 事件映射成前端可消费的事件；无法映射的诊断也会显式上报。
pub fn map_event(event: &SupervisorEvent) -> Option<RuntimeEventKind> {
    match event {
        SupervisorEvent::StateChanged { state } => Some(RuntimeEventKind::State {
            state: state.as_str().to_owned(),
        }),
        SupervisorEvent::AgentEvent { kind, data } => Some(RuntimeEventKind::Stream {
            event: kind.clone(),
            data: data.clone(),
        }),
        SupervisorEvent::Settled => Some(RuntimeEventKind::Settled),
        SupervisorEvent::Stderr { line } => Some(RuntimeEventKind::Stderr { line: line.clone() }),
        SupervisorEvent::ProtocolWarning { detail } => Some(RuntimeEventKind::Warning {
            detail: detail.clone(),
        }),
        SupervisorEvent::UnmatchedResponse { request_id } => Some(RuntimeEventKind::Warning {
            detail: format!("未匹配的 response：{request_id}"),
        }),
        SupervisorEvent::UnhandledRecord { kind } => Some(RuntimeEventKind::Warning {
            detail: format!("未处理的记录类型：{kind}"),
        }),
        SupervisorEvent::Exit { info } => Some(RuntimeEventKind::Exit {
            code: info.code,
            reason: info.reason.as_str().to_owned(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soxu_agent_runtime::{ExitInfo, ExitReason, RuntimeState};

    #[test]
    fn state_and_exit_events_carry_stable_strings() {
        let state = map_event(&SupervisorEvent::StateChanged {
            state: RuntimeState::Running,
        });
        assert_eq!(
            state,
            Some(RuntimeEventKind::State {
                state: "running".to_owned()
            })
        );
        let exit = map_event(&SupervisorEvent::Exit {
            info: ExitInfo {
                code: Some(3),
                reason: ExitReason::RequestedAbort,
            },
        });
        assert_eq!(
            exit,
            Some(RuntimeEventKind::Exit {
                code: Some(3),
                reason: "requested_abort".to_owned()
            })
        );
    }

    #[test]
    fn serialized_event_is_flat_and_camel_case() {
        let event = RuntimeEvent::new(
            "ses_a",
            "ses_a#1",
            7,
            RuntimeEventKind::Stream {
                event: "message_update".to_owned(),
                data: Some(serde_json::json!({ "delta": "hi" })),
            },
        );
        let value = serde_json::to_value(&event).unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(value["sessionId"], "ses_a");
        assert_eq!(value["runtimeId"], "ses_a#1");
        assert_eq!(value["generation"], 7);
        assert_eq!(value["type"], "stream");
        assert_eq!(value["event"], "message_update");
        assert!(value.get("kind").is_none());
    }
}
