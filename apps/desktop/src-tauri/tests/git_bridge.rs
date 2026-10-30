//! 桌面 Git 适配层的集成测试（Issue #121 · TASK-029）：真实仓库 + 真实会话目录。
//!
//! 覆盖命令层的承诺：项目/工作树身份只从会话目录解析、更改列表带徽章与行数、
//! 暂存与提交走同一份事实、推送失败给出明确错误、路径穿越在到达 git 之前被拒绝。

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use soxu_desktop_lib::dto::CreateWorktreeInput;
use soxu_desktop_lib::git;
use soxu_desktop_lib::state::AppState;
use soxu_desktop_lib::{workspace, worktree};
use soxu_session_index::CatalogConfig;

fn temp_dir(name: &str) -> PathBuf {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or_default();
    let dir = std::env::temp_dir().join(format!("soxu-git-{name}-{stamp}"));
    fs::create_dir_all(&dir).expect("创建临时目录");
    dir
}

fn git(dir: &Path, args: &[&str]) {
    let output = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_AUTHOR_NAME", "SOXU Test")
        .env("GIT_AUTHOR_EMAIL", "soxu@example.invalid")
        .env("GIT_COMMITTER_NAME", "SOXU Test")
        .env("GIT_COMMITTER_EMAIL", "soxu@example.invalid")
        .output()
        .expect("启动 git");
    assert!(
        output.status.success(),
        "git {args:?} 失败：{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn init_repo(root: &Path) {
    fs::create_dir_all(root).expect("创建仓库目录");
    git(root, &["init", "-b", "main"]);
    fs::write(root.join("README.md"), "# repo\n").expect("写入文件");
    git(root, &["add", "."]);
    git(root, &["commit", "-m", "init"]);
    // 适配层使用生产 GitRunner（不带测试环境变量），因此身份写进仓库本地配置。
    git(root, &["config", "user.name", "SOXU Test"]);
    git(root, &["config", "user.email", "soxu@example.invalid"]);
}

async fn setup(sandbox: &Path) -> (AppState, PathBuf, String) {
    let project_root = sandbox.join("project");
    init_repo(&project_root);
    let state = AppState::open(
        sandbox.join("state"),
        CatalogConfig::with_sessions_root(sandbox.join("sessions")),
    )
    .expect("初始化状态");
    let project = workspace::register_project(&state, project_root.to_string_lossy().as_ref())
        .await
        .expect("登记项目");
    (state, project_root, project.id)
}

#[tokio::test]
async fn status_stage_commit_and_log_share_one_source_of_truth() {
    let sandbox = temp_dir("drawer");
    let (state, root, project_id) = setup(&sandbox).await;

    fs::write(root.join("README.md"), "# repo\nchanged\n").expect("修改文件");
    fs::write(root.join("new.txt"), "hello\n").expect("新增文件");

    let status = git::status(&state, &project_id, None)
        .await
        .expect("读取更改列表");
    assert_eq!(status.project_id, project_id);
    assert_eq!(status.worktree_id, None, "省略工作树表示项目主工作树");
    assert_eq!(status.branch.as_deref(), Some("main"));
    assert_eq!(status.total_files, 2);
    assert!(!status.truncated);
    assert!(!status.index_locked);

    let modified = status
        .files
        .iter()
        .find(|file| file.path == "README.md")
        .expect("修改的文件");
    assert_eq!(modified.status, "M");
    assert_eq!(modified.added, Some(1));
    assert_eq!(modified.removed, Some(0));

    let added = status
        .files
        .iter()
        .find(|file| file.path == "new.txt")
        .expect("新增的文件");
    assert_eq!(added.status, "A");
    assert!(added.untracked);

    // 单文件 diff 与 git CLI 一致（命令层不再二次加工补丁）。
    let diff = git::diff(&state, &project_id, None, "README.md".to_owned(), false)
        .await
        .expect("读取 diff");
    assert_eq!(diff.path, "README.md");
    assert!(!diff.staged);
    assert!(diff.patch.contains("+changed"), "{}", diff.patch);
    assert!(!diff.truncated);

    // 路径穿越在适配层就被拒绝。
    let error = git::diff(
        &state,
        &project_id,
        None,
        "../outside.txt".to_owned(),
        false,
    )
    .await
    .expect_err("越界路径必须被拒绝");
    assert!(error.contains("E_GIT_PATH_OUTSIDE_ROOT"), "{error}");

    // 暂存全部：返回的 status 已经包含暂存标记，不需要前端再查一次。
    let staged = git::stage(
        &state,
        &project_id,
        None,
        vec!["README.md".to_owned(), "new.txt".to_owned()],
    )
    .await
    .expect("暂存");
    let readme = staged
        .files
        .iter()
        .find(|file| file.path == "README.md")
        .expect("README 仍在列表里");
    assert!(readme.staged);
    assert!(!readme.unstaged);

    let committed = git::commit(&state, &project_id, None, "feat: 抽屉提交".to_owned())
        .await
        .expect("提交");
    assert_eq!(committed.subject, "feat: 抽屉提交");
    assert_eq!(committed.hash.len(), 40);
    assert_eq!(committed.status.total_files, 0, "提交后工作区干净");
    assert!(
        !committed
            .status
            .files
            .iter()
            .any(|file| file.path == "new.txt")
    );

    let log = git::log(&state, &project_id, None, Some(5))
        .await
        .expect("读取历史");
    assert_eq!(log.entries.len(), 2);
    assert_eq!(log.entries[0].subject, "feat: 抽屉提交");
    assert!(!log.truncated);

    let branches = git::branches(&state, &project_id, None)
        .await
        .expect("读取分支");
    assert_eq!(branches.current.as_deref(), Some("main"));
    assert!(branches.branches.iter().any(|branch| branch.current));
}

#[tokio::test]
async fn worktree_id_resolves_to_the_registered_worktree() {
    let sandbox = temp_dir("worktree");
    let (state, _root, project_id) = setup(&sandbox).await;
    let target = sandbox.join("wt-121");
    let created = worktree::create(
        &state,
        &project_id,
        CreateWorktreeInput {
            branch: "agent/issue-121".to_owned(),
            new_branch: true,
            base: None,
            path: Some(target.to_string_lossy().to_string()),
        },
    )
    .await
    .expect("创建工作树");

    // 附加工作树里写一个改动：主工作树看不到，说明身份解析走的是工作树路径。
    fs::write(Path::new(&created.path).join("only-here.txt"), "wt\n").expect("写入文件");

    let primary = git::status(&state, &project_id, None)
        .await
        .expect("主工作树状态");
    assert!(
        !primary
            .files
            .iter()
            .any(|file| file.path == "only-here.txt"),
        "主工作树不应看到附加工作树的改动"
    );

    let linked = git::status(&state, &project_id, Some(&created.id))
        .await
        .expect("附加工作树状态");
    assert_eq!(linked.worktree_id.as_deref(), Some(created.id.as_str()));
    assert!(linked.files.iter().any(|file| file.path == "only-here.txt"));

    // 未登记的工作树与未登记的项目都返回稳定错误码。
    let error = git::status(&state, &project_id, Some("wkt_missing"))
        .await
        .expect_err("未登记工作树");
    assert!(error.contains("E_WORKTREE_UNKNOWN"), "{error}");
    let error = git::status(&state, "prj_missing", None)
        .await
        .expect_err("未登记项目");
    assert!(error.contains("E_PROJECT_UNKNOWN"), "{error}");
}

#[tokio::test]
async fn push_without_remote_reports_a_clear_error() {
    let sandbox = temp_dir("push");
    let (state, _root, project_id) = setup(&sandbox).await;

    let error = git::push(&state, &project_id, None)
        .await
        .expect_err("没有远端时推送失败");
    assert!(error.contains("E_GIT_COMMAND_FAILED"), "{error}");
    assert!(error.contains("推送失败"), "错误必须说明是推送：{error}");
    // 失败不修改磁盘：工作区仍然干净，可以修正配置后重试。
    let status = git::status(&state, &project_id, None)
        .await
        .expect("推送失败后仍可读状态");
    assert_eq!(status.total_files, 0);

    let error = git::pull(&state, &project_id, None)
        .await
        .expect_err("没有远端时拉取失败");
    assert!(error.contains("拉取失败"), "{error}");
}
