//! Git 抽屉的事实层（Issue #121 · TASK-029）：更改列表、单文件 diff、暂存/提交、
//! 历史/分支、推送/拉取与路径守卫。
//!
//! 全部使用独立临时仓库；推送/拉取走本地裸仓库（file 协议），不访问网络。
//! 断言的都是 git 事实：徽章、行数、补丁正文与 CLI 输出一致、领先/落后计数。

mod support;

use std::fs;
use std::path::Path;

use soxu_git_worktree::{GitErrorCode, GitRepo, validate_relative_path};
use support::{Sandbox, git, init_repo};

/// 测试仓库补上本地身份，避免依赖开发机的全局 git 配置。
fn open_repo(root: &Path) -> GitRepo {
    git(root, &["config", "user.name", "SOXU Test"]);
    git(root, &["config", "user.email", "soxu-test@example.invalid"]);
    GitRepo::open(root).expect("打开仓库")
}

fn write(path: &Path, text: &str) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("创建目录");
    }
    fs::write(path, text).expect("写入文件");
}

/// 本地裸仓库作为远端：路径统一成正斜杠，Windows 上 git 也接受。
fn init_bare_remote(sandbox: &Sandbox) -> String {
    let remote = sandbox.path("remote.git");
    git(sandbox.root(), &["init", "--bare", "remote.git"]);
    git(&remote, &["symbolic-ref", "HEAD", "refs/heads/main"]);
    remote.to_string_lossy().replace('\\', "/")
}

#[test]
fn changes_report_badges_counts_and_line_stats() {
    let sandbox = Sandbox::new("drawer-changes");
    let root = init_repo(&sandbox);
    let repo = open_repo(&root);

    // 一次改动覆盖 A/M/D 与未跟踪，并给出可预测的增删行数。
    write(&root.join("a.txt"), "one\ntwo\n");
    write(&root.join("removed.txt"), "temporary\n");
    git(&root, &["add", "removed.txt"]);
    git(&root, &["commit", "-m", "add removed.txt"]);
    fs::remove_file(root.join("removed.txt")).expect("删除文件");
    write(&root.join("untracked.txt"), "hello\n");

    let view = repo.changes(&root).expect("读取更改列表");
    assert_eq!(view.branch.as_deref(), Some("main"));
    assert!(!view.truncated);

    let by_path = |path: &str| {
        view.files
            .iter()
            .find(|file| file.path == path)
            .unwrap_or_else(|| panic!("缺少文件 {path}：{:?}", view.files))
    };

    let modified = by_path("a.txt");
    assert_eq!(modified.status, "M");
    assert!(modified.unstaged && !modified.staged);
    assert_eq!(modified.added, Some(1), "新增一行");
    assert_eq!(modified.removed, Some(0));

    let removed = by_path("removed.txt");
    assert_eq!(removed.status, "D");
    assert_eq!(removed.removed, Some(1));
    assert_eq!(removed.added, Some(0));

    let untracked = by_path("untracked.txt");
    assert_eq!(untracked.status, "A", "未跟踪文件按新增展示");
    assert!(untracked.untracked);
    assert_eq!(untracked.added, None, "未跟踪文件没有 numstat 行数");

    assert_eq!(view.total_files, 3);
    assert_eq!(view.files.len(), 3);
}

#[test]
fn staged_and_unstaged_are_reported_separately() {
    let sandbox = Sandbox::new("drawer-staged");
    let root = init_repo(&sandbox);
    let repo = open_repo(&root);

    write(&root.join("staged.txt"), "a\nb\n");
    git(&root, &["add", "staged.txt"]);

    let view = repo.changes(&root).expect("读取更改列表");
    let staged = view
        .files
        .iter()
        .find(|file| file.path == "staged.txt")
        .expect("暂存文件出现在列表里");
    assert!(staged.staged);
    assert!(!staged.unstaged);
    assert_eq!(staged.status, "A");
    assert_eq!(staged.added, Some(2), "已暂存行数来自 --cached --numstat");

    // 再改一次同一文件：徽章保持 A（索引区字母优先），两个标记同时为真。
    write(&root.join("staged.txt"), "a\nb\nc\n");
    let view = repo.changes(&root).expect("读取更改列表");
    let both = view
        .files
        .iter()
        .find(|file| file.path == "staged.txt")
        .expect("文件仍在列表里");
    assert!(both.staged && both.unstaged);
    assert_eq!(both.status, "A");
    assert_eq!(both.added, Some(1), "未暂存优先：工作区相对索引多了一行");
}

