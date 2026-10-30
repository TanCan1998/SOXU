//! 从 Pi 事件的 `data` 里提取 token 用量与上下文窗口。
//!
//! Pi RPC 只保证外层 `{"type":"event","event":"…"}`，`data` 是自由 JSON
//! （见 `soxu_pi_protocol`）。因此这里做**宽容但保守**的解析：
//!
//! - 只认明确的数字字段，字段名同时接受 camelCase 与 snake_case
//!   （Pi 生态里 `cacheRead` 与 `cache_read` 都出现过）；
//! - 找不到就返回 `None`，**绝不估算**——把缺失值编成 0 会让「缓存命中 0%」
//!   与「模型没有报缓存」看起来一模一样；
//! - 只在事件对象内部向下找有限层（`MAX_DEPTH`），不递归整个 payload：
//!   工具输出可能有任意深度，统计不该为它付出代价。
//!
//! 已知限制：真实 `pi --mode rpc` 的事件全集尚未实机核对
//! （`docs/development/agent-runtime.md` 的未验证项），这里覆盖的是
//! `message_update` / `message_end` / `turn_end` 常见的 usage 承载位置；
//! 解析不到时界面显示占位，不会显示错误数字。

use serde_json::Value;

/// 向 payload 内部查找的最大层数（含起始层）。
const MAX_DEPTH: usize = 3;

/// 一次用量观测：Pi 每个请求都会回报这四个数（缺项按 0 处理）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct UsageSample {
    /// 非缓存输入 token。
    pub input: u64,
    /// 输出 token。
    pub output: u64,
    /// 命中缓存的输入 token。
    pub cache_read: u64,
    /// 写入缓存的输入 token。
    pub cache_write: u64,
}

impl UsageSample {
    /// 这一次请求实际占用的上下文 = 输入 + 缓存读 + 缓存写。
    pub fn prompt_tokens(&self) -> u64 {
        self.input
            .saturating_add(self.cache_read)
            .saturating_add(self.cache_write)
    }

    /// 缓存命中率（0–100）。没有任何输入时返回 `None`：0/0 不是「0%」。
    pub fn cache_hit_pct(&self) -> Option<f64> {
        let prompt = self.prompt_tokens();
        if prompt == 0 {
            return None;
        }
        Some((self.cache_read as f64 / prompt as f64) * 100.0)
    }

    /// 完全空的用量（四个字段都是 0）视为「没有观测到」，不作为有效样本。
    pub fn is_empty(&self) -> bool {
        self.input == 0 && self.output == 0 && self.cache_read == 0 && self.cache_write == 0
    }
}

/// 从事件 data 里取出用量；找不到返回 `None`。
pub fn parse_usage(data: &Value) -> Option<UsageSample> {
    let object = find_usage_object(data, 0)?;
    let sample = UsageSample {
        input: number(object, &["input", "inputTokens", "input_tokens"]),
        output: number(object, &["output", "outputTokens", "output_tokens"]),
        cache_read: number(object, &["cacheRead", "cache_read", "cacheReadTokens"]),
        cache_write: number(object, &["cacheWrite", "cache_write", "cacheWriteTokens"]),
    };
    if sample.is_empty() {
        return None;
    }
    Some(sample)
}

/// 从事件 data 里取出模型上下文窗口（token 数）；找不到返回 `None`。
pub fn parse_context_window(data: &Value) -> Option<u64> {
    find_number(
        data,
        &["contextWindow", "context_window", "contextLength"],
        0,
    )
}

/// 事件 data 里是否带可上屏的文本增量。
///
/// 与前端 `mapping.ts::deltaText` 的口径一致：`delta` / `text` / `content` 字符串，
/// 或 `message.content` 的字符串/文本块数组。只用于判断「首 token 到了」。
pub fn has_text_delta(data: &Value) -> bool {
    match data {
        Value::String(text) => !text.is_empty(),
        Value::Object(object) => {
            for key in ["delta", "text", "content"] {
                if let Some(Value::String(text)) = object.get(key)
                    && !text.is_empty()
                {
                    return true;
                }
            }
            if let Some(Value::Object(message)) = object.get("message")
                && let Some(content) = message.get("content")
            {
                return match content {
                    Value::String(text) => !text.is_empty(),
                    Value::Array(blocks) => blocks.iter().any(|block| match block {
                        Value::Object(fields) => {
                            fields.get("type").and_then(Value::as_str) == Some("text")
                                && fields
                                    .get("text")
                                    .and_then(Value::as_str)
                                    .is_some_and(|text| !text.is_empty())
                        }
                        _ => false,
                    }),
                    _ => false,
                };
            }
            false
        }
        _ => false,
    }
}

