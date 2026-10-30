//! 工作树状态：脏改动、未跟踪、冲突、索引锁与进行中的 Git 操作。
//!
//! 只读：使用 GIT_OPTIONAL_LOCKS=0 执行 git status，不会为了刷新索引而写盘，
//! 因此不会与正在运行的 Pi Agent 抢 index.lock。文件清单有上限，计数不受影响。
//!
//! 解析只做一次（parse_porcelain）：工作树汇总与 Git 抽屉的更改列表共用同一份
//! porcelain 记录，避免两处解析规则漂移（徽章字母与计数必须永远一致）。

use std::path::Path;

use crate::error::{GitError, GitErrorCode, Result};
use crate::repo::{GitRepo, normalize_path};
use crate::run::GitCall;

/// 单次状态查询最多列出多少个文件路径；staged_count 等计数不受此限制。
pub const MAX_LISTED_CHANGES: usize = 200;

const CONFLICT_CODES: [&str; 7] = ["DD", "AU", "UD", "UA", "DU", "AA", "UU"];

const IN_PROGRESS_MARKERS: [(&str, &str); 6] = [
    ("MERGE_HEAD", "merge"),
    ("CHERRY_PICK_HEAD", "cherry-pick"),
    ("REVERT_HEAD", "revert"),
    ("rebase-merge", "rebase"),
    ("rebase-apply", "rebase"),
    ("BISECT_LOG", "bisect"),
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConflictEntry {
    pub path: String,
    /// UU / AA / DU 等 porcelain 冲突码。
    pub kind: String,
}

/// 单条 porcelain 记录：路径 + 索引区/工作区两列状态字母。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatusEntry {
    pub path: String,
    /// porcelain 第 1 列（索引区，X）。
    pub index: char,
    /// porcelain 第 2 列（工作区，Y）。
    pub working: char,
}

impl StatusEntry {
    /// porcelain 两列字母，例如 UU、空格+M、??。
    pub fn code(&self) -> String {
        [self.index, self.working].iter().collect()
    }

    pub fn is_conflict(&self) -> bool {
        CONFLICT_CODES.contains(&self.code().as_str())
    }

    pub fn is_untracked(&self) -> bool {
        self.index == '?' && self.working == '?'
    }

    /// 索引区有改动（冲突与未跟踪单独计数，不重复算作 staged）。
    pub fn is_staged(&self) -> bool {
        !self.is_untracked() && !self.is_conflict() && self.index != ' ' && self.index != '!'
    }

    /// 工作区有改动（同上，冲突与未跟踪不重复计数）。
    pub fn is_unstaged(&self) -> bool {
        !self.is_untracked() && !self.is_conflict() && self.working != ' ' && self.working != '!'
    }

    /// 更改列表徽章字母（Issue #121）：A 新增、M 修改、D 删除、U 冲突。
    ///
    /// 同一文件既有暂存又有未暂存改动时以索引区字母为准：徽章表达的是
    /// 「下一次提交会把该文件变成什么」。重命名/类型变化（R/T/C）按修改处理。
    pub fn badge(&self) -> &'static str {
        if self.is_conflict() {
            return "U";
        }
        if self.is_untracked() {
            return "A";
        }
        let letter = if self.index != ' ' && self.index != '!' {
            self.index
        } else {
            self.working
        };
        match letter {
            'A' => "A",
            'D' => "D",
            _ => "M",
        }
    }
}

/// 工作树状态快照。列表有界，计数完整。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorktreeStatus {
    /// 规范化后的工作树路径。
    pub worktree: String,
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: usize,
    pub behind: usize,
    pub staged: Vec<String>,
    pub unstaged: Vec<String>,
    pub untracked: Vec<String>,
    pub conflicts: Vec<ConflictEntry>,
    /// 逐条 porcelain 记录（含徽章字母）；与 staged/unstaged 列表一样有界。
    pub entries: Vec<StatusEntry>,
    /// 文件条目总数（entries 被上限裁剪时仍然完整）。
    pub entry_count: usize,
    pub staged_count: usize,
    pub unstaged_count: usize,
    pub untracked_count: usize,
    pub conflict_count: usize,
    /// index.lock 的绝对路径；存在时说明有进程（或崩溃残留）持有索引锁。
    pub index_lock: Option<String>,
    /// 进行中的多步操作：merge / rebase / cherry-pick / revert / bisect。
    pub operation: Option<String>,
    /// 文件清单或 git 输出被截断。
    pub truncated: bool,
}

impl WorktreeStatus {
    /// 有任何未提交改动（含冲突）即为脏工作树。
    pub fn dirty(&self) -> bool {
        self.total_changes() > 0
    }

    pub fn total_changes(&self) -> usize {
        self.staged_count + self.unstaged_count + self.untracked_count + self.conflict_count
    }

    /// 是否处于不可安全执行破坏性操作的状态。
    pub fn blocked(&self) -> bool {
        self.dirty() || self.index_lock.is_some() || self.operation.is_some()
    }
}

