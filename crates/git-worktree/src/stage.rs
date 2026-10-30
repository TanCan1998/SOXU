//! 暂存与提交（Issue #121 · TASK-029）。
//!
//! 边界：
//! - 只执行 git add 与 git commit，**不**做 amend、不 --no-verify、不自动 -a；
//! - 路径逐个校验（crate::path），全部通过才执行，避免「一半暂存、一半失败」；
//! - 提交说明必须非空且有长度上限；失败保留暂存内容，磁盘不会被回滚。

use std::path::Path;

use crate::error::{GitError, GitErrorCode, Result};
use crate::path::validate_relative_path;
use crate::repo::GitRepo;
use crate::run::GitCall;

/// 提交说明的字符上限（含正文）。git 本身没有硬限制，这里防的是误粘贴整份文件。
pub const MAX_COMMIT_MESSAGE_CHARS: usize = 4000;

/// 一次提交的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitOutcome {
    pub hash: String,
    pub short_hash: String,
    pub subject: String,
}

impl GitRepo {
    /// 暂存改动。paths 为空表示全部（git add -A）。
    /// 返回实际传给 git 的路径数（0 表示全部）。
    pub fn stage(&self, worktree: &Path, paths: &[String]) -> Result<usize> {
        let mut args: Vec<String> = vec!["add".to_owned(), "-A".to_owned()];
        if !paths.is_empty() {
            let mut validated = Vec::with_capacity(paths.len());
            for path in paths {
                validated.push(validate_relative_path(path)?);
            }
            args.push("--".to_owned());
            args.extend(validated);
        }
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let output = self.runner().capture(worktree, &refs, &GitCall::write())?;
        if !output.success {
            let detail = output.first_stderr_line().to_owned();
            let code = if detail.contains("index.lock") || detail.contains("already locked") {
                GitErrorCode::IndexLocked
            } else {
                GitErrorCode::CommandFailed
            };
            return Err(GitError::new(code, "暂存改动失败").with_detail(detail));
        }
        Ok(paths.len())
    }

    /// 提交已暂存内容。说明两侧空白会被裁剪，内部换行原样保留。
    pub fn commit(&self, worktree: &Path, message: &str) -> Result<CommitOutcome> {
        let message = message.trim();
        if message.is_empty() {
            return Err(GitError::new(
                GitErrorCode::CommitMessageInvalid,
                "提交说明不能为空",
            ));
        }
        if message.chars().count() > MAX_COMMIT_MESSAGE_CHARS {
            return Err(GitError::new(
                GitErrorCode::CommitMessageInvalid,
                format!("提交说明过长（超过 {MAX_COMMIT_MESSAGE_CHARS} 字符）"),
            ));
        }
        let output =
            self.runner()
                .capture(worktree, &["commit", "-m", message], &GitCall::write())?;
        if !output.success {
            let detail = output.first_stderr_line().to_owned();
            let code = if detail.contains("index.lock") || detail.contains("already locked") {
                GitErrorCode::IndexLocked
            } else {
                GitErrorCode::CommandFailed
            };
            return Err(GitError::new(code, "提交失败").with_detail(detail));
        }
        let hash = self.runner().read_ok(worktree, &["rev-parse", "HEAD"])?;
        let short_hash = self
            .runner()
            .read_ok(worktree, &["rev-parse", "--short", "HEAD"])?;
        Ok(CommitOutcome {
            hash: hash.text().to_owned(),
            short_hash: short_hash.text().to_owned(),
            subject: message.lines().next().unwrap_or("").to_owned(),
        })
    }
}
