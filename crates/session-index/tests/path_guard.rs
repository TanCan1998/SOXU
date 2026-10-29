//! 越权路径与符号链接回归测试（PRD P-08 / Issue #40）。
//!
//! 边界：隐式扫描（`ProjectCatalog::sync`）只允许解析后仍位于会话根目录内的
//! `.jsonl`。文件符号链接与目录联接（Windows junction）都不能把外部文件带进索引；
//! 被拒绝的文件列在 `SyncReport::rejected_paths` 里，且磁盘内容原样保留。
//!
//! 平台差异（Windows 普通用户不能建符号链接、只能建目录联接）与运行方式见
//! `docs/development/security-regression.md`。

mod common;

use std::fs;
use std::path::{Path, PathBuf};

use common::*;
use soxu_session_index::{
    CatalogConfig, ErrorCode, ProjectCatalog, SessionId, WorktreeId, normalize_path,
    project_sessions_dir_name,
};

/// 外部文件的标记：一旦被索引就可以被断言抓出来。
const OUTSIDE_MARKER: &str = "outside-only-marker";

fn open(state: &Path, sessions_root: &Path) -> ProjectCatalog {
    ProjectCatalog::open_with(state, CatalogConfig::with_sessions_root(sessions_root))
        .unwrap_or_else(|error| panic!("open catalog: {error}"))
}

/// 在 Pi 布局下为工作树写入一个正常会话，返回文件路径。
fn seed_inside(sessions_root: &Path, root: &Path, id: &str) -> PathBuf {
    let file = session_dir(sessions_root, root).join(format!("2026-01-01T00-00-00_{id}.jsonl"));
    write_text(&file, &session_text(id, &root.to_string_lossy(), 2));
    file
}

/// 在会话根目录之外写入一个"机密"会话文件。
fn seed_outside(outer: &Path) -> PathBuf {
    let file = outer.join("secret.jsonl");
    let mut text = header_line("sess-outside", "/outside/secret");
    text.push('\n');
    text.push_str(&message_line("m1", None, "user", OUTSIDE_MARKER));
    text.push('\n');
    write_text(&file, &text);
    file
}

#[test]
fn linked_session_file_outside_root_is_not_indexed() {
    let temp = TempDir::new("guard-file-link");
    let root = temp.mkdir("repo");
    let sessions_root = temp.mkdir("sessions");
    let outer = temp.mkdir("outer");
    let outside_file = seed_outside(&outer);
    let inside_file = seed_inside(&sessions_root, &root, "sess-inside");
    let link = session_dir(&sessions_root, &root).join("leak.jsonl");

    if let Err(reason) = try_file_link(&outside_file, &link) {
        // 不假装通过：报告平台限制，符号链接子用例在无权限的 Windows 上不执行。
        eprintln!("平台限制：{reason}；文件符号链接子用例跳过");
        return;
    }

    let mut catalog = open(&temp.child("state"), &sessions_root);
    let project = catalog
        .register_project(&root)
        .unwrap_or_else(|error| panic!("{error}"));
    let report = catalog
        .sync(&project.id)
        .unwrap_or_else(|error| panic!("{error}"));

    assert_eq!(report.scanned_files, 1, "只应扫描到目录内的正常会话");
    assert!(
        report
            .rejected_paths
            .iter()
            .any(|path| path.ends_with("leak.jsonl")),
        "越界链接必须出现在拒绝清单里：{:?}",
        report.rejected_paths
    );
    assert!(
        catalog
            .find_session(&SessionId::from_header_id("sess-outside"))
            .is_none(),
        "外部会话不得进入索引"
    );
    let sessions = catalog.sessions(&project.id).expect("项目已登记");
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].id, SessionId::from_header_id("sess-inside"));
    assert_eq!(
        normalize_path(Path::new(&sessions[0].file)),
        normalize_path(&inside_file)
    );

    // 拒绝只影响索引：外部文件与链接都原样留在磁盘上，SOXU 不删除用户文件。
    assert!(outside_file.exists());
    assert!(link.exists());
}

