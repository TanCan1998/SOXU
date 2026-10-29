//! 临时会话：只活在内存里的会话视图，以及显式的「转正」入口。
//!
//! 契约见 docs/architecture/session-catalog.md 的「临时会话与转正」一节：
//!
//! 1. 临时会话的登记只存在于 `ProjectCatalog` 的内存里，`save()` 不写它，
//!    因此崩溃、断电或正常退出后都不会出现「幽灵历史」。
//! 2. 临时会话可以绑定一个 Pi 会话文件；绑定期间 `sync` 跳过该文件，
//!    避免「临时对话在重启后变成普通历史」。
//! 3. 转正是显式动作：只有绑定成功且文件是合法 Pi 会话时才写入历史；
//!    失败不写入任何东西，临时会话与内容保留，由 UI 显示原因（不伪造成功）。
//! 4. 结束临时会话只清内存登记与可丢弃的索引快照，**绝不删除 Pi 的会话文件**。
//! 5. 临时会话同样登记**可写归属**（`claim_temporary_writable`）：只要还有 Pi 持有它，
//!    转正与结束都必须被拒绝，否则旧进程会失去 owner（停止变成 no-op 假成功），
//!    转正后再启动就会对同一 JSONL 双写。

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::catalog::ProjectCatalog;
use crate::entry::{EntryPage, SessionHeader, parse_header};
use crate::error::{CatalogError, ErrorCode, Result};
use crate::identity::{
    ProjectId, RuntimeId, SessionId, WorktreeId, normalize_path, now_ms, strip_verbatim,
};
use crate::index::{SessionLog, SessionPage};
use crate::records::SessionRecord;
use crate::snapshot::SnapshotLoad;

/// 内存登记表的容量上限：临时会话不是历史，数量必须有界，避免无限增长。
pub const MAX_TEMPORARY_SESSIONS: usize = 32;

/// Pi 会话头部的读取上限：与索引快照的 `head_len` 上限（4096 字节）一致。
const HEADER_BYTES: u64 = 4096;

/// 一个临时会话：项目/工作树归属 + 可选的已绑定 Pi 会话文件。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TemporarySession {
    pub session: SessionId,
    pub project: ProjectId,
    pub worktree: WorktreeId,
    /// 已绑定的 Pi 会话文件绝对路径。绑定期间该文件不进入普通历史。
    pub file: Option<String>,
    /// 当前持有可写权的运行时（只存在于内存）：有值时转正与结束都必须先停止运行时。
    pub runtime: Option<RuntimeId>,
    pub created_at_ms: u64,
}

impl TemporarySession {
    pub fn file_path(&self) -> Option<PathBuf> {
        self.file.as_deref().map(PathBuf::from)
    }

    /// 是否已绑定 Pi 会话文件；未绑定时没有可持久化的内容。
    pub fn is_bound(&self) -> bool {
        self.file.is_some()
    }

    /// 是否有 Pi 运行时仍持有这个临时会话（归属只存在内存里，不落盘）。
    pub fn is_claimed(&self) -> bool {
        self.runtime.is_some()
    }
}

/// 内存登记表。**刻意不实现 Serialize**：临时会话绝不能被写进 catalog.json。
#[derive(Debug, Default)]
pub(crate) struct TemporaryRegistry {
    entries: Vec<TemporarySession>,
    sequence: u64,
}

impl TemporaryRegistry {
    pub(crate) fn all(&self) -> &[TemporarySession] {
        &self.entries
    }

    pub(crate) fn len(&self) -> usize {
        self.entries.len()
    }

    pub(crate) fn get(&self, session: &SessionId) -> Option<&TemporarySession> {
        self.entries.iter().find(|entry| &entry.session == session)
    }

    pub(crate) fn get_mut(&mut self, session: &SessionId) -> Option<&mut TemporarySession> {
        self.entries
            .iter_mut()
            .find(|entry| &entry.session == session)
    }

    pub(crate) fn push(&mut self, entry: TemporarySession) {
        self.entries.push(entry);
    }

    pub(crate) fn remove(&mut self, session: &SessionId) -> Option<TemporarySession> {
        let position = self
            .entries
            .iter()
            .position(|entry| &entry.session == session)?;
        Some(self.entries.remove(position))
    }

    /// 下一个候选身份。序号只增不减，同一次运行内不会重复分配。
    pub(crate) fn next_candidate(&mut self) -> SessionId {
        self.sequence = self.sequence.saturating_add(1);
        SessionId::temporary(self.sequence)
    }

