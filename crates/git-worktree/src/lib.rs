//! # soxu-git-worktree
//!
//! SOXU 的 Git 工作树服务：枚举、创建、状态检查、diff 预览与**受确认约束**的删除。
//!
//! ## 边界
//! - 本 crate 只认 Git 事实：工作树路径、分支、脏改动、索引锁、diff。
//!   **不**知道 ProjectId / SessionId，也不写 Pi 会话文件；身份映射在桌面适配层
//!   （soxu-desktop 的 worktree.rs）与会话目录之间完成。
//! - 只读命令带 GIT_OPTIONAL_LOCKS=0，不会为了刷新索引而与正在运行的 Agent 抢锁。
//! - 破坏性操作只有两种：remove_worktree（删除非主、干净、无活跃运行时的附加工作树）
//!   与 prune（清理 git 已标记 prunable 的管理记录）。两者都必须携带与当前状态绑定的
//!   确认令牌；状态变化后令牌失效。**永不自动执行**，永不使用 --force、reset、clean。
//! - 输出有字节上限、命令有超时、文件清单有界；大 diff 会标记 truncated。
//!
//! ## 典型流程
//!
//! 1. `GitRepo::open(worktree)`：仓库句柄，解析真实工作树根。
//! 2. `repo.worktrees()`：工作树清单（主/附加、locked、prunable）。
//! 3. `repo.inspect_status(path)`：脏改动 / 冲突 / index.lock / 进行中的 merge。
//! 4. `repo.preview_diff(path, options)`：文件统计 + 有界补丁。
//! 5. `repo.create_worktree(request)`：路径边界 + 分支 + 锁检查后 git worktree add。
//! 6. `repo.plan_remove(path)` → `repo.remove_worktree(plan, token)`：只读计划 + 校验后删除。
//! 7. `repo.plan_prune()` → `repo.prune(plan, token)`：异常退出后的失效记录清理。
//!
//! 错误码契约见 [`GitErrorCode`]；实现与 docs/architecture/worktree-service.md 冲突时以文档为准。

mod diff;
mod error;
mod repo;
mod run;
mod safety;
mod status;
mod worktree;

pub use diff::{DEFAULT_MAX_BYTES, DEFAULT_MAX_FILES, DiffFile, DiffOptions, DiffPreview};
pub use error::{GitError, GitErrorCode, Result};
pub use repo::{GitRepo, is_within, normalize_path, strip_verbatim};
pub use run::{
    DEFAULT_OUTPUT_LIMIT, DEFAULT_TIMEOUT, GitCall, GitOutput, GitRunner, WRITE_TIMEOUT,
};
pub use safety::{PrunePlan, RemovalBlocker, RemovalOutcome, RemovePlan, removal_error};
pub use status::{ConflictEntry, MAX_LISTED_CHANGES, WorktreeStatus, parse_status};
pub use worktree::{BranchSource, CreateRequest, WorktreeEntry, parse_worktree_list};
