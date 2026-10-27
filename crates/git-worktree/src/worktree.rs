//! 工作树枚举、查找与创建。
//!
//! 解析 `git worktree list --porcelain`：这是 git 自己维护的权威清单，
//! 包含 `locked` /`prunable` 标注，比扫描目录更可靠。

use std::path::{Path, PathBuf};

use crate::error::{GitError, GitErrorCode, Result};
use crate::repo::{GitRepo, is_within, normalize_path, strip_verbatim};
use crate::run::GitCall;

/// 一个工作树的只读视图。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WorktreeEntry {
    /// git 输出的绝对路径（已去掉 Windows verbatim 前缀，用正斜杠）。
    pub path: String,
    pub head: Option<String>,
    /// 短分支名（如 `main`、`agent/issue-5`）；分离头指针时为 `None`。
    pub branch: Option<String>,
    pub bare: bool,
    pub detached: bool,
    /// `git worktree lock` 的原因（没有原因时为空串）。
    pub locked: Option<String>,
    /// 目录或管理记录已失效，git 建议 prune。
    pub prunable: Option<String>,
    /// git 列表的第一项就是主工作树。
    pub primary: bool,
}

impl WorktreeEntry {
    /// 能否当作正常的工作树使用（bare 与 prunable 都不行）。
    pub fn is_usable(&self) -> bool {
        !self.bare && self.prunable.is_none()
    }

    pub fn path_buf(&self) -> PathBuf {
        PathBuf::from(&self.path)
    }
}

/// 创建来源：检出既有分支，或新建分支（可选起点）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BranchSource {
    Existing(String),
    NewBranch { name: String, base: Option<String> },
}

/// 创建请求。`allowed_root` 是安全边界：目标目录必须位于它之内。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreateRequest {
    pub path: PathBuf,
    pub branch: BranchSource,
    pub allowed_root: Option<PathBuf>,
}

impl CreateRequest {
    pub fn existing(path: impl Into<PathBuf>, branch: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            branch: BranchSource::Existing(branch.into()),
            allowed_root: None,
        }
    }

    pub fn new_branch(path: impl Into<PathBuf>, name: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            branch: BranchSource::NewBranch {
                name: name.into(),
                base: None,
            },
            allowed_root: None,
        }
    }

    pub fn with_base(mut self, base: impl Into<String>) -> Self {
        if let BranchSource::NewBranch { base: slot, .. } = &mut self.branch {
            *slot = Some(base.into());
        }
        self
    }

    pub fn inside(mut self, root: impl Into<PathBuf>) -> Self {
        self.allowed_root = Some(root.into());
        self
    }
}

impl GitRepo {
    /// git 维护的工作树清单。输出被截断时报错，不返回残缺列表。
    pub fn worktrees(&self) -> Result<Vec<WorktreeEntry>> {
        let output = self
            .runner()
            .read_ok(self.root(), &["worktree", "list", "--porcelain"])?;
        if output.truncated {
            return Err(GitError::new(
                GitErrorCode::CommandFailed,
                "git worktree list 输出超过上限，拒绝返回残缺清单",
            ));
        }
        Ok(parse_worktree_list(&output.stdout))
    }

    /// 按路径查找工作树；不存在时返回 `E_GIT_WORKTREE_UNKNOWN`。
    pub fn worktree(&self, path: &Path) -> Result<WorktreeEntry> {
        let wanted = normalize_path(path);
        self.worktrees()?
            .into_iter()
            .find(|entry| normalize_path(Path::new(&entry.path)) == wanted)
            .ok_or_else(|| {
                GitError::new(
                    GitErrorCode::WorktreeUnknown,
                    format!("不是本仓库登记的工作树：{}", path.display()),
                )
                .with_detail("可重新枚举工作树后再选择")
            })
    }

