//! 目录生命周期：身份稳定、迁移、缺失、重复、错误码与运行时归属。

mod common;

use std::fs;
use std::path::{Path, PathBuf};

use common::*;
use soxu_session_index::{
    CatalogConfig, ErrorCode, ProjectCatalog, ProjectId, SessionId, SessionState, WorktreeId,
};

fn open(state: &Path, sessions_root: &Path) -> ProjectCatalog {
    ProjectCatalog::open_with(state, CatalogConfig::with_sessions_root(sessions_root))
        .unwrap_or_else(|error| panic!("open catalog: {error}"))
}

/// 在 Pi 布局下为工作树写入一个会话文件，返回文件路径。
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

fn first_session_id(catalog: &ProjectCatalog, project: &ProjectId) -> SessionId {
    catalog
        .sessions(project)
        .and_then(|sessions| sessions.first())
        .map(|session| session.id.clone())
        .unwrap_or_else(|| panic!("项目下应至少有一个会话"))
}

#[test]
fn ids_and_index_survive_restart() {
    let temp = TempDir::new("restart");
    let root = temp.mkdir("repo");
    let sessions_root = temp.mkdir("sessions");
    let file = seed_session(&sessions_root, &root, "sess-stable", 3);

    let mut catalog = open(&temp.child("state"), &sessions_root);
    let project = catalog
        .register_project(&root)
        .unwrap_or_else(|error| panic!("{error}"));
    let report = catalog
        .sync(&project.id)
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(report.added, 1);
    assert_eq!(report.scanned_files, 1);
    let worktree_id = catalog
        .project(&project.id)
        .and_then(|record| {
            record
                .primary_worktree()
                .map(|worktree| worktree.id.clone())
        })
        .unwrap_or_else(|| panic!("主工作树应存在"));
    let session = first_session_id(&catalog, &project.id);
    assert_eq!(session, SessionId::from_header_id("sess-stable"));
    assert_eq!(
        catalog
            .identity(&session)
            .unwrap_or_else(|error| panic!("{error}"))
            .worktree,
        worktree_id
    );
    let entries_before = catalog
        .find_session(&session)
        .map(|record| record.entry_count)
        .unwrap_or(0);
    assert_eq!(entries_before, 4);
    catalog.save().unwrap_or_else(|error| panic!("{error}"));
    drop(catalog);

    // 「重启」：新进程只读磁盘状态。
    let mut reopened = open(&temp.child("state"), &sessions_root);
    assert!(!reopened.load_warning(), "正常关闭后不应有重建告警");
    assert_eq!(reopened.projects().len(), 1);
    assert_eq!(reopened.projects()[0].id, project.id);
    assert_eq!(
        reopened.projects()[0]
            .primary_worktree()
            .map(|worktree| worktree.id.clone()),
        Some(worktree_id.clone())
    );
    let restored = first_session_id(&reopened, &project.id);
    assert_eq!(restored, session, "重启后 SessionId 必须稳定");
    assert_eq!(
        reopened
            .find_session(&restored)
            .map(|record| record.entry_count),
        Some(4)
    );

    // 索引快照命中：没有新字节就不重扫。
    let report = reopened
        .sync(&project.id)
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(report.unchanged, 1);
    assert!(report.rebuilds.is_empty(), "快照未失效时不应重建");
    assert!(file.exists());
}

#[test]
fn renamed_session_keeps_its_id() {
    let temp = TempDir::new("rename");
    let root = temp.mkdir("repo");
    let sessions_root = temp.mkdir("sessions");
    let file = seed_session(&sessions_root, &root, "sess-move", 2);

    let mut catalog = open(&temp.child("state"), &sessions_root);
    let project = catalog
        .register_project(&root)
        .unwrap_or_else(|error| panic!("{error}"));
    catalog
        .sync(&project.id)
        .unwrap_or_else(|error| panic!("{error}"));
    let session = first_session_id(&catalog, &project.id);

    let renamed = file.with_file_name("renamed-session.jsonl");
    fs::rename(&file, &renamed).expect("重命名会话文件");
    let report = catalog
        .sync(&project.id)
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(report.relocated.len(), 1, "重命名应被识别为迁移而非新会话");
    assert_eq!(report.relocated[0].session, session);
    assert_eq!(
        catalog.sessions(&project.id).map(|items| items.len()),
        Some(1)
    );
    let record = catalog
        .find_session(&session)
        .unwrap_or_else(|| panic!("会话应保留"));
    assert_eq!(record.id, session, "迁移后 SessionId 不变");
    assert!(record.file.ends_with("renamed-session.jsonl"));
    assert_eq!(record.state, SessionState::Present);
}

