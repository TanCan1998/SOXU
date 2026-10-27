//! 增量扫描、损坏/截断/替换恢复与有界分页的自动测试。

mod common;

use common::*;
use soxu_session_index::{
    CATALOG_SCHEMA_VERSION, EntryMeta, ErrorCode, MAX_PAGE_BYTES, RebuildReason, SessionLog,
    SessionPage, WarningKind,
};

fn open_log(path: &std::path::Path) -> SessionLog {
    let mut log = SessionLog::new(path);
    log.refresh()
        .unwrap_or_else(|error| panic!("refresh failed: {error}"));
    log
}

#[test]
fn indexes_complete_lines_and_defers_partial_tail() {
    let temp = TempDir::new("partial");
    let path = temp.child("session.jsonl");
    let mut text = header_line("sess-a", "/repo");
    text.push('\n');
    text.push_str(&message_line("m1", None, "user", "hello"));
    text.push('\n');
    // 尾部半行模拟 Pi 正在写：未以 LF 结束的内容不得被索引。
    let tail = message_line("m2", Some("m1"), "assistant", "world");
    let split = tail.len() - 12;
    text.push_str(&tail[..split]);
    write_text(&path, &text);

    let mut log = open_log(&path);
    assert_eq!(log.entry_count(), 2, "只应索引完整行");
    assert!(log.pending_bytes() > 0, "半行应留在 pending 缓冲");

    append_text(&path, &tail[split..]);
    append_text(&path, "\n");
    let report = log.refresh().unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(report.appended_entries, 1);
    assert_eq!(report.pending_bytes, 0, "半行补齐后不应留有残片");
    assert_eq!(log.entry_count(), 3);
    assert_eq!(
        log.header().and_then(|header| header.id.clone()),
        Some("sess-a".to_string())
    );
}

#[test]
fn corrupt_and_non_utf8_lines_do_not_stop_the_scan() {
    let temp = TempDir::new("corrupt");
    let path = temp.child("session.jsonl");
    let mut bytes = header_line("sess-c", "/repo").into_bytes();
    bytes.push(b'\n');
    bytes.extend_from_slice(b"{not json}");
    bytes.push(b'\n');
    bytes.extend_from_slice(&[0xff, 0xfe, 0xfd]);
    bytes.push(b'\n');
    bytes.extend_from_slice(message_line("m1", None, "user", "still indexed").as_bytes());
    bytes.push(b'\n');
    std::fs::write(&path, &bytes).expect("写入含损坏行的文件");

    let log = open_log(&path);
    assert_eq!(log.entry_count(), 4, "损坏行也占位，后续行继续索引");
    assert_eq!(log.corrupt_lines(), 2);
    assert!(
        log.warnings()
            .iter()
            .any(|warning| warning.kind == WarningKind::CorruptLine)
    );

    let page = log
        .page(SessionPage::new(0, 10))
        .unwrap_or_else(|error| panic!("{error}"));
    assert!(page.entries[1].corrupt);
    assert!(page.entries[2].corrupt);
    assert_eq!(page.entries[3].preview.as_deref(), Some("still indexed"));
}

#[test]
fn oversized_line_is_skipped_with_bounded_memory() {
    let temp = TempDir::new("oversized");
    let path = temp.child("session.jsonl");
    let mut text = header_line("sess-o", "/repo");
    text.push('\n');
    let huge = "x".repeat(9 * 1024 * 1024);
    text.push_str(&message_line("m1", None, "toolResult", &huge));
    text.push('\n');
    text.push_str(&message_line("m2", Some("m1"), "user", "after huge"));
    text.push('\n');
    write_text(&path, &text);

    let mut log = SessionLog::new(&path);
    let report = log.refresh().unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(report.oversized_lines, 1);
    assert!(report.pending_bytes < 1024 * 1024, "超长行不得滞留在缓冲里");
    assert_eq!(log.entry_count(), 3, "头部 + 超长占位 + 后续行");
    assert!(
        log.warnings()
            .iter()
            .any(|warning| warning.kind == WarningKind::OversizedLine)
    );

    // 超长条目只返回占位视图，不读正文。
    log.clear_stats();
    let page = log
        .page(SessionPage::new(1, 1))
        .unwrap_or_else(|error| panic!("{error}"));
    assert!(page.entries[0].oversized);
    assert!(page.entries[0].preview.is_none());
    assert_eq!(page.bytes_read, 0);
}

#[test]
fn refresh_reads_only_new_bytes() {
    let temp = TempDir::new("incremental");
    let path = temp.child("session.jsonl");
    write_text(&path, &session_text("sess-i", "/repo", 5));

    let mut log = open_log(&path);
    assert_eq!(log.entry_count(), 6);
    log.clear_stats();
    let report = log.refresh().unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(report.scanned_bytes, 0, "没有新内容不应重复读取");
    assert_eq!(log.bytes_read(), 0);

    let extra = format!("{}\n", message_line("m999", None, "user", "later"));
    append_text(&path, &extra);
    let report = log.refresh().unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(report.scanned_bytes, extra.len() as u64);
    assert_eq!(log.entry_count(), 7);
    assert_eq!(report.rebuild, None);
}

#[test]
fn truncation_rebuilds_the_index() {
    let temp = TempDir::new("truncate");
    let path = temp.child("session.jsonl");
    write_text(&path, &session_text("sess-t", "/repo", 20));
    let mut log = open_log(&path);
    assert_eq!(log.entry_count(), 21);

    write_text(&path, &session_text("sess-t", "/repo", 2));
    let report = log.refresh().unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(report.rebuild, Some(RebuildReason::Truncated));
    assert_eq!(log.entry_count(), 3, "重建后只保留新内容");
}