    /// 创建（附加）工作树。所有检查都在执行前完成：路径边界、分支可用性、索引锁。
    pub fn create_worktree(&self, request: &CreateRequest) -> Result<WorktreeEntry> {
        let destination = self.resolve_destination(request)?;
        let entries = self.worktrees()?;
        let (branch_name, is_new, base) = match &request.branch {
            BranchSource::Existing(name) => {
                validate_branch(self, name)?;
                if !branch_exists(self, name)? {
                    return Err(GitError::new(
                        GitErrorCode::BranchInvalid,
                        format!("分支不存在：{name}"),
                    ));
                }
                (name.clone(), false, None::<String>)
            }
            BranchSource::NewBranch { name, base } => {
                validate_branch(self, name)?;
                if branch_exists(self, name)? {
                    return Err(GitError::new(
                        GitErrorCode::BranchExists,
                        format!("分支已存在：{name}"),
                    ));
                }
                (
                    name.clone(),
                    true,
                    Some(base.clone().unwrap_or_else(|| "HEAD".to_owned())),
                )
            }
        };
        if entries
            .iter()
            .any(|entry| entry.branch.as_deref() == Some(branch_name.as_str()))
        {
            return Err(GitError::new(
                GitErrorCode::BranchInUse,
                format!("分支 {branch_name} 已被其他工作树检出"),
            ));
        }
        // 写入类操作：先看索引锁，避免和正在运行的 Agent 抢锁后留下半成品。
        if let Some(lock) = self.index_lock(self.root())? {
            return Err(GitError::new(
                GitErrorCode::IndexLocked,
                format!("仓库索引被锁定，暂不创建工作树：{lock}"),
            ));
        }

        let destination_text = destination.to_string_lossy().to_string();
        let mut args: Vec<String> = vec!["worktree".to_owned(), "add".to_owned(), "--no-track".to_owned()];
        if is_new {
            args.push("-b".to_owned());
            args.push(branch_name.clone());
        }
        args.push("--".to_owned());
        args.push(destination_text);
        args.push(if is_new {
            base.unwrap_or_else(|| "HEAD".to_owned())
        } else {
            branch_name.clone()
        });
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        self.runner()
            .capture_ok(self.root(), &refs, &GitCall::write())?;

        let created = self.worktree(&destination)?;
        if !created.is_usable() {
            return Err(GitError::new(
                GitErrorCode::CommandFailed,
                format!("工作树创建后不可用：{}", created.path),
            ));
        }
        Ok(created)
    }

    /// 目标路径校验：绝对路径、父目录存在、不在仓库内、在允许根目录内、当前不存在。
    fn resolve_destination(&self, request: &CreateRequest) -> Result<PathBuf> {
        let raw = &request.path;
        if raw.as_os_str().is_empty() || !raw.is_absolute() {
            return Err(GitError::new(
                GitErrorCode::PathNotAbsolute,
                format!("工作树路径必须是绝对路径：{}", raw.display()),
            ));
        }
        let Some(parent) = raw.parent() else {
            return Err(GitError::new(
                GitErrorCode::PathNotAbsolute,
                format!("工作树路径缺少父目录：{}", raw.display()),
            ));
        };
        if !parent.is_dir() {
            return Err(GitError::new(
                GitErrorCode::WorktreePathMissing,
                format!("工作树目标父目录不存在：{}", parent.display()),
            ));
        }
        let canonical_parent = std::fs::canonicalize(parent).map_err(|error| {
            GitError::io(
                GitErrorCode::WorktreePathMissing,
                format!("工作树目标父目录不可用：{}", parent.display()),
                &error,
            )
        })?;
        let Some(name) = raw.file_name() else {
            return Err(GitError::new(
                GitErrorCode::PathNotAbsolute,
                format!("工作树路径缺少目录名：{}", raw.display()),
            ));
        };
        let destination = strip_verbatim(&canonical_parent).join(name);
        if self.is_inside_repo(&destination) {
            return Err(GitError::new(
                GitErrorCode::PathInsideRepo,
                format!("工作树不能创建在仓库目录内部：{}", destination.display()),
            ));
        }
        if let Some(root) = &request.allowed_root {
            let allowed = std::fs::canonicalize(root).map_err(|error| {
                GitError::io(
                    GitErrorCode::PathOutsideRoot,
                    format!("工作树允许根目录不可用：{}", root.display()),
                    &error,
                )
            })?;
            let allowed = strip_verbatim(&allowed);
            if !is_within(&allowed, &destination) {
                return Err(GitError::new(
                    GitErrorCode::PathOutsideRoot,
                    format!(
                        "工作树路径不在允许的根目录内：{}（允许 {}）",
                        destination.display(),
                        allowed.display()
                    ),
                ));
            }
        }
        if destination.exists() {
            return Err(GitError::new(
                GitErrorCode::PathExists,
                format!("目标路径已存在，拒绝覆盖：{}", destination.display()),
            ));
        }
        Ok(destination)
    }
}

fn validate_branch(repo: &GitRepo, name: &str) -> Result<()> {
    if name.is_empty() || name != name.trim() {
        return Err(GitError::new(
            GitErrorCode::BranchInvalid,
            format!("分支名不合法：{name:?}"),
        ));
    }
    let output = repo.runner().capture(
        repo.root(),
        &["check-ref-format", "--branch", name],
        &GitCall::read(),
    )?;
    if !output.success {
        return Err(
            GitError::new(
                GitErrorCode::BranchInvalid,
                format!("分支名不合法：{name}"),
            )
            .with_detail(output.first_stderr_line().to_owned()),
        );
    }
    Ok(())
}

fn branch_exists(repo: &GitRepo, name: &str) -> Result<bool> {
    let reference = format!("refs/heads/{name}");
    let output = repo.runner().capture(
        repo.root(),
        &["show-ref", "--verify", "--quiet", &reference],
        &GitCall::read(),
    )?;
    Ok(output.success)
}