#[test]
fn missing_session_is_retained_but_flagged() {
    let temp = TempDir::new("missing");
    let root = temp.mkdir("repo");
    let sessions_root = temp.mkdir("sessions");
    let file = seed_session(&sessions_root, &root, "sess-gone", 2);

    let mut catalog = open(&temp.child("state"), &sessions_root);
    let project = catalog
        .register_project(&root)
        .unwrap_or_else(|error| panic!("{error}"));
    catalog
        .sync(&project.id)
        .unwrap_or_else(|error| panic!("{error}"));
    let session = first_session_id(&catalog, &project.id);

    fs::remove_file(&file).expect("删除会话文件");
    let report = catalog
        .sync(&project.id)
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(report.missing.len(), 1);
    let record = catalog
        .find_session(&session)
        .unwrap_or_else(|| panic!("会话记录必须保留"));
    assert_eq!(record.state, SessionState::Missing);
    catalog.save().unwrap_or_else(|error| panic!("{error}"));
    drop(catalog);

    let reopened = open(&temp.child("state"), &sessions_root);
    assert_eq!(
        reopened.find_session(&session).map(|record| record.state),
        Some(SessionState::Missing)
    );
}

#[test]
fn duplicate_session_header_is_reported_not_merged() {
    let temp = TempDir::new("duplicate");
    let root = temp.mkdir("repo");
    let sessions_root = temp.mkdir("sessions");
    let file = seed_session(&sessions_root, &root, "sess-dup", 2);
    let copy = file.with_file_name("copy-of-session.jsonl");
    fs::copy(&file, &copy).expect("复制会话文件");

    let mut catalog = open(&temp.child("state"), &sessions_root);
    let project = catalog
        .register_project(&root)
        .unwrap_or_else(|error| panic!("{error}"));
    let report = catalog
        .sync(&project.id)
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(
        report.duplicates.len(),
        1,
        "同一 header id 的两份文件必须报告"
    );
    assert_eq!(
        catalog.sessions(&project.id).map(|items| items.len()),
        Some(1)
    );
}

#[test]
fn worktrees_do_not_share_sessions() {
    let temp = TempDir::new("worktrees");
    let root = temp.mkdir("repo-main");
    let branch = temp.mkdir("repo-feature");
    let sessions_root = temp.mkdir("sessions");
    seed_session(&sessions_root, &root, "sess-main", 2);
    seed_session(&sessions_root, &branch, "sess-branch", 5);

    let mut catalog = open(&temp.child("state"), &sessions_root);
    let project = catalog
        .register_project(&root)
        .unwrap_or_else(|error| panic!("{error}"));
    let worktree = catalog
        .add_worktree(&project.id, &branch, Some("feature"))
        .unwrap_or_else(|error| panic!("{error}"));
    assert!(!worktree.primary);
    let report = catalog
        .sync(&project.id)
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(report.added, 2);
    assert!(report.cwd_mismatch.is_empty(), "cwd 与工作树一致时不应告警");

    let sessions = catalog.sessions(&project.id).unwrap_or(&[]);
    assert_eq!(sessions.len(), 2);
    for session in sessions {
        let identity = catalog
            .identity(&session.id)
            .unwrap_or_else(|error| panic!("{error}"));
        if session.id == SessionId::from_header_id("sess-branch") {
            assert_eq!(identity.worktree, worktree.id);
            assert_eq!(session.entry_count, 6);
        } else {
            assert_ne!(identity.worktree, worktree.id);
            assert_eq!(session.entry_count, 3);
        }
    }
}

