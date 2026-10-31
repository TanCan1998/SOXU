//! 发送模式（Issue #146）的后端链路：并行发送必须真的落到「同项目下的新临时会话」。
//!
//! 这里走的是**真实链路**而不是替身：`workspace::open_temporary` 就是
//! `open_temporary_session` 命令体（apps/desktop/src-tauri/src/commands/workspace.rs），
//! 用的是真实 `AppState` + 真实 `soxu-session-index` 目录，没有伪数据。
//!
//! 桌面端「点并行发送 → 新会话里真的发出消息」由实机走查覆盖
//! （apps/desktop/tests/harness/verify-issue-146-desktop.mjs，见
//! docs/development/evidence/issue-146-send-modes/README.md）。

use std::fs;
use std::path::{Path, PathBuf};

use soxu_agent_runtime::StreamingBehavior;
use soxu_desktop_lib::session_runtime;
use soxu_desktop_lib::state::AppState;
use soxu_desktop_lib::workspace;
use soxu_session_index::{CatalogConfig, project_sessions_dir_name};

fn temp_dir(name: &str) -> PathBuf {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or_default();
    let dir = std::env::temp_dir().join(format!("soxu-send-modes-{name}-{stamp}"));
    fs::create_dir_all(&dir).expect("创建临时目录");
    let dir = std::fs::canonicalize(&dir).unwrap_or(dir);
    // 统一成 canonical 形式：真实大小写、长文件名、无 Windows verbatim 前缀。
    let text = dir.to_string_lossy().into_owned();
    match text.strip_prefix(r"\\?\") {
        Some(rest) if rest.as_bytes().get(1) == Some(&b':') => PathBuf::from(rest),
        _ => dir,
    }
}

fn open_state(sandbox: &Path) -> AppState {
    AppState::open(
        sandbox.join("state"),
        CatalogConfig::with_sessions_root(sandbox.join("sessions")),
    )
    .expect("初始化状态")
}

fn write_session(sessions_root: &Path, project_root: &Path, id: &str) -> PathBuf {
    let directory = sessions_root.join(project_sessions_dir_name(project_root));
    fs::create_dir_all(&directory).expect("创建会话目录");
    let path = directory.join(format!("2026-01-01T00-00-00-000Z_{id}.jsonl"));
    let cwd = project_root.to_string_lossy().replace('\\', "\\\\");
    let lines = [
        format!(
            r#"{{"type":"session","version":3,"id":"{id}","timestamp":"2026-01-01T00:00:00Z","cwd":"{cwd}"}}"#
        ),
        r#"{"type":"message","id":"m1","parentId":null,"timestamp":"2026-01-01T00:00:01Z","message":{"role":"user","content":[{"type":"text","text":"已有的历史会话"}]}}"#.to_owned(),
    ];
    fs::write(&path, format!("{}\n", lines.join("\n"))).expect("写入会话文件");
    path
}

