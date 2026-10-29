//! Issue #109 · 性能基线（默认 ignore，只在需要出证据时手动跑）。
//!
//! 用 50,000 条事件 / ≈10 MiB 的合成会话，验证两条硬指标：
//! - 建缓存 < 400 ms；
//! - 单次查询 < 50 ms。
//!
//! 指标只在 release 构建下断言：debug 构建慢一个数量级，用 debug 数字宣称
//! 「达标」等于伪造证据。复现命令见 docs/development/session-search.md。

mod common;

use std::time::Instant;

use common::{TempDir, header_line, message_line, write_text};
use soxu_session_index::{SearchCache, SessionId, project_sessions_dir_name};

const CWD: &str = "/repo";
const ENTRIES: usize = 50_000;
const TARGET_BYTES: usize = 10 * 1024 * 1024;

/// 生成接近真实形态的会话：平均每行 ≈ TARGET_BYTES / ENTRIES 字节。
fn synthetic_session(id: &str) -> String {
    let mut text = String::with_capacity(TARGET_BYTES + 4096);
    text.push_str(&header_line(id, CWD));
    text.push('\n');
    let filler = "扩散模型的采样步数与显存占用需要一起观察";
    let mut previous: Option<String> = None;
    let mut index = 0_usize;
    while index < ENTRIES {
        let message_id = format!("m{index:06}");
        let body = if index.is_multiple_of(500) {
            format!("第 {index} 条：{filler}（扩散关键条目）")
        } else {
            format!("第 {index} 条：{filler}")
        };
        let role = if index.is_multiple_of(2) {
            "user"
        } else {
            "assistant"
        };
        text.push_str(&message_line(&message_id, previous.as_deref(), role, &body));
        text.push('\n');
        previous = Some(message_id);
        index += 1;
    }
    text
}

#[test]
#[ignore = "性能基线：cargo test --release -p soxu-session-index --test search_perf -- --ignored --nocapture"]
fn fifty_thousand_entries_stay_within_budget() {
    let dir = TempDir::new("search-perf");
    let id = "01a101f1-perf";
    let root = dir.mkdir("sessions");
    let path = root
        .join(project_sessions_dir_name(std::path::Path::new(CWD)))
        .join(format!("2026-01-01T00-00-00-000Z_{id}.jsonl"));
    let text = synthetic_session(id);
    write_text(&path, &text);
    let file_bytes = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);

    let mut cache = SearchCache::new();
    let session = SessionId::new(format!("ses_{id}"));

    let build_started = Instant::now();
    let built = cache
        .search(&session, &path, "扩散", 50, None)
        .expect("首次查询建立缓存");
    let build_ms = build_started.elapsed().as_millis();

    let query_started = Instant::now();
    let queried = cache
        .search(&session, &path, "扩散关键条目", 50, None)
        .expect("查询成功");
    let query_ms = query_started.elapsed().as_millis();

    let cached_bytes = cache.bytes();
    println!(
        "perf: file={file_bytes} B entries={} build={build_ms} ms query={query_ms} ms cache={cached_bytes} B hits={} total={} rebuilt={} took={}ms",
        built.scanned_entries,
        queried.hits.len(),
        queried.total_hits,
        queried.rebuilt,
        queried.took_ms,
    );

    assert!(built.rebuilt, "首次查询必须建立缓存");
    assert!(queried.total_hits > 0, "查询必须命中");
    assert!(
        cached_bytes <= 8 * 1024 * 1024,
        "单会话缓存必须 ≤ 8 MiB：{cached_bytes}"
    );

    if cfg!(not(debug_assertions)) {
        assert!(
            build_ms < 400,
            "建缓存必须 < 400 ms（实测 {build_ms} ms，文件 {file_bytes} 字节）"
        );
        assert!(query_ms < 50, "单次查询必须 < 50 ms（实测 {query_ms} ms）");
    } else {
        println!("perf: debug 构建不断言时间指标（只打印实测值）");
    }
}
