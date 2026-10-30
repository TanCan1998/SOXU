//! 文件抽屉后端（Issue #120 / TASK-028）：项目根目录内的枚举、只读预览与受约束的写操作。
//!
//! 分层：`commands/files.rs`（IPC 参数映射）→ 本模块（项目身份 → 路径守卫 → 阻塞 IO）→ `std::fs`。
//!
//! - `guard.rs`：路径守卫。绝对路径/`..`/UNC/Windows 设备名在**读盘之前**拒绝，
//!   `canonicalize` 之后再与项目根目录逐段比对，符号链接跳出根目录一律拒绝。
//! - `ops.rs`：目录枚举、只读预览、新建/写入/重命名/删除、文件内搜索，全部有界。
//!
//! 本文件只做「项目身份 → 根目录」的解析与线程调度，不含业务判断。

mod guard;
mod ops;

use std::path::{Path, PathBuf};

use soxu_session_index::ProjectId;

use crate::dto::{DirListing, FileContent, FileMutation, FileSearchResult};
use crate::state::AppState;

pub use guard::{
    CONFIRM_MISMATCH, CONTENT_TOO_LARGE, DIR_NOT_EMPTY, FileError, FileRoot, IO_FAILURE, NOT_A_DIR,
    NOT_A_FILE, PATH_ABSOLUTE, PATH_EXISTS, PATH_INVALID, PATH_IS_ROOT, PATH_MISSING,
    PATH_OUTSIDE_ROOT, PATH_TRAVERSAL, QUERY_EMPTY, ROOT_UNKNOWN, SYMLINK_UNSUPPORTED,
};
pub use ops::{
    DEFAULT_FILE_HITS, MAX_DIR_ENTRIES, MAX_PREVIEW_BYTES, MAX_SEARCH_DEPTH, MAX_SEARCH_FILE_BYTES,
    MAX_SEARCH_FILES, MAX_WRITE_BYTES,
};

/// 项目身份 → 根目录。只查会话目录里的登记，不接受前端自报的绝对路径。
async fn project_root(state: &AppState, project_id: &str) -> Result<PathBuf, String> {
    let project = ProjectId::new(project_id);
    let catalog = state.catalog.lock().await;
    let record = catalog
        .project(&project)
        .ok_or_else(|| format!("{ROOT_UNKNOWN}: 项目未注册：{project_id}"))?;
    Ok(PathBuf::from(&record.root))
}

/// 把文件系统调用移出异步运行时：大目录枚举与网络盘上可能持续上百毫秒。
async fn blocking<T, F>(task: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, FileError> + Send + 'static,
    T: Send + 'static,
{
    match tokio::task::spawn_blocking(task).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(error)) => Err(error.to_string()),
        Err(error) => Err(format!("{IO_FAILURE}: 文件任务未完成（{error}）")),
    }
}

fn with_root<T>(
    root: &Path,
    task: impl FnOnce(&FileRoot) -> Result<T, FileError>,
) -> Result<T, FileError> {
    let guard = FileRoot::open(root)?;
    task(&guard)
}

/// 列出一层目录（懒加载）：只读目标目录这一层，不递归。
pub async fn list_dir(
    state: &AppState,
    project_id: &str,
    path: &str,
) -> Result<DirListing, String> {
    let root = project_root(state, project_id).await?;
    let path = path.to_owned();
    let project_id = project_id.to_owned();
    blocking(move || {
        with_root(&root, |guard| {
            let listing = ops::list_dir(guard, &path)?;
            Ok(DirListing {
                project_id,
                ..listing
            })
        })
    })
    .await
}

/// 只读预览：按字节截断，二进制内容只回标记不回正文。
pub async fn read_file(
    state: &AppState,
    project_id: &str,
    path: &str,
) -> Result<FileContent, String> {
    let root = project_root(state, project_id).await?;
    let path = path.to_owned();
    blocking(move || with_root(&root, |guard| ops::read_file(guard, &path))).await
}

/// 覆盖写入**已存在**的文件；目标不存在时报错，不会顺手创建。
pub async fn write_file(
    state: &AppState,
    project_id: &str,
    path: &str,
    content: &str,
) -> Result<FileMutation, String> {
    let root = project_root(state, project_id).await?;
    let path = path.to_owned();
    let content = content.to_owned();
    blocking(move || with_root(&root, |guard| ops::write_file(guard, &path, &content))).await
}

/// 新建文件：目标已存在（含悬空符号链接）时拒绝，绝不覆盖。
pub async fn create_file(
    state: &AppState,
    project_id: &str,
    path: &str,
    content: Option<&str>,
) -> Result<FileMutation, String> {
    let root = project_root(state, project_id).await?;
    let path = path.to_owned();
    let content = content.map(str::to_owned);
    blocking(move || {
        with_root(&root, |guard| {
            ops::create_file(guard, &path, content.as_deref())
        })
    })
    .await
}

/// 重命名/移动：源与目标都必须在根内，目标不得已存在。
pub async fn rename_path(
    state: &AppState,
    project_id: &str,
    from: &str,
    to: &str,
) -> Result<FileMutation, String> {
    let root = project_root(state, project_id).await?;
    let from = from.to_owned();
    let to = to.to_owned();
    blocking(move || with_root(&root, |guard| ops::rename(guard, &from, &to))).await
}

/// 删除：确认名称必须等于目标名称（二次确认由后端校验），根目录永远不可删。
pub async fn delete_path(
    state: &AppState,
    project_id: &str,
    path: &str,
    recursive: bool,
    confirm_name: &str,
) -> Result<FileMutation, String> {
    let root = project_root(state, project_id).await?;
    let path = path.to_owned();
    let confirm_name = confirm_name.to_owned();
    blocking(move || {
        with_root(&root, |guard| {
            ops::delete(guard, &path, recursive, &confirm_name)
        })
    })
    .await
}

/// 项目内文件搜索：深度、文件数、命中数都有上限，跳过依赖与构建产物目录。
pub async fn search_files(
    state: &AppState,
    project_id: &str,
    query: &str,
    limit: Option<usize>,
) -> Result<FileSearchResult, String> {
    let root = project_root(state, project_id).await?;
    let query = query.to_owned();
    let limit = limit
        .unwrap_or(DEFAULT_FILE_HITS)
        .clamp(1, DEFAULT_FILE_HITS);
    blocking(move || with_root(&root, |guard| ops::search(guard, &query, limit))).await
}