    /// 该文件当前绑定的临时会话（一个文件只能属于一个临时会话）。
    pub(crate) fn owner_of(&self, file: &Path) -> Option<SessionId> {
        let normalized = normalize_path(file);
        self.entries
            .iter()
            .find(|entry| {
                entry
                    .file
                    .as_deref()
                    .is_some_and(|bound| normalize_path(Path::new(bound)) == normalized)
            })
            .map(|entry| entry.session.clone())
    }

    /// `sync` 用它把已绑定的文件挡在普通历史之外。
    ///
    /// 扫描拿到的是目录项路径（可能含相对段或不同的盘符写法），绑定存的是解析后的
    /// 绝对路径，所以这里先解析再比较；解析失败（并发删除）时退回原样比较。
    pub(crate) fn is_bound_file(&self, file: &Path) -> bool {
        let resolved = fs::canonicalize(file)
            .map(|value| strip_verbatim(&value))
            .unwrap_or_else(|_| file.to_path_buf());
        self.owner_of(&resolved).is_some()
    }
}

impl ProjectCatalog {
    /// 分配一个临时会话：只登记在内存，不写 catalog.json，也不碰磁盘。
    pub fn open_temporary_session(
        &mut self,
        project: &ProjectId,
        worktree: Option<&WorktreeId>,
    ) -> Result<TemporarySession> {
        if self.temporary.len() >= MAX_TEMPORARY_SESSIONS {
            return Err(CatalogError::new(
                ErrorCode::TemporarySessionLimit,
                format!("临时会话数量已达上限 {MAX_TEMPORARY_SESSIONS}，请先结束一个临时会话"),
            ));
        }
        let worktree_id = {
            let record = self.project(project).ok_or_else(|| {
                CatalogError::new(ErrorCode::ProjectUnknown, format!("项目未注册：{project}"))
            })?;
            match worktree {
                Some(id) => record
                    .worktree(id)
                    .map(|item| item.id.clone())
                    .ok_or_else(|| {
                        CatalogError::new(ErrorCode::WorktreeUnknown, format!("工作树未登记：{id}"))
                    })?,
                None => record
                    .primary_worktree()
                    .map(|item| item.id.clone())
                    .ok_or_else(|| {
                        CatalogError::new(
                            ErrorCode::WorktreeUnknown,
                            format!("项目 {project} 没有主工作树"),
                        )
                    })?,
            }
        };
        let mut session = self.temporary.next_candidate();
        let mut attempts = 0_usize;
        // 与已持久化的会话身份、已有临时会话都不能撞车。
        while self.find_session(&session).is_some() || self.temporary.get(&session).is_some() {
            attempts += 1;
            if attempts > MAX_TEMPORARY_SESSIONS {
                return Err(CatalogError::new(
                    ErrorCode::TemporarySessionLimit,
                    "无法分配未被占用的临时会话身份",
                ));
            }
            session = self.temporary.next_candidate();
        }
        let entry = TemporarySession {
            session,
            project: project.clone(),
            worktree: worktree_id,
            file: None,
            runtime: None,
            created_at_ms: now_ms(),
        };
        self.temporary.push(entry.clone());
        Ok(entry)
    }

    /// 当前进程里的全部临时会话（永远不含持久化历史）。
    pub fn temporary_sessions(&self) -> &[TemporarySession] {
        self.temporary.all()
    }

    pub fn temporary_session(&self, session: &SessionId) -> Option<&TemporarySession> {
        self.temporary.get(session)
    }

    /// 是否是一个临时会话（内存登记唯一权威，不靠 id 前缀猜测）。
    pub fn is_temporary(&self, session: &SessionId) -> bool {
        self.temporary.get(session).is_some()
    }

    /// 该临时会话当前是否被运行时持有可写权。
    pub fn temporary_session_claimed(&self, session: &SessionId) -> bool {
        self.temporary
            .get(session)
            .is_some_and(|entry| entry.is_claimed())
    }