impl GitRepo {
    /// 读取工作树状态。目录不存在时返回 E_GIT_WORKTREE_PATH_MISSING。
    pub fn inspect_status(&self, worktree: &Path) -> Result<WorktreeStatus> {
        if !worktree.is_dir() {
            return Err(GitError::new(
                GitErrorCode::WorktreePathMissing,
                format!("工作树目录不存在：{}", worktree.display()),
            ));
        }
        let index_lock = self.index_lock(worktree)?;
        let operation = self.operation_in_progress(worktree)?;
        let output = self.runner().capture(
            worktree,
            &[
                "status",
                "--porcelain=v1",
                "-z",
                "--branch",
                "--untracked-files=normal",
                "--no-renames",
            ],
            &GitCall::read(),
        )?;
        if !output.success {
            let detail = output.first_stderr_line().to_owned();
            let locked = index_lock.is_some()
                || detail.contains("index.lock")
                || detail.contains("already locked");
            let code = if locked {
                GitErrorCode::IndexLocked
            } else {
                GitErrorCode::CommandFailed
            };
            return Err(
                GitError::new(code, format!("读取工作树状态失败：{}", worktree.display()))
                    .with_detail(detail),
            );
        }
        let mut status = parse_status(&output.stdout);
        status.worktree = normalize_path(worktree);
        status.index_lock = index_lock;
        status.operation = operation;
        status.truncated = output.truncated || status.truncated;
        Ok(status)
    }

    /// index.lock 是否存在。链接工作树的锁位于主仓库的 .git/worktrees/<name>/ 下。
    pub fn index_lock(&self, worktree: &Path) -> Result<Option<String>> {
        let path = self.rev_parse_path(worktree, "index.lock")?;
        Ok(path.exists().then(|| path.to_string_lossy().to_string()))
    }

    /// 是否有未完成的 merge / rebase / cherry-pick / revert / bisect。
    pub fn operation_in_progress(&self, worktree: &Path) -> Result<Option<String>> {
        for (marker, label) in IN_PROGRESS_MARKERS {
            let path = self.rev_parse_path(worktree, marker)?;
            if path.exists() {
                return Ok(Some(label.to_owned()));
            }
        }
        Ok(None)
    }
}

/// 解析 --porcelain=v1 -z 输出：可选的 ## 表头 + 逐条记录。
///
/// -z + --no-renames 保证每条记录都是 XY + 空格 + 路径，不存在重命名的双路径记录，
/// 因此这里可以按固定 3 字节前缀切分（前 3 字节一定是 ASCII）。
pub fn parse_porcelain(text: &str) -> (Option<String>, Vec<StatusEntry>) {
    let mut header = None;
    let mut entries = Vec::new();
    for record in text.split('\0').filter(|record| !record.is_empty()) {
        if let Some(rest) = record.strip_prefix("## ") {
            header = Some(rest.to_owned());
            continue;
        }
        if record.len() < 4 {
            continue;
        }
        let bytes = record.as_bytes();
        entries.push(StatusEntry {
            path: record[3..].to_owned(),
            index: bytes[0] as char,
            working: bytes[1] as char,
        });
    }
    (header, entries)
}

/// 解析 git status --porcelain=v1 -z --branch --no-renames 的输出。
pub fn parse_status(text: &str) -> WorktreeStatus {
    let mut status = WorktreeStatus {
        worktree: String::new(),
        branch: None,
        upstream: None,
        ahead: 0,
        behind: 0,
        staged: Vec::new(),
        unstaged: Vec::new(),
        untracked: Vec::new(),
        conflicts: Vec::new(),
        entries: Vec::new(),
        entry_count: 0,
        staged_count: 0,
        unstaged_count: 0,
        untracked_count: 0,
        conflict_count: 0,
        index_lock: None,
        operation: None,
        truncated: false,
    };
    let (header, entries) = parse_porcelain(text);
    if let Some(header) = header {
        apply_header(&mut status, &header);
    }
    for entry in entries {
        status.entry_count += 1;
        if status.entries.len() < MAX_LISTED_CHANGES {
            status.entries.push(entry.clone());
        } else {
            status.truncated = true;
        }
        if entry.is_conflict() {
            status.conflict_count += 1;
            if status.conflicts.len() < MAX_LISTED_CHANGES {
                status.conflicts.push(ConflictEntry {
                    kind: entry.code(),
                    path: entry.path,
                });
            } else {
                status.truncated = true;
            }
            continue;
        }
        if entry.is_untracked() {
            status.untracked_count += 1;
            if status.untracked.len() < MAX_LISTED_CHANGES {
                status.untracked.push(entry.path);
            } else {
                status.truncated = true;
            }
            continue;
        }
        if entry.is_staged() {
            status.staged_count += 1;
            if status.staged.len() < MAX_LISTED_CHANGES {
                status.staged.push(entry.path.clone());
            } else {
                status.truncated = true;
            }
        }
        if entry.is_unstaged() {
            status.unstaged_count += 1;
            if status.unstaged.len() < MAX_LISTED_CHANGES {
                status.unstaged.push(entry.path);
            } else {
                status.truncated = true;
            }
        }
    }
    status
}

