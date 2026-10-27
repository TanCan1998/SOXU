//! 并发读写：追加写入期间索引不丢条目、不误判损坏、分页可并行。

mod common;

use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use common::*;
use soxu_session_index::{
    CatalogConfig, ErrorCode, ProjectCatalog, SessionId, SessionLog, SessionPage,
};

fn page_through(log: &SessionLog) -> Vec<EntryMetaOffsets> {
    let mut offsets = Vec::new();
    let mut offset = 0_u64;
    loop {
        let page = log
            .page(SessionPage::new(offset, 100))
            .unwrap_or_else(|error| panic!("{error}"));
        for entry in &page.entries {
            offsets.push(EntryMetaOffsets {
                ordinal: entry.ordinal,
                offset: entry.offset,
            });
        }
        match page.next {
            Some(next) => offset = next,
            None => break,
        }
    }
    offsets
}

struct EntryMetaOffsets {
    ordinal: u64,
    offset: u64,
}

#[test]
fn concurrent_appends_never_lose_or_duplicate_entries() {
    let temp = TempDir::new("concurrent-append");
    let path = temp.child("session.jsonl");
    write_text(&path, &session_text("sess-w", "/repo", 10));

    let mut log = SessionLog::new(&path);
    log.refresh().unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(log.entry_count(), 11);

    let writer_path = path.clone();
    let writer = thread::spawn(move || {
        for index in 0..400_u32 {
            let id = format!("w{index:05}");
            append_text(
                &writer_path,
                &format!(
                    "{}\n",
                    message_line(&id, None, "user", &format!("payload {index}"))
                ),
            );
            if index % 25 == 0 {
                // 让读者有机会撞上「半行」状态。
                thread::sleep(Duration::from_millis(1));
            }
        }
    });

    let mut refreshes = 0_usize;
    while !writer.is_finished() || refreshes < 5 {
        log.refresh().unwrap_or_else(|error| panic!("{error}"));
        refreshes += 1;
    }
    writer.join().expect("writer 线程不应 panic");

    let report = log.refresh().unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(report.pending_bytes, 0, "写完后不应残留半行");
    assert_eq!(log.entry_count(), 411, "并发追加不得丢行或重复计数");
    assert_eq!(log.corrupt_lines(), 0, "半行不得被误判为损坏行");
    assert!(refreshes >= 5);

    // 偏移严格递增且连续：证明没有重复索引同一行。
    let entries = page_through(&log);
    assert_eq!(entries.len(), 411);
    for window in entries.windows(2) {
        assert!(window[1].offset > window[0].offset, "偏移必须严格递增");
        assert_eq!(window[1].ordinal, window[0].ordinal + 1);
    }
}

#[test]
fn partial_line_writes_are_never_indexed_twice() {
    let temp = TempDir::new("concurrent-partial");
    let path = temp.child("session.jsonl");
    write_text(&path, &session_text("sess-p", "/repo", 3));
    let mut log = SessionLog::new(&path);
    log.refresh().unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(log.entry_count(), 4);

    for round in 0..20_u32 {
        let id = format!("split{round:02}");
        let line = message_line(&id, None, "user", "split write");
        let split = line.len() / 2;
        append_text(&path, &line[..split]);
        log.refresh().unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(log.corrupt_lines(), 0, "半行不应被当作损坏行");
        append_text(&path, &line[split..]);
        append_text(&path, "\n");
        let report = log.refresh().unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(report.appended_entries, 1);
    }
    assert_eq!(log.entry_count(), 24);
}

#[test]
fn pages_can_be_read_in_parallel() {
    let temp = TempDir::new("parallel-pages");
    let path = temp.child("session.jsonl");
    write_text(&path, &session_text("sess-par", "/repo", 500));
    let mut log = SessionLog::new(&path);
    log.refresh().unwrap_or_else(|error| panic!("{error}"));
    let log = Arc::new(log);

    let handles: Vec<_> = (0..4_u64)
        .map(|worker| {
            let log = Arc::clone(&log);
            thread::spawn(move || {
                for round in 0..20_u64 {
                    let offset = worker * 50 + round;
                    let page = log
                        .page(SessionPage::new(offset, 10))
                        .unwrap_or_else(|error| panic!("{error}"));
                    assert!(!page.entries.is_empty());
                    for (index, entry) in page.entries.iter().enumerate() {
                        assert_eq!(entry.ordinal, offset + index as u64);
                    }
                }
            })
        })
        .collect();
    for handle in handles {
        handle.join().expect("分页线程不应 panic");
    }
}

#[test]
fn catalog_claims_one_runtime_per_session() {
    let temp = TempDir::new("catalog-claims");
    let root = temp.mkdir("repo");
    let sessions_root = temp.mkdir("sessions");
    let directory = session_dir(&sessions_root, &root);
    write_text(
        &directory.join("session.jsonl"),
        &session_text("sess-claim", &root.to_string_lossy(), 2),
    );

    let mut catalog = ProjectCatalog::open_with(
        temp.child("state"),
        CatalogConfig::with_sessions_root(&sessions_root),
    )
    .unwrap_or_else(|error| panic!("{error}"));
    let project = catalog
        .register_project(&root)
        .unwrap_or_else(|error| panic!("{error}"));
    catalog
        .sync(&project.id)
        .unwrap_or_else(|error| panic!("{error}"));
    let session: SessionId = catalog
        .sessions(&project.id)
        .and_then(|sessions| sessions.first())
        .map(|record| record.id.clone())
        .unwrap_or_else(|| panic!("需要至少一个会话"));

    let shared = Arc::new(Mutex::new(catalog));
    let handles: Vec<_> = ["rt-a", "rt-b", "rt-c", "rt-d"]
        .into_iter()
        .map(|runtime| {
            let shared = Arc::clone(&shared);
            let session = session.clone();
            thread::spawn(move || {
                let mut catalog = shared.lock().expect("互斥锁不应中毒");
                match catalog.claim_writable(&session, runtime) {
                    Ok(link) => Ok(link.generation),
                    Err(error) => Err(error.code()),
                }
            })
        })
        .collect();

    let results: Vec<_> = handles
        .into_iter()
        .map(|handle| handle.join().expect("claim 线程不应 panic"))
        .collect();
    let successes = results.iter().filter(|result| result.is_ok()).count();
    assert_eq!(successes, 1, "同一会话只允许一个可写运行时");
    assert!(
        results
            .iter()
            .filter(|result| result.is_err())
            .all(|result| result.err() == Some(ErrorCode::SessionAlreadyOwned))
    );

    let catalog = shared.lock().expect("互斥锁不应中毒");
    let identity = catalog
        .identity(&session)
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(identity.session, session);
    assert_eq!(identity.project, project.id);
    assert!(identity.runtime.is_some());
}
