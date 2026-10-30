//! 推送与拉取（Issue #121 · TASK-029）。
//!
//! 这是本 crate 里唯一会访问网络的路径，规则刻意收得很紧：
//! - 只用 git push / git pull --ff-only，**永不** --force、永不 rebase、永不隐式合并；
//!   需要合并时由用户在终端自行处理（失败信息里会说明原因）；
//! - GIT_TERMINAL_PROMPT=0（GitRunner 统一设置），没有凭据时立刻失败而不是挂在终端；
//! - 网络超时 120s，失败返回稳定错误码 + git 的第一行 stderr，UI 直接展示；
//! - 结束后重新读取 status，领先/落后计数与列表用同一份事实。

use std::path::Path;
use std::time::Duration;

use crate::error::{GitError, GitErrorCode, Result};
use crate::repo::GitRepo;
use crate::run::GitCall;

/// 网络操作超时：比本地写操作短一些，避免抽屉按钮长时间无响应。
pub const NETWORK_TIMEOUT: Duration = Duration::from_secs(120);
/// 回传给 UI 的 git 输出上限（字符）：只用于提示，不用于解析。
pub const MAX_REMOTE_OUTPUT_CHARS: usize = 4000;

/// 推送/拉取的结果：分支与领先落后计数都是**操作之后**重新读取的事实。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteOutcome {
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: usize,
    pub behind: usize,
    /// git 的 stdout（已裁剪），失败时不返回。
    pub output: String,
}

impl GitRepo {
    /// git push：把当前分支推到已配置的上游分支。
    pub fn push(&self, worktree: &Path) -> Result<RemoteOutcome> {
        self.remote(worktree, "推送", &["push"])
    }

    /// git pull --ff-only：只做快进，绝不产生隐式合并提交。
    pub fn pull(&self, worktree: &Path) -> Result<RemoteOutcome> {
        self.remote(worktree, "拉取", &["pull", "--ff-only"])
    }

    fn remote(&self, worktree: &Path, label: &str, args: &[&str]) -> Result<RemoteOutcome> {
        let before = self.inspect_status(worktree)?;
        if let Some(operation) = &before.operation {
            return Err(GitError::new(
                GitErrorCode::OperationInProgress,
                format!("{label}前请先完成进行中的 Git 操作（{operation}）"),
            ));
        }
        if before.branch.is_none() {
            return Err(GitError::new(
                GitErrorCode::BranchInvalid,
                format!("{label}需要先检出一个分支（当前是 detached HEAD）"),
            ));
        }
        let call = GitCall::write().with_timeout(NETWORK_TIMEOUT);
        let output = self.runner().capture(worktree, args, &call)?;
        if !output.success {
            let detail = output.first_stderr_line().to_owned();
            let code = if detail.contains("index.lock") || detail.contains("already locked") {
                GitErrorCode::IndexLocked
            } else {
                GitErrorCode::CommandFailed
            };
            return Err(GitError::new(
                code,
                format!("{label}失败：请检查网络、凭据与分支上游设置（未执行任何强制覆盖）"),
            )
            .with_detail(detail));
        }
        let after = self.inspect_status(worktree)?;
        Ok(RemoteOutcome {
            branch: after.branch,
            upstream: after.upstream,
            ahead: after.ahead,
            behind: after.behind,
            output: clip(&output.stdout, MAX_REMOTE_OUTPUT_CHARS),
        })
    }
}

/// 按字符（不是字节）裁剪，避免把多字节字符切坏。
fn clip(text: &str, max_chars: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= max_chars {
        return trimmed.to_owned();
    }
    let mut clipped: String = trimmed.chars().take(max_chars).collect();
    clipped.push('…');
    clipped
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clip_keeps_character_boundaries() {
        assert_eq!(clip("  推送成功  ", 10), "推送成功");
        let clipped = clip(&"改动".repeat(10), 4);
        assert_eq!(clipped, "改动改动…");
        assert_eq!(clipped.chars().count(), 5);
    }
}
