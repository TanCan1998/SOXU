//! 项目 / Worktree / Session 目录与运行时归属。
//!
//! 目录只保存引用与索引元数据：不移动、不删除用户的目录和会话文件，也不写回 JSONL。

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::entry::EntryPage;
use crate::error::{CatalogError, ErrorCode, Result};
use crate::identity::{
    ProjectId, RuntimeId, RuntimeLink, SessionId, SessionIdentity, WorktreeId, normalize_path,
    now_ms, strip_verbatim,
};
use crate::index::{SessionLog, SessionPage};
use crate::records::{
    CatalogSnapshot, ProjectRecord, SessionRecord, SessionState, WorktreeRecord,
    default_sessions_root, file_key, project_sessions_dir_name,
};
use crate::snapshot::{CATALOG_SCHEMA_VERSION, RebuildReason, SnapshotLoad};
use crate::store;

/// 目录配置：Pi 会话根目录通常来自默认布局，也可显式覆盖。
#[derive(Debug, Clone, Default)]
pub struct CatalogConfig {
    pub sessions_root: Option<PathBuf>,
}

impl CatalogConfig {
    pub fn with_default_sessions_root() -> Self {
        Self {
            sessions_root: default_sessions_root(),
        }
    }

    pub fn with_sessions_root(root: impl Into<PathBuf>) -> Self {
        Self {
            sessions_root: Some(root.into()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Relocation {
    pub session: SessionId,
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RebuildNote {
    pub session: SessionId,
    pub reason: RebuildReason,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct SyncReport {
    pub scanned_files: usize,
    pub added: usize,
    pub updated: usize,
    pub unchanged: usize,
    pub relocated: Vec<Relocation>,
    pub duplicates: Vec<String>,
    pub missing: Vec<String>,
    pub missing_dirs: Vec<String>,
    pub rebuilds: Vec<RebuildNote>,
    /// 会话头部 cwd 与工作树路径不一致的提示（不阻断索引，供人工核对）。
    pub cwd_mismatch: Vec<String>,
    pub warnings: usize,
}

struct Upsert {
    record: SessionRecord,
    report: crate::snapshot::ScanReport,
    load_accepted: bool,
    is_new: bool,
    relocation: Option<Relocation>,
    duplicate: Option<String>,
}

pub struct ProjectCatalog {
    store: PathBuf,
    index_dir: PathBuf,
    sessions_root: Option<PathBuf>,
    snapshot: CatalogSnapshot,
    dirty: bool,
    load_warning: bool,
}

impl ProjectCatalog {
    /// 打开（或新建）状态目录下的目录元数据。
    pub fn open(state_dir: impl AsRef<Path>) -> Result<Self> {
        Self::open_with(state_dir, CatalogConfig::with_default_sessions_root())
    }

    pub fn open_with(state_dir: impl AsRef<Path>, config: CatalogConfig) -> Result<Self> {
        let directory = state_dir.as_ref().to_path_buf();
        let store_path = directory.join("catalog.json");
        let mut load_warning = false;
        let snapshot = match store::read_json::<CatalogSnapshot>(&store_path) {
            Ok(Some(snapshot)) if snapshot.schema == CATALOG_SCHEMA_VERSION => snapshot,
            Ok(Some(_)) => {
                load_warning = true;
                CatalogSnapshot::default()
            }
            Ok(None) => CatalogSnapshot::default(),
            // 元数据损坏不是致命错误：重建空目录并继续，磁盘上的会话文件不受影响。
            Err(_) => {
                load_warning = true;
                CatalogSnapshot::default()
            }
        };
        Ok(Self {
            store: store_path,
            index_dir: directory.join("indexes"),
            sessions_root: config.sessions_root,
            snapshot,
            dirty: load_warning,
            load_warning,
        })
    }

    pub fn load_warning(&self) -> bool {
        self.load_warning
    }

    pub fn is_dirty(&self) -> bool {
        self.dirty
    }

    pub fn sessions_root(&self) -> Option<&Path> {
        self.sessions_root.as_deref()
    }

    pub fn projects(&self) -> &[ProjectRecord] {
        &self.snapshot.projects
    }

    pub fn project(&self, id: &ProjectId) -> Option<&ProjectRecord> {
        self.snapshot
            .projects
            .iter()
            .find(|project| &project.id == id)
    }

    /// 注册项目根目录。重复注册是幂等的；不会创建或删除任何目录。
    pub fn register_project(&mut self, root: &Path) -> Result<ProjectRecord> {
        let canonical = fs::canonicalize(root).map_err(|error| {
            CatalogError::io(
                ErrorCode::ProjectRootMissing,
                format!("项目根目录不可用：{}", root.display()),
                &error,
            )
        })?;
        let canonical = strip_verbatim(&canonical);
        if !canonical.is_dir() {
            return Err(CatalogError::new(
                ErrorCode::ProjectRootNotDirectory,
                format!("项目根不是目录：{}", canonical.display()),
            ));
        }
        let id = ProjectId::derive(&canonical);
        if let Some(existing) = self.project(&id) {
            return Ok(existing.clone());
        }
        let record = ProjectRecord::new(id, &canonical);
        self.snapshot.projects.push(record.clone());
        self.touch();
        Ok(record)
    }

    /// 只移除引用；磁盘目录与会话文件保持原样。
    pub fn remove_project(&mut self, project: &ProjectId) -> Result<ProjectRecord> {
        let position = self
            .snapshot
            .projects
            .iter()
            .position(|record| &record.id == project)
            .ok_or_else(|| {
                CatalogError::new(ErrorCode::ProjectUnknown, format!("项目未注册：{project}"))
            })?;
        let removed = self.snapshot.projects.remove(position);
        self.touch();
        Ok(removed)
    }

    pub fn add_worktree(
        &mut self,
        project: &ProjectId,
        path: &Path,
        branch: Option<&str>,
    ) -> Result<WorktreeRecord> {
        if !path.is_dir() {
            return Err(CatalogError::new(
                ErrorCode::WorktreePathMissing,
                format!("工作树目录不存在：{}", path.display()),
            ));
        }
        // 与项目根同样去掉 verbatim 前缀，保证主工作树与附加工作树的 ID 派生口径一致。
        let canonical = std::fs::canonicalize(path)
            .map_err(|error| {
                CatalogError::io(
                    ErrorCode::WorktreePathMissing,
                    format!("工作树目录不可用：{}", path.display()),
                    &error,
                )
            })
            .map(|value| strip_verbatim(&value))?;
        let path = canonical.as_path();
        let parent = self.project(project).ok_or_else(|| {
            CatalogError::new(ErrorCode::ProjectUnknown, format!("项目未注册：{project}"))
        })?;
        let id = WorktreeId::derive(project, path);
        if let Some(existing) = parent.worktree(&id) {
            return Ok(existing.clone());
        }
        let record = WorktreeRecord {
            id,
            project: project.clone(),
            path: path.to_string_lossy().to_string(),
            branch: branch.map(str::to_string),
            primary: false,
            missing: false,
            created_at_ms: now_ms(),
        };
        let parent = self.project_mut(project).ok_or_else(|| {
            CatalogError::new(ErrorCode::ProjectUnknown, format!("项目未注册：{project}"))
        })?;
        parent.worktrees.push(record.clone());
        parent.updated_at_ms = now_ms();
        self.touch();
        Ok(record)
    }

    /// 用 Git 服务枚举的结果回填已登记工作树的分支与可用状态。
    ///
    /// 只更新引用：不创建目录、不删除会话记录。Git 侧发现的新工作树先用
    /// [`Self::add_worktree`] 登记，再由本方法补分支信息。
    pub fn update_worktree(
        &mut self,
        project: &ProjectId,
        worktree: &WorktreeId,
        branch: Option<&str>,
        missing: bool,
    ) -> Result<WorktreeRecord> {
        let parent = self.project_mut(project).ok_or_else(|| {
            CatalogError::new(ErrorCode::ProjectUnknown, format!("项目未注册：{project}"))
        })?;
        let record = parent
            .worktrees
            .iter_mut()
            .find(|candidate| &candidate.id == worktree)
            .ok_or_else(|| {
                CatalogError::new(
                    ErrorCode::WorktreeUnknown,
                    format!("工作树未登记：{worktree}"),
                )
            })?;
        if let Some(branch) = branch {
            record.branch = Some(branch.to_string());
        }
        record.missing = missing;
        parent.updated_at_ms = now_ms();
        let updated = record.clone();
        self.touch();
        Ok(updated)
    }

    /// 某个工作树下的全部会话记录（跨项目查找，工作树身份本身带项目前缀）。
    pub fn sessions_in_worktree(&self, worktree: &WorktreeId) -> Vec<&SessionRecord> {
        self.snapshot
            .projects
            .iter()
            .flat_map(|project| project.sessions.iter())
            .filter(|session| &session.worktree == worktree)
            .collect()
    }

    pub fn sessions(&self, project: &ProjectId) -> Option<&[SessionRecord]> {
        self.project(project)
            .map(|record| record.sessions.as_slice())
    }

    pub fn sessions_root_required(&self) -> Result<&Path> {
        self.sessions_root.as_deref().ok_or_else(|| {
            CatalogError::new(
                ErrorCode::SessionsRootUnavailable,
                "未配置 Pi 会话根目录，可显式 attach 会话文件或设置 SOXU_PI_SESSIONS_DIR",
            )
        })
    }

    /// 扫描项目所有工作树对应的 Pi 会话目录，增量更新索引。
    pub fn sync(&mut self, project: &ProjectId) -> Result<SyncReport> {
        let sessions_root = self.sessions_root_required()?.to_path_buf();
        let worktrees: Vec<WorktreeRecord> = self
            .project(project)
            .ok_or_else(|| {
                CatalogError::new(ErrorCode::ProjectUnknown, format!("项目未注册：{project}"))
            })?
            .worktrees
            .clone();
        let mut report = SyncReport::default();
        for worktree in worktrees {
            let directory =
                sessions_root.join(project_sessions_dir_name(Path::new(&worktree.path)));
            let entries = match fs::read_dir(&directory) {
                Ok(entries) => entries,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    report
                        .missing_dirs
                        .push(directory.to_string_lossy().to_string());
                    continue;
                }
                Err(error) => {
                    return Err(CatalogError::io(
                        ErrorCode::IoFailure,
                        format!("无法读取会话目录：{}", directory.display()),
                        &error,
                    ));
                }
            };
            let mut paths: Vec<PathBuf> = Vec::new();
            for entry in entries {
                let entry = entry.map_err(|error| {
                    CatalogError::io(
                        ErrorCode::IoFailure,
                        format!("无法读取会话目录项：{}", directory.display()),
                        &error,
                    )
                })?;
                let path = entry.path();
                if path
                    .extension()
                    .is_some_and(|extension| extension == "jsonl")
                {
                    paths.push(path);
                }
            }
            // 排序保证多平台扫描顺序稳定，报告可复现。
            paths.sort();
            for path in paths {
                report.scanned_files += 1;
                match self.upsert_session(project, &worktree.id, &path) {
                    Ok(upsert) => {
                        let unchanged = upsert.load_accepted
                            && upsert.report.appended_entries == 0
                            && upsert.report.rebuild.is_none();
                        if upsert.relocation.is_none() && upsert.duplicate.is_none() {
                            if upsert.is_new {
                                report.added += 1;
                            } else if unchanged {
                                report.unchanged += 1;
                            } else {
                                report.updated += 1;
                            }
                        }
                        if let Some(relocation) = upsert.relocation {
                            report.relocated.push(relocation);
                        }
                        if let Some(duplicate) = upsert.duplicate {
                            report.duplicates.push(duplicate);
                        }
                        if let Some(reason) = upsert.report.rebuild {
                            report.rebuilds.push(RebuildNote {
                                session: upsert.record.id.clone(),
                                reason,
                            });
                        }
                        report.warnings += upsert.report.new_warnings
                            + usize::try_from(upsert.report.corrupt_lines).unwrap_or(0);
                        if let Some(cwd) = upsert.record.cwd.as_deref() {
                            let cwd_path = Path::new(cwd);
                            if normalize_path(cwd_path) != normalize_path(Path::new(&worktree.path))
                            {
                                report.cwd_mismatch.push(format!(
                                    "{}: cwd {cwd} 与工作树 {} 不一致",
                                    upsert.record.id, worktree.path
                                ));
                            }
                        }
                    }
                    Err(error) if error.code() == ErrorCode::SessionFileMissing => {
                        // 扫描期间文件被删除：跳过，不放大成整个项目失败。
                        continue;
                    }
                    Err(error) => return Err(error),
                }
            }
        }
        self.mark_missing(project, &mut report);
        self.touch();
        Ok(report)
    }

    /// 显式登记一个会话文件（会话不在 Pi 默认布局下时使用）。
    pub fn attach_session_file(
        &mut self,
        project: &ProjectId,
        worktree: &WorktreeId,
        file: &Path,
    ) -> Result<SessionRecord> {
        let known = self
            .project(project)
            .ok_or_else(|| {
                CatalogError::new(ErrorCode::ProjectUnknown, format!("项目未注册：{project}"))
            })?
            .worktree(worktree)
            .ok_or_else(|| {
                CatalogError::new(
                    ErrorCode::WorktreeUnknown,
                    format!("工作树未注册：{worktree}"),
                )
            })?;
        let worktree_id = known.id.clone();
        let upsert = self.upsert_session(project, &worktree_id, file)?;
        if let Some(duplicate) = upsert.duplicate {
            return Err(CatalogError::new(ErrorCode::SessionPathConflict, duplicate));
        }
        Ok(upsert.record)
    }

    pub fn identity(&self, session: &SessionId) -> Result<SessionIdentity> {
        for project in &self.snapshot.projects {
            if let Some(record) = project.session(session) {
                return Ok(SessionIdentity {
                    project: project.id.clone(),
                    worktree: record.worktree.clone(),
                    session: record.id.clone(),
                    runtime: record.runtime.clone(),
                });
            }
        }
        Err(CatalogError::new(
            ErrorCode::SessionUnknown,
            format!("会话未登记：{session}"),
        ))
    }

    /// 声明某个会话的可写运行时。已有其他 runtime 持有时拒绝，避免双写同一 JSONL。
    pub fn claim_writable(&mut self, session: &SessionId, runtime: &str) -> Result<RuntimeLink> {
        let runtime = RuntimeId::new(runtime);
        let watermark = {
            let record = self.session_mut(session).ok_or_else(|| {
                CatalogError::new(ErrorCode::SessionUnknown, format!("会话未登记：{session}"))
            })?;
            if let Some(link) = &record.runtime {
                if link.runtime == runtime {
                    return Ok(link.clone());
                }
                return Err(CatalogError::new(
                    ErrorCode::SessionAlreadyOwned,
                    format!("会话 {session} 仍由 {} 持有", link.runtime),
                ));
            }
            record.generation_watermark = record.generation_watermark.max(1);
            record.generation_watermark
        };
        let link = RuntimeLink {
            session: session.clone(),
            runtime,
            generation: watermark,
            attached_at_ms: now_ms(),
        };
        let record = self.session_mut(session).ok_or_else(|| {
            CatalogError::new(ErrorCode::SessionUnknown, format!("会话未登记：{session}"))
        })?;
        record.runtime = Some(link.clone());
        record.updated_at_ms = now_ms();
        self.touch();
        Ok(link)
    }

    /// 应用启动时清理上一进程遗留的运行时挂载；水位继续递增，旧事件仍被丢弃。
    pub fn release_stale_runtime(&mut self, session: &SessionId) -> Result<Option<RuntimeLink>> {
        let record = self.session_mut(session).ok_or_else(|| {
            CatalogError::new(ErrorCode::SessionUnknown, format!("会话未登记：{session}"))
        })?;
        let previous = record.runtime.take();
        if let Some(link) = &previous {
            record.generation_watermark = link.next_generation();
        }
        record.updated_at_ms = now_ms();
        self.touch();
        Ok(previous)
    }

    /// 释放运行时并抬高水位，使下一代的迟到事件被丢弃。
    pub fn release(&mut self, session: &SessionId, runtime: &str) -> Result<()> {
        let runtime = RuntimeId::new(runtime);
        let record = self.session_mut(session).ok_or_else(|| {
            CatalogError::new(ErrorCode::SessionUnknown, format!("会话未登记：{session}"))
        })?;
        match &record.runtime {
            Some(link) if link.runtime == runtime => {
                record.generation_watermark = link.generation.saturating_add(1);
                record.runtime = None;
                record.updated_at_ms = now_ms();
                self.touch();
                Ok(())
            }
            _ => Err(CatalogError::new(
                ErrorCode::SessionRuntimeUnknown,
                format!("会话 {session} 没有由 {runtime} 持有的运行时"),
            )),
        }
    }

    /// 事件是否仍属于当前运行时（按 generation 丢弃迟到事件）。
    pub fn event_allowed(&self, session: &SessionId, runtime: &str, generation: u64) -> bool {
        let runtime = RuntimeId::new(runtime);
        self.find_session(session)
            .and_then(|record| record.runtime.as_ref())
            .is_some_and(|link| link.accepts(session, &runtime, generation))
    }

    pub fn guard_event(&self, session: &SessionId, runtime: &str, generation: u64) -> Result<()> {
        if self.event_allowed(session, runtime, generation) {
            return Ok(());
        }
        Err(CatalogError::new(
            ErrorCode::StaleRuntimeGeneration,
            format!("会话 {session} 的 {runtime}#{generation} 事件已过期"),
        ))
    }

    pub fn save(&mut self) -> Result<()> {
        self.snapshot.schema = CATALOG_SCHEMA_VERSION;
        self.snapshot.updated_at_ms = now_ms();
        store::write_json(&self.store, &self.snapshot)?;
        self.dirty = false;
        Ok(())
    }

    pub fn save_if_dirty(&mut self) -> Result<bool> {
        if !self.dirty {
            return Ok(false);
        }
        self.save()?;
        Ok(true)
    }

    /// 索引快照的落盘路径：缓存键绑定文件路径，与 SessionId 解耦，
    /// 因此文件重命名后旧快照自然失效并由快照自校验重建。
    fn index_snapshot_path(&self, file: &Path) -> PathBuf {
        self.index_dir.join(format!("{:016x}.json", file_key(file)))
    }

    /// 打开会话的只读索引视图，优先复用上次落盘的快照。
    ///
    /// 不在这里触发扫描：调用方决定何时 refresh，便于把「打开」和「增量刷新」分离。
    /// 返回的 SnapshotLoad 说明快照是否被接受；被拒绝时下一次 refresh 会重建并给出原因。
    pub fn open_session_log(&self, session: &SessionId) -> Result<(SessionLog, SnapshotLoad)> {
        let record = self.find_session(session).ok_or_else(|| {
            CatalogError::new(ErrorCode::SessionUnknown, format!("会话未登记：{session}"))
        })?;
        let file = PathBuf::from(&record.file);
        let snapshot_path = self.index_snapshot_path(&file);
        match SessionLog::load_snapshot(&snapshot_path)? {
            Some(snapshot) => Ok(SessionLog::from_snapshot(&file, snapshot)),
            None => Ok((SessionLog::new(&file), SnapshotLoad::fresh())),
        }
    }

    /// 按页读取会话条目：增量刷新索引后，只读取本页字节预算内的内容。
    ///
    /// 接收 &mut self：目录是索引缓存目录的唯一 owner（与 sync/save 相同的所有权模型），
    /// 因此同一时刻只有一个写者，不需要在此层加锁。只读的并发分页请用
    /// `open_session_log` + `SessionLog::page`。
    ///
    /// 仅当有新增条目或发生重建时才回写快照，纯翻页不会重复落盘。
    pub fn page_session(&mut self, session: &SessionId, page: SessionPage) -> Result<EntryPage> {
        let (mut log, _load) = self.open_session_log(session)?;
        let report = log.refresh()?;
        let snapshot_path = self.index_snapshot_path(log.path());
        let result = log.page(page)?;
        if report.appended_entries > 0 || report.rebuild.is_some() {
            log.save_if_dirty(&snapshot_path)?;
        }
        Ok(result)
    }

    pub fn find_session(&self, id: &SessionId) -> Option<&SessionRecord> {
        self.snapshot
            .projects
            .iter()
            .flat_map(|project| project.sessions.iter())
            .find(|record| &record.id == id)
    }

    fn session_mut(&mut self, id: &SessionId) -> Option<&mut SessionRecord> {
        self.snapshot
            .projects
            .iter_mut()
            .flat_map(|project| project.sessions.iter_mut())
            .find(|record| &record.id == id)
    }

    fn project_mut(&mut self, id: &ProjectId) -> Option<&mut ProjectRecord> {
        self.snapshot
            .projects
            .iter_mut()
            .find(|project| &project.id == id)
    }

    fn touch(&mut self) {
        self.dirty = true;
        self.snapshot.updated_at_ms = now_ms();
    }

    fn find_session_by_file(&self, project: &ProjectId, file: &Path) -> Option<&SessionRecord> {
        let normalized = normalize_path(file);
        self.project(project)?
            .sessions
            .iter()
            .find(|record| normalize_path(Path::new(&record.file)) == normalized)
    }

    fn find_relocatable(
        &self,
        project: &ProjectId,
        fingerprint: u64,
        file: &Path,
    ) -> Option<&SessionRecord> {
        if fingerprint == 0 {
            return None;
        }
        let normalized = normalize_path(file);
        self.project(project)?.sessions.iter().find(|record| {
            record.head_fingerprint == fingerprint
                && normalize_path(Path::new(&record.file)) != normalized
                && !Path::new(&record.file).exists()
        })
    }

    fn upsert_session(
        &mut self,
        project: &ProjectId,
        worktree: &WorktreeId,
        file: &Path,
    ) -> Result<Upsert> {
        let key = file_key(file);
        let snapshot_path = self.index_dir.join(format!("{key:016x}.json"));
        let (mut log, load) = match SessionLog::load_snapshot(&snapshot_path)? {
            Some(snapshot) => SessionLog::from_snapshot(file, snapshot),
            None => (
                SessionLog::new(file),
                crate::snapshot::SnapshotLoad::fresh(),
            ),
        };
        let report = log.refresh()?;
        let header = log.header().cloned();
        let display = file.to_string_lossy().to_string();

        let known_here = self
            .find_session_by_file(project, file)
            .map(|record| record.id.clone());
        let session_id = if let Some(id) = known_here {
            id
        } else if let Some(raw) = header.as_ref().and_then(|value| value.id.as_deref()) {
            SessionId::from_header_id(raw)
        } else if let Some(relocated) = self.find_relocatable(project, log.head_fingerprint(), file)
        {
            relocated.id.clone()
        } else {
            SessionId::from_legacy_fingerprint(log.head_fingerprint())
        };

        let mut relocation = None;
        let mut duplicate = None;
        let normalized = normalize_path(file);
        if let Some(existing) = self.find_session(&session_id) {
            let existing_path = normalize_path(Path::new(&existing.file));
            if existing_path != normalized {
                let live =
                    existing.state == SessionState::Present && Path::new(&existing.file).exists();
                if live {
                    duplicate = Some(format!(
                        "会话 {session_id} 同时存在于 {} 与 {display}，已保留先登记的文件",
                        existing.file
                    ));
                } else {
                    relocation = Some(Relocation {
                        session: session_id.clone(),
                        from: existing.file.clone(),
                        to: display.clone(),
                    });
                }
            }
        }

        let previous = self.find_session(&session_id).cloned();
        let is_new = previous.is_none();
        let mut record = SessionRecord::new(session_id.clone(), worktree.clone(), file);
        record.header_version = header.as_ref().map(|value| value.version);
        record.cwd = header.as_ref().and_then(|value| value.cwd.clone());
        record.head_fingerprint = log.head_fingerprint();
        record.entry_count = report.total_entries;
        record.indexed_bytes = log.indexed_bytes();
        record.file_len = report.file_len;
        record.state = SessionState::Present;
        if let Some(previous) = previous {
            // 运行时归属与水印不能因为一次 sync 丢失，否则迟到事件过滤会失效。
            record.runtime = previous.runtime;
            record.generation_watermark = previous.generation_watermark;
            if duplicate.is_some() {
                record.state = previous.state;
            }
        }

        if duplicate.is_none() {
            self.store_session(project, record.clone(), relocation.is_some());
            if self.index_dir.is_dir() || self.index_dir.parent().is_some() {
                log.save_if_dirty(&snapshot_path)?;
            }
        }
        self.touch();
        Ok(Upsert {
            record,
            report,
            load_accepted: load.accepted,
            is_new,
            relocation,
            duplicate,
        })
    }

    fn store_session(&mut self, project: &ProjectId, record: SessionRecord, replace_path: bool) {
        let target = match self.project_mut(project) {
            Some(project_record) => project_record,
            None => return,
        };
        if let Some(existing) = target
            .sessions
            .iter_mut()
            .find(|candidate| candidate.id == record.id)
        {
            *existing = record;
            target.updated_at_ms = now_ms();
            return;
        }
        // 迁移：同一 SessionId 在别的项目里留有旧记录时也要清掉，避免出现两个落点。
        if replace_path {
            for project_record in &mut self.snapshot.projects {
                project_record
                    .sessions
                    .retain(|session| session.id != record.id);
            }
        }
        if let Some(project_record) = self.project_mut(project) {
            project_record.sessions.push(record);
            project_record.updated_at_ms = now_ms();
        }
    }

    fn mark_missing(&mut self, project: &ProjectId, report: &mut SyncReport) {
        let Some(record) = self.project_mut(project) else {
            return;
        };
        for session in &mut record.sessions {
            if !Path::new(&session.file).exists() {
                if session.state != SessionState::Missing {
                    session.state = SessionState::Missing;
                    session.updated_at_ms = now_ms();
                    report
                        .missing
                        .push(format!("{} ({})", session.id, session.file));
                }
            } else if session.state == SessionState::Missing {
                session.state = SessionState::Present;
            }
        }
        record.updated_at_ms = now_ms();
    }
}
