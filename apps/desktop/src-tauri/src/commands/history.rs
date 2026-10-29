//! 历史与会话命令：分页读取、正文按需加载、会话内搜索、临时会话生命周期。

use tauri::State;

use crate::dto::{
    EntryRefInput, EntryText, HistoryPage, PromotedSession, SessionSearchResult,
    TemporarySessionView,
};
use crate::state::AppState;
use crate::workspace;

#[tauri::command]
pub async fn open_session_history(
    state: State<'_, AppState>,
    session_id: String,
    offset: u64,
    limit: usize,
) -> Result<HistoryPage, String> {
    workspace::open_history(state.inner(), &session_id, offset, limit).await
}

#[tauri::command]
pub async fn read_session_texts(
    state: State<'_, AppState>,
    session_id: String,
    entries: Vec<EntryRefInput>,
) -> Result<Vec<EntryText>, String> {
    workspace::read_texts(state.inner(), &session_id, entries).await
}

/// 会话内搜索：走本地文本缓存 + 线性扫描，搜的是整份会话，不是已加载的一页。
///
/// 空查询返回空结果（不是错误）；超过 200 字符返回 E_SEARCH_QUERY_TOO_LONG。
#[tauri::command]
pub async fn search_session(
    state: State<'_, AppState>,
    session_id: String,
    query: String,
    limit: Option<usize>,
    after_ordinal: Option<u64>,
) -> Result<SessionSearchResult, String> {
    workspace::search(state.inner(), &session_id, &query, limit, after_ordinal).await
}

/// 分配一个临时会话：只存在于 Rust 进程内存，默认不进入持久化历史。
#[tauri::command]
pub async fn open_temporary_session(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<TemporarySessionView, String> {
    workspace::open_temporary(state.inner(), &project_id).await
}

/// 绑定 Pi 会话文件：绑定期间该文件不进入普通历史，转正后才登记。
#[tauri::command]
pub async fn bind_temporary_session_file(
    state: State<'_, AppState>,
    session_id: String,
    file: String,
) -> Result<TemporarySessionView, String> {
    workspace::bind_temporary_file(state.inner(), &session_id, &file).await
}

/// 显式转正：把临时会话变成普通会话；失败保留临时会话并返回原因。
#[tauri::command]
pub async fn promote_session(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<PromotedSession, String> {
    workspace::promote_session(state.inner(), &session_id).await
}

/// 结束临时会话：幂等，不删除 Pi 的会话文件。
#[tauri::command]
pub async fn discard_temporary_session(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<bool, String> {
    workspace::discard_temporary(state.inner(), &session_id).await
}