    /// 声明临时会话的可写运行时。归属只存在内存里（临时会话本来就不落盘）。
    ///
    /// 语义与持久化会话的 `claim_writable` 对齐：同一个 runtime 重复声明幂等，
    /// 已有其他 runtime 持有时返回 `E_TEMPORARY_SESSION_RUNTIME_ACTIVE`。
    /// 没有这一步，「临时会话 → 转正 → 再次启动」会对同一 JSONL 形成双写。
    pub fn claim_temporary_writable(
        &mut self,
        session: &SessionId,
        runtime: &str,
    ) -> Result<RuntimeId> {
        let runtime = RuntimeId::new(runtime);
        let entry = self.temporary.get_mut(session).ok_or_else(|| {
            CatalogError::new(
                ErrorCode::TemporarySessionUnknown,
                format!("临时会话未登记：{session}"),
            )
        })?;
        if let Some(current) = &entry.runtime {
            if current == &runtime {
                return Ok(current.clone());
            }
            return Err(CatalogError::new(
                ErrorCode::TemporarySessionRuntimeActive,
                format!("临时会话 {session} 仍由 {current} 持有，请先停止该运行时"),
            ));
        }
        entry.runtime = Some(runtime.clone());
        Ok(runtime)
    }

    /// 清理临时会话遗留的可写归属（上一代运行时已确认不存在时使用）。
    ///
    /// 不做存活判断，直接清空；只有真正掌握进程生命周期的调用方（桌面端的
    /// `session_runtime`）才可以用它。与持久化会话的 `release_stale_runtime` 对应：
    /// 崩溃或自行退出留下的归属如果不清，用户会看到「请先停止运行时」但停止按钮已置灰的死循环。
    pub fn release_stale_temporary_runtime(&mut self, session: &SessionId) -> Option<RuntimeId> {
        self.temporary
            .get_mut(session)
            .and_then(|entry| entry.runtime.take())
    }

    /// 释放临时会话的可写归属。没有归属时视为已释放（停止是幂等的）；
    /// 持有者不一致时返回 `E_SESSION_RUNTIME_UNKNOWN`，与持久化会话的 `release` 一致。
    pub fn release_temporary_writable(&mut self, session: &SessionId, runtime: &str) -> Result<()> {
        let runtime = RuntimeId::new(runtime);
        let entry = self.temporary.get_mut(session).ok_or_else(|| {
            CatalogError::new(
                ErrorCode::TemporarySessionUnknown,
                format!("临时会话未登记：{session}"),
            )
        })?;
        match &entry.runtime {
            None => Ok(()),
            Some(current) if current == &runtime => {
                entry.runtime = None;
                Ok(())
            }
            Some(current) => Err(CatalogError::new(
                ErrorCode::SessionRuntimeUnknown,
                format!("临时会话 {session} 没有由 {runtime} 持有（当前持有者：{current}）"),
            )),
        }
    }

    /// 绑定 Pi 会话文件。绑定期间 `sync` 不会把它登记成普通历史。
    ///
    /// 文件必须是合法的 Pi 会话（首行 session 头部、`.jsonl` 扩展名），
    /// 且不能已经是普通会话的落点——历史一旦可见就不能再退回临时。
    pub fn bind_temporary_file(
        &mut self,
        session: &SessionId,
        file: &Path,
    ) -> Result<TemporarySession> {
        if self.temporary.get(session).is_none() {
            return Err(CatalogError::new(
                ErrorCode::TemporarySessionUnknown,
                format!("临时会话未登记：{session}"),
            ));
        }
        validate_pi_session_file(file)?;
        let canonical = fs::canonicalize(file)
            .map(|value| strip_verbatim(&value))
            .map_err(|error| {
                CatalogError::io(
                    ErrorCode::TemporarySessionFileInvalid,
                    format!("无法解析会话文件路径：{}", file.display()),
                    &error,
                )
            })?;
        if self.registered_file(&canonical).is_some() {
            return Err(CatalogError::new(
                ErrorCode::TemporarySessionFileConflict,
                format!(
                    "文件已是普通会话的落点，不能改回临时会话：{}",
                    canonical.display()
                ),
            ));
        }
        if let Some(owner) = self.temporary.owner_of(&canonical)
            && &owner != session
        {
            return Err(CatalogError::new(
                ErrorCode::TemporarySessionFileConflict,
                format!("文件已绑定到临时会话 {owner}：{}", canonical.display()),
            ));
        }
        let entry = self
            .temporary
            .get_mut(session)
            .expect("临时会话已在上面校验存在");
        entry.file = Some(canonical.to_string_lossy().to_string());
        Ok(entry.clone())
    }