#[test]
fn replacement_rebuilds_the_index() {
    let temp = TempDir::new("replace");
    let path = temp.child("session.jsonl");
    write_text(&path, &session_text("sess-r", "/repo", 4));
    let mut log = open_log(&path);
    assert_eq!(log.entry_count(), 5);

    // 换成另一个会话、且长度不短于旧文件：只能靠头部指纹识别替换。
    write_text(&path, &session_text("sess-other", "/repo", 8));
    let report = log.refresh().unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(report.rebuild, Some(RebuildReason::Replaced));
    assert_eq!(log.entry_count(), 9);
    assert_eq!(
        log.header().and_then(|header| header.id.clone()),
        Some("sess-other".to_string())
    );
}

#[test]
fn snapshot_restore_avoids_rescan_and_detects_schema_mismatch() {
    let temp = TempDir::new("snapshot");
    let path = temp.child("session.jsonl");
    let snapshot_path = temp.child("index.json");
    write_text(&path, &session_text("sess-s", "/repo", 30));

    let mut log = open_log(&path);
    log.save_snapshot(&snapshot_path)
        .unwrap_or_else(|error| panic!("save failed: {error}"));
    let snapshot = SessionLog::load_snapshot(&snapshot_path)
        .unwrap_or_else(|error| panic!("{error}"))
        .unwrap_or_else(|| panic!("snapshot should exist"));

    let (mut restored, load) = SessionLog::from_snapshot(&path, snapshot);
    assert!(load.accepted);
    let report = restored.refresh().unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(report.scanned_bytes, 0, "快照命中后不应重新扫描");
    assert_eq!(restored.entry_count(), 31);

    let mut broken = SessionLog::load_snapshot(&snapshot_path)
        .unwrap_or_else(|error| panic!("{error}"))
        .unwrap_or_else(|| panic!("snapshot should exist"));
    broken.schema = CATALOG_SCHEMA_VERSION + 7;
    let (mut rejected, load) = SessionLog::from_snapshot(&path, broken);
    assert!(!load.accepted);
    assert_eq!(load.reason, Some(RebuildReason::SnapshotSchemaMismatch));
    let report = rejected.refresh().unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(report.rebuild, Some(RebuildReason::SnapshotSchemaMismatch));
    assert_eq!(rejected.entry_count(), 31);
}

#[test]
fn pages_are_bounded_and_report_overflow() {
    let temp = TempDir::new("pages");
    let path = temp.child("session.jsonl");
    let filler = "y".repeat(2000);
    let mut text = header_line("sess-p", "/repo");
    text.push('\n');
    for index in 0..30 {
        text.push_str(&message_line(
            &format!("p{index:03}"),
            None,
            "assistant",
            &filler,
        ));
        text.push('\n');
    }
    write_text(&path, &text);
    let log = open_log(&path);
    assert_eq!(log.entry_count(), 31);

    let clipped = log
        .page(SessionPage::new(0, 5).with_budget(3000))
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(clipped.entries.len(), 2, "头部 + 一条消息用尽预算");
    assert!(clipped.clipped, "还有条目没返回，必须标记截断");
    assert!(clipped.bytes_read <= 3000, "不得超出本页预算");
    assert_eq!(clipped.next, Some(2));

    let full = log
        .page(SessionPage::new(2, 5))
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(full.entries.len(), 5);
    assert_eq!(full.entries[0].ordinal, 2);
    assert_eq!(full.next, Some(7));
    assert!(full.bytes_read <= MAX_PAGE_BYTES as u64);

    let tail = log
        .page(SessionPage::new(31, 5))
        .unwrap_or_else(|error| panic!("{error}"));
    assert!(tail.entries.is_empty());
    assert_eq!(tail.next, None);

    let beyond = log.page(SessionPage::new(99, 5));
    assert_eq!(
        beyond.err().map(|error| error.code()),
        Some(ErrorCode::PageOutOfRange)
    );
}

#[test]
fn long_session_never_loads_whole_file_per_page() {
    let temp = TempDir::new("long");
    let path = temp.child("session.jsonl");
    let mut text = header_line("sess-long", "/repo");
    text.push('\n');
    for index in 0..50_000_u32 {
        let role = if index % 2 == 0 { "user" } else { "assistant" };
        text.push_str(&message_line(
            &format!("l{index:06}"),
            None,
            role,
            &format!("payload {index}"),
        ));
        text.push('\n');
    }
    write_text(&path, &text);

    let mut log = open_log(&path);
    assert_eq!(log.entry_count(), 50_001);
    assert_eq!(
        log.bytes_read(),
        text.len() as u64,
        "首次扫描应一次流过整个文件，不重复读取"
    );

    // 索引固定开销：50k 条 × EntryMeta（16 字节量级）。
    let index_bytes = log.entry_count() * std::mem::size_of::<EntryMeta>();
    assert!(
        index_bytes <= 4 * 1024 * 1024,
        "索引元数据 {index_bytes} 字节超出预算"
    );

    log.clear_stats();
    let page = log
        .page(SessionPage::new(25_000, 50))
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(page.entries.len(), 50);
    assert_eq!(page.entries[0].ordinal, 25_000);
    assert!(page.bytes_read < 32 * 1024, "单页只应读取该页范围");
}
