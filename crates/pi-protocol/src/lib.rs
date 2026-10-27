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

/// 诊断文本里保留的最大字符数，避免把整段输出写进事件通道。
const DIAGNOSTIC_CHARS: usize = 160;

/// 出站命令。type 字段与 Pi RPC 线格式一致。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type")]
pub enum PiCommand {
    #[serde(rename = "get_state")]
    GetState { id: String },
    #[serde(rename = "prompt")]
    Prompt { id: String, message: String },
    #[serde(rename = "abort")]
    Abort { id: String },
}

impl PiCommand {
    /// 请求 id；用于 pending 关联与重复 id 检测。
    pub fn id(&self) -> &str {
        match self {
            Self::GetState { id } | Self::Prompt { id, .. } | Self::Abort { id } => id,
        }
    }

    /// 线协议里的命令名。
    pub fn kind(&self) -> &'static str {
        match self {
            Self::GetState { .. } => "get_state",
            Self::Prompt { .. } => "prompt",
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
        let value = encode_command(&PiCommand::Prompt {
            id: "req-1".into(),
            message: "Hi\n第二行".into(),
        })
        .unwrap();
        assert!(value.ends_with('\n'));
        assert_eq!(
            value.matches('\n').count(),
            1,
            "换行必须被 JSON 转义，不能破坏分帧"
        );
        assert!(value.contains("\"type\":\"prompt\""));
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
