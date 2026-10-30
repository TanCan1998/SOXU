//! 单会话统计的累加器：只吃运行时事件，不读磁盘、不起定时器、不轮询。
//!
//! 口径（与前端 `components/sessionStats.ts` 的展示文案逐条对应）：
//!
//! | 指标 | 定义 |
//! | --- | --- |
//! | 轮次 | 收到 `settled` 的次数（未正常结束的一轮不计数） |
//! | 首 token | prompt 被接受 → 第一个带文本的流式事件 |
//! | 回复耗时 | prompt 被接受 → `settled`（进行中时为「到目前为止」） |
//! | 流式速度 | 本轮输出 token / 首 token 到结束的秒数 |
//! | 均速 | 本轮输出 token / 整轮耗时 |
//! | 缓存命中 | cacheRead / (input + cacheRead + cacheWrite) |
//!
//! 两条不可让步的规则：
//! 1. **没有观测就是 None**。缺 usage 事件时速度与缓存命中保持 None，界面显示占位；
//!    编一个 0 会让「模型没报缓存」看起来像「一次都没命中」。
//! 2. **迟到的一轮不跨代**。新一代运行时开始时丢弃未完成的一轮（`begin_generation`），
//!    否则上一代的 prompt 计时会算到新代头上。

use std::time::{Duration, Instant};

use crate::events::RuntimeEventKind;

use super::usage::{self, UsageSample};

/// 已结算的一轮。
#[derive(Debug, Clone, PartialEq)]
struct CompletedTurn {
    first_token: Option<Duration>,
    duration: Duration,
    usage: Option<UsageSample>,
}

/// 进行中的一轮：只记时间点与最近一次 usage。
#[derive(Debug, Clone, PartialEq)]
struct InFlightTurn {
    started: Instant,
    first_token: Option<Instant>,
    usage: Option<UsageSample>,
}

/// 统计快照：纯数据，不含 `Instant`，可以直接映射成 DTO。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct StatsSnapshot {
    pub context_used: Option<u64>,
    pub context_total: Option<u64>,
    pub context_percent: Option<f64>,
    pub turns: Option<u64>,
    pub in_flight: bool,
    pub first_token_ms: Option<u64>,
    pub duration_ms: Option<u64>,
    pub stream_tokens_per_sec: Option<f64>,
    pub avg_tokens_per_sec: Option<f64>,
    pub cache_hit_pct: Option<f64>,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    /// 最后一次观测事件的时间；`None` 表示本进程内没观测到任何事件。
    pub updated_at: Option<Instant>,
}

/// 单会话累加器；`Default` 即「什么都没有」。
#[derive(Debug, Clone, Default)]
pub struct StatsAccumulator {
    generation: Option<u64>,
    turns: u64,
    in_flight: Option<InFlightTurn>,
    last_turn: Option<CompletedTurn>,
    latest_usage: Option<UsageSample>,
    context_window: Option<u64>,
    input_tokens: u64,
    output_tokens: u64,
    /// 是否真的累加过 token：区分「累计 0」与「从未观测」。
    has_tokens: bool,
    updated_at: Option<Instant>,
}

impl StatsAccumulator {
    /// 新一代运行时开始：丢弃未完成的一轮，累计值（token、轮次、重试预算）保留。
    pub fn begin_generation(&mut self, generation: u64, now: Instant) {
        if self.generation != Some(generation) {
            self.generation = Some(generation);
            // 上一代没等到 settled 的一轮不能算完成，也不能把计时带进新代。
            self.in_flight = None;
            self.updated_at = Some(now);
        }
    }

    /// prompt 已被 Pi 接受：开始计时一轮。
    pub fn note_prompt(&mut self, now: Instant) {
        self.in_flight = Some(InFlightTurn {
            started: now,
            first_token: None,
            usage: None,
        });
        self.updated_at = Some(now);
    }