    /// 显式转正：把临时会话变成普通会话，写入持久化历史。
    ///
    /// 失败（未绑定文件、文件非法、身份冲突）不写入任何东西，临时会话保留。
    pub fn promote_temporary_session(&mut self, session: &SessionId) -> Result<SessionRecord> {
        let entry = self.temporary.get(session).cloned().ok_or_else(|| {
            CatalogError::new(
                ErrorCode::TemporarySessionUnknown,
                format!("临时会话未登记：{session}"),
            )
        })?;
        let file = entry.file_path().ok_or_else(|| {
            CatalogError::new(
                ErrorCode::TemporarySessionUnpromotable,
                format!("临时会话 {session} 还没有绑定 Pi 会话文件，暂无可持久化的内容"),
            )
        })?;
        // 有运行中的 Pi 时禁止转正：转正后旧进程会失去 owner（停止变成 no-op 假成功，
        // 进程直到自己退出才被回收），同一 JSONL 还可能被下一次启动双写。
        if let Some(runtime) = &entry.runtime {
            return Err(CatalogError::new(
                ErrorCode::TemporarySessionRuntimeActive,
                format!("临时会话 {session} 仍由 {runtime} 持有运行中的 Pi，请先停止运行时再转正"),
            ));
        }
        // upsert_session 是历史登记的唯一入口：它负责身份派生、索引与快照落盘。
        let upsert = self.upsert_session(&entry.project, &entry.worktree, &file)?;
        if let Some(duplicate) = upsert.duplicate {
            return Err(CatalogError::new(
                ErrorCode::TemporarySessionFileConflict,
                duplicate,
            ));
        }
        self.temporary.remove(session);
        Ok(upsert.record)
    }

    /// 结束临时会话：只清内存登记与可丢弃的索引快照，不删除 Pi 的会话文件。
    ///
    /// 有运行中的 Pi 持有时拒绝：登记一旦消失，进程就失去 owner（停止变成 no-op），
    /// 绑定也随之解除，文件可能被下一次扫描当成普通会话，产生幽灵历史。
    pub fn discard_temporary_session(&mut self, session: &SessionId) -> Result<TemporarySession> {
        if let Some(entry) = self.temporary.get(session)
            && let Some(runtime) = &entry.runtime
        {
            return Err(CatalogError::new(
                ErrorCode::TemporarySessionRuntimeActive,
                format!(
                    "临时会话 {session} 仍由 {runtime} 持有运行中的 Pi，请先停止运行时再结束会话"
                ),
            ));
        }
        let entry = self.temporary.remove(session).ok_or_else(|| {
            CatalogError::new(
                ErrorCode::TemporarySessionUnknown,
                format!("临时会话未登记：{session}"),
            )
        })?;
        if let Some(file) = entry.file_path() {
            // 索引快照是可丢弃缓存；临时会话结束后没有 owner，主动清理避免残留增长。
            let _ = fs::remove_file(self.index_snapshot_path(&file));
        }
        Ok(entry)
    }

    /// 临时会话的分页读取。未绑定文件时返回 `E_TEMPORARY_SESSION_UNPROMOTABLE`，
    /// 由上层决定显示空会话还是错误——绝不编造历史。
    pub fn page_temporary_session(
        &mut self,
        session: &SessionId,
        page: SessionPage,
    ) -> Result<EntryPage> {
        let file = self
            .temporary
            .get(session)
            .and_then(|entry| entry.file_path())
            .ok_or_else(|| {
                CatalogError::new(
                    ErrorCode::TemporarySessionUnpromotable,
                    format!("临时会话 {session} 还没有绑定 Pi 会话文件"),
                )
            })?;
        let snapshot_path = self.index_snapshot_path(&file);
        let (mut log, _load) = match SessionLog::load_snapshot(&snapshot_path)? {
            Some(snapshot) => SessionLog::from_snapshot(&file, snapshot),
            None => (SessionLog::new(&file), SnapshotLoad::fresh()),
        };
        let report = log.refresh()?;
        let result = log.page(page)?;
        if report.appended_entries > 0 || report.rebuild.is_some() {
            log.save_if_dirty(&snapshot_path)?;
        }
        Ok(result)
    }
}