#[test]
fn cwd_mismatch_is_surfaced() {
    let temp = TempDir::new("cwd-mismatch");
    let root = temp.mkdir("repo");
    let sessions_root = temp.mkdir("sessions");
    // 故意写入不属于该工作树的 cwd，模拟手工复制与迁移。
    let directory = session_dir(&sessions_root, &root);
    write_text(
        &directory.join("odd.jsonl"),
        &session_text("sess-odd", "/somewhere/else", 1),
    );

    let mut catalog = open(&temp.child("state"), &sessions_root);
    let project = catalog
        .register_project(&root)
        .unwrap_or_else(|error| panic!("{error}"));
    let report = catalog
        .sync(&project.id)
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(report.cwd_mismatch.len(), 1);
    assert_eq!(
        catalog.sessions(&project.id).map(|items| items.len()),
        Some(1)
    );
}

#[test]
fn error_codes_are_stable_and_specific() {
    let temp = TempDir::new("errors");
    let root = temp.mkdir("repo");
    let sessions_root = temp.mkdir("sessions");
    let mut catalog = open(&temp.child("state"), &sessions_root);

    let missing_root = temp.child("does-not-exist");
    assert_eq!(
        catalog
            .register_project(&missing_root)
            .err()
            .map(|error| error.code()),
        Some(ErrorCode::ProjectRootMissing)
    );

    let plain_file = temp.child("file.txt");
    write_text(&plain_file, "x");
    assert_eq!(
        catalog
            .register_project(&plain_file)
            .err()
            .map(|error| error.code()),
        Some(ErrorCode::ProjectRootNotDirectory)
    );

    let project = catalog
        .register_project(&root)
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(
        catalog
            .sync(&ProjectId::new("prj_unknown"))
            .err()
            .map(|error| error.code()),
        Some(ErrorCode::ProjectUnknown)
    );
    assert_eq!(
        catalog
            .add_worktree(&project.id, &temp.child("no-worktree"), None)
            .err()
            .map(|error| error.code()),
        Some(ErrorCode::WorktreePathMissing)
    );
    assert_eq!(
        catalog
            .attach_session_file(&project.id, &WorktreeId::new("wkt_unknown"), &plain_file)
            .err()
            .map(|error| error.code()),
        Some(ErrorCode::WorktreeUnknown)
    );
    assert_eq!(
        catalog
            .identity(&SessionId::new("ses_unknown"))
            .err()
            .map(|error| error.code()),
        Some(ErrorCode::SessionUnknown)
    );
    assert_eq!(
        catalog
            .claim_writable(&SessionId::new("ses_unknown"), "rt-1")
            .err()
            .map(|error| error.code()),
        Some(ErrorCode::SessionUnknown)
    );

    // 没有配置 Pi 会话根目录时，sync 必须给出可恢复的明确错误。
    let mut bare = ProjectCatalog::open_with(
        temp.child("state-bare"),
        CatalogConfig {
            sessions_root: None,
        },
    )
    .unwrap_or_else(|error| panic!("{error}"));
    let bare_project = bare
        .register_project(&root)
        .unwrap_or_else(|error| panic!("{error}"));
    let error = bare
        .sync(&bare_project.id)
        .err()
        .unwrap_or_else(|| panic!("应返回错误"));
    assert_eq!(error.code(), ErrorCode::SessionsRootUnavailable);
    assert!(error.recoverable());
    assert_eq!(error.code().as_str(), "E_SESSIONS_ROOT_UNAVAILABLE");
}

#[test]
fn attach_session_file_handles_foreign_layout_and_conflicts() {
    let temp = TempDir::new("attach");
    let root = temp.mkdir("repo");
    let sessions_root = temp.mkdir("sessions");
    let odd = temp.child("external/session.jsonl");
    write_text(&odd, &session_text("sess-ext", &root.to_string_lossy(), 2));

    let mut catalog = open(&temp.child("state"), &sessions_root);
    let project = catalog
        .register_project(&root)
        .unwrap_or_else(|error| panic!("{error}"));
    let worktree = catalog
        .project(&project.id)
        .and_then(|record| record.primary_worktree().map(|item| item.id.clone()))
        .unwrap_or_else(|| panic!("主工作树应存在"));
    let record = catalog
        .attach_session_file(&project.id, &worktree, &odd)
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(record.id, SessionId::from_header_id("sess-ext"));
    assert_eq!(record.entry_count, 3);

    // 幂等：同一文件再次登记不产生新记录。
    let again = catalog
        .attach_session_file(&project.id, &worktree, &odd)
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(again.id, record.id);
    assert_eq!(
        catalog.sessions(&project.id).map(|items| items.len()),
        Some(1)
    );

    // 另一份不同路径的文件带同一个 header id：显式 attach 必须报冲突。
    let duplicate = temp.child("external/copy.jsonl");
    write_text(
        &duplicate,
        &session_text("sess-ext", &root.to_string_lossy(), 2),
    );
    assert_eq!(
        catalog
            .attach_session_file(&project.id, &worktree, &duplicate)
            .err()
            .map(|error| error.code()),
        Some(ErrorCode::SessionPathConflict)
    );
}

