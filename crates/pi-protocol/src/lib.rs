//! Pi RPC（pi --mode rpc）的 stdio NDJSON 数据契约。
//!
//! 本 crate 只描述线协议：命令编码、入站记录解码、单条记录上限、事件名判定。
//! 进程所有权、超时、取消与 generation 隔离归 soxu-agent-runtime。

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 单条 NDJSON 记录字节上限（不含换行符）。
///
/// 超出上限说明流已失步：调用方必须终止子进程，而不是继续猜测边界。
pub const MAX_RECORD_BYTES: usize = 1024 * 1024;

/// 一轮执行「完全安定」的唯一事件名；agent_end 不能代替它。
pub const EVENT_AGENT_SETTLED: &str = "agent_settled";

/// 扩展 UI 请求的记录类型。SOXU 尚未实现扩展 UI，必须显式警告并按拒绝处理。
pub const RECORD_EXTENSION_UI_REQUEST: &str = "extension_ui_request";

/// Pi 会话事件的顶层 `type` 取值（Pi 1.4 的 docs/json.md「Event sequence」与各事件表）。
///
/// 真实帧是**扁平**的：`{"type":"agent_settled","aborted":false}`，不是
/// `{"type":"event","event":"agent_settled"}`。不把这批名字认成事件，
/// `agent_settled` 就会落进 UnhandledRecord：前端永远等不到「本轮安定」，
/// 状态卡在 running、排队回执也不会消失（Issue #146 实机走查复现）。
/// 这里只列会话事件；扩展 UI 请求仍是 `Other`，由上层按拒绝处理。
pub const SESSION_EVENT_TYPES: [&str; 19] = [
    "agent_start",
    "agent_end",
    "agent_settled",
    "turn_start",
    "turn_end",
    "message_start",
    "message_update",
    "message_end",
    "tool_execution_start",
    "tool_execution_update",
    "tool_execution_end",
    "queue_update",
    "entry_appended",
    "session_info_changed",
    "thinking_level_changed",
    "compaction_start",
    "compaction_end",
    "auto_retry_start",
    "auto_retry_end",
];

/// 这条记录是不是 Pi 的会话事件（顶层 type）。
pub fn is_session_event(kind: &str) -> bool {
    SESSION_EVENT_TYPES.contains(&kind)
}

/// 诊断文本里保留的最大字符数，避免把整段输出写进事件通道。
const DIAGNOSTIC_CHARS: usize = 160;

/// 忙碌时投递一条 prompt 的排队方式（Pi RPC 的 `streamingBehavior`）。
///
/// 事实来源：Pi 1.4 的 docs/rpc-commands.md 与实测记录
/// （docs/development/send-modes.md）。agent 正在流式输出时，**不带**这个字段的
/// prompt 会被 Pi 直接拒绝（success=false），而不是静默排队。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum StreamingBehavior {
    /// 本轮助手回合（含工具调用）结束后、下一次 LLM 调用前插入。
    #[serde(rename = "steer")]
    Steer,
    /// 等 agent 完全停下（agent_settled）之后再作为下一轮处理。
    #[serde(rename = "followUp")]
    FollowUp,
}

/// 出站命令。type 字段与 Pi RPC 线格式一致。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type")]
pub enum PiCommand {
    #[serde(rename = "get_state")]
    GetState { id: String },
    /// `streamingBehavior` 只在忙碌时出现：空闲时省略，线格式与旧版完全一致。
    #[serde(rename = "prompt")]
    Prompt {
        id: String,
        message: String,
        #[serde(rename = "streamingBehavior", skip_serializing_if = "Option::is_none")]
        streaming_behavior: Option<StreamingBehavior>,
    },
    /// 清空 Pi 侧的 steering / follow-up 队列，返回被清掉的消息文本。
    #[serde(rename = "clear_queue")]
    ClearQueue { id: String },
    #[serde(rename = "abort")]
    Abort { id: String },
}

impl PiCommand {
    /// 空闲时的一条普通 prompt：不带 streamingBehavior。
    pub fn prompt(id: impl Into<String>, message: impl Into<String>) -> Self {
        Self::Prompt {
            id: id.into(),
            message: message.into(),
            streaming_behavior: None,
        }
    }