#[test]
fn file_diff_matches_git_cli_output() {
    let sandbox = Sandbox::new("drawer-diff");
    let root = init_repo(&sandbox);
    let repo = open_repo(&root);
    write(&root.join("a.txt"), "one\ntwo\n");

    let view = repo
        .file_diff(&root, "a.txt", false, 64 * 1024)
        .expect("读取单文件 diff");
    let expected = git(
        &root,
        &[
            "diff",
            "--no-color",
            "--no-ext-diff",
            "--no-renames",
            "--unified=3",
            "--",
            "a.txt",
        ],
    );
    assert_eq!(view.patch, expected, "补丁正文必须与 git CLI 完全一致");
    assert_eq!(view.added, Some(1));
    assert_eq!(view.removed, Some(0));
    assert!(!view.truncated);

    // 未暂存改动进不了 --cached，暂存后同一路径的 staged diff 才有内容。
    assert!(
        repo.file_diff(&root, "a.txt", true, 64 * 1024)
            .expect("暂存 diff")
            .patch
            .is_empty()
    );
    repo.stage(&root, &["a.txt".to_owned()]).expect("暂存");
    assert!(
        !repo
            .file_diff(&root, "a.txt", true, 64 * 1024)
            .expect("暂存 diff")
            .patch
            .is_empty()
    );
}

#[test]
fn rejects_paths_outside_the_repository() {
    let sandbox = Sandbox::new("drawer-paths");
    let root = init_repo(&sandbox);
    let repo = open_repo(&root);

    for raw in ["../secret.txt", "C:/Windows/win.ini", "/etc/passwd"] {
        let error = repo
            .file_diff(&root, raw, false, 1024)
            .expect_err("越界路径必须被拒绝");
        assert!(
            matches!(
                error.code(),
                GitErrorCode::PathOutsideRoot | GitErrorCode::PathNotAbsolute
            ),
            "{raw} 得到 {:?}",
            error.code()
        );
        let error = repo
            .stage(&root, &[raw.to_owned()])
            .expect_err("越界路径不能进入 git add");
        assert!(
            matches!(
                error.code(),
                GitErrorCode::PathOutsideRoot | GitErrorCode::PathNotAbsolute
            ),
            "{raw} 得到 {:?}",
            error.code()
        );
    }

    assert_eq!(
        validate_relative_path("docs/a.md").expect("正常路径"),
        "docs/a.md"
    );
}

#[test]
fn stage_and_commit_produce_a_real_commit() {
    let sandbox = Sandbox::new("drawer-commit");
    let root = init_repo(&sandbox);
    let repo = open_repo(&root);

    write(&root.join("a.txt"), "one\nchanged\n");
    repo.stage(&root, &["a.txt".to_owned()]).expect("暂存");
    let outcome = repo.commit(&root, "  feat: 更新 a.txt  ").expect("提交");
    assert_eq!(outcome.subject, "feat: 更新 a.txt");
    assert_eq!(outcome.hash.len(), 40);
    assert!(outcome.hash.starts_with(&outcome.short_hash));

    let status = repo.inspect_status(&root).expect("提交后状态");
    assert!(!status.dirty(), "提交后工作区干净");
    assert_eq!(
        git(&root, &["log", "-1", "--format=%s"]).trim(),
        "feat: 更新 a.txt"
    );

    // 空说明在调用 git 之前就被拒绝。
    let error = repo.commit(&root, "   ").expect_err("空说明");
    assert_eq!(error.code(), GitErrorCode::CommitMessageInvalid);
}

#[test]
fn log_and_branches_reflect_repository_state() {
    let sandbox = Sandbox::new("drawer-log");
    let root = init_repo(&sandbox);
    let repo = open_repo(&root);
    write(&root.join("a.txt"), "one\ntwo\n");
    repo.stage(&root, &["a.txt".to_owned()]).expect("暂存");
    repo.commit(&root, "feat: 第二次提交").expect("提交");

    let log = repo.log(&root, 10).expect("读取历史");
    assert_eq!(log.len(), 2);
    assert_eq!(log[0].subject, "feat: 第二次提交", "最新提交在前");
    assert_eq!(log[1].subject, "init");
    assert!(
        log[0].date.contains('T'),
        "日期为 ISO-8601：{}",
        log[0].date
    );

    let branches = repo.branches(&root).expect("读取分支");
    assert_eq!(branches.current.as_deref(), Some("main"));
    assert_eq!(branches.branches.len(), 1);
    assert!(branches.branches[0].current);

    git(&root, &["branch", "agent/issue-121"]);
    let branches = repo.branches(&root).expect("读取分支");
    assert_eq!(branches.branches.len(), 2);
    assert!(
        branches
            .branches
            .iter()
            .any(|b| b.name == "agent/issue-121")
    );
}

