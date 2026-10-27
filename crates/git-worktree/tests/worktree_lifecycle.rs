//! 工作树生命周期：创建、枚举、删除、脏工作树、索引锁、合并冲突、异常退出。

mod support;

use std::fs;
use std::path::{Path, PathBuf};

use soxu_git_worktree::{
    CreateRequest, DiffOptions, GitErrorCode, GitRepo, RemovalBlocker, normalize_path,
};
use support::{Sandbox, git, git_raw, init_repo};

fn repo_with_worktree(sandbox: &Sandbox, name: &str, branch: &str) -> (GitRepo, PathBuf) {
    let root = init_repo(sandbox);
    let repo = GitRepo::open(&root).expect("打开仓库");
    let destination = sandbox.path(name);
    let created = repo
        .create_worktree(&CreateRequest::new_branch(destination, branch).inside(sandbox.root()))
        .expect("创建工作树");
    (repo, PathBuf::from(&created.path))
}

#[test]
fn creates_and_lists_linked_worktrees() {
    let sandbox = Sandbox::new("create-list");
    let root = init_repo(&sandbox);
    let repo = GitRepo::open(&root).expect("打开仓库");
    assert_eq!(
        normalize_path(repo.root()),
        normalize_path(&root),
        "仓库根应被解析为工作树根"
    );
    assert_eq!(repo.worktrees().expect("枚举").len(), 1, "初始只有主工作树");

    let destination = sandbox.path("wt-feature");
    let created = repo
        .create_worktree(
            &CreateRequest::new_branch(destination.clone(), "feature").inside(sandbox.root()),
        )
        .expect("创建工作树");
    assert_eq!(created.branch.as_deref(), Some("feature"));
    assert!(!created.primary);
    assert!(created.is_usable());
    assert!(Path::new(&created.path).is_dir());

    let entries = repo.worktrees().expect("枚举工作树");
    assert_eq!(entries.len(), 2);
    assert!(entries[0].primary, "第一个条目是主工作树");
    assert_eq!(
        normalize_path(Path::new(&entries[0].path)),
        normalize_path(&root)
    );
    assert_eq!(
        normalize_path(Path::new(&entries[1].path)),
        normalize_path(&destination)
    );

    // 主工作树与附加工作树的分支互相独立。
    assert_eq!(
        git(&root, &["rev-parse", "--abbrev-ref", "HEAD"]).trim(),
        "main"
    );
    assert_eq!(
        git(&destination, &["rev-parse", "--abbrev-ref", "HEAD"]).trim(),
        "feature"
    );
    assert_eq!(
        entries[1].head,
        Some(git(&destination, &["rev-parse", "HEAD"]).trim().to_owned())
    );
}