    /// 忙碌时的投递：带上排队方式，否则 Pi 会拒绝这条 prompt。
    pub fn prompt_while_busy(
        id: impl Into<String>,
        message: impl Into<String>,
        behavior: StreamingBehavior,
    ) -> Self {
        Self::Prompt {
            id: id.into(),
            message: message.into(),
            streaming_behavior: Some(behavior),
        }
    }

    /// 请求 id；用于 pending 关联与重复 id 检测。
    pub fn id(&self) -> &str {
        match self {
            Self::GetState { id }
            | Self::Prompt { id, .. }
            | Self::ClearQueue { id }
            | Self::Abort { id } => id,
        }
    }

    /// 线协议里的命令名。
    pub fn kind(&self) -> &'static str {
        match self {
            Self::GetState { .. } => "get_state",
            Self::Prompt { .. } => "prompt",
            Self::ClearQueue { .. } => "clear_queue",
            Self::Abort { .. } => "abort",
        }
    }
}

/// 把命令编码成「一行 + LF」。
///
/// 只做 JSON 转义，不做换行拼接，因此命令内容里的换行/中文都不会破坏分帧。
pub fn encode_command(command: &PiCommand) -> Result<String, ProtocolError> {
    if command.id().trim().is_empty() {
        return Err(ProtocolError::EmptyId);
    }
    let mut line =
        serde_json::to_string(command).map_err(|err| ProtocolError::Encode(err.to_string()))?;
    line.push('\n');
    Ok(line)
}

/// type=response 记录：success 只代表命令被接收，不代表执行结束。
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct RpcResponse {
    pub id: String,
    #[serde(default)]
    pub command: Option<String>,
    /// 缺省按失败处理（fail-closed），避免把无法判定的响应当成成功。
    #[serde(default)]
    pub success: bool,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub data: Option<Value>,
}

impl RpcResponse {
    /// 结构化的失败描述，供上层显示；不包含 stdout 原始字节。
    pub fn failure_message(&self) -> Option<String> {
        if self.success {
            return None;
        }
        Some(match &self.error {
            Some(error) => error.clone(),
            None => "agent rejected the command without a reason".to_owned(),
        })
    }
}

/// type=event 记录：例如 agent_start、agent_settled。
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct RpcEvent {
    pub event: String,
    #[serde(default)]
    pub data: Option<Value>,
}

/// 一条已分帧的入站记录。
#[derive(Debug, Clone, PartialEq)]
pub enum Inbound {
    Response(RpcResponse),
    Event(RpcEvent),
    /// 未知 type（例如未来的扩展 UI 请求）。原样保留，交给上层决定。
    Other {
        kind: String,
        payload: Value,
    },
}

/// 解析一行 NDJSON。
pub fn decode_inbound(line: &str) -> Result<Inbound, ProtocolError> {
    let trimmed = line.trim_end_matches('\r');
    if trimmed.trim().is_empty() {
        return Err(ProtocolError::EmptyLine);
    }
    let payload: Value = serde_json::from_str(trimmed)
        .map_err(|err| ProtocolError::InvalidJson(truncate(&err.to_string())))?;
    let object = payload.as_object().ok_or(ProtocolError::NotAnObject)?;
    let kind = object
        .get("type")
        .and_then(Value::as_str)
        .ok_or(ProtocolError::MissingField("type"))?
        .to_owned();

    match kind.as_str() {
        "response" => {
            let response: RpcResponse = serde_json::from_value(payload.clone())
                .map_err(|_| ProtocolError::MissingField("id"))?;
            Ok(Inbound::Response(response))
        }
        "event" => {
            let event: RpcEvent = serde_json::from_value(payload.clone())
                .map_err(|_| ProtocolError::MissingField("event"))?;
            Ok(Inbound::Event(event))
        }
        // Pi 1.4.0 的真实帧：事件就是顶层 type，其余字段平铺在同一层。
        // data 里去掉判别字段，调用方因此不用关心记录是被包装还是扁平的。
        _ if is_session_event(&kind) => {
            let data = payload.as_object().and_then(|object| {
                let mut rest = object.clone();
                rest.remove("type");
                (!rest.is_empty()).then_some(Value::Object(rest))
            });
            Ok(Inbound::Event(RpcEvent { event: kind, data }))
        }
        _ => Ok(Inbound::Other { kind, payload }),
    }
}

