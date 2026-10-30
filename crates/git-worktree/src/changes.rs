//! 更改列表与单文件 diff（Issue #121 · TASK-029）。
//!
//! 两条规则：
//! 1. 徽章与计数来自同一份 porcelain 记录（crate::status::parse_porcelain），
//!    不在这里重新解析 git status 文本；
//! 2. 行数来自 git diff --numstat：未暂存优先、其次已暂存。同一文件两处都有改动时
//!    用户关心的是「工作区相对 HEAD 还差什么」，而未暂存那一份正是下一次 git add 的内容。
//!
//! 补丁正文一律原样透传 git 输出（--no-color --no-ext-diff --no-renames），
//! 只按字节预算截断，保证前端渲染与 git CLI 看到的完全一致。

use std::collections::HashMap;
use std::path::Path;

use crate::diff::{DiffFile, DiffOptions};
use crate::error::Result;
use crate::path::validate_relative_path;
use crate::repo::GitRepo;

/// 单文件 diff 的默认字节预算：512 KiB（抽屉里只看一个文件，比整棵树预览宽松）。
pub const MAX_FILE_DIFF_BYTES: usize = 512 * 1024;

/// 更改列表里的一个文件。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChangeFile {
    pub path: String,
    /// 徽章字母：A 新增（含未跟踪）、M 修改、D 删除、U 冲突。
    pub status: String,
    pub staged: bool,
    pub unstaged: bool,
    pub untracked: bool,
    pub conflict: bool,
    /// 增删行数；二进制文件与未跟踪文件没有行数统计。
    pub added: Option<u64>,
    pub removed: Option<u64>,
    pub binary: bool,
}

/// 更改列表视图：分支/上游/领先落后 + 逐文件徽章与行数。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChangesView {
    /// 规范化后的工作树路径。
    pub worktree: String,
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: usize,
    pub behind: usize,
    pub files: Vec<ChangeFile>,
    /// 文件总数（files 因上限被裁剪时仍然完整）。
    pub total_files: usize,
    pub truncated: bool,
    pub index_lock: Option<String>,
    pub operation: Option<String>,
}

/// 单文件 diff 视图。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileDiffView {
    pub path: String,
    pub staged: bool,
    /// git diff 的原始补丁正文（--no-color）。
    pub patch: String,
    pub truncated: bool,
    pub bytes_read: usize,
    pub added: Option<u64>,
    pub removed: Option<u64>,
    pub binary: bool,
}

impl GitRepo {
    /// 读取更改列表。只读；GIT_OPTIONAL_LOCKS=0，不抢索引锁。
    pub fn changes(&self, worktree: &Path) -> Result<ChangesView> {
        let status = self.inspect_status(worktree)?;
        let (unstaged, unstaged_truncated) =
            self.diff_numstat(worktree, &DiffOptions::default())?;
        let (staged, staged_truncated) = self.diff_numstat(worktree, &DiffOptions::staged())?;
        let unstaged_by_path = by_path(unstaged);
        let staged_by_path = by_path(staged);

        let files: Vec<ChangeFile> = status
            .entries
            .iter()
            .map(|entry| {
                let stats = unstaged_by_path
                    .get(&entry.path)
                    .or_else(|| staged_by_path.get(&entry.path));
                ChangeFile {
                    path: entry.path.clone(),
                    status: entry.badge().to_owned(),
                    staged: entry.is_staged(),
                    unstaged: entry.is_unstaged(),
                    untracked: entry.is_untracked(),
                    conflict: entry.is_conflict(),
                    added: stats.and_then(|file| file.added),
                    removed: stats.and_then(|file| file.removed),
                    binary: stats.is_some_and(|file| file.binary),
                }
            })
            .collect();

        Ok(ChangesView {
            worktree: status.worktree,
            branch: status.branch,
            upstream: status.upstream,
            ahead: status.ahead,
            behind: status.behind,
            files,
            total_files: status.entry_count,
            truncated: status.truncated || unstaged_truncated || staged_truncated,
            index_lock: status.index_lock,
            operation: status.operation,
        })
    }

    /// 单个文件的补丁。路径必须相对仓库根目录（见 crate::path）。
    pub fn file_diff(
        &self,
        worktree: &Path,
        path: &str,
        staged: bool,
        max_bytes: usize,
    ) -> Result<FileDiffView> {
        let path = validate_relative_path(path)?;
        let options = DiffOptions {
            staged,
            ..DiffOptions::default()
        }
        .with_path(path.clone())
        .with_limits(1, max_bytes);
        let preview = self.preview_diff(worktree, &options)?;
        let stats = preview.files.first();
        Ok(FileDiffView {
            path,
            staged,
            patch: preview.patch,
            truncated: preview.truncated,
            bytes_read: preview.bytes_read,
            added: stats.and_then(|file| file.added),
            removed: stats.and_then(|file| file.removed),
            binary: stats.is_some_and(|file| file.binary),
        })
    }
}

fn by_path(files: Vec<DiffFile>) -> HashMap<String, DiffFile> {
    files
        .into_iter()
        .map(|file| (file.path.clone(), file))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::GitErrorCode;

    /// 单文件 diff 的路径守卫必须在到达 git 之前就拒绝穿越路径。
    #[test]
    fn rejects_paths_outside_the_worktree() {
        let error = validate_relative_path("../outside.txt").expect_err("穿越路径");
        assert_eq!(error.code(), GitErrorCode::PathOutsideRoot);
    }
}
