//! Issue #109 · 桌面端搜索适配层：真实 JSONL + 真实 catalog，不使用伪数据。
//!
//! 验证 Tauri 命令背后的行为契约：搜全整份会话、limit 有上限、分页游标生效、
//! 边界输入有明确结果、未登记的会话给出稳定错误码。

use std::fs;
use std::path::{Path, PathBuf};

use soxu_desktop_lib::state::AppState;
use soxu_desktop_lib::workspace;
use soxu_session_index::{CatalogConfig, MAX_SEARCH_HITS, project_sessions_dir_name};

fn temp_dir(name: &str) -> PathBuf {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or_default();
    let dir = std::env::temp_dir().join(format!("soxu-search-{name}-{stamp}"));
    fs::create_dir_all(&dir).expect("创建临时目录");
    dir
}

/// 1,235 条消息，每第 6 条含「扩散」。
fn write_session(sessions_root: &Path, project_root: &Path, id: &str, messages: usize) -> PathBuf {
    let directory = sessions_root.join(project_sessions_dir_name(project_root));
    fs::create_dir_all(&directory).expect("创建会话目录");
    let path = directory.join(format!("2026-01-01T00-00-00-000Z_{id}.jsonl"));
    let cwd = project_root.to_string_lossy().replace('\\', "\\\\");
    let mut lines = vec![format!(
        r#"{{"type":"session","version":3,"id":"{id}","timestamp":"2026-01-01T00:00:00Z","cwd":"{cwd}"}}"#
    )];
    for index in 0..messages {
        let body = if index % 6 == 0 {
            format!("第 {index} 条讨论扩散模型的采样步数")
        } else {
            format!("第 {index} 条普通记录")
        };
        let role = if index % 2 == 0 { "user" } else { "assistant" };
        lines.push(format!(
            r#"{{"type":"message","id":"m{index:06}","parentId":null,"timestamp":"2026-01-01T00:00:01Z","message":{{"role":"{role}","content":"{body}"}}}}"#
        ));
    }
    fs::write(&path, format!("{}\n", lines.join("\n"))).expect("写入会话文件");
    path
}

async fn setup(name: &str, messages: usize) -> (PathBuf, AppState, String) {
    let sandbox = temp_dir(name);
    let project_root = sandbox.join("project");
    let sessions_root = sandbox.join("sessions");
    fs::create_dir_all(&project_root).expect("创建项目目录");
    write_session(&sessions_root, &project_root, "01a101f1-search", messages);

    let state = AppState::open(
        sandbox.join("state"),
        CatalogConfig::with_sessions_root(&sessions_root),
    )
    .expect("初始化状态");
    let project = workspace::register_project(&state, project_root.to_string_lossy().as_ref())
        .await
        .expect("登记项目");
    let session_id = project
        .sessions
        .first()
        .map(|session| session.id.clone())
        .expect("扫描到会话");
    (sandbox, state, session_id)
}

#[tokio::test]
async fn search_covers_the_whole_session_and_pages_by_ordinal() {
    let (sandbox, state, session_id) = setup("all", 1_235).await;

    let first = workspace::search(&state, &session_id, "扩散", None, None)
        .await
        .expect("搜索成功");
    assert_eq!(first.session_id, session_id);
    // 1,235 条里每 6 条命中一次 = 206 条；默认 limit 50。
    assert_eq!(
        first.total_hits, 206,
        "必须搜全整份会话，而不是已加载的一页"
    );
    assert_eq!(first.hits.len(), 50, "默认返回上限是 50");
    assert!(first.truncated, "还有下一页");
    assert!(!first.degraded);
    assert_eq!(first.scanned_entries, 1_236);

    for hit in &first.hits {
        let chars: Vec<char> = hit.snippet.chars().collect();
        let matched: String = chars[hit.match_start..hit.match_end].iter().collect();
        assert_eq!(matched, "扩散", "片段偏移必须精确指向命中词");
        assert!(hit.total_matches >= 1);
    }

    let last = first.hits.last().map(|hit| hit.ordinal).unwrap_or_default();
    let second = workspace::search(&state, &session_id, "扩散", Some(50), Some(last))
        .await
        .expect("搜索成功");
    assert_eq!(second.hits.len(), 50);
    assert_eq!(second.total_hits, 206, "翻页不改变命中总数");
    assert!(
        second.hits.first().map(|hit| hit.ordinal) > Some(last),
        "第二页必须接在第一页之后"
    );

    // 第二次查询不重建缓存（追加/翻页都不该整份重扫）。
    assert!(!second.rebuilt, "缓存命中后不应重建");

    let _ = fs::remove_dir_all(&sandbox);
}

#[tokio::test]
async fn search_limits_and_boundary_inputs_are_explicit() {
    let (sandbox, state, session_id) = setup("bounds", 60).await;

    // limit 会被夹到上限，不会因为前端传大数就返回无限条。
    let huge = workspace::search(&state, &session_id, "扩散", Some(100_000), None)
        .await
        .expect("搜索成功");
    assert!(huge.hits.len() <= MAX_SEARCH_HITS);

    // 空查询：不是错误，返回空结果。
    let empty = workspace::search(&state, &session_id, "   ", None, None)
        .await
        .expect("空查询不是错误");
    assert_eq!(empty.hits.len(), 0);
    assert_eq!(empty.total_hits, 0);
    assert!(empty.scanned_entries > 0);

    // 超长查询：稳定错误码，不 panic、不静默截断。
    let too_long = "长".repeat(201);
    let error = workspace::search(&state, &session_id, &too_long, None, None)
        .await
        .expect_err("超长查询必须失败");
    assert!(
        error.contains("E_SEARCH_QUERY_TOO_LONG"),
        "错误码是机器可读契约：{error}"
    );

    // 未登记的会话：给出稳定错误码而不是空结果。
    let unknown = workspace::search(&state, "ses_missing", "扩散", None, None)
        .await
        .expect_err("未登记会话必须失败");
    assert!(unknown.contains("会话未登记"), "{unknown}");

    let _ = fs::remove_dir_all(&sandbox);
}

#[tokio::test]
async fn unbound_temporary_session_reports_why_search_is_impossible() {
    let (sandbox, state, _session_id) = setup("temporary", 4).await;
    let project_id = workspace::list_projects(&state)
        .await
        .expect("列出项目")
        .first()
        .map(|project| project.id.clone())
        .expect("至少一个项目");
    let temporary = workspace::open_temporary(&state, &project_id)
        .await
        .expect("分配临时会话");

    let error = workspace::search(&state, &temporary.session_id, "扩散", None, None)
        .await
        .expect_err("未绑定文件的临时会话不能搜索");
    assert!(error.contains("还没有绑定 Pi 会话文件"), "{error}");

    let _ = fs::remove_dir_all(&sandbox);
}
