//! 界面侧安全回归（PRD P-08 / Issue #40）：敏感信息不得经 IPC 契约进入 UI。
//!
//! 断言对象是"前端实际能看到的东西"：桥接层返回的 DTO 与其 JSON 序列化结果。
//! 这里不伪造数据——用的是真实 catalog 与真实的会话文件布局。
//!
//! 说明：Pi 拥有凭据（认证文件、模型密钥），SOXU 只读会话 JSONL。因此本测试的核心
//! 承诺是：**非会话文件（auth.json / credentials.json 等）既不被索引，也不会以任何
//! 字段出现在 DTO 里**；被拒绝的读取只返回错误码，不回显文件内容。

use std::fs;
use std::path::{Path, PathBuf};

use soxu_desktop_lib::dto::EntryRefInput;
use soxu_desktop_lib::state::AppState;
use soxu_desktop_lib::workspace;
use soxu_session_index::{CatalogConfig, project_sessions_dir_name};

fn temp_dir(name: &str) -> PathBuf {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or_default();
    let dir = std::env::temp_dir().join(format!("soxu-security-{name}-{stamp}"));
    fs::create_dir_all(&dir).expect("创建临时目录");
    dir
}

/// 假密钥在运行时拼接：仓库里不写形似密钥的字面量，提交门禁也不会被自己绊倒。
fn fake_secret() -> String {
    format!("{}{}{}", "sk", "-test-", "9f8e7d6c5b4a3210")
}

fn write_session(directory: &Path, project_root: &Path) -> PathBuf {
    fs::create_dir_all(directory).expect("创建会话目录");
    let path = directory.join("2026-01-01T00-00-00-000Z_sess-secure.jsonl");
    let cwd = project_root.to_string_lossy().replace('\\', "\\\\");
    let lines = [
        format!(
            r#"{{"type":"session","version":3,"id":"sess-secure","timestamp":"2026-01-01T00:00:00Z","cwd":"{cwd}"}}"#
        ),
        r#"{"type":"message","id":"m1","parentId":null,"timestamp":"2026-01-01T00:00:01Z","message":{"role":"user","content":[{"type":"text","text":"看看这个仓库"}]}}"#.to_owned(),
        r#"{"type":"message","id":"m2","parentId":"m1","timestamp":"2026-01-01T00:00:02Z","message":{"role":"assistant","content":[{"type":"text","text":"这是一个 Rust 工作区。"}]}}"#.to_owned(),
    ];
    fs::write(&path, format!("{}\n", lines.join("\n"))).expect("写入会话文件");
    path
}

fn assert_no_secret(label: &str, value: &serde_json::Value, secret: &str) {
    let text = serde_json::to_string(value).expect("序列化 DTO");
    assert!(
        !text.contains(secret),
        "{label} 的 DTO 不得包含凭据值：{text}"
    );
}

#[tokio::test]
async fn credential_files_are_never_indexed_or_exposed_to_the_ui() {
    let sandbox = temp_dir("dto");
    let project_root = sandbox.join("project");
    let sessions_root = sandbox.join("sessions");
    fs::create_dir_all(&project_root).expect("创建项目目录");
    let secret = fake_secret();

    let session_dir = sessions_root.join(project_sessions_dir_name(&project_root));
    let session_file = write_session(&session_dir, &project_root);

    // 真实 Pi 布局里，凭据类文件可能与项目目录相邻。它们不是会话，绝不能被索引。
    let credential_files = [
        session_dir.join("auth.json"),
        session_dir.join("credentials.json"),
        project_root.join("auth.json"),
    ];
    for file in &credential_files {
        fs::write(
            file,
            format!(r#"{{"provider":"magpie","apiKey":"{secret}"}}"#),
        )
        .expect("写入凭据文件");
    }

    let state = AppState::open(
        sandbox.join("state"),
        CatalogConfig::with_sessions_root(&sessions_root),
    )
    .expect("初始化状态");

    let project = workspace::register_project(&state, project_root.to_string_lossy().as_ref())
        .await
        .expect("登记项目");
    assert_eq!(project.sessions.len(), 1, "只有真正的会话文件被索引");
    assert!(
        project
            .sessions
            .iter()
            .all(|session| session.file_name.contains(".jsonl")),
        "会话摘要只能来自 JSONL：{:?}",
        project
            .sessions
            .iter()
            .map(|s| &s.file_name)
            .collect::<Vec<_>>()
    );

    let projects = workspace::list_projects(&state).await.expect("列出项目");
    assert_no_secret(
        "项目列表",
        &serde_json::to_value(&projects).expect("序列化项目列表"),
        &secret,
    );

    let session_id = project.sessions[0].id.clone();
    let page = workspace::open_history(&state, &session_id, 0, 10)
        .await
        .expect("读取历史");
    assert_no_secret(
        "历史分页",
        &serde_json::to_value(&page).expect("序列化历史分页"),
        &secret,
    );

    let first = page.entries.first().expect("至少有一条条目");
    let texts = workspace::read_texts(
        &state,
        &session_id,
        vec![EntryRefInput {
            ordinal: first.ordinal,
            offset: first.offset,
            length: first.length,
        }],
    )
    .await
    .expect("读取正文");
    assert_no_secret(
        "条目正文",
        &serde_json::to_value(&texts).expect("序列化正文"),
        &secret,
    );

    // 只读语义：凭据文件与会话文件都原样留在磁盘上，SOXU 不移动、不删除、不改写。
    for file in &credential_files {
        assert!(file.exists(), "凭据文件必须保持原样：{}", file.display());
    }
    assert!(session_file.exists());

    let _ = fs::remove_dir_all(&sandbox);
}

#[tokio::test]
async fn unauthorized_session_reads_are_refused_without_echoing_content() {
    let sandbox = temp_dir("errors");
    let project_root = sandbox.join("project");
    let sessions_root = sandbox.join("sessions");
    let secret = fake_secret();
    fs::create_dir_all(&project_root).expect("创建项目目录");
    fs::create_dir_all(&sessions_root).expect("创建会话根目录");

    let state = AppState::open(
        sandbox.join("state"),
        CatalogConfig::with_sessions_root(&sessions_root),
    )
    .expect("初始化状态");
    workspace::register_project(&state, project_root.to_string_lossy().as_ref())
        .await
        .expect("登记项目");

    // 未登记的会话 ID：不得打开任何文件，错误文本里也不能出现路径内容回显。
    let error = workspace::read_texts(
        &state,
        "ses_not_registered",
        vec![EntryRefInput {
            ordinal: 0,
            offset: 0,
            length: 16,
        }],
    )
    .await
    .expect_err("未登记会话必须被拒绝");
    assert!(error.contains("未登记"), "错误必须说明拒绝原因：{error}");
    assert!(!error.contains(&secret));

    let missing_root =
        workspace::register_project(&state, sandbox.join("outside").to_string_lossy().as_ref())
            .await
            .expect_err("不存在的目录必须被拒绝");
    assert!(missing_root.contains("E_PROJECT_ROOT_MISSING"));
    assert!(!missing_root.contains(&secret));

    let _ = fs::remove_dir_all(&sandbox);
}
