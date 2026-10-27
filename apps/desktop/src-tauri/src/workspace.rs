//! 项目导航与会话历史读取：把 `soxu-session-index` 的目录/索引映射成前端 DTO。
//!
//! 只读语义：不写回 JSONL、不移动或删除用户的会话文件；翻页只写索引快照。

use std::path::Path;

use soxu_session_index::{
    EntryKind, MessageRole, ProjectCatalog, ProjectId, ProjectRecord, SessionId, SessionPage,
};

use crate::dto::{
    EntryRefInput, EntryText, HistoryEntry, HistoryPage, ProjectSummary, SessionSummary,
};
use crate::entry_text::{MAX_BATCH_TEXTS, read_entry_text};
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
    let page = catalog
        .page_session(&session, SessionPage::new(offset, limit))
        .map_err(|error| error.to_string())?;
    Ok(HistoryPage {
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
    })
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
        let record = catalog
            .find_session(&SessionId::new(session_id))
            .ok_or_else(|| format!("会话未登记：{session_id}"))?;
        (record.file.clone(), record.file_len)
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
