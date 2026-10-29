//! 项目导航与会话历史读取：把 `soxu-session-index` 的目录/索引映射成前端 DTO。
//!
//! 只读语义：不写回 JSONL、不移动或删除用户的会话文件；翻页只写索引快照。

use std::path::Path;

use soxu_session_index::{
    EntryKind, ErrorCode, MessageRole, ProjectCatalog, ProjectId, ProjectRecord, SessionId,
    SessionPage,
};

use crate::dto::{
    EntryRefInput, EntryText, HistoryEntry, HistoryPage, ProjectSummary, PromotedSession,
    SessionSummary, TemporarySessionView,
};
use crate::entry_text::{MAX_BATCH_TEXTS, read_entry_text};
use crate::session_runtime;
use crate::state::{AppState, lock};

/// 标题最大字符数：与侧栏一行的显示宽度对齐，避免列表被长消息撑开。
const TITLE_CHARS: usize = 44;

pub async fn list_projects(state: &AppState) -> Result<Vec<ProjectSummary>, String> {
    let mut catalog = state.catalog.lock().await;
    let projects: Vec<ProjectRecord> = catalog.projects().to_vec();
    Ok(projects
        .iter()
        .map(|project| summarize(&mut catalog, state, project))
        .collect())
}

pub async fn register_project(state: &AppState, root: &str) -> Result<ProjectSummary, String> {
    if root.trim().is_empty() {
        return Err("项目路径不能为空".to_owned());
    }
    let mut catalog = state.catalog.lock().await;
    let record = catalog
        .register_project(Path::new(root.trim()))
        .map_err(|error| error.to_string())?;
    // 注册后立刻扫描一次，让新项目在 UI 中带有真实会话列表。
    // 扫描失败（例如会话根目录不可用）不隐藏项目本身，但错误必须留痕。
    if let Err(error) = catalog.sync(&record.id) {
        eprintln!("SOXU: 项目 {} 首次扫描失败（{error}）", record.root);
    }
    catalog.save().map_err(|error| error.to_string())?;
    // 重新取快照：`record` 是扫描前的克隆，不含新发现的会话。
    let refreshed = catalog
        .project(&record.id)
        .cloned()
        .ok_or_else(|| "项目登记后立即丢失".to_owned())?;
    Ok(summarize(&mut catalog, state, &refreshed))
}

pub async fn refresh_project(state: &AppState, project_id: &str) -> Result<ProjectSummary, String> {
    let project = ProjectId::new(project_id);
    let mut catalog = state.catalog.lock().await;
    catalog.sync(&project).map_err(|error| error.to_string())?;
    catalog.save().map_err(|error| error.to_string())?;
    let record = catalog
        .project(&project)
        .cloned()
        .ok_or_else(|| format!("项目未注册：{project_id}"))?;
    Ok(summarize(&mut catalog, state, &record))
}

pub async fn open_history(
    state: &AppState,
    session_id: &str,
    offset: u64,
    limit: usize,
) -> Result<HistoryPage, String> {
    let session = SessionId::new(session_id);
    let mut catalog = state.catalog.lock().await;
    // 临时会话默认没有持久化历史：未绑定 Pi 文件时返回空页，而不是把「未登记」当错误。
    // 已绑定的临时会话可以分页（只读该文件），但不会因此进入历史。
    let temporary = catalog.temporary_session(&session).cloned();
    let page = match temporary {
        Some(entry) if !entry.is_bound() => return Ok(empty_page(session_id, offset)),
        Some(_) => catalog
            .page_temporary_session(&session, SessionPage::new(offset, limit))
            .map_err(|error| error.to_string())?,
        None => catalog
            .page_session(&session, SessionPage::new(offset, limit))
            .map_err(|error| error.to_string())?,
    };
    Ok(history_page(session_id, &page))
}

/// 临时会话：分配一个只存在于内存的身份，默认不进入持久化历史。
pub async fn open_temporary(
    state: &AppState,
    project_id: &str,
) -> Result<TemporarySessionView, String> {
    let project = ProjectId::new(project_id);
    let mut catalog = state.catalog.lock().await;
    let temporary = catalog
        .open_temporary_session(&project, None)
        .map_err(|error| error.to_string())?;
    Ok(TemporarySessionView::from_record(&temporary))
}