    /// 消费一条运行时事件。调用方保证事件已通过 generation 闸门。
    pub fn observe(&mut self, kind: &RuntimeEventKind, now: Instant) {
        match kind {
            RuntimeEventKind::Stream {
                data: Some(data), ..
            } => {
                if let Some(sample) = usage::parse_usage(data) {
                    self.latest_usage = Some(sample);
                    if let Some(active) = self.in_flight.as_mut() {
                        active.usage = Some(sample);
                    }
                }
                if let Some(window) = usage::parse_context_window(data) {
                    self.context_window = Some(window);
                }
                if let Some(active) = self.in_flight.as_mut()
                    && active.first_token.is_none()
                    && usage::has_text_delta(data)
                {
                    active.first_token = Some(now);
                }
            }
            RuntimeEventKind::Settled => {
                if let Some(active) = self.in_flight.take() {
                    let duration = now.saturating_duration_since(active.started);
                    // 只有结算时才累加 token 总量：同一轮的多次 message_update 会重复报 usage，
                    // 逐条累加会把输入 token 翻好几倍。
                    if let Some(sample) = active.usage.or(self.latest_usage) {
                        self.input_tokens =
                            self.input_tokens.saturating_add(sample.prompt_tokens());
                        self.output_tokens = self.output_tokens.saturating_add(sample.output);
                        self.has_tokens = true;
                    }
                    self.last_turn = Some(CompletedTurn {
                        first_token: active
                            .first_token
                            .map(|at| at.saturating_duration_since(active.started)),
                        duration,
                        usage: active.usage,
                    });
                    self.turns = self.turns.saturating_add(1);
                }
            }
            // 进程异常退出：未完成的一轮不计数（既不算轮次，也不累加 token）。
            RuntimeEventKind::Exit { .. } => {
                self.in_flight = None;
            }
            _ => {}
        }
        self.updated_at = Some(now);
    }

    /// 生成快照。`now` 只用于「进行中这一轮」的实时耗时。
    pub fn snapshot(&self, now: Instant) -> StatsSnapshot {
        let context_used = self
            .latest_usage
            .map(|sample| sample.prompt_tokens())
            .filter(|used| *used > 0);
        let context_total = self.context_window.filter(|total| *total > 0);
        let context_percent = match (context_used, context_total) {
            (Some(used), Some(total)) => Some(round1(used as f64 / total as f64 * 100.0)),
            _ => None,
        };

        let cache_hit_pct = self
            .in_flight
            .as_ref()
            .and_then(|active| active.usage)
            .or(self.last_turn.as_ref().and_then(|turn| turn.usage))
            .or(self.latest_usage)
            .and_then(|sample| sample.cache_hit_pct())
            .map(round1);

        let (first_token_ms, duration_ms, stream_tps, avg_tps) =
            match (&self.in_flight, &self.last_turn) {
                (Some(active), _) => {
                    let elapsed = now.saturating_duration_since(active.started);
                    let first = active
                        .first_token
                        .map(|at| at.saturating_duration_since(active.started));
                    let output = active.usage.map(|sample| sample.output);
                    let stream_window = active
                        .first_token
                        .map(|at| now.saturating_duration_since(at));
                    (
                        first.map(to_ms),
                        Some(to_ms(elapsed)),
                        tokens_per_sec(output, stream_window),
                        tokens_per_sec(output, Some(elapsed)),
                    )
                }
                (None, Some(turn)) => (
                    turn.first_token.map(to_ms),
                    Some(to_ms(turn.duration)),
                    tokens_per_sec(
                        turn.usage.map(|sample| sample.output),
                        turn.first_token
                            .map(|first| turn.duration.saturating_sub(first)),
                    ),
                    tokens_per_sec(turn.usage.map(|sample| sample.output), Some(turn.duration)),
                ),
                (None, None) => (None, None, None, None),
            };

        StatsSnapshot {
            context_used,
            context_total,
            context_percent,
            turns: (self.turns > 0).then_some(self.turns),
            in_flight: self.in_flight.is_some(),
            first_token_ms,
            duration_ms,
            stream_tokens_per_sec: stream_tps.map(round1),
            avg_tokens_per_sec: avg_tps.map(round1),
            cache_hit_pct,
            input_tokens: self.has_tokens.then_some(self.input_tokens),
            output_tokens: self.has_tokens.then_some(self.output_tokens),
            updated_at: self.updated_at,
        }
    }
}