/// 协议层错误；Display 输出被截断，避免把大段/敏感内容写进日志。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProtocolError {
    EmptyId,
    EmptyLine,
    Encode(String),
    InvalidJson(String),
    NotAnObject,
    MissingField(&'static str),
}

impl std::fmt::Display for ProtocolError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::EmptyId => write!(formatter, "request id must not be empty"),
            Self::EmptyLine => write!(formatter, "empty NDJSON line"),
            Self::Encode(detail) => {
                write!(formatter, "cannot encode command: {}", truncate(detail))
            }
            // Display 也要截断：错误文本可能来自任意大小的子进程输入。
            Self::InvalidJson(detail) => {
                write!(formatter, "malformed JSON record: {}", truncate(detail))
            }
            Self::NotAnObject => write!(formatter, "record is not a JSON object"),
            Self::MissingField(field) => {
                write!(formatter, "record is missing required field {field}")
            }
        }
    }
}

impl std::error::Error for ProtocolError {}

fn truncate(value: &str) -> String {
    if value.chars().count() <= DIAGNOSTIC_CHARS {
        return value.to_owned();
    }
    value.chars().take(DIAGNOSTIC_CHARS).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_is_one_json_record() {
        let value = encode_command(&PiCommand::prompt("req-1", "Hi\n第二行")).unwrap();
        assert!(value.ends_with('\n'));
        assert_eq!(
            value.matches('\n').count(),
            1,
            "换行必须被 JSON 转义，不能破坏分帧"
        );
        assert!(value.contains("\"type\":\"prompt\""));
        assert!(
            !value.contains("streamingBehavior"),
            "空闲投递不带 streamingBehavior：线格式与旧版一致"
        );
    }

    /// 忙碌时投递必须带上 Pi 认识的 streamingBehavior 取值，否则 Pi 会拒绝。
    #[test]
    fn busy_prompt_carries_streaming_behavior() {
        for (behavior, wire) in [
            (StreamingBehavior::Steer, "steer"),
            (StreamingBehavior::FollowUp, "followUp"),
        ] {
            let value =
                encode_command(&PiCommand::prompt_while_busy("req-2", "插一句", behavior)).unwrap();
            assert!(
                value.contains(&format!("\"streamingBehavior\":\"{wire}\"")),
                "线格式必须是 Pi 文档里的 {wire}：{value}"
            );
            assert!(value.contains("\"type\":\"prompt\""));
        }
    }

    #[test]
    fn clear_queue_uses_the_documented_command_name() {
        let value = encode_command(&PiCommand::ClearQueue { id: "req-3".into() }).unwrap();
        assert!(value.contains("\"type\":\"clear_queue\""));
    }

    #[test]
    fn empty_id_is_rejected() {
        let error = encode_command(&PiCommand::Abort { id: "  ".into() }).unwrap_err();
        assert_eq!(error, ProtocolError::EmptyId);
    }

    #[test]
    fn decodes_response_and_keeps_failure_reason() {
        let inbound = decode_inbound(
            "{\"type\":\"response\",\"id\":\"r1\",\"success\":false,\"error\":\"rate limited\"}",
        )
        .unwrap();
        let Inbound::Response(response) = inbound else {
            panic!("expected response");
        };
        assert_eq!(response.id, "r1");
        assert_eq!(response.failure_message().as_deref(), Some("rate limited"));
    }

    #[test]
    fn missing_success_is_treated_as_failure() {
        let inbound = decode_inbound("{\"type\":\"response\",\"id\":\"r1\"}").unwrap();
        let Inbound::Response(response) = inbound else {
            panic!("expected response");
        };
        assert!(!response.success);
    }

    #[test]
    fn decodes_settled_event() {
        let inbound = decode_inbound(
            "{\"type\":\"event\",\"event\":\"agent_settled\",\"data\":{\"sessionId\":\"s\"}}",
        )
        .unwrap();
        let Inbound::Event(event) = inbound else {
            panic!("expected event");
        };
        assert_eq!(event.event, EVENT_AGENT_SETTLED);
    }

    /// 真实帧（摘自已落库的探测证据 probe-windows.json）必须被认成事件。
    #[test]
    fn top_level_session_events_are_decoded_as_events() {
        let settled = decode_inbound("{\"type\":\"agent_settled\",\"aborted\":false}").unwrap();
        let Inbound::Event(event) = settled else {
            panic!("扁平 agent_settled 必须被认成事件");
        };
        assert_eq!(event.event, EVENT_AGENT_SETTLED);
        assert_eq!(
            event.data.as_ref().map(|data| data["aborted"].clone()),
            Some(serde_json::json!(false))
        );

        // 没有额外字段的事件不需要空对象 data。
        let started = decode_inbound("{\"type\":\"agent_start\"}").unwrap();
        let Inbound::Event(event) = started else {
            panic!("扁平 agent_start 必须被认成事件");
        };
        assert_eq!(event.event, "agent_start");
        assert_eq!(event.data, None);

        // 流式与队列事件携带的字段必须原样保留在 data 里。
        let update = decode_inbound(
            "{\"type\":\"message_update\",\"assistantMessageEvent\":{\"type\":\"text_delta\",\"delta\":\"Hi\"}}",
        )
        .unwrap();
        let Inbound::Event(event) = update else {
            panic!("扁平 message_update 必须被认成事件");
        };
        assert_eq!(event.event, "message_update");
        assert_eq!(
            event
                .data
                .as_ref()
                .map(|data| data["assistantMessageEvent"]["delta"].clone()),
            Some(serde_json::json!("Hi"))
        );

        let queue =
            decode_inbound("{\"type\":\"queue_update\",\"steering\":[],\"followUp\":[\"x\"]}")
                .unwrap();
        let Inbound::Event(event) = queue else {
            panic!("扁平 queue_update 必须被认成事件");
        };
        assert_eq!(event.event, "queue_update");
        assert_eq!(
            event.data.as_ref().map(|data| data["followUp"][0].clone()),
            Some(serde_json::json!("x"))
        );
    }

    #[test]
    fn unknown_type_is_preserved_not_dropped() {
        let inbound =
            decode_inbound("{\"type\":\"extension_ui_request\",\"id\":\"ui-1\"}").unwrap();
        let Inbound::Other { kind, payload } = inbound else {
            panic!("expected other");
        };
        assert_eq!(kind, "extension_ui_request");
        assert_eq!(payload["id"], serde_json::json!("ui-1"));
    }

    #[test]
    fn malformed_records_report_structured_errors() {
        assert!(matches!(
            decode_inbound("not json"),
            Err(ProtocolError::InvalidJson(_))
        ));
        assert!(matches!(
            decode_inbound("[1,2]"),
            Err(ProtocolError::NotAnObject)
        ));
        assert!(matches!(
            decode_inbound("{\"type\":\"response\"}"),
            Err(ProtocolError::MissingField("id"))
        ));
        assert!(matches!(
            decode_inbound("{\"type\":\"event\"}"),
            Err(ProtocolError::MissingField("event"))
        ));
        assert!(matches!(
            decode_inbound("\r"),
            Err(ProtocolError::EmptyLine)
        ));
    }

    #[test]
    fn diagnostics_are_truncated() {
        // 直接验证截断与 Display：serde 自身的错误文本很短，不能作为长度证据。
        let detail = truncate(&"a".repeat(5000));
        assert_eq!(detail.chars().count(), DIAGNOSTIC_CHARS);
        let rendered = ProtocolError::InvalidJson("b".repeat(5000)).to_string();
        assert!(rendered.chars().count() <= DIAGNOSTIC_CHARS + 32);
        // 真实解析路径仍必须给出结构化错误类型。
        assert!(matches!(
            decode_inbound(&format!(
                "{{\"type\":\"response\",\"id\":{}}}",
                "a".repeat(64)
            )),
            Err(ProtocolError::InvalidJson(_))
        ));
    }
}