/// 绑定 Pi 会话文件（显式选择）：绑定期间该文件被挡在普通历史之外。
pub async fn bind_temporary_file(
    state: &AppState,
    session_id: &str,
    file: &str,
) -> Result<TemporarySessionView, String> {
    if file.trim().is_empty() {
        return Err("会话文件路径不能为空".to_owned());
    }
    let session = SessionId::new(session_id);
    let mut catalog = state.catalog.lock().await;
    let temporary = catalog
        .bind_temporary_file(&session, Path::new(file.trim()))
        .map_err(|error| error.to_string())?;
    Ok(TemporarySessionView::from_record(&temporary))
}

/// 显式转正：成功后临时会话进入持久化历史，并返回所属项目的最新摘要。
///
/// 失败（未绑定文件、文件非法、身份冲突）不写入任何东西，临时会话与内容保留，
/// 错误文本带回稳定错误码，供 UI 显示原因——绝不声称「保存成功」。
pub async fn promote_session(
    state: &AppState,
    session_id: &str,
) -> Result<PromotedSession, String> {
    let session = SessionId::new(session_id);
    // 与启动/停止串行：否则「检查没有运行时」与「启动刚拉起进程」之间会出现空档，
    // 转正后进程仍在写同一个 JSONL，形成双写。
    let _serialized = state.start_guard.lock().await;
    // 有活运行时（含 idle 与启动中）时拒绝转正：旧 Pi 进程会失去 owner，
    // 「停止」变成 no-op 假成功，进程直到自己退出才被回收；同一 JSONL 还可能被双写。
    if session_runtime::has_live_runtime(state, session_id).await {
        return Err(runtime_active_error(session_id, "转正"));
    }
    let mut catalog = state.catalog.lock().await;
    let project_id = catalog
        .temporary_session(&session)
        .map(|entry| entry.project.clone())
        .ok_or_else(|| format!("E_TEMPORARY_SESSION_UNKNOWN: 临时会话未登记：{session_id}"))?;
    // 走到这里已经确认没有活运行时（并且启动被 start_guard 串行化），
    // 所以遗留的可写归属一定是过期数据（Pi 崩溃或自行退出）。不清掉它，
    // 用户会陷入「请先停止运行时」但停止按钮已经置灰的死循环。
    let _ = catalog.release_stale_temporary_runtime(&session);
    let record = catalog
        .promote_temporary_session(&session)
        .map_err(|error| error.to_string())?;
    catalog.save().map_err(|error| error.to_string())?;
    let project = catalog
        .project(&project_id)
        .cloned()
        .ok_or_else(|| "转正后项目丢失".to_owned())?;
    Ok(PromotedSession {
        session_id: record.id.to_string(),
        project: summarize(&mut catalog, state, &project),
    })
}