fn to_ms(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

/// token / 秒；窗口为 0 或 token 未知时返回 `None`（不做除零，也不编数字）。
fn tokens_per_sec(tokens: Option<u64>, window: Option<Duration>) -> Option<f64> {
    let tokens = tokens?;
    if tokens == 0 {
        return None;
    }
    let seconds = window?.as_secs_f64();
    if seconds <= 0.0 {
        return None;
    }
    Some(tokens as f64 / seconds)
}

/// 保留一位小数：界面上 33.333333% 与 33.3% 没有区别，四舍五入口径固定便于测试。
fn round1(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn at(base: Instant, millis: u64) -> Instant {
        base + Duration::from_millis(millis)
    }

    fn stream(data: serde_json::Value) -> RuntimeEventKind {
        RuntimeEventKind::Stream {
            event: "message_update".to_owned(),
            data: Some(data),
        }
    }

    /// usage 在 message_update 里重复出现，不能每条都累加进总量。
    #[test]
    fn tokens_accumulate_once_per_turn() {
        let base = Instant::now();
        let mut acc = StatsAccumulator::default();
        acc.begin_generation(1, base);
        acc.note_prompt(base);
        let usage = json!({
            "delta": "你好",
            "message": { "usage": { "input": 100, "output": 40, "cacheRead": 100 } }
        });
        acc.observe(&stream(usage.clone()), at(base, 500));
        acc.observe(&stream(usage.clone()), at(base, 900));
        acc.observe(&stream(usage), at(base, 1_200));
        acc.observe(&RuntimeEventKind::Settled, at(base, 1_500));

        let snapshot = acc.snapshot(at(base, 1_500));
        assert_eq!(snapshot.turns, Some(1));
        assert_eq!(
            snapshot.input_tokens,
            Some(200),
            "input + cacheRead 只算一次"
        );
        assert_eq!(snapshot.output_tokens, Some(40));
        assert_eq!(snapshot.duration_ms, Some(1_500));
        assert_eq!(snapshot.first_token_ms, Some(500));
        assert_eq!(snapshot.cache_hit_pct, Some(50.0));
    }

    /// 没有任何 usage：速度与缓存命中保持占位，不写 0。
    #[test]
    fn missing_usage_keeps_throughput_and_cache_as_placeholder() {
        let base = Instant::now();
        let mut acc = StatsAccumulator::default();
        acc.note_prompt(base);
        acc.observe(&stream(json!({ "delta": "你好" })), at(base, 300));
        acc.observe(&RuntimeEventKind::Settled, at(base, 1_300));

        let snapshot = acc.snapshot(at(base, 1_300));
        assert_eq!(snapshot.first_token_ms, Some(300));
        assert_eq!(snapshot.duration_ms, Some(1_300));
        assert_eq!(snapshot.stream_tokens_per_sec, None);
        assert_eq!(snapshot.avg_tokens_per_sec, None);
        assert_eq!(snapshot.cache_hit_pct, None);
        assert_eq!(snapshot.input_tokens, None);
        assert_eq!(snapshot.output_tokens, None);
        assert_eq!(snapshot.turns, Some(1));
    }

    #[test]
    fn throughput_uses_streaming_window_and_full_turn_window() {
        let base = Instant::now();
        let mut acc = StatsAccumulator::default();
        acc.note_prompt(base);
        acc.observe(&stream(json!({ "delta": "a" })), at(base, 1_000));
        acc.observe(
            &stream(json!({ "usage": { "input": 10, "output": 100 } })),
            at(base, 2_000),
        );
        acc.observe(&RuntimeEventKind::Settled, at(base, 3_000));

        let snapshot = acc.snapshot(at(base, 3_000));
        // 首 token 在 1000ms，结束在 3000ms：流式窗口 2s，100 token → 50 tok/s。
        assert_eq!(snapshot.stream_tokens_per_sec, Some(50.0));
        // 整轮 3s → 33.3 tok/s。
        assert_eq!(snapshot.avg_tokens_per_sec, Some(33.3));
    }

    #[test]
    fn in_flight_turn_reports_live_duration_without_counting_as_a_turn() {
        let base = Instant::now();
        let mut acc = StatsAccumulator::default();
        acc.note_prompt(base);
        acc.observe(&stream(json!({ "delta": "a" })), at(base, 250));

        let snapshot = acc.snapshot(at(base, 2_250));
        assert!(snapshot.in_flight);
        assert_eq!(snapshot.turns, None, "还没 settled，不能算完成一轮");
        assert_eq!(snapshot.first_token_ms, Some(250));
        assert_eq!(snapshot.duration_ms, Some(2_250));
    }

    #[test]
    fn context_percent_needs_both_used_and_window() {
        let base = Instant::now();
        let mut acc = StatsAccumulator::default();
        acc.observe(
            &stream(json!({ "usage": { "input": 60_000, "cacheRead": 60_000 } })),
            base,
        );
        let without_window = acc.snapshot(base);
        assert_eq!(without_window.context_used, Some(120_000));
        assert_eq!(without_window.context_total, None);
        assert_eq!(without_window.context_percent, None, "没有窗口就不猜占用率");

        acc.observe(&stream(json!({ "contextWindow": 200_000 })), base);
        let with_window = acc.snapshot(base);
        assert_eq!(with_window.context_total, Some(200_000));
        assert_eq!(with_window.context_percent, Some(60.0));
    }

    #[test]
    fn abnormal_exit_does_not_count_an_unfinished_turn() {
        let base = Instant::now();
        let mut acc = StatsAccumulator::default();
        acc.note_prompt(base);
        acc.observe(&stream(json!({ "delta": "a" })), at(base, 100));
        acc.observe(
            &RuntimeEventKind::Exit {
                code: Some(1),
                reason: "child_exited".to_owned(),
            },
            at(base, 900),
        );

        let snapshot = acc.snapshot(at(base, 900));
        assert_eq!(snapshot.turns, None);
        assert_eq!(snapshot.duration_ms, None);
        assert!(!snapshot.in_flight);
    }

    #[test]
    fn new_generation_drops_the_previous_in_flight_turn() {
        let base = Instant::now();
        let mut acc = StatsAccumulator::default();
        acc.begin_generation(1, base);
        acc.note_prompt(base);
        acc.observe(&stream(json!({ "delta": "a" })), at(base, 100));
        acc.begin_generation(2, at(base, 400));

        let snapshot = acc.snapshot(at(base, 800));
        assert!(!snapshot.in_flight, "上一代未完成的一轮必须被丢弃");
        assert_eq!(snapshot.duration_ms, None);
        // 累计轮次不受影响：新一代不清空历史。
        assert_eq!(snapshot.turns, None);
    }

    /// 时间戳只记录最后一次观测：快照用它换算成 Unix 毫秒给前端展示。
    #[test]
    fn updated_at_tracks_the_last_observation() {
        let base = Instant::now();
        let mut acc = StatsAccumulator::default();
        assert!(acc.snapshot(base).updated_at.is_none());
        acc.observe(&stream(json!({ "delta": "a" })), at(base, 700));
        assert_eq!(acc.snapshot(base).updated_at, Some(at(base, 700)));
    }
}
