//! 目录级分页：SessionId → 增量索引 → 有界分页的完整链路。
//!
//! 这里验证的是「API 可用且内存/IO 有界」，不是索引内部实现细节：
//! 重启后复用快照不重扫、长会话按页推进、缺失与未知会话给出可恢复错误码。

mod common;

use std::fs;
use std::path::{Path, PathBuf};

use common::*;
use soxu_session_index::{
    CatalogConfig, ErrorCode, MAX_PAGE_BYTES, ProjectCatalog, ProjectId, ProjectRecord, SessionId,
    SessionPage,
};

fn open(state: &Path, sessions_root: &Path) -> ProjectCatalog {
    ProjectCatalog::open_with(state, CatalogConfig::with_sessions_root(sessions_root))
        .unwrap_or_else(|error| panic!("open catalog: {error}"))
}

fn seed_session(
    sessions_root: &Path,
    worktree: &Path,
    session_id: &str,
    messages: usize,
) -> PathBuf {
    let directory = session_dir(sessions_root, worktree);
    let file = directory.join(format!("2026-01-01T00-00-00_{session_id}.jsonl"));
    write_text(
        &file,
        &session_text(session_id, &worktree.to_string_lossy(), messages),
    );
    file
}

fn first_session(catalog: &ProjectCatalog, project: &ProjectId) -> SessionId {
    catalog
        .sessions(project)
        .and_then(|sessions| sessions.first())
        .map(|session| session.id.clone())
        .unwrap_or_else(|| panic!("项目下应至少有一个会话"))
}

fn synced(root: &Path, sessions_root: &Path, state: &Path) -> (ProjectCatalog, ProjectRecord) {
    let mut catalog = open(state, sessions_root);
    let project = catalog
        .register_project(root)
        .unwrap_or_else(|error| panic!("{error}"));
    catalog
        .sync(&project.id)
        .unwrap_or_else(|error| panic!("{error}"));
    catalog.save().unwrap_or_else(|error| panic!("{error}"));
    (catalog, project)
}

#[test]
fn catalog_pages_a_long_session_with_bounded_reads() {
    let temp = TempDir::new("page-long");
    let root = temp.mkdir("repo");
    let sessions_root = temp.mkdir("sessions");
    let messages = 3_000;
    seed_session(&sessions_root, &root, "sess-long", messages);

    let (mut catalog, project) = synced(&root, &sessions_root, &temp.child("state"));
    let session = first_session(&catalog, &project.id);
    assert_eq!(
        catalog
            .find_session(&session)
            .map(|record| record.entry_count),
        Some(messages + 1)
    );

    let mut offset = 0_u64;
    let mut seen = 0_usize;
    let mut pages = 0_usize;
    loop {
        let page = catalog
            .page_session(&session, SessionPage::new(offset, 100))
            .unwrap_or_else(|error| panic!("{error}"));
        pages += 1;
        assert!(
            page.bytes_read <= MAX_PAGE_BYTES as u64,
            "单页读取必须受预算约束：{} > {MAX_PAGE_BYTES}",
            page.bytes_read
        );
        assert!(page.entries.len() <= 100, "单页条目数必须受限");
        seen += page.entries.len();
        match page.next {
            Some(next) => {
                assert!(next > offset, "next 必须前进，否则分页会原地打转");
                offset = next;
            }
            None => break,
        }
    }
    assert_eq!(seen, messages + 1);
    assert!(pages > 1, "长会话必须跨多页，实际 {pages} 页");
}