#[test]
fn runtime_ownership_filters_stale_generations() {
    let temp = TempDir::new("runtime");
    let root = temp.mkdir("repo");
    let sessions_root = temp.mkdir("sessions");
    seed_session(&sessions_root, &root, "sess-rt", 2);

    let mut catalog = open(&temp.child("state"), &sessions_root);
    let project = catalog
        .register_project(&root)
        .unwrap_or_else(|error| panic!("{error}"));
    catalog
        .sync(&project.id)
        .unwrap_or_else(|error| panic!("{error}"));
    let session = first_session_id(&catalog, &project.id);

    let link = catalog
        .claim_writable(&session, "rt-1")
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(link.generation, 1);
    assert_eq!(
        catalog
            .claim_writable(&session, "rt-1")
            .map(|again| again.generation),
        Ok(1),
        "同一 runtime 重复声明是幂等的"
    );
    assert_eq!(
        catalog
            .claim_writable(&session, "rt-2")
            .err()
            .map(|error| error.code()),
        Some(ErrorCode::SessionAlreadyOwned)
    );
    assert!(catalog.guard_event(&session, "rt-1", 1).is_ok());
    assert_eq!(
        catalog
            .guard_event(&session, "rt-1", 0)
            .err()
            .map(|error| error.code()),
        Some(ErrorCode::StaleRuntimeGeneration)
    );
    assert_eq!(
        catalog
            .release(&session, "rt-2")
            .err()
            .map(|error| error.code()),
        Some(ErrorCode::SessionRuntimeUnknown)
    );
    catalog
        .release(&session, "rt-1")
        .unwrap_or_else(|error| panic!("{error}"));
    let second = catalog
        .claim_writable(&session, "rt-2")
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(second.generation, 2, "generation 必须单调递增");
    catalog.save().unwrap_or_else(|error| panic!("{error}"));
    drop(catalog);

    // 重启后上一进程的挂载是死连接：打开目录时就已经清掉（不是等某个会话被启动才发现），
    // 所以这里 release_stale_runtime 已经没有可清理的挂载，水位也已经抬到 3。
    let mut reopened = open(&temp.child("state"), &sessions_root);
    assert_eq!(
        reopened.recovered_stale_runtimes(),
        1,
        "打开目录即清理崩溃遗留的运行时挂载"
    );
    assert!(
        reopened
            .find_session(&session)
            .is_some_and(|record| record.runtime.is_none()),
        "重启后不允许残留幽灵运行时"
    );
    let stale = reopened
        .release_stale_runtime(&session)
        .unwrap_or_else(|error| panic!("{error}"));
    assert!(stale.is_none(), "挂载已在 open 时清理");
    let third = reopened
        .claim_writable(&session, "rt-3")
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(third.generation, 3);
    assert!(
        !reopened.event_allowed(&session, "rt-2", 2),
        "旧运行时事件必须被丢弃"
    );
    assert!(reopened.event_allowed(&session, "rt-3", 3));
}

#[test]
fn corrupt_metadata_is_rebuilt_not_fatal() {
    let temp = TempDir::new("corrupt-state");
    let root = temp.mkdir("repo");
    let state = temp.mkdir("state");
    write_text(&state.join("catalog.json"), "{ this is not json");

    let mut catalog = open(&state, temp.path());
    assert!(catalog.load_warning(), "损坏的元数据必须被标记");
    assert!(catalog.projects().is_empty());
    let project = catalog
        .register_project(&root)
        .unwrap_or_else(|error| panic!("{error}"));
    catalog.save().unwrap_or_else(|error| panic!("{error}"));
    drop(catalog);

    let reopened = open(&state, temp.path());
    assert!(!reopened.load_warning());
    assert_eq!(
        reopened
            .project(&project.id)
            .map(|record| record.id.clone()),
        Some(project.id)
    );
}
