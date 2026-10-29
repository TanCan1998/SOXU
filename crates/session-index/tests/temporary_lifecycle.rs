//! 临时会话生命周期：默认不进入持久化历史、显式转正、崩溃后无幽灵历史、多会话隔离。

mod common;

use std::fs;
use std::path::{Path, PathBuf};

use common::*;
use soxu_session_index::{
    CatalogConfig, ErrorCode, MAX_TEMPORARY_SESSIONS, ProjectCatalog, ProjectId, SessionId,
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

fn session_count(catalog: &ProjectCatalog, project: &ProjectId) -> usize {
    catalog
        .sessions(project)
        .map(|items| items.len())
        .unwrap_or(0)
}

#[test]
fn temporary_session_never_enters_persisted_history() {
    let temp = TempDir::new("temp-only-memory");
    let root = temp.mkdir("repo");
    let sessions_root = temp.mkdir("sessions");

    let mut catalog = open(&temp.child("state"), &sessions_root);
    let project = catalog
        .register_project(&root)
        .unwrap_or_else(|error| panic!("{error}"));
    let temporary = catalog
        .open_temporary_session(&project.id, None)
        .unwrap_or_else(|error| panic!("{error}"));
    assert!(temporary.session.as_str().starts_with("ses_tmp_"));
    assert!(!temporary.is_bound());
    assert!(catalog.is_temporary(&temporary.session));
    assert_eq!(catalog.temporary_sessions().len(), 1);
    // 关键：临时会话不在持久化历史里。
    assert_eq!(session_count(&catalog, &project.id), 0);
    catalog.save().unwrap_or_else(|error| panic!("{error}"));
    drop(catalog);

    // 「重启」：新进程只读磁盘状态，内存登记表本来就是空的。
    let reopened = open(&temp.child("state"), &sessions_root);
    assert_eq!(reopened.temporary_sessions().len(), 0);
    assert_eq!(session_count(&reopened, &project.id), 0);
    assert!(reopened.find_session(&temporary.session).is_none());
}

#[test]
fn bound_file_is_hidden_from_sync_until_promoted() {
    let temp = TempDir::new("bind-promote");
    let root = temp.mkdir("repo");
    let sessions_root = temp.mkdir("sessions");
    let file = seed_session(&sessions_root, &root, "sess-tmp-promote", 2);

    let mut catalog = open(&temp.child("state"), &sessions_root);
    let project = catalog
        .register_project(&root)
        .unwrap_or_else(|error| panic!("{error}"));
    let temporary = catalog
        .open_temporary_session(&project.id, None)
        .unwrap_or_else(|error| panic!("{error}"));
    let bound = catalog
        .bind_temporary_file(&temporary.session, &file)
        .unwrap_or_else(|error| panic!("{error}"));
    assert!(bound.is_bound());

    // 绑定期间扫描必须跳过：临时对话不能变成普通历史（否则重启后就是幽灵历史）。
    let report = catalog
        .sync(&project.id)
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(report.scanned_files, 0);
    assert_eq!(report.temporary_skipped.len(), 1);
    assert_eq!(session_count(&catalog, &project.id), 0);

    // 显式转正：登记进历史，身份取 Pi 会话头部的 id。
    let record = catalog
        .promote_temporary_session(&temporary.session)
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(record.id, SessionId::from_header_id("sess-tmp-promote"));
    assert_eq!(record.entry_count, 3);
    assert_eq!(session_count(&catalog, &project.id), 1);
    assert!(catalog.temporary_sessions().is_empty());
    catalog.save().unwrap_or_else(|error| panic!("{error}"));
    drop(catalog);

    // 重启后转正结果必须还在，并且不会被扫描重复登记。
    let mut reopened = open(&temp.child("state"), &sessions_root);
    assert_eq!(session_count(&reopened, &project.id), 1);
    let report = reopened
        .sync(&project.id)
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(report.unchanged, 1);
    assert!(
        report.temporary_skipped.is_empty(),
        "转正后不再被临时登记挡住"
    );
    assert_eq!(session_count(&reopened, &project.id), 1);
    assert!(file.exists(), "转正不得移动或删除 Pi 的会话文件");
}

#[test]
fn promotion_without_a_bound_file_keeps_the_temporary_session() {
    let temp = TempDir::new("promote-unbound");
    let root = temp.mkdir("repo");
    let sessions_root = temp.mkdir("sessions");

    let mut catalog = open(&temp.child("state"), &sessions_root);
    let project = catalog
        .register_project(&root)
        .unwrap_or_else(|error| panic!("{error}"));
    let temporary = catalog
        .open_temporary_session(&project.id, None)
        .unwrap_or_else(|error| panic!("{error}"));

    let error = catalog
        .promote_temporary_session(&temporary.session)
        .err()
        .unwrap_or_else(|| panic!("未绑定文件时转正必须失败"));
    assert_eq!(error.code(), ErrorCode::TemporarySessionUnpromotable);
    assert_eq!(error.code().as_str(), "E_TEMPORARY_SESSION_UNPROMOTABLE");
    assert!(error.recoverable(), "绑定文件后可以重试");
    // 失败必须保留临时会话，且不写入任何历史（UI 才能显示原因并保留内容）。
    assert!(catalog.is_temporary(&temporary.session));
    assert_eq!(session_count(&catalog, &project.id), 0);

    // 未绑定文件时的分页同样给出明确错误，而不是编造空历史。
    let page_error = catalog
        .page_temporary_session(&temporary.session, Default::default())
        .err()
        .unwrap_or_else(|| panic!("未绑定文件时不应返回分页"));
    assert_eq!(page_error.code(), ErrorCode::TemporarySessionUnpromotable);
}

#[test]
fn binding_rejects_invalid_and_already_registered_files() {
    let temp = TempDir::new("bind-guard");
    let root = temp.mkdir("repo");
    let sessions_root = temp.mkdir("sessions");
    let registered = seed_session(&sessions_root, &root, "sess-normal", 1);
    let plain = temp.child("notes.txt");
    write_text(&plain, "not a session");
    let broken = temp.child("broken.jsonl");
    write_text(&broken, "not json\n");

    let mut catalog = open(&temp.child("state"), &sessions_root);
    let project = catalog
        .register_project(&root)
        .unwrap_or_else(|error| panic!("{error}"));
    catalog
        .sync(&project.id)
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(session_count(&catalog, &project.id), 1);
    let temporary = catalog
        .open_temporary_session(&project.id, None)
        .unwrap_or_else(|error| panic!("{error}"));

    // 不是 Pi 会话文件：扩展名与头部都要校验。
    assert_eq!(
        catalog
            .bind_temporary_file(&temporary.session, &plain)
            .err()
            .map(|error| error.code()),
        Some(ErrorCode::TemporarySessionFileInvalid)
    );
    assert_eq!(
        catalog
            .bind_temporary_file(&temporary.session, &broken)
            .err()
            .map(|error| error.code()),
        Some(ErrorCode::TemporarySessionFileInvalid)
    );
    // 已经是普通会话的落点：历史一旦可见就不能再退回临时。
    assert_eq!(
        catalog
            .bind_temporary_file(&temporary.session, &registered)
            .err()
            .map(|error| error.code()),
        Some(ErrorCode::TemporarySessionFileConflict)
    );
    // 未登记的临时会话：显式错误码，不是静默忽略。
    assert_eq!(
        catalog
            .bind_temporary_file(&SessionId::new("ses_tmp_unknown"), &registered)
            .err()
            .map(|error| error.code()),
        Some(ErrorCode::TemporarySessionUnknown)
    );
}

#[test]
fn crash_leaves_no_ghost_runtime_and_no_temporary_history() {
    let temp = TempDir::new("crash");
    let root = temp.mkdir("repo");
    let sessions_root = temp.mkdir("sessions");
    seed_session(&sessions_root, &root, "sess-crash", 2);

    let mut catalog = open(&temp.child("state"), &sessions_root);
    let project = catalog
        .register_project(&root)
        .unwrap_or_else(|error| panic!("{error}"));
    catalog
        .sync(&project.id)
        .unwrap_or_else(|error| panic!("{error}"));
    let session = catalog
        .sessions(&project.id)
        .and_then(|items| items.first())
        .map(|record| record.id.clone())
        .unwrap_or_else(|| panic!("会话应被登记"));
    let link = catalog
        .claim_writable(&session, "rt-crashed")
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(link.generation, 1);
    // 崩溃前还存在一个临时会话：它只活在内存里，不该被写盘。
    let temporary = catalog
        .open_temporary_session(&project.id, None)
        .unwrap_or_else(|error| panic!("{error}"));
    catalog.save().unwrap_or_else(|error| panic!("{error}"));
    // 模拟崩溃：不调用 release 就丢弃目录对象。
    drop(catalog);

    let reopened = open(&temp.child("state"), &sessions_root);
    assert_eq!(
        reopened.recovered_stale_runtimes(),
        1,
        "上一进程的运行时挂载必须被清理"
    );
    assert!(
        reopened
            .find_session(&session)
            .is_some_and(|record| record.runtime.is_none()),
        "重启后不允许出现幽灵运行时"
    );
    assert!(
        !reopened.event_allowed(&session, "rt-crashed", 1),
        "旧 generation 的事件必须被丢弃"
    );
    // 水位已抬到 2：新运行时拿到更大的代号。
    let next = reopened
        .find_session(&session)
        .map(|record| record.generation_watermark)
        .unwrap_or(0);
    assert_eq!(next, 2);
    // 临时会话没有留下任何历史痕迹。
    assert_eq!(reopened.temporary_sessions().len(), 0);
    assert!(reopened.find_session(&temporary.session).is_none());
    assert_eq!(
        reopened.sessions(&project.id).map(|items| items.len()),
        Some(1),
        "崩溃后历史里只有真实的 Pi 会话"
    );
}

#[test]
fn temporary_sessions_are_isolated_between_projects_and_worktrees() {
    let temp = TempDir::new("isolation");
    let root_a = temp.mkdir("repo-a");
    let root_b = temp.mkdir("repo-b");
    let branch_a = temp.mkdir("repo-a-feature");
    let sessions_root = temp.mkdir("sessions");
    let file_a = seed_session(&sessions_root, &root_a, "sess-a", 2);
    let file_b = seed_session(&sessions_root, &root_b, "sess-b", 3);

    let mut catalog = open(&temp.child("state"), &sessions_root);
    let project_a = catalog
        .register_project(&root_a)
        .unwrap_or_else(|error| panic!("{error}"));
    let project_b = catalog
        .register_project(&root_b)
        .unwrap_or_else(|error| panic!("{error}"));
    let worktree_a = catalog
        .add_worktree(&project_a.id, &branch_a, Some("feature"))
        .unwrap_or_else(|error| panic!("{error}"));

    let temp_a = catalog
        .open_temporary_session(&project_a.id, Some(&worktree_a.id))
        .unwrap_or_else(|error| panic!("{error}"));
    let temp_b = catalog
        .open_temporary_session(&project_b.id, None)
        .unwrap_or_else(|error| panic!("{error}"));
    assert_ne!(temp_a.session, temp_b.session, "两个临时会话身份必须不同");
    assert_eq!(temp_a.worktree, worktree_a.id);
    assert_eq!(catalog.temporary_sessions().len(), 2);

    catalog
        .bind_temporary_file(&temp_a.session, &file_a)
        .unwrap_or_else(|error| panic!("{error}"));
    catalog
        .bind_temporary_file(&temp_b.session, &file_b)
        .unwrap_or_else(|error| panic!("{error}"));

    // 转正 A 不能顺带登记 B 的会话。
    catalog
        .promote_temporary_session(&temp_a.session)
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(session_count(&catalog, &project_a.id), 1);
    assert_eq!(session_count(&catalog, &project_b.id), 0);
    assert!(catalog.is_temporary(&temp_b.session), "B 仍是临时会话");
    assert_eq!(
        catalog
            .identity(&SessionId::from_header_id("sess-a"))
            .map(|identity| identity.project),
        Ok(project_a.id.clone())
    );

    // 扫描 B 时 A 已转正的文件不影响 B；B 的绑定文件仍被跳过。
    let report = catalog
        .sync(&project_b.id)
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(report.temporary_skipped.len(), 1);
    assert_eq!(session_count(&catalog, &project_b.id), 0);
}

#[test]
fn temporary_registry_is_bounded_and_discard_keeps_pi_files() {
    let temp = TempDir::new("bounded");
    let root = temp.mkdir("repo");
    let sessions_root = temp.mkdir("sessions");
    let file = seed_session(&sessions_root, &root, "sess-discard", 1);

    let mut catalog = open(&temp.child("state"), &sessions_root);
    let project = catalog
        .register_project(&root)
        .unwrap_or_else(|error| panic!("{error}"));
    let first = catalog
        .open_temporary_session(&project.id, None)
        .unwrap_or_else(|error| panic!("{error}"));
    catalog
        .bind_temporary_file(&first.session, &file)
        .unwrap_or_else(|error| panic!("{error}"));
    // 分页会写索引快照；结束临时会话后该快照必须被清掉。
    let page = catalog
        .page_temporary_session(&first.session, Default::default())
        .unwrap_or_else(|error| panic!("{error}"));
    assert!(page.total > 0, "绑定的文件应当可以分页");
    let index_dir = temp.child("state").join("indexes");
    let snapshots = fs::read_dir(&index_dir)
        .map(|entries| entries.filter_map(|entry| entry.ok()).count())
        .unwrap_or(0);
    assert_eq!(snapshots, 1, "临时会话的分页会落一份索引快照");

    let discarded = catalog
        .discard_temporary_session(&first.session)
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(discarded.session, first.session);
    assert!(!catalog.is_temporary(&first.session));
    assert!(file.exists(), "结束临时会话不得删除 Pi 的会话文件");
    assert_eq!(session_count(&catalog, &project.id), 0);
    let snapshots = fs::read_dir(&index_dir)
        .map(|entries| entries.filter_map(|entry| entry.ok()).count())
        .unwrap_or(0);
    assert_eq!(snapshots, 0, "临时会话结束后索引快照不应残留");
    assert_eq!(
        catalog
            .discard_temporary_session(&first.session)
            .err()
            .map(|error| error.code()),
        Some(ErrorCode::TemporarySessionUnknown)
    );

    for _ in 0..MAX_TEMPORARY_SESSIONS {
        catalog
            .open_temporary_session(&project.id, None)
            .unwrap_or_else(|error| panic!("{error}"));
    }
    let limit = catalog
        .open_temporary_session(&project.id, None)
        .err()
        .unwrap_or_else(|| panic!("超出上限必须失败"));
    assert_eq!(limit.code(), ErrorCode::TemporarySessionLimit);
    assert!(limit.recoverable());
    assert_eq!(catalog.temporary_sessions().len(), MAX_TEMPORARY_SESSIONS);
}

#[test]
fn live_runtime_blocks_promotion_and_discard() {
    let temp = TempDir::new("runtime-guard");
    let root = temp.mkdir("repo");
    let sessions_root = temp.mkdir("sessions");
    let file = seed_session(&sessions_root, &root, "sess-runtime-guard", 2);

    let mut catalog = open(&temp.child("state"), &sessions_root);
    let project = catalog
        .register_project(&root)
        .unwrap_or_else(|error| panic!("{error}"));
    let temporary = catalog
        .open_temporary_session(&project.id, None)
        .unwrap_or_else(|error| panic!("{error}"));
    catalog
        .bind_temporary_file(&temporary.session, &file)
        .unwrap_or_else(|error| panic!("{error}"));
    assert!(!catalog.temporary_session_claimed(&temporary.session));

    // 运行中的 Pi 声明可写归属（只存在内存，不写 catalog.json）。
    let claimed = catalog
        .claim_temporary_writable(&temporary.session, "rt_live")
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(claimed.as_str(), "rt_live");
    assert!(catalog.temporary_session_claimed(&temporary.session));
    // 同一个 runtime 重复声明幂等；别的 runtime 抢占必须失败（防双写）。
    assert!(
        catalog
            .claim_temporary_writable(&temporary.session, "rt_live")
            .is_ok()
    );
    let conflict = catalog
        .claim_temporary_writable(&temporary.session, "rt_other")
        .err()
        .unwrap_or_else(|| panic!("不同 runtime 抢占必须失败"));
    assert_eq!(conflict.code(), ErrorCode::TemporarySessionRuntimeActive);

    // 转正被拒：不写入历史，临时会话与 Pi 文件都保留，UI 可以显示原因后重试。
    let blocked = catalog
        .promote_temporary_session(&temporary.session)
        .err()
        .unwrap_or_else(|| panic!("有活运行时不允许转正"));
    assert_eq!(blocked.code(), ErrorCode::TemporarySessionRuntimeActive);
    assert!(
        blocked.recoverable(),
        "停止运行时后可以重试，属于可恢复错误"
    );
    assert_eq!(session_count(&catalog, &project.id), 0);
    assert!(catalog.is_temporary(&temporary.session));
    assert!(file.exists(), "被拒绝的转正不得动 Pi 的会话文件");

    // 结束同样被拒：登记一旦消失，进程就失去 owner，文件还可能被扫描成幽灵历史。
    let blocked = catalog
        .discard_temporary_session(&temporary.session)
        .err()
        .unwrap_or_else(|| panic!("有活运行时不允许结束临时会话"));
    assert_eq!(blocked.code(), ErrorCode::TemporarySessionRuntimeActive);
    assert!(catalog.is_temporary(&temporary.session));

    // 释放者必须与持有者一致；错误的释放不能清掉归属，重复释放幂等。
    let wrong = catalog
        .release_temporary_writable(&temporary.session, "rt_other")
        .err()
        .unwrap_or_else(|| panic!("错误的释放者必须被拒绝"));
    assert_eq!(wrong.code(), ErrorCode::SessionRuntimeUnknown);
    assert!(catalog.temporary_session_claimed(&temporary.session));
    catalog
        .release_temporary_writable(&temporary.session, "rt_live")
        .unwrap_or_else(|error| panic!("{error}"));
    assert!(!catalog.temporary_session_claimed(&temporary.session));
    catalog
        .release_temporary_writable(&temporary.session, "rt_live")
        .unwrap_or_else(|error| panic!("重复释放必须幂等：{error}"));

    // 崩溃或自行退出遗留的归属可以被强制清理（只有掌握进程生命周期的调用方会这样做），
    // 否则「请先停止运行时」会变成无法退出的死循环。
    catalog
        .claim_temporary_writable(&temporary.session, "rt_crashed")
        .unwrap_or_else(|error| panic!("{error}"));
    let stale = catalog.release_stale_temporary_runtime(&temporary.session);
    assert_eq!(
        stale.as_ref().map(|runtime| runtime.as_str()),
        Some("rt_crashed")
    );
    assert!(!catalog.temporary_session_claimed(&temporary.session));
    assert!(
        catalog
            .release_stale_temporary_runtime(&temporary.session)
            .is_none(),
        "没有归属时清理是幂等的"
    );

    // 运行时停下之后，转正恢复正常。
    let record = catalog
        .promote_temporary_session(&temporary.session)
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(record.id, SessionId::from_header_id("sess-runtime-guard"));
    assert_eq!(session_count(&catalog, &project.id), 1);
    assert!(!catalog.is_temporary(&temporary.session));
    assert!(file.exists());
}
