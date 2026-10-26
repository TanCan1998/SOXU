//! Pi RPC 的最小数据契约；完整 Supervisor 在后续任务中实现。
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
pub enum PiCommand {
    #[serde(rename = "get_state")]
    GetState { id: String },
    #[serde(rename = "prompt")]
    Prompt { id: String, message: String },
    #[serde(rename = "abort")]
    Abort { id: String },
}

#[derive(Debug, Clone, Deserialize)]
pub struct RpcRecord {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub success: Option<bool>,
}

pub fn encode_command(value: &PiCommand) -> Result<String, serde_json::Error> {
    serde_json::to_string(value).map(|s| format!("{s}\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn prompt_is_one_json_record() {
        let value = encode_command(&PiCommand::Prompt {
            id: "req-1".into(),
            message: "Hi".into(),
        })
        .unwrap();
        assert!(value.ends_with('\n'));
        assert!(value.contains("\"type\":\"prompt\""));
    }
}