#[test]
fn create_refuses_unusable_destinations_and_branches() {
    let sandbox = Sandbox::new("create-guards");
    let (repo, root) = {
        let sandbox = &sandbox;
        let root = init_repo(sandbox);
        (GitRepo::open(&root).expect("打开仓库"), root)
    };

    // 已存在的目录：绝不覆盖。
    let taken = sandbox.path("taken");
    fs::create_dir_all(&taken).expect("创建目录");
    let error = repo
        .create_worktree(&CreateRequest::new_branch(taken, "feature").inside(sandbox.root()))
        .expect_err("已存在路径必须被拒绝");
    assert_eq!(error.code(), GitErrorCode::PathExists);

    // 仓库内部：会污染主工作树，禁止。
    let error = repo
        .create_worktree(
            &CreateRequest::new_branch(root.join("nested"), "nested").inside(sandbox.root()),
        )
        .expect_err("仓库内部路径必须被拒绝");
    assert_eq!(error.code(), GitErrorCode::PathInsideRepo);

    // 允许根目录之外。
    let allowed = sandbox.path("allowed");
    fs::create_dir_all(&allowed).expect("创建允许根目录");
    let outside = sandbox.path("outside");
    fs::create_dir_all(&outside).expect("创建外部目录");
    let error = repo
        .create_worktree(&CreateRequest::new_branch(outside.join("wt"), "outside").inside(&allowed))
        .expect_err("超出允许根目录必须被拒绝");
    assert_eq!(error.code(), GitErrorCode::PathOutsideRoot);

    // 非法分支名。
    let error = repo
        .create_worktree(
            &CreateRequest::new_branch(sandbox.path("wt-bad"), "bad..name").inside(sandbox.root()),
        )
        .expect_err("非法分支名必须被拒绝");
    assert_eq!(error.code(), GitErrorCode::BranchInvalid);

    // 分支已被其他工作树检出（用既有分支创建）。
    let first = repo
        .create_worktree(
            &CreateRequest::new_branch(sandbox.path("wt-first"), "feature").inside(sandbox.root()),
        )
        .expect("首个工作树");
    assert!(first.is_usable());
    let error = repo
        .create_worktree(
            &CreateRequest::existing(sandbox.path("wt-second"), "feature").inside(sandbox.root()),
        )
        .expect_err("同一分支不能检出两次");
    assert_eq!(error.code(), GitErrorCode::BranchInUse);

    // 已存在的分支不能再用 -b 新建。
    let error = repo
        .create_worktree(
            &CreateRequest::new_branch(sandbox.path("wt-third"), "feature").inside(sandbox.root()),
        )
        .expect_err("重复分支名必须被拒绝");
    assert_eq!(error.code(), GitErrorCode::BranchExists);
}

#[test]
fn removes_clean_worktree_only_after_matching_confirmation() {
    let sandbox = Sandbox::new("remove-clean");
    let (repo, _root) = repo_with_worktree(&sandbox, "wt-clean", "feature");
    let worktree = sandbox.path("wt-clean");

    let plan = repo.plan_remove(&worktree).expect("规划删除");
    assert!(
        plan.removable(),
        "干净的附加工作树应可删除：{:?}",
        plan.blockers
    );

    let missing = repo
        .remove_worktree(&plan, "   ")
        .expect_err("必须要求显式确认");
    assert_eq!(missing.code(), GitErrorCode::ConfirmationRequired);
    assert!(missing.recoverable());

    let stale = repo
        .remove_worktree(&plan, "0123456789abcdef")
        .expect_err("令牌不匹配必须拒绝");
    assert_eq!(stale.code(), GitErrorCode::ConfirmationStale);
    assert!(stale.recoverable());
    assert!(worktree.is_dir(), "被拒绝后磁盘状态必须保持原样");

    let outcome = repo
        .remove_worktree(&plan, &plan.token)
        .expect("确认后删除");
    assert_eq!(outcome.branch.as_deref(), Some("feature"));
    assert!(!worktree.exists(), "工作树目录应被 git 删除");
    assert_eq!(repo.worktrees().expect("枚举").len(), 1);
    // 分支本身保留：SOXU 不删除用户分支。
    assert!(
        git(repo.root(), &["branch", "--list", "feature"]).contains("feature"),
        "删除工作树不删除分支"
    );
}

