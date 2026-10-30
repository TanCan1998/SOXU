//! Diff 预览：文件统计 + 有界补丁正文。
//!
//! 只读、有字节预算：补丁正文超过 `max_bytes` 就截断并标记 `truncated`，
//! 绝不把整份大 diff 一次性读进内存或序列化给前端。
//! 未跟踪文件不出现在 `git diff` 里，由工作树状态的 `untracked` 列表负责提示。

use std::path::Path;

use crate::error::{GitError, GitErrorCode, Result};
use crate::repo::GitRepo;
use crate::run::GitCall;

/// 默认补丁预算：256 KiB。
pub const DEFAULT_MAX_BYTES: usize = 256 * 1024;
/// 默认最多列出的文件数。
pub const DEFAULT_MAX_FILES: usize = 200;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffOptions {
    /// `true` 比较暂存区与 HEAD；`false` 比较工作区与暂存区。
    pub staged: bool,
    pub max_files: usize,
    pub max_bytes: usize,
    /// 只看单个路径（相对工作树根）。
    pub path: Option<String>,
}

impl Default for DiffOptions {
    fn default() -> Self {
        Self {
            staged: false,
            max_files: DEFAULT_MAX_FILES,
            max_bytes: DEFAULT_MAX_BYTES,
            path: None,
        }
    }
}

impl DiffOptions {
    pub fn staged() -> Self {
        Self {
            staged: true,
            ..Self::default()
        }
    }

    pub fn with_path(mut self, path: impl Into<String>) -> Self {
        self.path = Some(path.into());
        self
    }

