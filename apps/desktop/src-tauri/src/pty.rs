//! 终端 PTY 的桌面适配层：工作目录推导 + 守卫 + 输出事件推送。
//!
//! 业务边界：PTY 本身在 `soxu-pty-service`（不认 Tauri），这里只做三件事：
//! 1. 把 `PtyOutput` 变成前端事件（16ms 合并已经在 crate 里完成）；
//! 2. 从**会话目录**推导终端的工作目录，并校验它落在已登记项目内；
//! 3. 参数映射与错误转字符串。
//!
//! 威胁评估：终端等于一个以当前用户身份运行的 shell。因此
//! - 不新增任何 Tauri capability（命令由本进程实现，不走 WebView 的 shell 插件）；
//! - **工作目录不接受前端传参**：只从会话目录（Pi 记录的 cwd / 工作树）推导，
//!   WebView 因此无法指定任意目录；
//! - shell 只允许白名单程序（见 `ShellSpec`），参数走结构化 argv；
//! - `GH_TOKEN` 等 Runner 凭据不会传给终端（见 `SCRUBBED_ENV`）。

use std::path::PathBuf;

use serde::Serialize;
use soxu_pty_service::{OutputSink, PtyOutput, PtyRequest, PtyService};
use soxu_session_index::{ProjectCatalog, ProjectRecord, SessionId};
use tauri::Emitter;

use crate::dto::PtySessionView;
use crate::state::AppState;

/// 前端监听的终端输出事件名（与 `terminal/ptyClient.ts` 的常量一致）。
pub const PTY_OUTPUT_EVENT_NAME: &str = "soxu://pty-output";

/// 一次合并后的输出。`seq` 单调递增，供前端发现乱序。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyOutputEvent {
    pub pty_id: String,
    pub seq: u64,
    pub data: String,
}

impl From<PtyOutput> for PtyOutputEvent {
    fn from(output: PtyOutput) -> Self {
        Self {
            pty_id: output.pty_id,
            seq: output.seq,
            data: output.data,
        }
    }
}

/// 构造输出回调：把合并后的输出 emit 给前端。
///
/// 关闭的终端不会再收到事件（crate 侧已按 closed 标志拦截），所以这里不需要再过滤。
pub fn event_sink(app: tauri::AppHandle) -> OutputSink {
    std::sync::Arc::new(move |output: PtyOutput| {
        let _ = app.emit(PTY_OUTPUT_EVENT_NAME, PtyOutputEvent::from(output));
    })
}

/// 为某个会话打开终端。
pub async fn create(
    state: &AppState,
    service: &PtyService,
    session_id: &str,
    cols: Option<u16>,
    rows: Option<u16>,
    shell: Option<String>,
) -> Result<PtySessionView, String> {
    if session_id.trim().is_empty() {
        return Err("E_PTY_SESSION_REQUIRED: 终端必须绑定一个会话".to_owned());
    }
    // 只在取数据时持锁：拉起 shell 与建线程不需要会话目录的锁。
    let (projects, cwd) = {
        let catalog = state.catalog.lock().await;
        let session = SessionId::new(session_id.trim());
        let cwd = session_cwd(&catalog, &session)?;
        (catalog.projects().to_vec(), cwd)
    };
    let cwd = guard_cwd(&projects, &cwd)?;
    let info = service
        .create(PtyRequest {
            cols,
            rows,
            cwd: Some(cwd),
            shell,
        })
        .map_err(|error| error.to_string())?;
    Ok(PtySessionView {
        pty_id: info.id,
        pid: info.pid,
        cols: info.cols,
        rows: info.rows,
        shell: info.shell,
    })
}

/// 从会话目录推导终端的工作目录。
///
/// 优先用会话头部记录的 cwd（Pi 写入的事实），其次用所属工作树目录。
/// 临时会话没有 cwd 记录，因此落到它所属工作树。
fn session_cwd(catalog: &ProjectCatalog, session: &SessionId) -> Result<String, String> {
    let (worktree, recorded) = if let Some(record) = catalog.find_session(session) {
        (Some(record.worktree.clone()), record.cwd.clone())
    } else if let Some(temporary) = catalog.temporary_session(session) {
        (Some(temporary.worktree.clone()), None)
    } else {
        return Err(format!(
            "E_PTY_UNKNOWN_SESSION: 会话未登记，无法确定终端目录：{}",
            session.as_str()
        ));
    };

    if let Some(cwd) = recorded.filter(|value| !value.trim().is_empty()) {
        return Ok(cwd);
    }
    let worktree = worktree.ok_or_else(|| {
        format!(
            "E_PTY_UNKNOWN_WORKTREE: 会话没有工作树，无法确定终端目录：{}",
            session.as_str()
        )
    })?;
    catalog
        .projects()
        .iter()
        .flat_map(|project| project.worktrees.iter())
        .find(|record| record.id == worktree)
        .map(|record| record.path.clone())
        .ok_or_else(|| {
            format!(
                "E_PTY_UNKNOWN_WORKTREE: 工作树未登记，无法确定终端目录：{}",
                worktree.as_str()
            )
        })
}

