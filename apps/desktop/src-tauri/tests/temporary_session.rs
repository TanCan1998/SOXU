//! 临时会话的桌面端集成测试：默认不进入历史、显式转正、崩溃后无幽灵运行时。
//!
//! 全部走真实的 `AppState` + `soxu-session-index`，不使用伪数据。

use std::fs;
use std::path::{Path, PathBuf};

use soxu_desktop_lib::session_runtime;
use soxu_desktop_lib::state::AppState;
use soxu_desktop_lib::workspace;
use soxu_session_index::{CatalogConfig, SessionId, project_sessions_dir_name};

fn temp_dir(name: &str) -> PathBuf {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or_default();
    let dir = std::env::temp_dir().join(format!("soxu-temp-{name}-{stamp}"));
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
        r#"{"type":"message","id":"m1","parentId":null,"timestamp":"2026-01-01T00:00:01Z","message":{"role":"user","content":[{"type":"text","text":"临时会话里的第一句话"}]}}"#.to_owned(),
        r#"{"type":"message","id":"m2","parentId":"m1","timestamp":"2026-01-01T00:00:02Z","message":{"role":"assistant","content":[{"type":"text","text":"这是临时对话的回复"}]}}"#.to_owned(),
    ];
    fs::write(&path, format!("{}\n", lines.join("\n"))).expect("写入会话文件");
    path
}

fn open_state(sandbox: &Path) -> AppState {
    AppState::open(
        sandbox.join("state"),
        CatalogConfig::with_sessions_root(sandbox.join("sessions")),
    )
    .expect("初始化状态")
}

#[tokio::test]
async fn temporary_session_is_promoted_only_on_explicit_request() {
    let sandbox = temp_dir("promote");
    let project_root = sandbox.join("project");
    let sessions_root = sandbox.join("sessions");
    fs::create_dir_all(&project_root).expect("创建项目目录");
    let state = open_state(&sandbox);

    let project = workspace::register_project(&state, project_root.to_string_lossy().as_ref())
        .await
        .expect("登记项目");
    assert!(project.sessions.is_empty(), "初始没有任何历史会话");

    // 1. 分配临时会话：身份是本地 ses_tmp_*，未绑定文件。
    let temporary = workspace::open_temporary(&state, &project.id)
        .await
        .expect("分配临时会话");
    assert!(temporary.session_id.starts_with("ses_tmp_"));
    assert!(!temporary.bound);
    assert_eq!(temporary.mode, "temporary");

    // 临时对话随后才由 Pi 写出会话文件（此处用夹具代替真实 Pi 写入）。
    let file = write_session(&sessions_root, &project_root, "promote01");

    // 2. 临时会话不出现在持久化历史里（侧栏 recentSessions 不应包含它）。
    let listed = workspace::list_projects(&state).await.expect("列出项目");
    assert!(listed[0].sessions.is_empty(), "临时会话不得进入历史列表");

    // 3. 打开临时会话历史：返回空页而不是「会话未登记」错误。
    let page = workspace::open_history(&state, &temporary.session_id, 0, 10)
        .await
        .expect("临时会话应能打开空历史");
    assert_eq!(page.total, 0);
    assert!(page.next.is_none());
    assert!(page.entries.is_empty());

    // 4. 未绑定文件时转正必须失败，并保留临时会话（UI 才能显示原因并保留内容）。
    let error = workspace::promote_session(&state, &temporary.session_id)
        .await
        .expect_err("未绑定文件时不应转正成功");
    assert!(
        error.contains("E_TEMPORARY_SESSION_UNPROMOTABLE"),
        "错误码是机器可读契约：{error}"
    );
    let listed = workspace::list_projects(&state).await.expect("列出项目");
    assert!(listed[0].sessions.is_empty(), "失败的转正不能写入历史");
    assert!(
        workspace::open_history(&state, &temporary.session_id, 0, 10)
            .await
            .is_ok(),
        "失败的转正必须保留临时会话"
    );

    // 5. 显式绑定 Pi 会话文件后可以分页读取真实内容。
    let bound =
        workspace::bind_temporary_file(&state, &temporary.session_id, &file.to_string_lossy())
            .await
            .expect("绑定会话文件");
    assert!(bound.bound);
    let page = workspace::open_history(&state, &temporary.session_id, 0, 10)
        .await
        .expect("绑定后应能分页");
    assert!(page.total >= 3, "绑定文件后应看到真实条目");

    // 6. 绑定期间扫描仍不登记：临时对话不会悄悄变成历史。
    let refreshed = workspace::refresh_project(&state, &project.id)
        .await
        .expect("刷新项目");
    assert!(
        refreshed.sessions.is_empty(),
        "绑定到临时会话的文件必须被扫描跳过"
    );

    // 7. 显式转正：进入历史，身份改成 Pi 会话头部的 id。
    let promoted = workspace::promote_session(&state, &temporary.session_id)
        .await
        .expect("转正成功");
    assert_eq!(
        promoted.session_id,
        SessionId::from_header_id("promote01").to_string()
    );
    assert_eq!(promoted.project.sessions.len(), 1);
    assert_eq!(promoted.project.sessions[0].id, promoted.session_id);
    assert!(
        promoted.project.sessions[0]
            .title
            .contains("临时会话里的第一句话"),
        "转正后标题来自真实消息：{}",
        promoted.project.sessions[0].title
    );
    assert!(file.exists(), "转正不得移动或删除 Pi 的会话文件");

    // 8. 临时身份已经结束：重复转正或结束都是明确的错误/幂等结果。
    assert!(
        workspace::promote_session(&state, &temporary.session_id)
            .await
            .is_err(),
        "已转正的临时会话不能再次转正"
    );
    assert!(
        !workspace::discard_temporary(&state, &temporary.session_id)
            .await
            .expect("结束临时会话应幂等"),
        "已经转正的临时会话不再存在于内存登记表"
    );

    drop(state);

    // 9. 重启后转正结果仍在历史里（真实持久化，不是内存假象）。
    let reopened = open_state(&sandbox);
    let listed = workspace::list_projects(&reopened).await.expect("列出项目");
    assert_eq!(listed[0].sessions.len(), 1);
    assert_eq!(listed[0].sessions[0].id, promoted.session_id);
    assert!(!listed[0].sessions[0].missing);

    let _ = fs::remove_dir_all(&sandbox);
}