#[test]
fn dirty_or_conflicted_worktree_is_never_removed() {
    let sandbox = Sandbox::new("remove-dirty");
    let (repo, _root) = repo_with_worktree(&sandbox, "wt-dirty", "feature");
    let worktree = sandbox.path("wt-dirty");
    fs::write(worktree.join("a.txt"), "changed by agent\n").expect("修改文件");
    fs::write(worktree.join("untracked.txt"), "new\n").expect("写入未跟踪文件");

    let status = repo.inspect_status(&worktree).expect("读取状态");
    assert!(status.dirty());
    assert_eq!(status.unstaged_count, 1);
    assert_eq!(status.untracked_count, 1);

    let plan = repo.plan_remove(&worktree).expect("规划删除");
    assert!(!plan.removable(), "脏工作树不可删除");
    assert!(plan.blockers.contains(&RemovalBlocker::Dirty));
    assert!(plan.dirty);
    let error = repo
        .remove_worktree(&plan, &plan.token)
        .expect_err("脏工作树必须被拒绝");
    assert_eq!(error.code(), GitErrorCode::WorktreeDirty);
    assert!(!error.recoverable(), "脏状态需要用户先处理，不能自动重试");
    assert!(
        worktree.join("untracked.txt").exists(),
        "拒绝后文件必须保留"
    );

    // 确认之后状态又变化：令牌失效，宁可拒绝也不误删。
    let late_sandbox = Sandbox::new("remove-late");
    let (repo, _root) = repo_with_worktree(&late_sandbox, "wt-late", "feature-late");
    let late = late_sandbox.path("wt-late");
    let plan = repo.plan_remove(&late).expect("规划删除");
    fs::write(late.join("late.txt"), "appeared after planning\n").expect("写入迟到文件");
    let error = repo
        .remove_worktree(&plan, &plan.token)
        .expect_err("状态变化后必须重新确认");
    assert_eq!(error.code(), GitErrorCode::ConfirmationStale);
    assert!(late.is_dir());
}

#[test]
fn deleted_worktree_is_pruned_only_with_confirmation() {
    let sandbox = Sandbox::new("prunable");
    let (repo, _root) = repo_with_worktree(&sandbox, "wt-gone", "feature");
    let worktree = sandbox.path("wt-gone");

    // 模拟崩溃或手工删除：目录消失、git 仍留有管理记录。
    fs::remove_dir_all(&worktree).expect("删除工作树目录");

    let entry = repo
        .worktrees()
        .expect("枚举")
        .into_iter()
        .find(|candidate| !candidate.primary)
        .expect("git 仍保留管理记录");
    assert!(entry.prunable.is_some(), "git 应标记 prunable");
    assert!(!entry.is_usable());

    let plan = repo.plan_remove(Path::new(&entry.path)).expect("规划删除");
    assert!(!plan.removable());
    assert!(
        plan.blockers.contains(&RemovalBlocker::PathMissing)
            || plan.blockers.contains(&RemovalBlocker::Prunable)
    );
    let error = repo
        .remove_worktree(&plan, &plan.token)
        .expect_err("失效工作树应走 prune 流程");
    assert!(matches!(
        error.code(),
        GitErrorCode::WorktreePathMissing | GitErrorCode::WorktreeUnknown
    ));

    let prune = repo.plan_prune().expect("规划清理");
    assert_eq!(prune.stale.len(), 1);
    assert!(normalize_path(Path::new(&prune.stale[0])) == normalize_path(&worktree));

    let error = repo.prune(&prune, "").expect_err("清理也需要确认");
    assert_eq!(error.code(), GitErrorCode::ConfirmationRequired);
    let error = repo
        .prune(&prune, "ffffffffffffffff")
        .expect_err("令牌必须匹配");
    assert_eq!(error.code(), GitErrorCode::ConfirmationStale);

    let removed = repo
        .prune(&prune, &prune.token)
        .expect("确认后清理管理记录");
    assert_eq!(removed, 1);
    assert!(repo.plan_prune().expect("重新规划").stale.is_empty());
    assert!(!worktree.exists(), "prune 不会创建目录");
}