#[test]
fn restart_paging_reuses_persisted_snapshot() {
    let temp = TempDir::new("page-restart");
    let root = temp.mkdir("repo");
    let sessions_root = temp.mkdir("sessions");
    seed_session(&sessions_root, &root, "sess-restart", 200);
    let state = temp.child("state");

    let (catalog, project) = synced(&root, &sessions_root, &state);
    let session = first_session(&catalog, &project.id);
    let first_total = catalog
        .find_session(&session)
        .map(|record| record.entry_count)
        .unwrap_or(0);
    drop(catalog);

    // 「重启」：新实例只读磁盘状态，索引快照仍可用。
    let mut reopened = open(&state, &sessions_root);
    let (mut log, load) = reopened
        .open_session_log(&session)
        .unwrap_or_else(|error| panic!("{error}"));
    assert!(load.accepted, "正常关闭后快照应被接受");
    let report = log.refresh().unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(report.appended_entries, 0);
    assert_eq!(log.bytes_read(), 0, "快照可用时不得重新扫描文件正文");
    assert_eq!(report.total_entries, first_total);

    let page = reopened
        .page_session(&session, SessionPage::new(0, 10))
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(page.total, first_total);
    assert_eq!(page.offset, 0);
}

#[test]
fn paging_after_append_returns_only_complete_entries() {
    let temp = TempDir::new("page-append");
    let root = temp.mkdir("repo");
    let sessions_root = temp.mkdir("sessions");
    let file = seed_session(&sessions_root, &root, "sess-append", 2);

    let (mut catalog, project) = synced(&root, &sessions_root, &temp.child("state"));
    let session = first_session(&catalog, &project.id);
    let before = catalog
        .page_session(&session, SessionPage::new(0, 50))
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(before.total, 3);
    assert!(before.next.is_none());

    // 追加一整行与一行未写完的尾巴：只应索引整行。
    let mut text = message_line("m900000", Some("m000001"), "user", "appended");
    text.push('\n');
    append_text(&file, &text);
    append_text(&file, "{\"type\":\"message\",\"id\":\"partial\"");

    let after = catalog
        .page_session(&session, SessionPage::new(0, 50))
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(after.total, 4, "半个 JSONL 行不得进入索引");
    assert_eq!(
        after
            .entries
            .last()
            .and_then(|entry| entry.entry_id.clone()),
        Some("m900000".to_string())
    );
}

#[test]
fn paging_a_missing_session_is_recoverable() {
    let temp = TempDir::new("page-missing");
    let root = temp.mkdir("repo");
    let sessions_root = temp.mkdir("sessions");
    let file = seed_session(&sessions_root, &root, "sess-gone", 2);

    let (mut catalog, project) = synced(&root, &sessions_root, &temp.child("state"));
    let session = first_session(&catalog, &project.id);
    fs::remove_file(&file).unwrap_or_else(|error| panic!("{error}"));

    let error = catalog
        .page_session(&session, SessionPage::new(0, 10))
        .err()
        .unwrap_or_else(|| panic!("会话文件被删除后必须报错"));
    assert_eq!(error.code(), ErrorCode::SessionFileMissing);
    assert!(error.recoverable(), "缺失文件应可通过重新同步恢复");

    // 目录元数据仍保留该会话，避免历史身份随文件消失。
    assert_eq!(
        catalog.find_session(&session).map(|record| record.state),
        Some(soxu_session_index::SessionState::Present)
    );
}

#[test]
fn paging_an_unknown_session_reports_unknown() {
    let temp = TempDir::new("page-unknown");
    let root = temp.mkdir("repo");
    let sessions_root = temp.mkdir("sessions");
    let (mut catalog, _project) = synced(&root, &sessions_root, &temp.child("state"));

    let unknown = SessionId::from_header_id("never-seen");
    let error = catalog
        .page_session(&unknown, SessionPage::new(0, 10))
        .err()
        .unwrap_or_else(|| panic!("未知会话必须报错"));
    assert_eq!(error.code(), ErrorCode::SessionUnknown);
    assert_eq!(error.code().as_str(), "E_SESSION_UNKNOWN");
    assert!(!error.recoverable(), "未知身份需要重新登记，不是可重试错误");

    let opened = catalog.open_session_log(&unknown);
    assert!(opened.is_err(), "未知会话不应被打开");
}