/// 找到承载 usage 的对象：`{...usage:{…}}` 或 `{...message:{…usage:{…}}}`。
fn find_usage_object(value: &Value, depth: usize) -> Option<&Value> {
    if depth > MAX_DEPTH {
        return None;
    }
    let object = value.as_object()?;
    if let Some(Value::Object(usage)) = object.get("usage")
        && usage.keys().any(|key| {
            matches!(
                key.as_str(),
                "input" | "output" | "cacheRead" | "cache_read" | "inputTokens" | "outputTokens"
            )
        })
    {
        return object.get("usage");
    }
    // usage 常常挂在 message / result / data 下面：只走这三个已知分支，不遍历全部键。
    for key in ["message", "result", "data", "usage"] {
        if let Some(child) = object.get(key)
            && let Some(found) = find_usage_object(child, depth + 1)
        {
            return Some(found);
        }
    }
    None
}

/// 在有限深度内查找第一个命中任一候选键的数字。
fn find_number(value: &Value, keys: &[&str], depth: usize) -> Option<u64> {
    if depth > MAX_DEPTH {
        return None;
    }
    let object = value.as_object()?;
    for key in keys {
        if let Some(found) = object.get(*key).and_then(as_u64) {
            return Some(found);
        }
    }
    for key in ["message", "model", "result", "data", "context"] {
        if let Some(child) = object.get(key)
            && let Some(found) = find_number(child, keys, depth + 1)
        {
            return Some(found);
        }
    }
    None
}

fn number(object: &Value, keys: &[&str]) -> u64 {
    keys.iter()
        .find_map(|key| object.get(*key).and_then(as_u64))
        .unwrap_or(0)
}

/// 接受整数与「整数值的浮点」（JSON 里 `200000` 与 `200000.0` 都是合法写法）。
fn as_u64(value: &Value) -> Option<u64> {
    if let Some(number) = value.as_u64() {
        return Some(number);
    }
    let float = value.as_f64()?;
    if float.is_finite() && float >= 0.0 && float <= u64::MAX as f64 {
        Some(float as u64)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn usage_at_message_update_is_parsed() {
        let data = json!({
            "delta": "你好",
            "message": {
                "role": "assistant",
                "usage": { "input": 1200, "output": 340, "cacheRead": 800, "cacheWrite": 0 }
            }
        });
        let usage = parse_usage(&data).expect("usage 必须能解析出来");
        assert_eq!(usage.input, 1200);
        assert_eq!(usage.output, 340);
        assert_eq!(usage.cache_read, 800);
        // 上下文占用 = 1200 + 800 + 0，不含输出。
        assert_eq!(usage.prompt_tokens(), 2000);
        assert_eq!(usage.cache_hit_pct(), Some(40.0));
    }

    #[test]
    fn snake_case_usage_is_accepted() {
        let data = json!({ "usage": { "input": 10, "output": 2, "cache_read": 30 } });
        let usage = parse_usage(&data).expect("snake_case 也要认");
        assert_eq!(usage.cache_read, 30);
        assert_eq!(usage.prompt_tokens(), 40);
        assert_eq!(usage.cache_hit_pct(), Some(75.0));
    }

    #[test]
    fn missing_usage_is_none_not_zero() {
        for data in [
            json!({ "delta": "文本" }),
            json!({ "usage": {} }),
            json!({ "usage": { "input": 0, "output": 0 } }),
            json!(null),
            json!("纯字符串"),
        ] {
            assert!(parse_usage(&data).is_none(), "{data} 不应被当成有效用量");
        }
    }

    #[test]
    fn context_window_is_found_at_model_and_top_level() {
        assert_eq!(
            parse_context_window(&json!({ "contextWindow": 200000 })),
            Some(200_000)
        );
        assert_eq!(
            parse_context_window(&json!({ "message": { "model": { "contextWindow": 128000.0 } } })),
            Some(128_000)
        );
        assert_eq!(parse_context_window(&json!({ "delta": "x" })), None);
    }

    #[test]
    fn text_delta_detection_matches_frontend_contract() {
        assert!(has_text_delta(&json!({ "delta": "a" })));
        assert!(has_text_delta(&json!({ "text": "a" })));
        assert!(has_text_delta(&json!({ "content": "a" })));
        assert!(has_text_delta(&json!({
            "message": { "content": [{ "type": "text", "text": "a" }] }
        })));
        // 只有 usage 没有文本：不算首 token 到达。
        assert!(!has_text_delta(
            &json!({ "message": { "usage": { "output": 1 } } })
        ));
        assert!(!has_text_delta(&json!({ "delta": "" })));
        assert!(!has_text_delta(&json!(12)));
    }

    #[test]
    fn deep_payloads_are_not_walked_forever() {
        // 深度超过 MAX_DEPTH 的 usage 视为未观测：统计不为任意 payload 付代价。
        let data = json!({
            "data": { "data": { "data": { "data": { "usage": { "input": 1 } } } } }
        });
        assert!(parse_usage(&data).is_none());
    }
}
