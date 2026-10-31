//! MCP 服务列表（Issue #147）：只读 mcp.json，只取名字 / 传输方式 / 描述。

use serde_json::Value;

use super::entry::clip;
use crate::dto::{McpServerItem, McpStatus};

// ── MCP 服务 ────────────────────────────────────────────────────

/// mcp.json 的 mcpServers：只取名字、传输方式与描述。
///
/// headers / env / args 一律不读：里面常放 token，凭据属于 Pi，不进 UI。
pub(super) fn scan_mcp_servers(mcp: &Value) -> Vec<McpServerItem> {
    let Some(servers) = mcp.get("mcpServers").and_then(Value::as_object) else {
        return Vec::new();
    };
    let mut items: Vec<McpServerItem> = servers
        .iter()
        .map(|(name, value)| McpServerItem {
            id: format!("mcp:{name}"),
            name: name.clone(),
            transport: transport_of(value),
            description: value.get("description").and_then(Value::as_str).map(clip),
            // 只读模式下无法探测连接：固定 unknown，界面显示「未知」而不是伪造「已连接」。
            status: McpStatus::Unknown,
        })
        .collect();
    items.sort_by_key(|item| item.name.to_lowercase());
    items
}

fn transport_of(value: &Value) -> Option<String> {
    if let Some(kind) = value.get("type").and_then(Value::as_str) {
        return Some(kind.to_owned());
    }
    if let Some(url) = value.get("url").and_then(Value::as_str) {
        // 只根据 URL 形状区分：/sse 结尾的是 SSE 端点，其余按 HTTP 处理。
        return Some(if url.contains("/sse") { "sse" } else { "http" }.to_owned());
    }
    value.get("command").is_some().then(|| "stdio".to_owned())
}
