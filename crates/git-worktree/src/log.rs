//! 提交历史与分支清单（Issue #121 · TASK-029）。
//!
//! 只读、有界：条目数与字符数都有上限，日志输出不会被整份读进内存。
//! 字段分隔用 ASCII 单元分隔符（\x1f），记录分隔用换行——git 的 subject 一定不含换行，
//! 因此不需要处理多行记录，也不会被 subject 里的制表符打乱分列。

use std::path::Path;

use crate::error::{GitError, GitErrorCode, Result};
use crate::repo::GitRepo;
use crate::run::GitCall;

/// 一次最多返回多少条提交；再多对抽屉没有意义，也会浪费 IPC。
pub const MAX_LOG_ENTRIES: usize = 200;
/// 默认返回条数。
pub const DEFAULT_LOG_ENTRIES: usize = 50;
/// 一次最多返回多少个本地分支。
pub const MAX_BRANCHES: usize = 500;

/// 一条提交。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogEntry {
    pub hash: String,
    pub short_hash: String,
    pub author: String,
    /// ISO-8601 作者时间（%aI），由前端按本地时区格式化。
    pub date: String,
    pub subject: String,
}

/// 本地分支清单。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BranchEntry {
    pub name: String,
    pub head: String,
    pub upstream: Option<String>,
    pub current: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BranchesView {
    pub current: Option<String>,
    pub branches: Vec<BranchEntry>,
    /// 分支数超过上限（清单被裁剪）。
    pub truncated: bool,
}

impl GitRepo {
    /// 读取提交历史。还没有任何提交的空仓库返回空列表，而不是报错。
    pub fn log(&self, worktree: &Path, limit: usize) -> Result<Vec<LogEntry>> {
        let limit = limit.clamp(1, MAX_LOG_ENTRIES);
        let format = "--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s";
        let max_count = format!("--max-count={limit}");
        let args = ["log", max_count.as_str(), "--no-color", format];
        let output = self.runner().capture(worktree, &args, &GitCall::read())?;
        if !output.success {
            // 空仓库（没有 HEAD）时 git log 会失败：这不是错误，只是没有历史。
            if !self.has_head(worktree)? {
                return Ok(Vec::new());
            }
            return Err(
                GitError::new(GitErrorCode::CommandFailed, "读取提交历史失败")
                    .with_detail(output.first_stderr_line().to_owned()),
            );
        }
        Ok(parse_log(&output.stdout))
    }

    /// 本地分支清单。当前分支同时出现在清单与 current 字段里。
    pub fn branches(&self, worktree: &Path) -> Result<BranchesView> {
        let format =
            "--format=%(HEAD)%09%(refname:short)%09%(objectname:short)%09%(upstream:short)";
        let output = self
            .runner()
            .read_ok(worktree, &["branch", "--no-color", "--list", format])?;
        let mut branches = parse_branches(&output.stdout);
        let truncated = branches.len() > MAX_BRANCHES;
        branches.truncate(MAX_BRANCHES);
        let current = branches
            .iter()
            .find(|branch| branch.current)
            .map(|branch| branch.name.clone());
        Ok(BranchesView {
            current,
            branches,
            truncated: truncated || output.truncated,
        })
    }

    /// HEAD 是否存在（空仓库没有第一次提交）。
    fn has_head(&self, worktree: &Path) -> Result<bool> {
        let output = self.runner().capture(
            worktree,
            &["rev-parse", "--verify", "--quiet", "HEAD"],
            &GitCall::read(),
        )?;
        Ok(output.success)
    }
}

/// 解析 --format=%H%x1f%h%x1f%an%x1f%aI%x1f%s 的输出。
pub fn parse_log(text: &str) -> Vec<LogEntry> {
    let mut entries = Vec::new();
    for line in text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let mut fields = line.split('\u{1f}');
        let (Some(hash), Some(short_hash), Some(author), Some(date), Some(subject)) = (
            fields.next(),
            fields.next(),
            fields.next(),
            fields.next(),
            fields.next(),
        ) else {
            continue;
        };
        entries.push(LogEntry {
            hash: hash.to_owned(),
            short_hash: short_hash.to_owned(),
            author: author.to_owned(),
            date: date.to_owned(),
            subject: subject.to_owned(),
        });
    }
    entries
}

/// 解析 branch --format=%(HEAD)%09... 的输出；%09 是制表符。
pub fn parse_branches(text: &str) -> Vec<BranchEntry> {
    let mut branches = Vec::new();
    for line in text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let mut fields = line.split('\t');
        let (Some(head_marker), Some(name), Some(head)) =
            (fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        let upstream = fields.next().unwrap_or("").trim();
        branches.push(BranchEntry {
            name: name.to_owned(),
            head: head.to_owned(),
            upstream: (!upstream.is_empty()).then(|| upstream.to_owned()),
            current: head_marker.trim() == "*",
        });
    }
    branches
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_log_records_with_unit_separator() {
        let text = "abc\u{1f}abc\u{1f}SOXU Test\u{1f}2026-10-30T10:00:00+08:00\u{1f}feat: 抽屉\n\
                    def\u{1f}def\u{1f}SOXU Test\u{1f}2026-10-29T10:00:00+08:00\u{1f}fix: 修复\n";
        let entries = parse_log(text);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].hash, "abc");
        assert_eq!(entries[0].subject, "feat: 抽屉");
        assert_eq!(entries[1].short_hash, "def");
    }

    #[test]
    fn ignores_incomplete_log_records() {
        assert!(parse_log("only-hash\n").is_empty());
    }

    #[test]
    fn parses_branches_and_marks_current() {
        let text = "*\tmain\tabc123\torigin/main\n \tagent/x\tdef456\t\n";
        let branches = parse_branches(text);
        assert_eq!(branches.len(), 2);
        assert!(branches[0].current);
        assert_eq!(branches[0].upstream.as_deref(), Some("origin/main"));
        assert!(!branches[1].current);
        assert_eq!(branches[1].upstream, None);
    }
}
