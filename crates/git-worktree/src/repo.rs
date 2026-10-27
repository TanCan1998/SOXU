//! 仓库句柄与路径比较口径。
//!
//! 所有工作树路径在比较前统一走 [`normalize_path`]：反斜杠转正斜杠、去掉尾部斜杠、
//! 去掉 Windows 的 `\\?\` 前缀，并在 Windows 上折叠大小写。这样 git 输出的
//! `F:/repo` 与用户选择框里的 `F:\\repo` 会被判定为同一个工作树。

use std::path::{Path, PathBuf};

use crate::error::{GitError, GitErrorCode, Result};
use crate::run::{GitCall, GitRunner};

/// 仓库句柄：任意一个工作树目录都可以作为操作入口。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitRepo {
    root: PathBuf,
    runner: GitRunner,
}

impl GitRepo {
    /// 打开工作树目录。会解析出该工作树的真实根（允许传入子目录）。
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        Self::open_with(path, GitRunner::default())
    }

    pub fn open_with(path: impl AsRef<Path>, runner: GitRunner) -> Result<Self> {
        let requested = path.as_ref();
        let canonical = std::fs::canonicalize(requested).map_err(|error| {
            GitError::io(
                GitErrorCode::RepoMissing,
                format!("Git 仓库目录不可用：{}", requested.display()),
                &error,
            )
        })?;
        let canonical = strip_verbatim(&canonical);
        if !canonical.is_dir() {
            return Err(GitError::new(
                GitErrorCode::RepoMissing,
                format!("Git 仓库路径不是目录：{}", canonical.display()),
            ));
        }
        let output = runner.capture(
            &canonical,
            &["rev-parse", "--show-toplevel"],
            &GitCall::read(),
        )?;
        if !output.success {
            return Err(
                GitError::new(
                    GitErrorCode::RepoNotWorkTree,
                    format!("不是 Git 工作树：{}", canonical.display()),
                )
                .with_detail(output.first_stderr_line().to_owned()),
            );
        }
        let top = output.text();
        if top.is_empty() {
            return Err(GitError::new(
                GitErrorCode::RepoNotWorkTree,
                format!("无法解析工作树根目录：{}", canonical.display()),
            ));
        }
        let root = strip_verbatim(Path::new(top));
        Ok(Self { root, runner })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn runner(&self) -> &GitRunner {
        &self.runner
    }

    /// `git rev-parse --git-path <name>`：得到 index.lock / MERGE_HEAD 等状态文件的真实位置。
    /// 链接工作树的状态文件位于主仓库的 `.git/worktrees/<name>/` 下，不能假设在根目录。
    pub fn rev_parse_path(&self, worktree: &Path, name: &str) -> Result<PathBuf> {
        let output = self
            .runner
            .read_ok(worktree, &["rev-parse", "--git-path", name])?;
        let raw = output.text();
        if raw.is_empty() {
            return Err(GitError::new(
                GitErrorCode::CommandFailed,
                format!("git rev-parse --git-path {name} 没有输出"),
            ));
        }
        let path = Path::new(raw);
        Ok(if path.is_absolute() {
            strip_verbatim(path)
        } else {
            worktree.join(path)
        })
    }

    /// 目标路径是否落在本仓库目录内（含 `.git`）：工作树不能创建在仓库内部。
    pub fn is_inside_repo(&self, candidate: &Path) -> bool {
        is_within(&self.root, candidate)
    }
}

/// 身份比较用的规范化字符串：正斜杠、无尾斜杠、Windows 折叠大小写。
pub fn normalize_path(path: &Path) -> String {
    let raw = path.to_string_lossy().replace('\\', "/");
    let trimmed = raw.trim_end_matches('/');
    let trimmed = if trimmed.is_empty() { "/" } else { trimmed };
    if cfg!(windows) {
        trimmed.to_ascii_lowercase()
    } else {
        trimmed.to_string()
    }
}

/// 去掉 Windows canonicalize 产生的 verbatim 前缀（`\\?\`）。
pub fn strip_verbatim(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    let Some(rest) = text.strip_prefix(r"\\?\") else {
        return path.to_path_buf();
    };
    let bytes = rest.as_bytes();
    if bytes.len() > 2 && bytes[1] == b':' {
        return PathBuf::from(rest);
    }
    if let Some(unc) = rest.strip_prefix("UNC\\") {
        return PathBuf::from(format!("\\\\{unc}"));
    }
    path.to_path_buf()
}

/// `candidate` 是否等于 `root` 或位于其下（按规范化字符串比较）。
pub fn is_within(root: &Path, candidate: &Path) -> bool {
    let root = normalize_path(root);
    let candidate = normalize_path(candidate);
    if root == candidate {
        return true;
    }
    if root == "/" {
        return candidate.starts_with('/');
    }
    candidate.starts_with(&format!("{root}/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalization_unifies_separators() {
        assert_eq!(
            normalize_path(Path::new("/work/repo/")),
            normalize_path(Path::new("/work/repo"))
        );
    }

    #[test]
    fn containment_is_prefix_aware() {
        assert!(is_within(Path::new("/work"), Path::new("/work/repo")));
        assert!(is_within(Path::new("/work"), Path::new("/work")));
        // 前缀相同但不是子目录。
        assert!(!is_within(Path::new("/work"), Path::new("/workshop/repo")));
    }

    #[test]
    fn verbatim_prefix_is_stripped() {
        let path = Path::new(r"\\?\C:\work\repo");
        let stripped = strip_verbatim(path);
        assert!(!stripped.to_string_lossy().starts_with(r"\\?\"));
    }
}