#[test]
fn linked_session_directory_outside_root_is_not_indexed() {
    let temp = TempDir::new("guard-dir-link");
    let root = temp.mkdir("repo");
    let sessions_root = temp.mkdir("sessions");
    let outer_sessions = temp.mkdir("outer-sessions");
    let outside_file = seed_outside(&outer_sessions);
    let directory = session_dir(&sessions_root, &root);

    // 让项目的会话目录整体指向会话根目录之外：Windows 上这是普通用户也能建的目录联接。
    if let Some(parent) = directory.parent() {
        fs::create_dir_all(parent).expect("创建会话根目录");
    }
    if let Err(reason) = try_dir_link(&outer_sessions, &directory) {
        eprintln!("平台限制：{reason}；目录链接子用例跳过");
        return;
    }

    let mut catalog = open(&temp.child("state"), &sessions_root);
    let project = catalog
        .register_project(&root)
        .unwrap_or_else(|error| panic!("{error}"));
    let report = catalog
        .sync(&project.id)
        .unwrap_or_else(|error| panic!("{error}"));

    assert_eq!(report.scanned_files, 0, "越界目录里的文件不得被扫描");
    assert!(
        report
            .rejected_paths
            .iter()
            .any(|path| path.ends_with("secret.jsonl")),
        "拒绝清单必须记录越界文件：{:?}",
        report.rejected_paths
    );
    assert!(
        catalog
            .sessions(&project.id)
            .is_some_and(<[soxu_session_index::SessionRecord]>::is_empty),
        "越界目录不得登记任何会话"
    );
    assert!(outside_file.exists(), "外部会话文件必须原样保留");
}

#[test]
fn project_registered_through_link_keeps_a_single_identity() {
    let temp = TempDir::new("guard-project-link");
    let root = temp.mkdir("repo");
    let link = temp.child("repo-link");
    if let Err(reason) = try_dir_link(&root, &link) {
        eprintln!("平台限制：{reason}；项目符号链接子用例跳过");
        return;
    }

    let mut catalog = open(&temp.child("state"), &temp.mkdir("sessions"));
    let direct = catalog
        .register_project(&root)
        .unwrap_or_else(|error| panic!("{error}"));
    let via_link = catalog
        .register_project(&link)
        .unwrap_or_else(|error| panic!("{error}"));

    assert_eq!(direct.id, via_link.id, "同一目录的不同写法必须是同一身份");
    assert_eq!(catalog.projects().len(), 1, "不得因为路径写法重复登记");
    assert_eq!(
        normalize_path(Path::new(&via_link.root)),
        normalize_path(&root),
        "登记的根目录必须解析成真实路径"
    );
}

#[test]
fn attach_of_unregistered_worktree_is_rejected() {
    let temp = TempDir::new("guard-attach");
    let root = temp.mkdir("repo");
    let sessions_root = temp.mkdir("sessions");
    let file = seed_inside(&sessions_root, &root, "sess-attach");

    let mut catalog = open(&temp.child("state"), &sessions_root);
    let project = catalog
        .register_project(&root)
        .unwrap_or_else(|error| panic!("{error}"));
    let error = catalog
        .attach_session_file(&project.id, &WorktreeId::new("wkt_unknown"), &file)
        .expect_err("未登记的工作树不得读取会话文件");
    assert_eq!(error.code(), ErrorCode::WorktreeUnknown);
}

#[test]
fn registering_a_file_as_project_root_is_rejected() {
    let temp = TempDir::new("guard-file-root");
    let sessions_root = temp.mkdir("sessions");
    let file = temp.child("notes.txt");
    write_text(&file, "not a directory");

    let mut catalog = open(&temp.child("state"), &sessions_root);
    let error = catalog
        .register_project(&file)
        .expect_err("文件不能登记为项目根目录");
    assert_eq!(error.code(), ErrorCode::ProjectRootNotDirectory);
}

#[test]
fn session_directory_name_stays_inside_the_sessions_root() {
    // 目录名由路径派生：任何输入的路径都不允许在名字里留下分隔符，
    // 否则扫描会跑出会话根目录（Windows 的盘符与反斜杠同样处理）。
    for raw in [
        "/home/user/repo",
        r"F:\workplace\pi",
        "../..",
        "C:/a/../../b",
    ] {
        let name = project_sessions_dir_name(Path::new(raw));
        let relative = name.trim_matches('-');
        assert!(!relative.contains("..\\"), "目录名不得保留遍历片段：{name}");
        assert!(!relative.contains("../"), "目录名不得保留遍历片段：{name}");
        assert!(
            !relative.contains(':') && !relative.contains('\\') && !relative.contains('/'),
            "目录名不得保留分隔符或盘符：{name}"
        );
    }
}