/// 并行发送的核心事实：同一项目下每点一次就得到一个**新的**临时会话，
/// 身份互不相同、都不进入持久化历史，因此两个运行时不会写同一份 JSONL。
#[tokio::test]
async fn parallel_send_gets_a_new_temporary_session_per_draft() {
    let sandbox = temp_dir("parallel");
    let project_root = sandbox.join("project");
    fs::create_dir_all(&project_root).expect("创建项目目录");
    let state = open_state(&sandbox);

    let project = workspace::register_project(&state, project_root.to_string_lossy().as_ref())
        .await
        .expect("登记项目");

    let first = workspace::open_temporary(&state, &project.id)
        .await
        .expect("分配第一个临时会话");
    let second = workspace::open_temporary(&state, &project.id)
        .await
        .expect("分配第二个临时会话");

    for temporary in [&first, &second] {
        assert!(
            temporary.session_id.starts_with("ses_tmp_"),
            "临时身份前缀：{}",
            temporary.session_id
        );
        assert_eq!(
            temporary.project_id, project.id,
            "并行会话必须落在当前项目下"
        );
        assert_eq!(temporary.mode, "temporary");
        assert!(!temporary.bound, "新建的临时会话还没有绑定 Pi 会话文件");
    }
    assert_ne!(
        first.session_id, second.session_id,
        "并行发送不能复用同一个会话：那会变成同一个运行时里的排队，而不是并行"
    );

    // 临时会话不进历史：并行发送不会污染侧栏，也不会让下一次扫描把它当成持久会话。
    let listed = workspace::list_projects(&state).await.expect("列出项目");
    assert!(listed[0].sessions.is_empty(), "临时会话不得进入持久化历史");

    // 未知项目必须报错，而不是悄悄分配一个没有落点的会话。
    assert!(
        workspace::open_temporary(&state, "prj_不存在")
            .await
            .is_err(),
        "未知项目不能分配临时会话"
    );

    let _ = fs::remove_dir_all(&sandbox);
}

/// 忙碌投递的失败路径：没有活运行时的时候，send_prompt 必须返回错误。
///
/// 「静默丢弃」正是 Issue #146 要修的问题之一；命令层不能把失败伪装成成功，
/// 否则前端会把一条根本没发出去的消息当成已投递。
#[tokio::test]
async fn prompt_and_clear_queue_fail_loudly_without_a_runtime() {
    let sandbox = temp_dir("no-runtime");
    let project_root = sandbox.join("project");
    fs::create_dir_all(&project_root).expect("创建项目目录");
    let state = open_state(&sandbox);

    let project = workspace::register_project(&state, project_root.to_string_lossy().as_ref())
        .await
        .expect("登记项目");
    let temporary = workspace::open_temporary(&state, &project.id)
        .await
        .expect("分配临时会话");

    for behavior in [
        None,
        Some(StreamingBehavior::Steer),
        Some(StreamingBehavior::FollowUp),
    ] {
        let error = session_runtime::prompt(&state, &temporary.session_id, "忙碌时发送", behavior)
            .await
            .expect_err("没有运行时必须报错");
        assert!(
            error.contains("没有运行中的 Agent"),
            "错误文本要能指向真实原因：{error}"
        );
    }

    let error = session_runtime::clear_queue(&state, &temporary.session_id)
        .await
        .expect_err("没有运行时不能假装清空了队列");
    assert!(
        error.contains("没有运行中的 Agent"),
        "错误文本要能指向真实原因：{error}"
    );

    let _ = fs::remove_dir_all(&sandbox);
}

/// 历史会话与临时会话的边界：并行发送的临时会话不会让已有历史消失。
#[tokio::test]
async fn parallel_temporary_session_keeps_existing_history_intact() {
    let sandbox = temp_dir("history");
    let project_root = sandbox.join("project");
    let sessions_root = sandbox.join("sessions");
    fs::create_dir_all(&project_root).expect("创建项目目录");
    write_session(&sessions_root, &project_root, "keep01");
    let state = open_state(&sandbox);

    let project = workspace::register_project(&state, project_root.to_string_lossy().as_ref())
        .await
        .expect("登记项目");
    assert_eq!(project.sessions.len(), 1, "登记时应看到已有历史会话");

    let temporary = workspace::open_temporary(&state, &project.id)
        .await
        .expect("分配临时会话");
    assert!(temporary.session_id.starts_with("ses_tmp_"));

    let listed = workspace::list_projects(&state).await.expect("列出项目");
    assert_eq!(listed[0].sessions.len(), 1, "历史会话数量不受并行会话影响");
    assert_eq!(listed[0].sessions[0].id, project.sessions[0].id);
    assert!(
        listed[0].sessions[0].runtime_id.is_none(),
        "临时会话不占用历史会话的运行时归属"
    );

    let _ = fs::remove_dir_all(&sandbox);
}