    pub fn with_limits(mut self, max_files: usize, max_bytes: usize) -> Self {
        self.max_files = max_files;
        self.max_bytes = max_bytes;
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffFile {
    /// `A` / `M` / `D` / `T` 等 git name-status 字母。
    pub status: String,
    pub path: String,
    pub added: Option<u64>,
    pub removed: Option<u64>,
    /// 二进制文件没有行数统计。
    pub binary: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffPreview {
    pub worktree: String,
    pub staged: bool,
    pub files: Vec<DiffFile>,
    /// 文件总数（即使 `files` 因上限被裁剪）。
    pub total_files: usize,
    pub patch: String,
    pub truncated: bool,
    pub bytes_read: usize,
}

impl GitRepo {
    /// 生成有界 diff 预览。只读，不修改索引与工作树。
    pub fn preview_diff(&self, worktree: &Path, options: &DiffOptions) -> Result<DiffPreview> {
        if !worktree.is_dir() {
            return Err(GitError::new(
                GitErrorCode::WorktreePathMissing,
                format!("工作树目录不存在：{}", worktree.display()),
            ));
        }
        let (statuses, status_truncated) = self.diff_name_status(worktree, options)?;
        let (stats, stat_truncated) = self.diff_numstat(worktree, options)?;
        let total_files = statuses.len();
        let mut truncated =
            status_truncated || stat_truncated || statuses.len() > options.max_files;

        let mut files: Vec<DiffFile> = Vec::with_capacity(statuses.len().min(options.max_files));
        for (path, status) in statuses.into_iter().take(options.max_files) {
            let (added, removed, binary) = stats
                .iter()
                .find(|entry| entry.path == path)
                .map(|entry| (entry.added, entry.removed, entry.binary))
                .unwrap_or((None, None, false));
            files.push(DiffFile {
                status,
                path,
                added,
                removed,
                binary,
            });
        }

        let patch = self.diff_patch(worktree, options)?;
        truncated |= patch.truncated;
        Ok(DiffPreview {
            worktree: crate::repo::normalize_path(worktree),
            staged: options.staged,
            files,
            total_files,
            bytes_read: patch.stdout.len(),
            patch: patch.stdout,
            truncated,
        })
    }

    fn diff_args(options: &DiffOptions, extra: &[&str]) -> Vec<String> {
        let mut args: Vec<String> = vec!["diff".to_owned()];
        args.extend(extra.iter().map(|item| (*item).to_owned()));
        if options.staged {
            args.push("--cached".to_owned());
        }
        args.push("--no-color".to_owned());
        args.push("--no-ext-diff".to_owned());
        args.push("--no-renames".to_owned());
        if let Some(path) = &options.path {
            args.push("--".to_owned());
            args.push(path.clone());
        }
        args
    }

    fn diff_name_status(
        &self,
        worktree: &Path,
        options: &DiffOptions,
    ) -> Result<(Vec<(String, String)>, bool)> {
        let args = Self::diff_args(options, &["--name-status", "-z"]);
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let output = self.runner().capture(worktree, &refs, &GitCall::read())?;
        let output = require_output(&refs, output)?;
        Ok((parse_name_status(&output.stdout), output.truncated))
    }

    /// 逐文件增删行数。更改列表（crate::changes）复用它，避免出现第二份 numstat 解析。
    pub(crate) fn diff_numstat(
        &self,
        worktree: &Path,
        options: &DiffOptions,
    ) -> Result<(Vec<DiffFile>, bool)> {
        let args = Self::diff_args(options, &["--numstat", "-z"]);
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let output = self.runner().capture(worktree, &refs, &GitCall::read())?;
        let output = require_output(&refs, output)?;
        Ok((parse_numstat(&output.stdout), output.truncated))
    }

    fn diff_patch(&self, worktree: &Path, options: &DiffOptions) -> Result<crate::run::GitOutput> {
        let args = Self::diff_args(options, &["--unified=3"]);
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let call =
            GitCall::bounded(options.max_bytes).with_timeout(std::time::Duration::from_secs(30));
        let output = self.runner().capture(worktree, &refs, &call)?;
        require_output(&refs, output)
    }
}

/// 命中字节预算而被主动终止的调用不算失败：截断标记由调用方处理。
fn require_output(args: &[&str], output: crate::run::GitOutput) -> Result<crate::run::GitOutput> {
    if output.success || output.truncated {
        return Ok(output);
    }
    let detail = output.first_stderr_line().to_owned();
    Err(GitError::new(
        GitErrorCode::CommandFailed,
        format!("git {} 执行失败", args.join(" ")),
    )
    .with_detail(detail))
}

/// `--name-status -z` 输出形如 `M\0path\0A\0other\0`。
fn parse_name_status(text: &str) -> Vec<(String, String)> {
    let mut entries = Vec::new();
    let mut records = text.split('\0').filter(|record| !record.is_empty());
    while let Some(status) = records.next() {
        let Some(path) = records.next() else {
            break;
        };
        entries.push((path.to_owned(), status.to_owned()));
    }
    entries
}

/// `--numstat -z` 输出形如 `1\t2\tpath\0`；二进制文件的行数是 `-`。
fn parse_numstat(text: &str) -> Vec<DiffFile> {
    let mut entries = Vec::new();
    for record in text.split('\0').filter(|record| !record.is_empty()) {
        let mut parts = record.splitn(3, '\t');
        let (Some(added), Some(removed), Some(path)) = (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        let binary = added == "-" || removed == "-";
        entries.push(DiffFile {
            status: String::new(),
            path: path.to_owned(),
            added: added.parse().ok(),
            removed: removed.parse().ok(),
            binary,
        });
    }
    entries
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_name_status_records() {
        let entries = parse_name_status("M\0src/a.rs\0A\0src/b.rs\0");
        assert_eq!(
            entries,
            vec![
                ("src/a.rs".to_owned(), "M".to_owned()),
                ("src/b.rs".to_owned(), "A".to_owned()),
            ]
        );
    }

    #[test]
    fn parses_numstat_and_binary_marker() {
        let entries = parse_numstat("3\t1\tsrc/a.rs\0-\t-\tlogo.png\0");
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].added, Some(3));
        assert_eq!(entries[0].removed, Some(1));
        assert!(!entries[0].binary);
        assert!(entries[1].binary);
    }

    #[test]
    fn diff_arguments_are_staged_and_bounded() {
        let args = GitRepo::diff_args(
            &DiffOptions::staged().with_path("src/a.rs"),
            &["--numstat", "-z"],
        );
        assert_eq!(
            args,
            vec![
                "diff".to_owned(),
                "--numstat".to_owned(),
                "-z".to_owned(),
                "--cached".to_owned(),
                "--no-color".to_owned(),
                "--no-ext-diff".to_owned(),
                "--no-renames".to_owned(),
                "--".to_owned(),
                "src/a.rs".to_owned(),
            ]
        );
    }
}
