//! Git 路径参数守卫（Issue #121）。
//!
//! 前端传来的路径来自仓库文件清单，但它仍然是**不可信输入**：Git 抽屉的
//! 单文件 diff 与暂存都会把路径作为 pathspec 传给 git。这里统一成一条规则：
//! 只接受相对仓库根目录的路径，拒绝绝对路径、盘符路径与 .. 穿越。
//!
//! 通过校验的路径统一换成正斜杠：git 在 Windows 上也接受正斜杠，而反斜杠
//! 在 pathspec 里会被当成转义字符。

use crate::error::{GitError, GitErrorCode, Result};

/// 单个 pathspec 的字符上限：正常仓库不会出现这么长的路径，超出即视为异常输入。
pub const MAX_PATH_CHARS: usize = 4096;

/// 校验并规范化一个仓库相对路径。
pub fn validate_relative_path(raw: &str) -> Result<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(GitError::new(GitErrorCode::PathInvalid, "路径不能为空"));
    }
    if trimmed.chars().count() > MAX_PATH_CHARS {
        return Err(GitError::new(
            GitErrorCode::PathInvalid,
            format!("路径过长（超过 {MAX_PATH_CHARS} 字符）"),
        ));
    }
    if trimmed.contains('\0') {
        return Err(GitError::new(GitErrorCode::PathInvalid, "路径包含空字符"));
    }
    let normalized = trimmed.replace('\\', "/");
    if normalized.starts_with('/') {
        return Err(GitError::new(
            GitErrorCode::PathNotAbsolute,
            format!("只接受仓库内的相对路径：{trimmed}"),
        ));
    }
    // Windows 盘符（C:foo / C:/foo）与 UNC 前缀都按绝对路径处理。
    if normalized.len() > 1 && normalized.as_bytes()[1] == b':' {
        return Err(GitError::new(
            GitErrorCode::PathNotAbsolute,
            format!("只接受仓库内的相对路径：{trimmed}"),
        ));
    }
    if normalized.split('/').any(|segment| segment == "..") {
        return Err(GitError::new(
            GitErrorCode::PathOutsideRoot,
            format!("路径不能越出仓库根目录：{trimmed}"),
        ));
    }
    Ok(normalized)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_relative_paths_and_normalizes_separators() {
        assert_eq!(
            validate_relative_path("src/commands/git.rs").expect("普通相对路径"),
            "src/commands/git.rs"
        );
        assert_eq!(
            validate_relative_path(r"src\commands\git.rs").expect("Windows 分隔符"),
            "src/commands/git.rs"
        );
        assert_eq!(
            validate_relative_path(" docs/a b.md ").expect("两侧空白被裁剪"),
            "docs/a b.md"
        );
    }

    #[test]
    fn rejects_absolute_and_drive_paths() {
        for raw in [
            "/etc/passwd",
            r"\Windows\system.ini",
            "C:/work/a.txt",
            r"C:\work\a.txt",
        ] {
            let error = validate_relative_path(raw).expect_err("绝对路径必须被拒绝");
            assert_eq!(error.code(), GitErrorCode::PathNotAbsolute, "{raw}");
        }
    }

    #[test]
    fn rejects_traversal_and_empty_paths() {
        for raw in ["../secret", "src/../../secret", "src\\..\\..\\secret"] {
            let error = validate_relative_path(raw).expect_err("穿越路径必须被拒绝");
            assert_eq!(error.code(), GitErrorCode::PathOutsideRoot, "{raw}");
        }
        assert_eq!(
            validate_relative_path("   ").expect_err("空路径").code(),
            GitErrorCode::PathInvalid
        );
    }
}