#[tokio::test]
async fn discarding_a_temporary_session_keeps_pi_files_and_history_clean() {
    let sandbox = temp_dir("discard");
    let project_root = sandbox.join("project");
    let sessions_root = sandbox.join("sessions");
    fs::create_dir_all(&project_root).expect("创建项目目录");
    let state = open_state(&sandbox);

    let project = workspace::register_project(&state, project_root.to_string_lossy().as_ref())
        .await
        .expect("登记项目");
    let temporary = workspace::open_temporary(&state, &project.id)
        .await
        .expect("分配临时会话");
    // 文件在临时会话创建之后才出现（真实流程：Pi 先建立会话，再写文件）。
    let file = write_session(&sessions_root, &project_root, "discard01");
    workspace::bind_temporary_file(&state, &temporary.session_id, &file.to_string_lossy())
        .await
        .expect("绑定会话文件");

    assert!(
        workspace::discard_temporary(&state, &temporary.session_id)
            .await
            .expect("结束临时会话"),
        "第一次结束应命中"
    );
    assert!(file.exists(), "结束临时会话不得删除 Pi 的会话文件");
    let listed = workspace::list_projects(&state).await.expect("列出项目");
    assert!(listed[0].sessions.is_empty(), "结束临时会话后历史必须干净");
    assert!(
        workspace::open_history(&state, &temporary.session_id, 0, 10)
            .await
            .is_err(),
        "已结束的临时会话不再可读"
    );
    assert!(
        !workspace::discard_temporary(&state, &temporary.session_id)
            .await
            .expect("重复结束应幂等"),
        "重复结束返回 false 而不是错误"
    );

    let _ = fs::remove_dir_all(&sandbox);
}

