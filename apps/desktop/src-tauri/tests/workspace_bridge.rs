//! 桌面端适配层的集成测试：真实调用 `soxu-session-index`，不使用伪数据。
//!
//! 覆盖 TASK-003 的核心承诺：项目登记后能列出真实会话、分页读取真实 JSONL、
//! 按需读取完整正文，并且订阅计数遵守挂载/释放语义。

use std::fs;
use std::path::{Path, PathBuf};

use soxu_desktop_lib::state::AppState;
use soxu_desktop_lib::{session_runtime, workspace};
use soxu_session_index::{CatalogConfig, project_sessions_dir_name};

fn temp_dir(name: &str) -> PathBuf {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or_default();
    let dir = std::env::temp_dir().join(format!("soxu-ws-{name}-{stamp}"));
    fs::create_dir_all(&dir).expect("创建临时目录");
    dir
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
        r#"{"type":"message","id":"m1","parentId":null,"timestamp":"2026-01-01T00:00:01Z","message":{"role":"user","content":[{"type":"text","text":"请总结这个仓库的结构"}]}}"#.to_owned(),
        r#"{"type":"message","id":"m2","parentId":"m1","timestamp":"2026-01-01T00:00:02Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"内部推理"},{"type":"text","text":"仓库分为 apps、crates、packages 三层。"}]}}"#.to_owned(),
        r#"{"type":"message","id":"m3","parentId":"m2","timestamp":"2026-01-01T00:00:03Z","message":{"role":"bashExecution","command":"ls","output":"apps\ncrates"}}"#.to_owned(),
    ];
    fs::write(&path, format!("{}\n", lines.join("\n"))).expect("写入会话文件");
    path
}

#[tokio::test]
async fn workspace_lists_and_pages_real_jsonl_sessions() {
    let sandbox = temp_dir("catalog");
    let project_root = sandbox.join("project");
    let sessions_root = sandbox.join("sessions");
    fs::create_dir_all(&project_root).expect("创建项目目录");
    let file = write_session(&sessions_root, &project_root, "01a101f1-test");

    let state = AppState::open(
        sandbox.join("state"),
        CatalogConfig::with_sessions_root(&sessions_root),
    )
    .expect("初始化状态");

    let project = workspace::register_project(&state, project_root.to_string_lossy().as_ref())
        .await
        .expect("登记项目");
    assert_eq!(project.sessions.len(), 1, "扫描到真实会话文件");
    let session = &project.sessions[0];
    assert_eq!(session.id, "ses_01a101f1-test");
    assert!(
        session.title.contains("请总结这个仓库的结构"),
        "标题取自首条用户消息：{}",
        session.title
    );
    assert!(session.entry_count >= 4);
    assert!(Path::new(&file).exists(), "适配层不得移动或删除会话文件");

    let page = workspace::open_history(&state, &session.id, 0, 10)
        .await
        .expect("读取历史");
    assert_eq!(page.offset, 0);
    let user = page
        .entries
        .iter()
        .find(|entry| entry.preview.as_deref() == Some("请总结这个仓库的结构"))
        .expect("用户消息进入索引");
    let user_ordinal = user.ordinal;
    let user_offset = user.offset;
    let user_length = user.length;
    assert!(page.total >= 4);
    assert!(page.bytes_read > 0, "分页报告实际读取字节数");

    // 按需读取完整正文：范围来自索引，越界必须被拒绝。
    let texts = workspace::read_texts(
        &state,
        &session.id,
        vec![soxu_desktop_lib::dto::EntryRefInput {
            ordinal: user_ordinal,
            offset: user_offset,
            length: user_length,
        }],
    )
    .await
    .expect("读取正文");
    assert_eq!(texts.len(), 1);
    assert!(texts[0].text.contains("请总结这个仓库的结构"));
    assert!(!texts[0].clipped);

    let out_of_range = workspace::read_texts(
        &state,
        &session.id,
        vec![soxu_desktop_lib::dto::EntryRefInput {
            ordinal: 0,
            offset: u64::MAX - 8,
            length: 8,
        }],
    )
    .await;
    assert!(out_of_range.is_err(), "越界读取必须失败");

    // 订阅计数：视图挂载 +1，卸载 -1，归零后不再 emit。
    assert_eq!(session_runtime::retain_events(&state, &session.id).await, 1);
    assert_eq!(session_runtime::retain_events(&state, &session.id).await, 2);
    assert_eq!(
        session_runtime::release_events(&state, &session.id).await,
        1
    );
    assert_eq!(
        session_runtime::release_events(&state, &session.id).await,
        0
    );

    // 没有运行时的情况下 stop 是幂等的，不会拉起进程。
    session_runtime::stop(&state, &session.id)
        .await
        .expect("停止是幂等的");
    assert!(session_runtime::status(&state, &session.id).await.is_none());

    let _ = fs::remove_dir_all(&sandbox);
}

#[tokio::test]
async fn unregistered_project_reports_a_typed_error() {
    let sandbox = temp_dir("errors");
    let state = AppState::open(
        sandbox.join("state"),
        CatalogConfig::with_sessions_root(sandbox.join("sessions")),
    )
    .expect("初始化状态");

    let missing =
        workspace::register_project(&state, sandbox.join("nope").to_string_lossy().as_ref())
            .await
            .expect_err("不存在的目录必须失败");
    assert!(
        missing.contains("E_PROJECT_ROOT_MISSING"),
        "错误码是机器可读契约：{missing}"
    );

    assert!(
        workspace::open_history(&state, "ses_missing", 0, 10)
            .await
            .is_err()
    );

    let _ = fs::remove_dir_all(&sandbox);
}