/// 校验候选文件是合法的 Pi 会话：`.jsonl` 扩展名 + 可解析的 session 头部。
///
/// 只读首行（最多 4096 字节），不把整个文件读进内存；版本号大于已知版本时仍接受，
/// 与索引层「更高版本按已知字段解析」的口径一致，但显式的 0 版本视为非法。
fn validate_pi_session_file(path: &Path) -> Result<SessionHeader> {
    if !path
        .extension()
        .is_some_and(|extension| extension == "jsonl")
    {
        return Err(CatalogError::new(
            ErrorCode::TemporarySessionFileInvalid,
            format!(
                "不是 Pi 会话文件（扩展名必须是 .jsonl）：{}",
                path.display()
            ),
        ));
    }
    let file = fs::File::open(path).map_err(|error| {
        CatalogError::io(
            ErrorCode::TemporarySessionFileInvalid,
            format!("无法读取候选会话文件：{}", path.display()),
            &error,
        )
    })?;
    let mut buffer = Vec::with_capacity(HEADER_BYTES as usize);
    file.take(HEADER_BYTES)
        .read_to_end(&mut buffer)
        .map_err(|error| {
            CatalogError::io(
                ErrorCode::TemporarySessionFileInvalid,
                format!("无法读取会话头部：{}", path.display()),
                &error,
            )
        })?;
    let end = buffer
        .iter()
        .position(|byte| *byte == b'\n')
        .unwrap_or(buffer.len());
    let header = parse_header(&buffer[..end]).ok_or_else(|| {
        CatalogError::new(
            ErrorCode::TemporarySessionFileInvalid,
            format!("首行不是合法的 Pi 会话头部：{}", path.display()),
        )
    })?;
    if header.version == 0 {
        return Err(CatalogError::new(
            ErrorCode::TemporarySessionFileInvalid,
            format!("Pi 会话格式版本非法（0）：{}", path.display()),
        ));
    }
    Ok(header)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::CatalogConfig;

    fn sandbox(label: &str) -> PathBuf {
        let unique = now_ms();
        let path = std::env::temp_dir().join(format!(
            "soxu-temporary-{label}-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("创建临时目录");
        path
    }

    fn catalog(directory: &Path) -> ProjectCatalog {
        ProjectCatalog::open_with(
            directory.join("state"),
            CatalogConfig::with_sessions_root(directory.join("sessions")),
        )
        .unwrap_or_else(|error| panic!("open catalog: {error}"))
    }

    #[test]
    fn registry_ids_are_unique_and_monotonic() {
        let mut registry = TemporaryRegistry::default();
        let mut seen = Vec::new();
        for _ in 0..MAX_TEMPORARY_SESSIONS {
            let session = registry.next_candidate();
            assert!(!seen.contains(&session), "身份不能重复：{session}");
            seen.push(session);
        }
    }

    #[test]
    fn invalid_pi_session_file_is_rejected() {
        let directory = sandbox("invalid");
        let plain = directory.join("notes.txt");
        fs::write(&plain, "x").expect("写文件");
        assert_eq!(
            validate_pi_session_file(&plain).err().map(|e| e.code()),
            Some(ErrorCode::TemporarySessionFileInvalid)
        );

        let broken = directory.join("broken.jsonl");
        fs::write(&broken, "not json\n").expect("写文件");
        assert_eq!(
            validate_pi_session_file(&broken).err().map(|e| e.code()),
            Some(ErrorCode::TemporarySessionFileInvalid)
        );

        let zero = directory.join("zero.jsonl");
        fs::write(&zero, "{\"type\":\"session\",\"version\":0}\n").expect("写文件");
        assert_eq!(
            validate_pi_session_file(&zero).err().map(|e| e.code()),
            Some(ErrorCode::TemporarySessionFileInvalid)
        );

        let ok = directory.join("ok.jsonl");
        fs::write(&ok, "{\"type\":\"session\",\"version\":3,\"id\":\"abc\"}\n").expect("写文件");
        let header = validate_pi_session_file(&ok).unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(header.version, 3);
        let _ = fs::remove_dir_all(&directory);
    }

    #[test]
    fn temporary_session_needs_a_registered_project() {
        let directory = sandbox("unknown-project");
        let mut catalog = catalog(&directory);
        assert_eq!(
            catalog
                .open_temporary_session(&ProjectId::new("prj_missing"), None)
                .err()
                .map(|error| error.code()),
            Some(ErrorCode::ProjectUnknown)
        );
        assert!(catalog.temporary_sessions().is_empty());
        let _ = fs::remove_dir_all(&directory);
    }
}
