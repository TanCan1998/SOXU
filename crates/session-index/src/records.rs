//! 目录持久化记录：项目、工作树、会话与目录快照。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::hash::fnv1a64_parts;
use crate::identity::{ProjectId, RuntimeLink, SessionId, WorktreeId, home_dir, now_ms};
use crate::snapshot::CATALOG_SCHEMA_VERSION;

/// 目录快照：应用状态目录下的 catalog.json 内容。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogSnapshot {
    pub schema: u32,
    pub projects: Vec<ProjectRecord>,
    pub updated_at_ms: u64,
}

impl Default for CatalogSnapshot {
    fn default() -> Self {
        Self {
            schema: CATALOG_SCHEMA_VERSION,
            projects: Vec::new(),
            updated_at_ms: 0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectRecord {
    pub id: ProjectId,
    pub root: String,
    pub name: String,
    pub worktrees: Vec<WorktreeRecord>,
    pub sessions: Vec<SessionRecord>,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
}

impl ProjectRecord {
    pub fn new(id: ProjectId, root: &Path) -> Self {
        let worktree = WorktreeRecord::primary(&id, root);
        let name = root
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| root.to_string_lossy().to_string());
        let timestamp = now_ms();
        Self {
            id,
            root: root.to_string_lossy().to_string(),
            name,
            worktrees: vec![worktree],
            sessions: Vec::new(),
            created_at_ms: timestamp,
            updated_at_ms: timestamp,
        }
    }

    pub fn primary_worktree(&self) -> Option<&WorktreeRecord> {
        self.worktrees.iter().find(|worktree| worktree.primary)
    }

    pub fn worktree(&self, id: &WorktreeId) -> Option<&WorktreeRecord> {
        self.worktrees.iter().find(|worktree| &worktree.id == id)
    }

    pub fn session(&self, id: &SessionId) -> Option<&SessionRecord> {
        self.sessions.iter().find(|session| &session.id == id)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorktreeRecord {
    pub id: WorktreeId,
    pub project: ProjectId,
    pub path: String,
    pub branch: Option<String>,
    pub primary: bool,
    /// 磁盘上的工作树目录当前不存在（Git 标记 prunable 或已被删除）。
    /// 只是引用状态：会话记录与索引快照继续保留，供人工核对与恢复。
    #[serde(default)]
    pub missing: bool,
    pub created_at_ms: u64,
}

impl WorktreeRecord {
    pub fn primary(project: &ProjectId, root: &Path) -> Self {
        Self {
            id: WorktreeId::derive(project, root),
            project: project.clone(),
            path: root.to_string_lossy().to_string(),
            branch: None,
            primary: true,
            missing: false,
            created_at_ms: now_ms(),
        }
    }
}

/// 会话文件当前是否可读。Missing 表示磁盘上的文件不见了，但历史身份与索引元数据保留。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionState {
    Present,
    Missing,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionRecord {
    pub id: SessionId,
    pub worktree: WorktreeId,
    /// 会话文件当前落点。路径不是身份，重命名后应保持同一 id 并更新此字段。
    pub file: String,
    pub header_version: Option<u32>,
    /// 会话头部记录的 cwd，用于核对是否属于当前工作树。
    #[serde(default)]
    pub cwd: Option<String>,
    pub head_fingerprint: u64,
    pub entry_count: usize,
    pub indexed_bytes: u64,
    pub file_len: u64,
    pub state: SessionState,
    pub runtime: Option<RuntimeLink>,
    /// 已发放的最大 generation，保证重启后新 runtime 的代号继续递增，迟到事件仍可丢弃。
    pub generation_watermark: u64,
    pub updated_at_ms: u64,
}

impl SessionRecord {
    pub fn new(id: SessionId, worktree: WorktreeId, file: &Path) -> Self {
        Self {
            id,
            worktree,
            file: file.to_string_lossy().to_string(),
            header_version: None,
            cwd: None,
            head_fingerprint: 0,
            entry_count: 0,
            indexed_bytes: 0,
            file_len: 0,
            state: SessionState::Present,
            runtime: None,
            generation_watermark: 0,
            updated_at_ms: now_ms(),
        }
    }

    pub fn is_missing(&self) -> bool {
        self.state == SessionState::Missing
    }
}

/// Pi 的会话目录命名规则：去掉前导分隔符，把 / \ : 都替换成 -，两侧加 --。
/// 依据 Pi 文档的 session-format（v3 版本行为）。布局变化时用显式 attach 兜底。
pub fn project_sessions_dir_name(root: &Path) -> String {
    let raw = root.to_string_lossy();
    let trimmed = raw.trim_start_matches(['/', '\\']);
    let mut name = String::with_capacity(trimmed.len());
    for character in trimmed.chars() {
        name.push(match character {
            '/' | '\\' | ':' => '-',
            other => other,
        });
    }
    format!("--{name}--")
}

/// Pi 会话根目录。SOXU_PI_SESSIONS_DIR 可覆盖（测试与自定义布局）。
pub fn default_sessions_root() -> Option<PathBuf> {
    if let Some(directory) = std::env::var_os("SOXU_PI_SESSIONS_DIR") {
        return Some(PathBuf::from(directory));
    }
    Some(home_dir()?.join(".pi").join("agent").join("sessions"))
}

/// 会话文件在索引缓存中的键：与路径绑定，而不是与 SessionId 绑定。
/// 文件重命名后沿用旧键也能命中，因为快照自校验会负责失效。
pub(crate) fn file_key(path: &Path) -> u64 {
    fnv1a64_parts(&["session-file", &crate::identity::normalize_path(path)])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_dir_name_follows_pi_layout() {
        assert_eq!(
            project_sessions_dir_name(Path::new("/home/user/project")),
            "--home-user-project--"
        );
        assert_eq!(
            project_sessions_dir_name(Path::new(r"F:\workplace\pi")),
            "--F--workplace-pi--"
        );
    }

    #[test]
    fn file_key_differs_by_path() {
        assert_ne!(
            file_key(Path::new("/sessions/a.jsonl")),
            file_key(Path::new("/sessions/b.jsonl"))
        );
    }
}
