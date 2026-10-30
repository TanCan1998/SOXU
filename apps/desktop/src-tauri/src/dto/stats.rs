//! 会话统计 DTO（Issue #119 / TASK-027）。
//!
//! 契约来源：`docs/design/UIUX/V4/interaction-inventory.md` 第 5 节「输入区 composer」
//! 给出的 `session_stats` 返回形状，字段见 `docs/development/session-stats.md`。
//!
//! 一条贯穿全文件的规则：**没观测到就是 `None`，不是 0**。
//! 「本轮还没跑过」与「本轮耗时 0 ms」、「上下文占用未知」与「占用 0%」是两件不同的事，
//! 前者必须让界面显示占位符。因此除 `sessionId` 外所有数值字段都是 `Option`，
//! 前端不得用 `?? 0` 把它们抹平。

use serde::Serialize;
use soxu_agent_runtime::retry::RetryStatus;

/// `session_stats` 的完整返回值：四组指标 + 执行身份。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStats {
    pub session_id: String,
    /// 当前运行时的临时身份；没有运行时（或从未启动）时为 `None`。
    pub runtime_id: Option<String>,
    pub generation: Option<u64>,
    pub context: ContextStats,
    pub turn: TurnStats,
    pub process: ProcessStats,
    pub session: SessionStatsInfo,
    /// 最后一次观测到运行时事件的时间（Unix 毫秒）。
    ///
    /// `None` 表示本进程内还没观测到该会话的任何事件——此时圆环与浮窗都必须显示占位，
    /// 而不是把「没有数据」画成「占用 0%」。
    pub updated_at_ms: Option<u64>,
}

/// 上下文占用（composer 右侧圆环的数据源）。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextStats {
    /// 最近一次请求实际占用的上下文 token 数（input + cacheRead + cacheWrite）。
    pub used: Option<u64>,
    /// 模型上下文窗口；Pi 的事件没带窗口信息时为 `None`（此时不猜占用率）。
    pub total: Option<u64>,
    /// `used / total` 的百分比（0–100，保留一位小数）。任一缺失时为 `None`。
    pub percent: Option<f64>,
}

/// 最近一轮（或正在进行的这一轮）的耗时与吞吐。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnStats {
    /// 已完成的轮次数（收到 `settled` 的次数）；一次都没跑完时为 `None`。
    pub turns: Option<u64>,
    /// 当前是否有一轮正在跑：为真时 `durationMs` / `firstTokenMs` 是**进行中**的实时值。
    pub in_flight: bool,
    /// 首 token 延迟：prompt 被接受 → 第一个带文本的流式事件。
    pub first_token_ms: Option<u64>,
    /// 回复耗时：prompt 被接受 → `settled`（进行中时为「到目前为止」）。
    pub duration_ms: Option<u64>,
    /// 流式速度：本轮输出 token / 首 token 到 `settled` 的秒数。
    pub stream_tokens_per_sec: Option<f64>,
    /// 均速：本轮输出 token / 整轮耗时。
    pub avg_tokens_per_sec: Option<f64>,
    /// 缓存命中率：cacheRead / (input + cacheRead + cacheWrite)。
    pub cache_hit_pct: Option<f64>,
}

/// 受管 Pi 进程树的资源占用（单次采样，不新增轮询）。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessStats {
    /// 进程树常驻内存（RSS / WorkingSet 之和），单位 MB。
    pub rss_mb: Option<f64>,
    /// CPU 占用百分比。当前平台的采样器不提供该指标，恒为 `None`（界面显示占位）。
    pub cpu_pct: Option<f64>,
    /// 除进程树根以外的子进程数（Pi 自己再拉起的进程）。
    pub child_count: Option<u32>,
    /// 采样降级说明（运行时未启动、平台不支持、部分进程已退出等）；空表示全部可用。
    pub degraded: Vec<String>,
}

/// 会话自身的信息：条目数、工作树、累计 token 与重试预算。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatsInfo {
    /// 会话文件里的条目总数（来自会话目录索引）；临时会话或未登记时为 `None`。
    pub entries_total: Option<u64>,
    /// 会话所属工作树的路径（索引里查不到时退回工作树 id）。
    pub worktree: Option<String>,
    /// 已完成的各轮输入 token 累计（prompt 侧，含缓存读写）。
    pub input_tokens: Option<u64>,
    /// 已完成的各轮输出 token 累计。
    pub output_tokens: Option<u64>,
    /// 重试预算快照；没有记录时为 `None`（界面显示「未发生重试」）。
    pub retry: Option<RetryStatus>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 空统计必须序列化成「处处 null」，前端据此显示占位而不是 0。
    #[test]
    fn empty_stats_serialize_to_nulls_not_zeroes() {
        let stats = SessionStats {
            session_id: "ses_a".to_owned(),
            ..SessionStats::default()
        };
        let value = serde_json::to_value(&stats).expect("serialize");
        assert_eq!(value["sessionId"], "ses_a");
        assert!(value["runtimeId"].is_null());
        assert!(value["context"]["used"].is_null());
        assert!(value["context"]["percent"].is_null());
        assert!(value["turn"]["turns"].is_null());
        assert_eq!(value["turn"]["inFlight"], serde_json::json!(false));
        assert!(value["process"]["rssMb"].is_null());
        assert_eq!(value["process"]["degraded"], serde_json::json!([]));
        assert!(value["session"]["inputTokens"].is_null());
        assert!(value["updatedAtMs"].is_null());
    }

    #[test]
    fn field_names_are_camel_case_for_the_frontend_contract() {
        let stats = SessionStats {
            session_id: "ses_a".to_owned(),
            runtime_id: Some("ses_a#1".to_owned()),
            generation: Some(3),
            context: ContextStats {
                used: Some(10),
                total: Some(100),
                percent: Some(10.0),
            },
            turn: TurnStats {
                turns: Some(2),
                in_flight: false,
                first_token_ms: Some(420),
                duration_ms: Some(2_400),
                stream_tokens_per_sec: Some(12.5),
                avg_tokens_per_sec: Some(9.5),
                cache_hit_pct: Some(80.0),
            },
            process: ProcessStats {
                rss_mb: Some(128.5),
                cpu_pct: None,
                child_count: Some(1),
                degraded: vec!["cpu_unsupported".to_owned()],
            },
            session: SessionStatsInfo {
                entries_total: Some(1_203),
                worktree: Some("F:/work/soxu".to_owned()),
                input_tokens: Some(9_000),
                output_tokens: Some(1_200),
                retry: None,
            },
            updated_at_ms: Some(1_700_000_000_000),
        };
        let value = serde_json::to_value(&stats).expect("serialize");
        assert_eq!(value["turn"]["firstTokenMs"], 420);
        assert_eq!(value["turn"]["streamTokensPerSec"], 12.5);
        assert_eq!(value["turn"]["avgTokensPerSec"], 9.5);
        assert_eq!(value["turn"]["cacheHitPct"], 80.0);
        assert_eq!(value["process"]["childCount"], 1);
        assert_eq!(value["session"]["entriesTotal"], 1_203);
        assert_eq!(value["session"]["outputTokens"], 1_200);
        assert_eq!(value["updatedAtMs"], 1_700_000_000_000u64);
    }
}