#[tokio::test]
async fn restarted_app_reports_no_ghost_runtime() {
    let sandbox = temp_dir("ghost");
    let project_root = sandbox.join("project");
    let sessions_root = sandbox.join("sessions");
    fs::create_dir_all(&project_root).expect("创建项目目录");
    write_session(&sessions_root, &project_root, "ghost01");
    let state = open_state(&sandbox);

    let project = workspace::register_project(&state, project_root.to_string_lossy().as_ref())
        .await
        .expect("登记项目");
    let session_id = project.sessions[0].id.clone();

    // 模拟「运行时正在跑」：目录里登记运行时归属后直接崩溃（不 release）。
    {
        let mut catalog = state.catalog.lock().await;
        catalog
            .claim_writable(&SessionId::new(&session_id), "rt-ghost")
            .expect("声明可写运行时");
        catalog.save().expect("落盘");
    }
    let listed = workspace::list_projects(&state).await.expect("列出项目");
    assert_eq!(
        listed[0].sessions[0].runtime_id.as_deref(),
        Some("rt-ghost"),
        "崩溃前 UI 确实看到了运行时"
    );
    drop(state);

    // 重启：上一进程的 Pi 已经不存在，运行时归属必须被清理，历史仍然保留。
    let reopened = open_state(&sandbox);
    let listed = workspace::list_projects(&reopened).await.expect("列出项目");
    assert_eq!(listed[0].sessions.len(), 1, "历史会话本身不受影响");
    assert!(
        listed[0].sessions[0].runtime_id.is_none(),
        "重启后不允许出现幽灵运行时"
    );

    let _ = fs::remove_dir_all(&sandbox);
}

#[tokio::test]
async fn promotion_and_discard_wait_for_the_runtime_to_stop() {
    let sandbox = temp_dir("runtime-guard");
    let project_root = sandbox.join("project");
    let sessions_root = sandbox.join("sessions");
    fs::create_dir_all(&project_root).expect("创建项目目录");
    let state = open_state(&sandbox);

    let project = workspace::register_project(&state, project_root.to_string_lossy().as_ref())
        .await
        .expect("登记项目");
    let temporary = workspace::open_temporary(&state, &project.id)
        .await
        .expect("分配临时会话");
    let file = write_session(&sessions_root, &project_root, "guard01");
    workspace::bind_temporary_file(&state, &temporary.session_id, &file.to_string_lossy())
        .await
        .expect("绑定会话文件");

    // 1. 启动还没完成（重试退避窗口）：应用层守卫必须拒绝转正与结束。
    state.begin_pending_start(&temporary.session_id);
    assert!(
        session_runtime::has_live_runtime(&state, &temporary.session_id).await,
        "启动中的会话也算活运行时"
    );
    let blocked = workspace::promote_session(&state, &temporary.session_id)
        .await
        .expect_err("启动中不允许转正");
    assert!(
        blocked.contains("E_TEMPORARY_SESSION_RUNTIME_ACTIVE"),
        "错误码是机器可读契约：{blocked}"
    );
    assert!(
        workspace::discard_temporary(&state, &temporary.session_id)
            .await
            .is_err(),
        "启动中不允许清掉临时会话登记"
    );
    state.finish_pending_start(&temporary.session_id);
    assert!(!session_runtime::has_live_runtime(&state, &temporary.session_id).await);

    // 2. Pi 崩溃或自行退出会留下「没有活进程、但归属还在」的过期数据。
    //    不清掉它，用户会陷入「请先停止运行时」而停止按钮已经置灰的死循环。
    {
        let mut catalog = state.catalog.lock().await;
        catalog
            .claim_temporary_writable(&SessionId::new(&temporary.session_id), "rt-crashed")
            .expect("声明临时会话的可写归属");
    }
    assert!(
        !session_runtime::has_live_runtime(&state, &temporary.session_id).await,
        "没有驱动任务时不存在活运行时"
    );
    let listed = workspace::list_projects(&state).await.expect("列出项目");
    assert!(listed[0].sessions.is_empty(), "归属本身不写入历史");

    // 3. 过期归属不应阻塞转正：否则崩溃后无法恢复，停止按钮也已置灰。
    let promoted = workspace::promote_session(&state, &temporary.session_id)
        .await
        .expect("没有活运行时，过期归属不应阻塞转正");
    assert_eq!(
        promoted.session_id,
        SessionId::from_header_id("guard01").to_string()
    );
    assert_eq!(promoted.project.sessions.len(), 1);
    assert!(file.exists());

    let _ = fs::remove_dir_all(&sandbox);
}
