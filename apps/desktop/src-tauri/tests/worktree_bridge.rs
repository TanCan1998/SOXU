//! 桌面工作树适配层的集成测试：真实 git 仓库 + 真实会话目录。
//!
//! 覆盖 TASK-005 的核心承诺：工作树与会话的关联来自会话目录、活跃运行时与脏改动
//! 会阻止删除、令牌校验失败时磁盘不变、目录被手工删除后可安全 prune。

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use soxu_desktop_lib::dto::CreateWorktreeInput;
use soxu_desktop_lib::state::AppState;
use soxu_desktop_lib::{workspace, worktree};
use soxu_session_index::{CatalogConfig, SessionId, project_sessions_dir_name};

fn temp_dir(name: &str) -> PathBuf {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or_default();
    let dir = std::env::temp_dir().join(format!("soxu-wt-{name}-{stamp}"));
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

/// 初始化一个带首个提交的仓库；工作树创建需要 HEAD。
fn init_repo(root: &Path) {
    fs::create_dir_all(root).expect("创建仓库目录");
    git(root, &["init", "-b", "main"]);
    fs::write(root.join("README.md"), "# repo\n").expect("写入文件");
    git(root, &["add", "."]);
    git(root, &["commit", "-m", "init"]);
}

/// 在某个工作树对应的会话目录下写一条真实 JSONL（只含会话头与一条用户消息）。
fn write_session(sessions_root: &Path, worktree: &Path, id: &str) -> PathBuf {
    let directory = sessions_root.join(project_sessions_dir_name(worktree));
    fs::create_dir_all(&directory).expect("创建会话目录");
    let path = directory.join(format!("2026-01-01T00-00-00-000Z_{id}.jsonl"));
    let cwd = worktree.to_string_lossy().replace('\\', "\\\\");
    let lines = [
        format!(
            r#"{{"type":"session","version":3,"id":"{id}","timestamp":"2026-01-01T00:00:00Z","cwd":"{cwd}"}}"#
        ),
        r#"{"type":"message","id":"m1","parentId":null,"timestamp":"2026-01-01T00:00:01Z","message":{"role":"user","content":[{"type":"text","text":"在工作树里工作"}]}}"#.to_owned(),
    ];
    fs::write(&path, format!("{}\n", lines.join("\n"))).expect("写入会话文件");
    path
}

async fn setup(sandbox: &Path) -> (AppState, PathBuf, String) {
    let project_root = sandbox.join("project");
    init_repo(&project_root);
    let sessions_root = sandbox.join("sessions");
    let state = AppState::open(
        sandbox.join("state"),
        CatalogConfig::with_sessions_root(&sessions_root),
    )
    .expect("初始化状态");
    let project = workspace::register_project(&state, project_root.to_string_lossy().as_ref())
        .await
        .expect("登记项目");
    (state, project_root, project.id)
}

#[tokio::test]
async fn worktree_sessions_are_linked_and_protected_from_removal() {
    let sandbox = temp_dir("lifecycle");
    let (state, _project_root, project_id) = setup(&sandbox).await;
    let target = sandbox.join("wt-5");

    let created = worktree::create(
        &state,
        &project_id,
        CreateWorktreeInput {
            branch: "agent/issue-5".to_owned(),
            new_branch: true,
            base: None,
            path: Some(target.to_string_lossy().to_string()),
        },
    )
    .await
    .expect("创建工作树");
    assert_eq!(created.branch.as_deref(), Some("agent/issue-5"));
    assert!(!created.primary);
    // 产品返回规范化（canonical）路径；这里给的 target 可能带 Windows 8.3 短名
    // （GitHub runner 的 RUNNER~1）或 macOS 的 /var → /private/var 符号链接，
    // 直接比较原始字符串会在这些环境里误报。
    let canonical_target = fs::canonicalize(&target).expect("解析工作树路径");
    // Windows 的 canonicalize 会带 `\\?\` verbatim 前缀，产品侧会 strip 掉后再存。
    let canonical_target = canonical_target.to_string_lossy();
    let canonical_target = canonical_target
        .trim_start_matches(r"\\?\")
        .replace('\\', "/");
    assert_eq!(
        created.path.replace('\\', "/"),
        canonical_target,
        "返回规范化后的工作树路径"
    );

    // 主工作树永远不可删除；新工作树干净时可删。
    let view = worktree::list(&state, &project_id)
        .await
        .expect("枚举工作树");
    assert_eq!(view.worktrees.len(), 2, "主 + 附加");
    let primary = view
        .worktrees
        .iter()
        .find(|item| item.primary)
        .expect("存在主工作树");
    assert!(primary.blockers.contains(&"primary".to_owned()));
    assert!(!primary.removable, "主工作树不允许删除");

    // 会话文件写在附加工作树的会话目录下，归属由会话目录决定。
    let session_file = write_session(&sandbox.join("sessions"), &target, "wt5");
    let refreshed = workspace::refresh_project(&state, &project_id)
        .await
        .expect("刷新项目");
    let summary = refreshed
        .sessions
        .iter()
        .find(|item| item.file_name.ends_with("_wt5.jsonl"))
        .expect("扫描到工作树会话");
    assert_eq!(summary.worktree_id, created.id, "会话归属工作树");

    let view = worktree::list(&state, &project_id)
        .await
        .expect("枚举工作树");
    let linked = view
        .worktrees
        .iter()
        .find(|item| item.id == created.id)
        .expect("附加工作树在清单中");
    assert_eq!(linked.session_ids, vec![summary.id.clone()]);
    assert!(linked.removable);

    // 活跃运行时（由会话层判定）追加 blocker，删除被拒绝且磁盘不变。
    {
        let mut catalog = state.catalog.lock().await;
        catalog
            .claim_writable(&SessionId::new(&summary.id), "rt_test")
            .expect("登记运行时");
    }
    let view = worktree::list(&state, &project_id)
        .await
        .expect("枚举工作树");
    let linked = view
        .worktrees
        .iter()
        .find(|item| item.id == created.id)
        .expect("附加工作树在清单中");
    assert!(linked.blockers.contains(&"active_runtime".to_owned()));
    assert!(!linked.removable);
    let error = worktree::remove(&state, &project_id, &created.id, &linked.token)
        .await
        .expect_err("活跃运行时下不得删除");
    assert!(error.contains("E_GIT_WORKTREE_BUSY"), "{error}");
    assert!(target.is_dir(), "拒绝删除后目录仍然存在");

    // 释放运行时后，未提交改动成为新的 blocker。
    {
        let mut catalog = state.catalog.lock().await;
        catalog
            .release(&SessionId::new(&summary.id), "rt_test")
            .expect("释放运行时");
    }
    fs::write(target.join("dirty.txt"), "未提交").expect("写入脏文件");
    let view = worktree::list(&state, &project_id)
        .await
        .expect("枚举工作树");
    let linked = view
        .worktrees
        .iter()
        .find(|item| item.id == created.id)
        .expect("附加工作树在清单中");
    assert!(linked.dirty);
    assert!(linked.blockers.contains(&"dirty".to_owned()));
    let error = worktree::remove(&state, &project_id, &created.id, &linked.token)
        .await
        .expect_err("脏工作树不得删除");
    assert!(error.contains("E_GIT_WORKTREE_DIRTY"), "{error}");

    // 清理改动后重新规划拿到新令牌，删除成功；会话记录与会话文件都保留。
    fs::remove_file(target.join("dirty.txt")).expect("删除脏文件");
    let plan = worktree::plan_removal(&state, &project_id, &created.id)
        .await
        .expect("删除计划");
    assert!(plan.removable, "干净后应可删除：{:?}", plan.blockers);
    let outcome = worktree::remove(&state, &project_id, &created.id, &plan.token)
        .await
        .expect("删除工作树");
    assert_eq!(outcome.worktree_id, created.id);
    assert!(!target.exists(), "工作树目录已被移除");

    let view = worktree::list(&state, &project_id)
        .await
        .expect("枚举工作树");
    assert_eq!(view.worktrees.len(), 1, "只剩主工作树");
    assert!(session_file.exists(), "不得删除 Pi 会话文件");
    let catalog = state.catalog.lock().await;
    assert!(
        catalog.find_session(&SessionId::new(&summary.id)).is_some(),
        "工作树删除后会话记录保留，供人工核对"
    );
    drop(catalog);

    let _ = fs::remove_dir_all(&sandbox);
}

#[tokio::test]
async fn stale_worktree_records_need_explicit_prune_confirmation() {
    let sandbox = temp_dir("prune");
    let (state, _project_root, project_id) = setup(&sandbox).await;
    let target = sandbox.join("wt-dead");

    let created = worktree::create(
        &state,
        &project_id,
        CreateWorktreeInput {
            branch: "agent/dead".to_owned(),
            new_branch: true,
            base: None,
            path: Some(target.to_string_lossy().to_string()),
        },
    )
    .await
    .expect("创建工作树");

    // 模拟异常退出/手工删除目录：Git 会把该记录标记为 prunable。
    fs::remove_dir_all(&target).expect("删除工作树目录");
    let view = worktree::list(&state, &project_id)
        .await
        .expect("枚举工作树");
    assert_eq!(view.stale.len(), 1, "Git 标记了一条失效记录");
    assert!(!view.prune_token.is_empty(), "清理需要令牌");

    let missing = view
        .worktrees
        .iter()
        .find(|item| item.id == created.id)
        .expect("失效工作树仍在清单中");
    assert!(missing.missing);
    assert!(!missing.removable, "失效记录不能按删除工作树处理");

    let empty = worktree::prune(&state, &project_id, "   ").await;
    assert!(
        empty.is_err_and(|error| error.contains("E_GIT_CONFIRMATION_REQUIRED")),
        "空令牌必须被拒绝"
    );

    let removed = worktree::prune(&state, &project_id, &view.prune_token)
        .await
        .expect("清理失效记录");
    assert_eq!(removed, 1);

    let view = worktree::list(&state, &project_id)
        .await
        .expect("枚举工作树");
    assert!(view.stale.is_empty(), "清理后不再有失效记录");
    assert_eq!(view.worktrees.len(), 1);
    assert!(
        state
            .catalog
            .lock()
            .await
            .project(&soxu_session_index::ProjectId::new(&project_id))
            .is_some(),
        "清理只影响 Git 管理记录，项目与会话目录仍然保留"
    );

    let _ = fs::remove_dir_all(&sandbox);
}
