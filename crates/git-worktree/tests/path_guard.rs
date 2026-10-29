//! 工作树路径边界回归测试（PRD P-08 / Issue #40）。
//!
//! 覆盖三类越权：
//! 1. **写越界**：目标目录不在允许根目录内、用 `..` 穿越、经符号链接/目录联接逃出；
//! 2. **覆盖写**：目标已存在时拒绝执行，绝不覆盖用户已有目录；
//! 3. **未授权读取**：未登记路径不作为工作树被读取或规划，非仓库目录直接拒绝。
//!
//! 所有断言都要求磁盘保持原样：拒绝只返回稳定错误码，不留下半成品目录。
//! 平台差异（Windows 普通用户只能建目录联接）见 docs/development/security-regression.md。

mod support;

use std::fs;
use std::path::{Path, PathBuf};

use soxu_git_worktree::{CreateRequest, GitErrorCode, GitRepo};
use support::{Sandbox, init_repo, try_dir_link};

fn repo(sandbox: &Sandbox) -> (GitRepo, PathBuf) {
    let root = init_repo(sandbox);
    let repo = GitRepo::open(&root).unwrap_or_else(|error| panic!("打开仓库失败：{error}"));
    (repo, root)
}

#[test]
fn relative_destination_is_rejected_by_path_resolution() {
    let sandbox = Sandbox::new("guard-relative");
    let (repo, _root) = repo(&sandbox);

    let error = repo
        .create_worktree(
            &CreateRequest::new_branch(Path::new("wt-relative"), "rel").inside(sandbox.root()),
        )
        .expect_err("相对路径必须被拒绝");
    assert_eq!(error.code(), GitErrorCode::PathNotAbsolute);
    assert!(!sandbox.path("wt-relative").exists());
}

#[test]
fn traversal_outside_allowed_root_is_rejected() {
    let sandbox = Sandbox::new("guard-traversal");
    let (repo, _root) = repo(&sandbox);
    let allowed = sandbox.path("allowed");
    let outside = sandbox.path("outside");
    fs::create_dir_all(&allowed).expect("创建允许根目录");
    fs::create_dir_all(&outside).expect("创建外部目录");

    // 父目录存在且可解析，但解析结果落在允许根目录之外。
    let destination = allowed.join("..").join("outside").join("wt");
    let error = repo
        .create_worktree(&CreateRequest::new_branch(&destination, "trav").inside(&allowed))
        .expect_err("穿越允许根目录必须被拒绝");
    assert_eq!(error.code(), GitErrorCode::PathOutsideRoot);
    assert!(!outside.join("wt").exists(), "拒绝后不得留下任何目录");
}

#[test]
fn linked_parent_escaping_allowed_root_is_rejected() {
    let sandbox = Sandbox::new("guard-link");
    let (repo, _root) = repo(&sandbox);
    let allowed = sandbox.path("allowed");
    let outside = sandbox.path("outside");
    fs::create_dir_all(&allowed).expect("创建允许根目录");
    fs::create_dir_all(&outside).expect("创建外部目录");
    let escape = allowed.join("escape");

    // 符号链接（Unix / 开发者模式的 Windows）或目录联接（Windows junction）。
    if let Err(reason) = try_dir_link(&outside, &escape) {
        eprintln!("平台限制：{reason}；符号链接子用例跳过");
        return;
    }

    let destination = escape.join("wt");
    let error = repo
        .create_worktree(&CreateRequest::new_branch(&destination, "linked").inside(&allowed))
        .expect_err("经链接逃出允许根目录必须被拒绝");
    assert_eq!(
        error.code(),
        GitErrorCode::PathOutsideRoot,
        "解析链接后必须识别出越界：{error}"
    );
    assert!(!outside.join("wt").exists(), "外部目录不得出现工作树目录");
}

#[test]
fn destination_inside_the_repository_is_rejected() {
    let sandbox = Sandbox::new("guard-inside");
    let (repo, root) = repo(&sandbox);
    let destination = root.join("nested-wt");

    let error = repo
        .create_worktree(&CreateRequest::new_branch(&destination, "inside").inside(sandbox.root()))
        .expect_err("工作树不能建在仓库内部");
    assert_eq!(error.code(), GitErrorCode::PathInsideRepo);
    assert!(!destination.exists());
}

#[test]
fn existing_destination_is_never_overwritten() {
    let sandbox = Sandbox::new("guard-exists");
    let (repo, _root) = repo(&sandbox);
    let destination = sandbox.path("wt-exists");
    fs::create_dir_all(&destination).expect("创建已存在目录");
    let sentinel = destination.join("keep.txt");
    fs::write(&sentinel, "user data").expect("写入哨兵文件");

    let error = repo
        .create_worktree(&CreateRequest::new_branch(&destination, "exists").inside(sandbox.root()))
        .expect_err("已存在目录必须拒绝覆盖");
    assert_eq!(error.code(), GitErrorCode::PathExists);
    assert_eq!(
        fs::read_to_string(&sentinel).expect("哨兵文件必须原样保留"),
        "user data"
    );
}

#[test]
fn unmanaged_path_is_not_read_as_a_worktree() {
    let sandbox = Sandbox::new("guard-unmanaged");
    let (repo, _root) = repo(&sandbox);
    let stray = sandbox.path("stray");
    fs::create_dir_all(&stray).expect("创建未登记目录");

    let lookup = repo
        .worktree(&stray)
        .expect_err("未登记路径不得被当作工作树");
    assert_eq!(lookup.code(), GitErrorCode::WorktreeUnknown);
    let plan = repo
        .plan_remove(&stray)
        .expect_err("未登记路径不得进入删除规划");
    assert_eq!(plan.code(), GitErrorCode::WorktreeUnknown);
    assert!(stray.is_dir(), "拒绝不影响磁盘");
}

#[test]
fn non_repository_directories_are_rejected() {
    let sandbox = Sandbox::new("guard-repo");
    let missing = GitRepo::open(sandbox.path("nope")).expect_err("不存在的目录必须被拒绝");
    assert_eq!(missing.code(), GitErrorCode::RepoMissing);

    let plain = sandbox.path("plain");
    fs::create_dir_all(&plain).expect("创建普通目录");
    let not_a_repo = GitRepo::open(&plain).expect_err("普通目录不是 Git 工作树");
    assert_eq!(not_a_repo.code(), GitErrorCode::RepoNotWorkTree);
}