/// 工作目录守卫：终端只能在已登记项目（或其工作树）内启动。
///
/// 为什么需要：shell 会在给定目录里执行用户命令。会话头部记录的 cwd 由 Pi 写入，
/// 理论上可能是任意路径（例如用户在别处手动改过 JSONL），所以落点仍要过一遍守卫。
///
/// 两侧都做 canonicalize，前缀比较按路径分量进行：`/proj2` 不会匹配 `/proj`。
pub fn guard_cwd(projects: &[ProjectRecord], requested: &str) -> Result<PathBuf, String> {
    let trimmed = requested.trim();
    if trimmed.is_empty() {
        return Err("E_PTY_CWD_REQUIRED: 终端需要工作目录".to_owned());
    }
    let candidate = std::fs::canonicalize(trimmed)
        .map_err(|error| format!("E_PTY_CWD_MISSING: 工作目录不可用（{error}）"))?;
    if !candidate.is_dir() {
        return Err("E_PTY_CWD_NOT_DIRECTORY: 工作目录不是目录".to_owned());
    }
    for project in projects {
        for root in project_roots(project) {
            if let Ok(root) = std::fs::canonicalize(&root)
                && candidate.starts_with(&root)
            {
                return Ok(candidate);
            }
        }
    }
    Err(format!(
        "E_PTY_CWD_OUTSIDE_PROJECT: 终端只能在已登记项目（含其工作树）内启动：{}",
        candidate.display()
    ))
}

/// 项目可用的工作目录根：主工作树 + 仍然存在的附加工作树。
fn project_roots(project: &ProjectRecord) -> Vec<PathBuf> {
    let mut roots = vec![PathBuf::from(&project.root)];
    for worktree in &project.worktrees {
        if !worktree.missing {
            roots.push(PathBuf::from(&worktree.path));
        }
    }
    roots
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    use soxu_session_index::{ProjectId, WorktreeId, WorktreeRecord};

    fn sandbox(name: &str) -> PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or_default();
        let dir = std::env::temp_dir().join(format!("soxu-pty-guard-{name}-{stamp}"));
        std::fs::create_dir_all(&dir).expect("创建临时目录");
        dir
    }

    fn project(root: &Path) -> ProjectRecord {
        ProjectRecord::new(ProjectId::new("prj_test"), root)
    }

    #[test]
    fn terminal_may_start_inside_a_registered_project() {
        let root = sandbox("inside");
        let nested = root.join("crates").join("app");
        std::fs::create_dir_all(&nested).expect("创建子目录");
        let projects = vec![project(&root)];
        let resolved = guard_cwd(&projects, &nested.to_string_lossy()).expect("项目内目录应放行");
        assert_eq!(resolved, std::fs::canonicalize(&nested).unwrap());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn terminal_is_rejected_outside_registered_projects() {
        let root = sandbox("outside");
        let sibling = root.join("other");
        std::fs::create_dir_all(&sibling).expect("创建兄弟目录");
        let projects = vec![project(&root.join("project"))];
        let error =
            guard_cwd(&projects, &sibling.to_string_lossy()).expect_err("项目之外的目录必须拒绝");
        assert!(error.starts_with("E_PTY_CWD_OUTSIDE_PROJECT"), "{error}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn prefix_matching_is_component_wise() {
        // proj 与 proj-other 只共享字符串前缀，不是父子目录。
        let base = sandbox("prefix");
        let project_root = base.join("proj");
        let lookalike = base.join("proj-other");
        std::fs::create_dir_all(&project_root).expect("创建项目目录");
        std::fs::create_dir_all(&lookalike).expect("创建同名前缀目录");
        let projects = vec![project(&project_root)];
        let error = guard_cwd(&projects, &lookalike.to_string_lossy())
            .expect_err("字符串前缀相同不等于在项目内");
        assert!(error.starts_with("E_PTY_CWD_OUTSIDE_PROJECT"), "{error}");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn worktrees_of_a_project_are_allowed_but_missing_ones_are_not() {
        let base = sandbox("worktree");
        let project_root = base.join("main");
        let worktree = base.join("main-worktrees").join("feature");
        std::fs::create_dir_all(&project_root).expect("创建主工作树");
        std::fs::create_dir_all(&worktree).expect("创建工作树");

        let mut record = project(&project_root);
        let mut entry = WorktreeRecord::primary(&record.id, &project_root);
        entry.id = WorktreeId::derive(&record.id, &worktree);
        entry.path = worktree.to_string_lossy().to_string();
        entry.primary = false;
        record.worktrees.push(entry);

        let projects = vec![record.clone()];
        guard_cwd(&projects, &worktree.to_string_lossy()).expect("工作树目录应放行");

        // 目录被删掉之后（missing = true）就不再放行：边界跟着磁盘事实走。
        let mut stale = record;
        stale.worktrees.last_mut().expect("有工作树").missing = true;
        let error = guard_cwd(&[stale], &worktree.to_string_lossy())
            .expect_err("已标记失效的工作树不能作为终端目录");
        assert!(error.starts_with("E_PTY_CWD_OUTSIDE_PROJECT"), "{error}");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn empty_or_missing_directories_have_explicit_errors() {
        let projects = vec![project(&sandbox("errors"))];
        let empty = guard_cwd(&projects, "   ").expect_err("空目录必须拒绝");
        assert!(empty.starts_with("E_PTY_CWD_REQUIRED"), "{empty}");

        let missing =
            guard_cwd(&projects, "/definitely/not/here/soxu").expect_err("不存在的目录必须拒绝");
        assert!(missing.starts_with("E_PTY_CWD_MISSING"), "{missing}");
    }

    #[test]
    fn no_registered_projects_means_no_terminal() {
        let dir = sandbox("no-project");
        let error = guard_cwd(&[], &dir.to_string_lossy()).expect_err("没有登记项目时不能起终端");
        assert!(error.starts_with("E_PTY_CWD_OUTSIDE_PROJECT"), "{error}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
