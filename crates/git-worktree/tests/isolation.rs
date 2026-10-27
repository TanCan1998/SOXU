//! 多工作树隔离：改动、状态、diff 与删除互不影响。

mod support;

use std::fs;
use std::path::Path;

use soxu_git_worktree::{CreateRequest, DiffOptions, GitRepo};
use support::{Sandbox, init_repo};

#[test]
fn changes_in_one_worktree_never_leak_into_another() {
    let sandbox = Sandbox::new("isolation");
    let root = init_repo(&sandbox);
    let repo = GitRepo::open(&root).expect("打开仓库");
    let a = repo
        .create_worktree(
            &CreateRequest::new_branch(sandbox.path("wt-a"), "feature-a").inside(sandbox.root()),
        )
        .expect("创建 A");
    let b = repo
        .create_worktree(
            &CreateRequest::new_branch(sandbox.path("wt-b"), "feature-b").inside(sandbox.root()),
        )
        .expect("创建 B");

    fs::write(Path::new(&a.path).join("a.txt"), "a changed\n").expect("改 A 的已跟踪文件");
    fs::write(Path::new(&a.path).join("only-a.txt"), "new in a\n").expect("在 A 新增文件");

    let status_a = repo.inspect_status(Path::new(&a.path)).expect("A 状态");
    let status_b = repo.inspect_status(Path::new(&b.path)).expect("B 状态");
    assert!(status_a.dirty());
    assert!(!status_b.dirty(), "B 必须保持干净：{status_b:?}");
    assert_eq!(status_a.branch.as_deref(), Some("feature-a"));
    assert_eq!(status_b.branch.as_deref(), Some("feature-b"));

    let diff_a = repo
        .preview_diff(Path::new(&a.path), &DiffOptions::default())
        .expect("A 的 diff");
    let diff_b = repo
        .preview_diff(Path::new(&b.path), &DiffOptions::default())
        .expect("B 的 diff");
    assert_eq!(diff_a.total_files, 1, "只有 a.txt 被修改");
    assert_eq!(diff_b.total_files, 0, "B 没有任何改动");
    assert!(diff_a.patch.contains("a changed"));
    assert!(diff_b.patch.is_empty());

    // 删除 A 不影响 B 的目录、分支与未提交状态。
    // A 先由用户自行处理掉改动（这里用 git 恢复），SOXU 不会代替用户回滚。
    support::git(Path::new(&a.path), &["checkout", "--", "a.txt"]);
    fs::remove_file(Path::new(&a.path).join("only-a.txt")).expect("删除 A 的未跟踪文件");
    fs::write(Path::new(&b.path).join("b-only.txt"), "b work\n").expect("在 B 新增文件");
    let plan = repo.plan_remove(Path::new(&a.path)).expect("规划删除 A");
    assert!(plan.removable(), "A 干净可删：{:?}", plan.blockers);
    repo.remove_worktree(&plan, &plan.token).expect("删除 A");
    assert!(!Path::new(&a.path).exists());
    assert!(
        Path::new(&b.path).join("b-only.txt").exists(),
        "B 的文件不受影响"
    );
    assert_eq!(
        repo.inspect_status(Path::new(&b.path))
            .expect("B 状态")
            .untracked_count,
        1
    );
    // 主工作树从未被修改。
    assert!(!repo.inspect_status(&root).expect("主工作树状态").dirty());
}
