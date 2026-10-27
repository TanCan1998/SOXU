//! 工作树记录：分支回填、失效标记、会话按工作树隔离（TASK-005 依赖面的证据）。

mod common;

use std::fs;
use std::path::Path;

use common::{TempDir, session_dir, session_text, write_text};
use soxu_session_index::{CatalogConfig, ErrorCode, ProjectCatalog, SessionId, WorktreeId};

#[test]
fn worktree_references_are_updated_and_sessions_stay_isolated() {
    let sandbox = TempDir::new("worktrees");
    let project_root = sandbox.mkdir("project");
    let linked_a = sandbox.mkdir("wt-a");
    let linked_b = sandbox.mkdir("wt-b");
    let sessions_root = sandbox.mkdir("sessions");
    let state = sandbox.mkdir("state");

    let mut catalog =
        ProjectCatalog::open_with(&state, CatalogConfig::with_sessions_root(&sessions_root))
            .expect("打开目录");
    let project = catalog.register_project(&project_root).expect("登记项目");
    let primary = project.primary_worktree().expect("主工作树").id.clone();
    let a = catalog
        .add_worktree(&project.id, &linked_a, None)
        .expect("登记工作树 A");
    let b = catalog
        .add_worktree(&project.id, &linked_b, Some("feature-b"))
        .expect("登记工作树 B");
    assert!(!a.missing, "新建引用默认可用");
    assert_eq!(a.branch, None);

    // 分支由 Git 服务回填；Git 的锁定/prunable 状态不影响目录存在性判断。
    let updated = catalog
        .update_worktree(&project.id, &a.id, Some("feature-a"), false)
        .expect("回填分支");
    assert_eq!(updated.branch.as_deref(), Some("feature-a"));
    assert!(!updated.missing);

    for (worktree, id) in [(&linked_a, "session-a"), (&linked_b, "session-b")] {
        let path = session_dir(&sessions_root, worktree).join(format!("{id}.jsonl"));
        write_text(&path, &session_text(id, &worktree.to_string_lossy(), 3));
    }
    catalog.sync(&project.id).expect("同步会话目录");

    let sessions_a = catalog.sessions_in_worktree(&a.id);
    assert_eq!(sessions_a.len(), 1, "A 只看到自己的会话");
    assert_eq!(sessions_a[0].id, SessionId::from_header_id("session-a"));
    assert_eq!(sessions_a[0].worktree, a.id);
    let file_a = sessions_a[0].file.clone();
    let sessions_b = catalog.sessions_in_worktree(&b.id);
    assert_eq!(sessions_b.len(), 1, "B 只看到自己的会话");
    assert_ne!(
        sessions_a[0].id, sessions_b[0].id,
        "工作树之间不共享会话身份"
    );
    assert!(catalog.sessions_in_worktree(&primary).is_empty());

    // 失效标记只改引用：会话文件与分支信息都保留，便于人工核对与恢复。
    catalog
        .update_worktree(&project.id, &a.id, None, true)
        .expect("标记工作树失效");
    let record = catalog
        .project(&project.id)
        .and_then(|record| record.worktree(&a.id).cloned())
        .expect("引用仍保留");
    assert!(record.missing);
    assert_eq!(
        record.branch.as_deref(),
        Some("feature-a"),
        "缺省分支不覆盖已有值"
    );
    assert!(Path::new(&file_a).exists(), "不得删除 Pi 会话文件");

    let error = catalog
        .update_worktree(&project.id, &WorktreeId::new("wkt_unknown"), None, true)
        .expect_err("未登记工作树必须报错");
    assert_eq!(error.code(), ErrorCode::WorktreeUnknown);

    // 失效标记与分支一起落盘，重启后仍可读。
    catalog.save().expect("保存目录");
    drop(catalog);
    let reloaded =
        ProjectCatalog::open_with(&state, CatalogConfig::with_sessions_root(&sessions_root))
            .expect("重新打开目录");
    let reloaded_worktree = reloaded
        .project(&project.id)
        .and_then(|record| record.worktree(&a.id))
        .expect("重启后工作树引用仍在");
    assert!(reloaded_worktree.missing);
    assert_eq!(reloaded_worktree.branch.as_deref(), Some("feature-a"));
    let _ = fs::remove_dir_all(&state);
}