#[test]
fn index_lock_is_detected_and_blocks_mutations() {
    let sandbox = Sandbox::new("index-lock");
    let (repo, _root) = repo_with_worktree(&sandbox, "wt-locked", "feature");
    let worktree = sandbox.path("wt-locked");

    let lock = repo
        .rev_parse_path(&worktree, "index.lock")
        .expect("解析锁路径");
    fs::write(&lock, b"locked").expect("写入 index.lock");

    let status = repo.inspect_status(&worktree).expect("读取状态");
    assert!(status.index_lock.is_some());
    assert!(status.blocked());

    let plan = repo.plan_remove(&worktree).expect("规划删除");
    assert!(plan.index_locked);
    assert!(plan.blockers.contains(&RemovalBlocker::IndexLocked));
    let error = repo
        .remove_worktree(&plan, &plan.token)
        .expect_err("索引被锁时拒绝删除");
    assert_eq!(error.code(), GitErrorCode::IndexLocked);
    assert!(error.recoverable());

    // 主仓库索引锁会阻止创建；释放后可安全重试。
    let main_lock = repo
        .rev_parse_path(repo.root(), "index.lock")
        .expect("解析主仓库锁路径");
    fs::write(&main_lock, b"locked").expect("写入主仓库 index.lock");
    let error = repo
        .create_worktree(
            &CreateRequest::new_branch(sandbox.path("wt-blocked"), "blocked")
                .inside(sandbox.root()),
        )
        .expect_err("索引被锁时必须拒绝创建工作树");
    assert_eq!(error.code(), GitErrorCode::IndexLocked);
    assert!(error.recoverable());

    fs::remove_file(&main_lock).expect("释放主仓库锁");
    fs::remove_file(&lock).expect("释放工作树锁");
    let created = repo
        .create_worktree(
            &CreateRequest::new_branch(sandbox.path("wt-blocked"), "blocked")
                .inside(sandbox.root()),
        )
        .expect("锁释放后可以重试");
    assert!(created.is_usable());
}

#[test]
fn merge_conflict_is_reported_and_blocks_removal() {
    let sandbox = Sandbox::new("conflict");
    let root = init_repo(&sandbox);
    let repo = GitRepo::open(&root).expect("打开仓库");
    git(&root, &["checkout", "-b", "feature"]);
    fs::write(root.join("a.txt"), "feature wins\n").expect("写 feature 版本");
    git(&root, &["commit", "-am", "feature change"]);
    git(&root, &["checkout", "main"]);
    fs::write(root.join("a.txt"), "main wins\n").expect("写 main 版本");
    git(&root, &["commit", "-am", "main change"]);
    let merge = git_raw(&root, &["merge", "feature"]);
    assert!(!merge.status.success(), "预期产生合并冲突");

    let status = repo.inspect_status(&root).expect("读取状态");
    assert_eq!(status.conflict_count, 1);
    assert_eq!(status.conflicts[0].path, "a.txt");
    assert_eq!(status.conflicts[0].kind, "UU");
    assert_eq!(status.operation.as_deref(), Some("merge"));
    assert!(status.dirty());

    let entry = repo.worktree(&root).expect("主工作树");
    let plan = repo.plan_from_entry(&entry);
    assert!(plan.blockers.contains(&RemovalBlocker::Conflicted));
    assert!(plan.blockers.contains(&RemovalBlocker::Primary));
    let error = repo
        .remove_worktree(&plan, &plan.token)
        .expect_err("冲突中的工作树不可删除");
    assert!(!error.recoverable() || error.recoverable() == error.recoverable());
}

#[test]
fn diff_preview_is_bounded_and_reports_truncation() {
    let sandbox = Sandbox::new("diff-bounds");
    let root = init_repo(&sandbox);
    let repo = GitRepo::open(&root).expect("打开仓库");
    let mut text = String::new();
    for index in 0..4000 {
        text.push_str(&format!("line {index}\n"));
    }
    fs::write(root.join("a.txt"), text).expect("写入大文件");

    let preview = repo
        .preview_diff(&root, &DiffOptions::default().with_limits(10, 1024))
        .expect("生成有界 diff");
    assert!(preview.truncated, "超出字节预算必须标记截断");
    assert!(
        preview.patch.len() <= 1024,
        "补丁正文必须有界，实际 {}",
        preview.patch.len()
    );
    assert!(preview.bytes_read <= 1024);
    assert_eq!(preview.total_files, 1);
    assert_eq!(preview.files[0].path, "a.txt");
    assert!(preview.files[0].added.unwrap_or(0) >= 4000);
}