fn apply_header(status: &mut WorktreeStatus, header: &str) {
    let header = header.trim();
    let (tracking, detail) = match header.split_once(" [") {
        Some((left, right)) => (left, Some(right.trim_end_matches(']'))),
        None => (header, None),
    };
    if let Some(branch) = tracking.strip_prefix("No commits yet on ") {
        status.branch = Some(branch.to_owned());
    } else if let Some((branch, upstream)) = tracking.split_once("...") {
        status.branch = Some(branch.to_owned());
        status.upstream = Some(upstream.to_owned());
    } else if tracking == "HEAD (no branch)" || tracking.starts_with("HEAD ") {
        status.branch = None;
    } else if !tracking.is_empty() {
        status.branch = Some(tracking.to_owned());
    }
    if let Some(detail) = detail {
        for part in detail.split(',') {
            let part = part.trim();
            if let Some(value) = part.strip_prefix("ahead ") {
                status.ahead = value.trim().parse().unwrap_or(0);
            } else if let Some(value) = part.strip_prefix("behind ") {
                status.behind = value.trim().parse().unwrap_or(0);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DIRTY: &str = "## agent/issue-5...origin/main [ahead 2, behind 1]\0 M src/a.rs\0M  src/b.rs\0?? notes.md\0";

    #[test]
    fn parses_branch_tracking_and_changes() {
        let status = parse_status(DIRTY);
        assert_eq!(status.branch.as_deref(), Some("agent/issue-5"));
        assert_eq!(status.upstream.as_deref(), Some("origin/main"));
        assert_eq!(status.ahead, 2);
        assert_eq!(status.behind, 1);
        assert_eq!(status.staged_count, 1);
        assert_eq!(status.unstaged_count, 1);
        assert_eq!(status.untracked_count, 1);
        assert_eq!(status.total_changes(), 3);
        assert!(status.dirty());
        assert_eq!(status.unstaged, vec!["src/a.rs".to_owned()]);
        assert_eq!(status.staged, vec!["src/b.rs".to_owned()]);
    }

    #[test]
    fn conflicts_are_counted_separately() {
        let text = "## main\0UU src/conflict.rs\0AA other.rs\0";
        let status = parse_status(text);
        assert_eq!(status.conflict_count, 2);
        assert_eq!(status.conflicts[0].kind, "UU");
        assert!(!status.conflicts.is_empty());
        // 冲突不算 staged/unstaged，避免重复计数。
        assert_eq!(status.staged_count, 0);
        assert_eq!(status.unstaged_count, 0);
        assert!(status.dirty());
    }

    #[test]
    fn clean_worktree_is_not_dirty() {
        let status = parse_status("## main...origin/main\0");
        assert!(!status.dirty());
        assert!(!status.blocked());
    }

    #[test]
    fn detached_header_has_no_branch() {
        let status = parse_status("## HEAD (no branch)\0");
        assert!(status.branch.is_none());
    }

    #[test]
    fn listing_is_bounded_but_counting_is_not() {
        let mut text = String::from("## main\0");
        for index in 0..(MAX_LISTED_CHANGES + 5) {
            text.push_str(&format!("?? file-{index}.txt\0"));
        }
        let status = parse_status(&text);
        assert_eq!(status.untracked_count, MAX_LISTED_CHANGES + 5);
        assert_eq!(status.untracked.len(), MAX_LISTED_CHANGES);
        // 条目清单与分类清单一样有界，但总数完整（更改列表用得上）。
        assert_eq!(status.entries.len(), MAX_LISTED_CHANGES);
        assert_eq!(status.entry_count, MAX_LISTED_CHANGES + 5);
        assert!(status.truncated);
    }

    #[test]
    fn badges_follow_porcelain_letters() {
        let status = parse_status(
            "## main\0A  added.rs\0 M edited.rs\0 D removed.rs\0?? fresh.rs\0UU conflict.rs\0",
        );
        let badges: Vec<(&str, &str)> = status
            .entries
            .iter()
            .map(|entry| (entry.path.as_str(), entry.badge()))
            .collect();
        assert_eq!(
            badges,
            vec![
                ("added.rs", "A"),
                ("edited.rs", "M"),
                ("removed.rs", "D"),
                ("fresh.rs", "A"),
                ("conflict.rs", "U"),
            ]
        );
        // 暂存区字母优先：同一文件既暂存又未暂存时徽章描述下一次提交。
        let both = parse_status("## main\0MM both.rs\0");
        assert_eq!(both.entries[0].badge(), "M");
        assert!(both.entries[0].is_staged() && both.entries[0].is_unstaged());
    }

    #[test]
    fn porcelain_parser_keeps_header_and_paths() {
        let (header, entries) =
            parse_porcelain("## main...origin/main [ahead 1]\0?? 目录/文件.txt\0");
        assert_eq!(header.as_deref(), Some("main...origin/main [ahead 1]"));
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].path, "目录/文件.txt");
        assert!(entries[0].is_untracked());
    }
}