#[test]
fn empty_repository_has_no_log_instead_of_an_error() {
    let sandbox = Sandbox::new("drawer-empty");
    let root = sandbox.path("empty");
    fs::create_dir_all(&root).expect("创建目录");
    git(&root, &["init", "-b", "main", "."]);
    let repo = GitRepo::open(&root).expect("打开空仓库");

    assert!(repo.log(&root, 10).expect("空仓库不报错").is_empty());
    let branches = repo.branches(&root).expect("空仓库没有分支");
    assert!(branches.branches.is_empty());
    assert!(branches.current.is_none());
}

#[test]
fn push_and_pull_track_ahead_and_behind() {
    let sandbox = Sandbox::new("drawer-remote");
    let root = init_repo(&sandbox);
    let repo = open_repo(&root);
    let remote = init_bare_remote(&sandbox);
    git(&root, &["remote", "add", "origin", remote.as_str()]);

    let pushed = repo.push(&root).expect_err("没有上游分支时推送失败");
    assert_eq!(pushed.code(), GitErrorCode::CommandFailed);
    assert!(
        pushed.context().contains("推送失败"),
        "错误上下文必须说明是推送：{}",
        pushed.context()
    );

    git(&root, &["push", "-u", "origin", "main"]);
    let outcome = repo.push(&root).expect("设置上游后推送成功");
    assert_eq!(outcome.upstream.as_deref(), Some("origin/main"));
    assert_eq!(outcome.ahead, 0);

    write(&root.join("a.txt"), "one\nlocal\n");
    repo.stage(&root, &["a.txt".to_owned()]).expect("暂存");
    repo.commit(&root, "feat: 本地提交").expect("提交");
    let status = repo.inspect_status(&root).expect("提交后状态");
    assert_eq!(status.ahead, 1, "领先远端一个提交");
    assert_eq!(status.behind, 0);

    let outcome = repo.push(&root).expect("推送本地提交");
    assert_eq!(outcome.ahead, 0, "推送后不再领先");

    // 第二个工作副本提交并推送，回到第一个仓库拉取。
    let clone = sandbox.path("clone");
    let clone_text = clone.to_string_lossy().replace('\\', "/");
    git(
        sandbox.root(),
        &["clone", remote.as_str(), clone_text.as_str()],
    );
    git(&clone, &["config", "user.name", "SOXU Test"]);
    git(
        &clone,
        &["config", "user.email", "soxu-test@example.invalid"],
    );
    write(&clone.join("a.txt"), "one\nlocal\nremote\n");
    git(&clone, &["add", "a.txt"]);
    git(&clone, &["commit", "-m", "feat: 远端提交"]);
    git(&clone, &["push", "origin", "main"]);

    // 领先/落后来自本地记录的远端跟踪分支，因此先 fetch 才能看到真实差距
    // （git status 不会自己联网；抽屉的「拉取」按钮会顺带刷新它）。
    git(&root, &["fetch", "origin"]);
    let before = repo.inspect_status(&root).expect("拉取前状态");
    assert_eq!(before.behind, 1, "落后远端一个提交");

    let outcome = repo.pull(&root).expect("快进拉取成功");
    assert_eq!(outcome.behind, 0, "拉取后不再落后");
    // Windows 上 core.autocrlf 会把换行转成 CRLF，比较前统一换行符。
    assert_eq!(
        fs::read_to_string(root.join("a.txt"))
            .expect("读取文件")
            .replace("\r\n", "\n"),
        "one\nlocal\nremote\n",
        "拉取后工作区与远端一致"
    );
}

#[test]
fn pull_failure_explains_what_went_wrong() {
    let sandbox = Sandbox::new("drawer-pull-fail");
    let root = init_repo(&sandbox);
    let repo = open_repo(&root);

    let error = repo.pull(&root).expect_err("没有上游时拉取失败");
    assert_eq!(error.code(), GitErrorCode::CommandFailed);
    assert!(
        error.context().contains("拉取失败"),
        "错误上下文必须说明是拉取：{}",
        error.context()
    );
    assert!(
        error.detail().is_some(),
        "必须带 git 的原始错误行，方便定位"
    );
    // 失败不修改磁盘：工作区仍然干净。
    assert!(!repo.inspect_status(&root).expect("状态").dirty());
}

#[test]
fn detached_head_cannot_push() {
    let sandbox = Sandbox::new("drawer-detached");
    let root = init_repo(&sandbox);
    let repo = open_repo(&root);
    git(&root, &["checkout", "--detach", "HEAD"]);

    let error = repo.push(&root).expect_err("detached HEAD 不能推送");
    assert_eq!(error.code(), GitErrorCode::BranchInvalid);
}
