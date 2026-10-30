//! 会话目录名与注册路径的一致性。
//!
//! Pi 用自己的 cwd 推导会话目录名，而目录里保存的是 canonical 路径：用户通过
//! 符号链接/目录联接注册项目、或 Windows 上路径大小写与 8.3 短名不同时，两侧算出的
//! 目录名不一致，扫描就会漏掉全部会话（pty_bridge 在 macOS/Windows CI 上曾因此全红）。

mod common;

use std::path::Path;

use common::{TempDir, session_text, try_dir_link, write_text};
use soxu_session_index::{CatalogConfig, ProjectCatalog, project_sessions_dir_name};

fn write_session_under(sessions_root: &Path, path_alias: &Path, session_id: &str, cwd: &str) {
    let directory = sessions_root.join(project_sessions_dir_name(path_alias));
    std::fs::create_dir_all(&directory).expect("创建会话目录");
    write_text(
        &directory.join(format!("{session_id}.jsonl")),
        &session_text(session_id, cwd, 3),
    );
}

#[test]
fn sessions_written_under_the_requested_path_alias_are_indexed() {
    let sandbox = TempDir::new("path-alias");
    let project_root = sandbox.mkdir("project");
    let sessions_root = sandbox.mkdir("sessions");
    let state = sandbox.mkdir("state");
    let alias = sandbox.child("alias");
    if let Err(reason) = try_dir_link(&project_root, &alias) {
        // 平台不允许创建链接时显式跳过，不伪装成通过。
        eprintln!("跳过路径别名用例：{reason}");
        return;
    }
    let mut catalog =
        ProjectCatalog::open_with(&state, CatalogConfig::with_sessions_root(&sessions_root))
            .expect("打开目录");
    let project = catalog
        .register_project(&alias)
        .expect("按别名路径登记项目");
    let worktree = project.primary_worktree().expect("主工作树").clone();
    // 别名与 canonical 必须真的不同，否则这条用例什么都没验证。
    assert_ne!(
        worktree.path.as_str(),
        alias.to_string_lossy().as_ref(),
        "canonical 路径应与注册时的别名不同"
    );

    // Pi 可能按用户看到的路径（别名）写会话目录。
    write_session_under(&sessions_root, &alias, "session-alias", &worktree.path);
    catalog.sync(&project.id).expect("同步会话目录");
    let sessions = catalog.sessions_in_worktree(&worktree.id);
    assert_eq!(sessions.len(), 1, "别名目录里的会话也必须被索引");

    let record = catalog.project(&project.id).expect("项目仍在").clone();
    assert!(
        record.worktrees[0]
            .aliases
            .iter()
            .any(|value| value == alias.to_string_lossy().as_ref()),
        "注册时的原始路径应作为别名保留"
    );
}

#[test]
fn canonical_directory_stays_the_preferred_candidate() {
    let sandbox = TempDir::new("path-canonical");
    let project_root = sandbox.mkdir("project");
    let sessions_root = sandbox.mkdir("sessions");
    let state = sandbox.mkdir("state");
    let mut catalog =
        ProjectCatalog::open_with(&state, CatalogConfig::with_sessions_root(&sessions_root))
            .expect("打开目录");
    let project = catalog.register_project(&project_root).expect("登记项目");
    let worktree = project.primary_worktree().expect("主工作树").clone();
    assert!(worktree.aliases.is_empty(), "路径一致时不应产生别名");
    write_session_under(
        &sessions_root,
        Path::new(&worktree.path),
        "session-canonical",
        &worktree.path,
    );
    catalog.sync(&project.id).expect("同步会话目录");
    assert_eq!(catalog.sessions_in_worktree(&worktree.id).len(), 1);
}