/// 解析 `git worktree list --porcelain`。
///
/// 每个工作树是一组 `key value` 行，空行分隔；第一个是主工作树。
/// 路径可能被 C 风格引号包裹（含空格或特殊字符时），这里做反转义。
pub fn parse_worktree_list(text: &str) -> Vec<WorktreeEntry> {
    let mut entries: Vec<WorktreeEntry> = Vec::new();
    let mut current: Option<WorktreeEntry> = None;
    for line in text.lines() {
        if line.trim().is_empty() {
            if let Some(entry) = current.take() {
                entries.push(entry);
            }
            continue;
        }
        let (key, value) = match line.split_once(' ') {
            Some(pair) => pair,
            None => (line, ""),
        };
        match key {
            "worktree" => {
                if let Some(entry) = current.take() {
                    entries.push(entry);
                }
                current = Some(WorktreeEntry {
                    path: decode_field(value),
                    ..WorktreeEntry::default()
                });
            }
            "HEAD" => {
                if let Some(entry) = current.as_mut() {
                    entry.head = Some(value.to_owned());
                }
            }
            "branch" => {
                if let Some(entry) = current.as_mut() {
                    entry.branch = Some(
                        value
                            .strip_prefix("refs/heads/")
                            .unwrap_or(value)
                            .to_owned(),
                    );
                }
            }
            "bare" => {
                if let Some(entry) = current.as_mut() {
                    entry.bare = true;
                }
            }
            "detached" => {
                if let Some(entry) = current.as_mut() {
                    entry.detached = true;
                }
            }
            "locked" => {
                if let Some(entry) = current.as_mut() {
                    entry.locked = Some(decode_field(value).trim().to_owned());
                }
            }
            "prunable" => {
                if let Some(entry) = current.as_mut() {
                    entry.prunable = Some(decode_field(value).trim().to_owned());
                }
            }
            _ => {}
        }
    }
    if let Some(entry) = current.take() {
        entries.push(entry);
    }
    if let Some(first) = entries.first_mut() {
        first.primary = true;
    }
    entries
}

/// 反转义 git 的 C 风格路径引用：只有被引号包裹时才有转义。
fn decode_field(raw: &str) -> String {
    if raw.len() >= 2 && raw.starts_with('"') && raw.ends_with('"') {
        unescape(&raw[1..raw.len() - 1])
    } else {
        raw.to_owned()
    }
}

fn unescape(raw: &str) -> String {
    let mut text = String::with_capacity(raw.len());
    let mut chars = raw.chars();
    while let Some(character) = chars.next() {
        if character != '\\' {
            text.push(character);
            continue;
        }
        match chars.next() {
            Some('n') => text.push('\n'),
            Some('t') => text.push('\t'),
            Some('r') => text.push('\r'),
            Some('"') => text.push('"'),
            Some('\\') => text.push('\\'),
            Some(digit) if digit.is_digit(8) => {
                let mut value = digit.to_digit(8).unwrap_or(0);
                for _ in 0..2 {
                    match chars.clone().next().and_then(|next| next.to_digit(8)) {
                        Some(next) => {
                            value = value * 8 + next;
                            chars.next();
                        }
                        None => break,
                    }
                }
                text.push(char::from(value as u8));
            }
            Some(other) => text.push(other),
            None => {}
        }
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "worktree F:/work/main\nHEAD 1111111111111111111111111111111111111111\nbranch refs/heads/main\n\nworktree F:/work/issue-5\nHEAD 2222222222222222222222222222222222222222\nbranch refs/heads/agent/issue-5\nlocked agent running\n\nworktree F:/work/gone\nHEAD 3333333333333333333333333333333333333333\ndetached\nprunable gitdir file points to non-existent location\n";

    #[test]
    fn parses_primary_locked_and_prunable_entries() {
        let entries = parse_worktree_list(SAMPLE);
        assert_eq!(entries.len(), 3);
        assert!(entries[0].primary);
        assert_eq!(entries[0].branch.as_deref(), Some("main"));
        assert_eq!(entries[1].branch.as_deref(), Some("agent/issue-5"));
        assert_eq!(entries[1].locked.as_deref(), Some("agent running"));
        assert!(entries[1].is_usable());
        assert_eq!(
            entries[2].prunable.as_deref(),
            Some("gitdir file points to non-existent location")
        );
        assert!(entries[2].detached);
        assert!(!entries[2].is_usable());
    }

    #[test]
    fn quoted_paths_are_unescaped() {
        let text = "worktree \"F:/work/a b\"\nHEAD 4\nbranch refs/heads/main\n";
        let entries = parse_worktree_list(text);
        assert_eq!(entries[0].path, "F:/work/a b");
        assert!(entries[0].primary);
    }
}