/// 结束临时会话：只清内存登记与可丢弃的索引快照，不删除 Pi 的会话文件。
///
/// 幂等：目录里已经没有这个临时会话时返回 false（重复关闭 Tab 不算失败）。
pub async fn discard_temporary(state: &AppState, session_id: &str) -> Result<bool, String> {
    let session = SessionId::new(session_id);
    // 与启动/停止串行：避免「刚检查完没有运行时」与「启动拉起进程」之间留下空档。
    let _serialized = state.start_guard.lock().await;
    // 结束临时会话同样要求没有活运行时：登记消失后进程就失去 owner，
    // 绑定也随之中断，文件可能被下一次扫描当成普通会话（幽灵历史）。
    if session_runtime::has_live_runtime(state, session_id).await {
        return Err(runtime_active_error(session_id, "结束"));
    }
    let mut catalog = state.catalog.lock().await;
    // 同上：已确认没有活运行时，遗留归属是过期数据，先清掉再结束会话。
    let _ = catalog.release_stale_temporary_runtime(&session);
    match catalog.discard_temporary_session(&session) {
        Ok(_) => Ok(true),
        Err(error) if error.code() == ErrorCode::TemporarySessionUnknown => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}

/// 活运行时守卫的统一错误文本：带稳定错误码，UI 可以直接照着提示「先停止运行时」。
fn runtime_active_error(session_id: &str, action: &str) -> String {
    format!(
        "{}: 临时会话 {session_id} 仍有运行中的 Pi，请先停止运行时再{action}",
        ErrorCode::TemporarySessionRuntimeActive
    )
}

/// 空历史页：临时会话尚未产生可索引内容时使用，不伪造条目。
fn empty_page(session_id: &str, offset: u64) -> HistoryPage {
    HistoryPage {
        session_id: session_id.to_owned(),
        entries: Vec::new(),
        offset,
        total: 0,
        next: None,
        bytes_read: 0,
        clipped: false,
    }
}

fn history_page(session_id: &str, page: &soxu_session_index::EntryPage) -> HistoryPage {
    HistoryPage {
        session_id: session_id.to_owned(),
        entries: page
            .entries
            .iter()
            .map(|entry| HistoryEntry {
                ordinal: entry.ordinal,
                offset: entry.offset,
                length: entry.byte_len,
                kind: entry.kind,
                role: entry.role,
                preview: entry.preview.clone(),
                timestamp: entry.timestamp.clone(),
                oversized: entry.oversized,
                corrupt: entry.corrupt,
            })
            .collect(),
        offset: page.offset,
        total: page.total,
        next: page.next,
        bytes_read: page.bytes_read,
        clipped: page.clipped,
    }
}

/// 批量读取完整正文。条目范围必须落在会话文件内，批次有上限。
pub async fn read_texts(
    state: &AppState,
    session_id: &str,
    entries: Vec<EntryRefInput>,
) -> Result<Vec<EntryText>, String> {
    if entries.len() > MAX_BATCH_TEXTS {
        return Err(format!(
            "一次最多读取 {MAX_BATCH_TEXTS} 条正文，收到 {}",
            entries.len()
        ));
    }
    let (file, file_len) = {
        let catalog = state.catalog.lock().await;
        let session = SessionId::new(session_id);
        // 临时会话的正文来自它绑定的 Pi 会话文件；文件长度以磁盘实际值为准。
        if let Some(temporary) = catalog.temporary_session(&session) {
            let file = temporary
                .file
                .clone()
                .ok_or_else(|| format!("临时会话 {session_id} 还没有绑定 Pi 会话文件"))?;
            let len = std::fs::metadata(&file).map(|meta| meta.len()).unwrap_or(0);
            (file, len)
        } else {
            let record = catalog
                .find_session(&session)
                .ok_or_else(|| format!("会话未登记：{session_id}"))?;
            (record.file.clone(), record.file_len)
        }
    };
    let path = std::path::PathBuf::from(file);
    let mut texts = Vec::with_capacity(entries.len());
    for reference in entries {
        texts.push(read_entry_text(&path, file_len, &reference)?);
    }
    Ok(texts)
}

fn summarize(
    catalog: &mut ProjectCatalog,
    state: &AppState,
    project: &ProjectRecord,
) -> ProjectSummary {
    let sessions = project
        .sessions
        .iter()
        .map(|record| SessionSummary {
            id: record.id.to_string(),
            project_id: project.id.to_string(),
            worktree_id: record.worktree.to_string(),
            title: title_for(catalog, state, &record.id),
            file_name: SessionSummary::file_name(&record.file),
            entry_count: record.entry_count,
            updated_at_ms: record.updated_at_ms,
            missing: record.is_missing(),
            runtime_id: record.runtime.as_ref().map(|link| link.runtime.to_string()),
            generation: record
                .runtime
                .as_ref()
                .map(|link| link.generation)
                .unwrap_or(record.generation_watermark),
        })
        .collect();
    ProjectSummary {
        id: project.id.to_string(),
        name: project.name.clone(),
        root: project.root.clone(),
        worktree_count: project.worktrees.len(),
        sessions,
    }
}

/// 标题来自首条用户消息；索引不可读时退回文件名，不编造内容。
fn title_for(catalog: &mut ProjectCatalog, state: &AppState, session: &SessionId) -> String {
    if let Some(cached) = lock(&state.titles).get(session.as_str()).cloned() {
        return cached;
    }
    let title = catalog
        .page_session(session, SessionPage::new(0, 12))
        .ok()
        .and_then(|page| {
            page.entries
                .iter()
                .find(|entry| {
                    entry.kind == EntryKind::Message && entry.role == Some(MessageRole::User)
                })
                .and_then(|entry| entry.preview.clone())
        })
        .map(|preview| clip(&preview))
        .unwrap_or_else(|| fallback_title(catalog, session));
    lock(&state.titles).insert(session.as_str().to_owned(), title.clone());
    title
}

fn fallback_title(catalog: &ProjectCatalog, session: &SessionId) -> String {
    catalog
        .find_session(session)
        .map(|record| SessionSummary::file_name(&record.file))
        .unwrap_or_else(|| "未命名会话".to_owned())
}

fn clip(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= TITLE_CHARS {
        return trimmed.to_owned();
    }
    let kept: String = trimmed.chars().take(TITLE_CHARS).collect();
    format!("{kept}…")
}
