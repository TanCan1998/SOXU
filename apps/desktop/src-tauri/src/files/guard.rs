//! 文件系统路径守卫（Issue #120 / TASK-028）：所有文件操作解析路径的唯一入口。
//!
//! 三条硬规则：
//! 1. **先词法、后磁盘**：绝对路径、UNC/盘符前缀、`..` 与 Windows 设备名在读盘之前就拒绝，
//!    否则 `canonicalize` 会把 `/etc/passwd` 老实解析成一个「合法」路径，越界判断就成了唯一防线。
//! 2. **落点比对**：`canonicalize` 展开符号链接/目录联接后再与项目根目录逐段比对，
//!    链接跳出根目录时解析结果必然不在根内。
//! 3. **逐段比较而非字符串前缀**：`/a/bc` 不能因为以 `/a/b` 开头就被当成在 `/a/b` 里。

use std::fs;
use std::path::{Component, Path, PathBuf};

// ── 稳定错误码：拒绝只返回码 + 原因，不回显目标文件的绝对路径与内容 ──
pub const ROOT_UNKNOWN: &str = "E_FILES_ROOT_UNKNOWN";
pub const PATH_ABSOLUTE: &str = "E_FILES_PATH_ABSOLUTE";
pub const PATH_TRAVERSAL: &str = "E_FILES_PATH_TRAVERSAL";
pub const PATH_INVALID: &str = "E_FILES_PATH_INVALID";
pub const PATH_OUTSIDE_ROOT: &str = "E_FILES_PATH_OUTSIDE_ROOT";
pub const PATH_MISSING: &str = "E_FILES_PATH_MISSING";
pub const PATH_EXISTS: &str = "E_FILES_PATH_EXISTS";
pub const PATH_IS_ROOT: &str = "E_FILES_PATH_IS_ROOT";
pub const NOT_A_FILE: &str = "E_FILES_NOT_A_FILE";
pub const NOT_A_DIR: &str = "E_FILES_NOT_A_DIR";
pub const SYMLINK_UNSUPPORTED: &str = "E_FILES_SYMLINK_UNSUPPORTED";
pub const DIR_NOT_EMPTY: &str = "E_FILES_DIR_NOT_EMPTY";
pub const CONTENT_TOO_LARGE: &str = "E_FILES_CONTENT_TOO_LARGE";
pub const CONFIRM_MISMATCH: &str = "E_FILES_CONFIRM_MISMATCH";
pub const QUERY_EMPTY: &str = "E_FILES_QUERY_EMPTY";
pub const IO_FAILURE: &str = "E_FILES_IO_FAILURE";

/// Windows 设备名：写进项目会得到不可预期的目标（例如 `NUL` 根本不是文件）。
const RESERVED_NAMES: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

#[derive(Debug, Clone)]
pub struct FileError {
    code: &'static str,
    message: String,
}

impl FileError {
    pub(crate) fn new(code: &'static str, message: String) -> Self {
        Self { code, message }
    }

    pub(crate) fn io(code: &'static str, message: String, error: &std::io::Error) -> Self {
        Self::new(code, format!("{message}（{error}）"))
    }

    pub fn code(&self) -> &'static str {
        self.code
    }
}

impl std::fmt::Display for FileError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for FileError {}

/// 项目根目录的路径守卫：所有文件操作的唯一入口。
#[derive(Debug, Clone)]
pub struct FileRoot {
    root: PathBuf,
}

impl FileRoot {
    /// 打开项目根目录：必须存在且是目录，保存**规范化**后的路径作为比较基准。
    pub fn open(root: &Path) -> Result<Self, FileError> {
        let canonical = fs::canonicalize(root).map_err(|error| {
            FileError::io(
                ROOT_UNKNOWN,
                format!("项目根目录不可访问：{}", root.display()),
                &error,
            )
        })?;
        let canonical = strip_verbatim(&canonical);
        if !canonical.is_dir() {
            return Err(FileError::new(
                ROOT_UNKNOWN,
                format!("项目根目录不是目录：{}", root.display()),
            ));
        }
        Ok(Self { root: canonical })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// 解析一个**已存在**的目标：词法校验 → 规范化 → 必须仍在根目录内。
    ///
    /// 符号链接在 `canonicalize` 阶段就被展开，因此链接跳出根目录时落点检查必然失败。
    pub fn existing(&self, relative: &str) -> Result<PathBuf, FileError> {
        let candidate = self.join(relative)?;
        let resolved = fs::canonicalize(&candidate).map_err(|error| {
            FileError::io(
                PATH_MISSING,
                format!("路径不存在或不可访问：{relative}"),
                &error,
            )
        })?;
        let resolved = strip_verbatim(&resolved);
        self.ensure_within(relative, &resolved)?;
        Ok(resolved)
    }

    /// 解析一个已存在的**目录**目标（目录树展开用）。
    pub fn existing_dir(&self, relative: &str) -> Result<PathBuf, FileError> {
        let path = self.existing(relative)?;
        if path.is_dir() {
            Ok(path)
        } else {
            Err(FileError::new(
                NOT_A_DIR,
                format!("目标不是目录：{relative}"),
            ))
        }
    }

    /// 解析一个**待创建**的目标：父目录必须在根内且存在，目标本身不得存在。
    ///
    /// 用 `symlink_metadata` 判断「已存在」而不是 `exists()`：悬空符号链接也必须算占用。
    pub fn creatable(&self, relative: &str) -> Result<PathBuf, FileError> {
        let candidate = self.join(relative)?;
        if candidate == self.root {
            return Err(FileError::new(
                PATH_IS_ROOT,
                "项目根目录本身不能作为目标".to_owned(),
            ));
        }
        let parent = candidate
            .parent()
            .ok_or_else(|| FileError::new(PATH_INVALID, format!("路径缺少父目录：{relative}")))?;
        let resolved_parent = fs::canonicalize(parent).map_err(|error| {
            FileError::io(
                PATH_MISSING,
                format!("父目录不存在或不可访问：{relative}"),
                &error,
            )
        })?;
        let resolved_parent = strip_verbatim(&resolved_parent);
        self.ensure_within(relative, &resolved_parent)?;
        let name = candidate
            .file_name()
            .ok_or_else(|| FileError::new(PATH_INVALID, format!("路径缺少名称：{relative}")))?;
        let target = resolved_parent.join(name);
        if fs::symlink_metadata(&target).is_ok() {
            return Err(FileError::new(
                PATH_EXISTS,
                format!("目标已存在，拒绝覆盖：{relative}"),
            ));
        }
        Ok(target)
    }

    /// 把绝对路径还原成项目内的相对路径（统一 `/` 分隔），用作树节点键。
    pub fn relative_display(&self, absolute: &Path) -> String {
        let relative = absolute.strip_prefix(&self.root).unwrap_or(absolute);
        relative
            .components()
            .filter_map(|component| match component {
                Component::Normal(name) => Some(name.to_string_lossy().into_owned()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("/")
    }

    fn join(&self, relative: &str) -> Result<PathBuf, FileError> {
        let mut candidate = self.root.clone();
        for part in relative_components(relative)? {
            candidate.push(part);
        }
        Ok(candidate)
    }

    fn ensure_within(&self, relative: &str, resolved: &Path) -> Result<(), FileError> {
        if is_within(&self.root, resolved) {
            Ok(())
        } else {
            Err(FileError::new(
                PATH_OUTSIDE_ROOT,
                format!("路径超出项目根目录：{relative}"),
            ))
        }
    }
}

/// 词法校验：只接受相对项目根目录的普通分量。
fn relative_components(relative: &str) -> Result<Vec<String>, FileError> {
    if relative.contains('\0') {
        return Err(FileError::new(
            PATH_INVALID,
            "路径包含非法字符 NUL".to_owned(),
        ));
    }
    // 前端统一用 `/`；Windows 用户粘贴的 `\` 也要当成同一种分隔符处理。
    let normalized = relative.trim().replace('\\', "/");
    if normalized.is_empty() {
        return Ok(Vec::new());
    }
    if normalized.starts_with('/') {
        return Err(FileError::new(
            PATH_ABSOLUTE,
            format!("路径必须是项目内的相对路径：{relative}"),
        ));
    }
    // UNC（`//server/share`）与设备前缀（`\\?\C:`）规范化后都以 `//` 开头。
    if normalized.starts_with("//") {
        return Err(FileError::new(
            PATH_ABSOLUTE,
            format!("不接受 UNC 或设备路径：{relative}"),
        ));
    }
    // 盘符写法在所有平台都按绝对路径拒绝：Unix 上把 `C:/x` 当成相对目录名只会更糟。
    let bytes = normalized.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return Err(FileError::new(
            PATH_ABSOLUTE,
            format!("路径必须是项目内的相对路径：{relative}"),
        ));
    }

    let mut parts = Vec::new();
    for component in Path::new(&normalized).components() {
        match component {
            Component::CurDir => {}
            Component::Normal(name) => {
                let name = name.to_string_lossy().into_owned();
                validate_name(&name)?;
                parts.push(name);
            }
            Component::ParentDir => {
                return Err(FileError::new(
                    PATH_TRAVERSAL,
                    format!("路径不得包含 `..`：{relative}"),
                ));
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(FileError::new(
                    PATH_ABSOLUTE,
                    format!("路径必须是项目内的相对路径：{relative}"),
                ));
            }
        }
    }
    Ok(parts)
}

/// 单个路径分量校验：拒绝空名，以及 Windows 上会被静默改写的写法。
fn validate_name(name: &str) -> Result<(), FileError> {
    if name.is_empty() {
        return Err(FileError::new(PATH_INVALID, "路径分量不能为空".to_owned()));
    }
    if cfg!(windows) {
        // Windows 忽略结尾的点与空格：`a.` 与 `a` 指向同一个文件，写进去只会让人困惑。
        if name.ends_with('.') || name.ends_with(' ') {
            return Err(FileError::new(
                PATH_INVALID,
                format!("Windows 不接受以点或空格结尾的名称：{name}"),
            ));
        }
        // 设备名（`NUL`、`COM1`…）不是普通文件，写进去等于往设备里灌数据。
        let stem = name
            .split('.')
            .next()
            .unwrap_or_default()
            .to_ascii_uppercase();
        if RESERVED_NAMES.contains(&stem.as_str()) || stem == "CONIN$" || stem == "CONOUT$" {
            return Err(FileError::new(
                PATH_INVALID,
                format!("Windows 保留设备名不能作为文件：{name}"),
            ));
        }
    }
    Ok(())
}

/// `path` 是否落在 `root` 之内（含 root 本身）。
///
/// Windows 路径大小写不敏感，比较时忽略 ASCII 大小写。
fn is_within(root: &Path, path: &Path) -> bool {
    let mut root_parts = root.components();
    let mut path_parts = path.components();
    loop {
        match (root_parts.next(), path_parts.next()) {
            (Some(expected), Some(actual)) => {
                if !component_eq(expected, actual) {
                    return false;
                }
            }
            (Some(_), None) => return false,
            (None, Some(_)) => return true,
            (None, None) => return true,
        }
    }
}

fn component_eq(left: Component<'_>, right: Component<'_>) -> bool {
    let left = left.as_os_str().to_string_lossy();
    let right = right.as_os_str().to_string_lossy();
    if cfg!(windows) {
        left.eq_ignore_ascii_case(&right)
    } else {
        left == right
    }
}

/// 去掉 Windows `canonicalize` 产生的 verbatim 前缀（`\\?\`）。
#[cfg(windows)]
fn strip_verbatim(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        // UNC 形式 `\\?\UNC\server\share` 去掉前缀后要还原成 `\\server\share`。
        if let Some(unc) = rest.strip_prefix("UNC\\") {
            return PathBuf::from(format!(r"\\{unc}"));
        }
        return PathBuf::from(rest.to_owned());
    }
    path.to_path_buf()
}

#[cfg(not(windows))]
fn strip_verbatim(path: &Path) -> PathBuf {
    path.to_path_buf()
}

#[cfg(test)]
mod tests {
    //! 路径守卫的纯词法单元测试（不碰磁盘）。
    //!
    //! 越界判定必须在**读盘之前**完成，因此这些用例不需要任何真实文件；
    //! 涉及符号链接与真实目录的用例在 `tests/files_bridge.rs`。

    use super::*;

    #[test]
    fn absolute_paths_are_rejected_before_touching_the_disk() {
        for input in [
            "/etc/passwd",
            "C:/Windows/System32",
            "c:relative-on-a-drive",
            r"\\server\share\file",
            r"\\?\C:\Windows",
            "//server/share",
        ] {
            let error = relative_components(input).expect_err("绝对路径必须被拒绝");
            assert_eq!(error.code(), PATH_ABSOLUTE, "{input} 应被当作绝对路径拒绝");
        }
    }

    #[test]
    fn parent_directory_components_are_rejected() {
        for input in ["../secret", "a/../../b", "a/..", "..", "./../x", r"a\..\b"] {
            let error = relative_components(input).expect_err("`..` 必须被拒绝");
            assert_eq!(error.code(), PATH_TRAVERSAL, "{input}");
        }
    }

    #[test]
    fn nul_bytes_are_rejected() {
        let error = relative_components("a\0b").expect_err("NUL 必须被拒绝");
        assert_eq!(error.code(), PATH_INVALID);
    }

    #[test]
    fn ordinary_relative_paths_are_accepted() {
        assert_eq!(
            relative_components("src/main.rs").expect("普通路径"),
            vec!["src".to_owned(), "main.rs".to_owned()]
        );
        // Windows 风格分隔符与 `./` 前缀都归一成同一组分量。
        assert_eq!(
            relative_components(r".\src\lib.rs").expect("普通路径"),
            vec!["src".to_owned(), "lib.rs".to_owned()]
        );
        // 空路径与 `.` 表示根目录本身（目录树初始展开用）。
        assert!(relative_components("").expect("空路径").is_empty());
        assert!(relative_components("  .  ").expect("点路径").is_empty());
        // 中间的空格是合法文件名的一部分，不能被 trim 掉。
        assert_eq!(
            relative_components("my notes/a b.md").expect("含空格路径"),
            vec!["my notes".to_owned(), "a b.md".to_owned()]
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_device_names_are_rejected() {
        // 整条路径两端会被 trim，因此尾空格用例写在中间分量上。
        for input in ["NUL", "con.txt", "COM1", "aux.md", "name.", "dir /file.txt"] {
            let error = relative_components(input).expect_err("Windows 设备名/尾点必须被拒绝");
            assert_eq!(error.code(), PATH_INVALID, "{input}");
        }
    }

    #[test]
    fn containment_is_component_wise() {
        let root = Path::new("/work/project");
        assert!(is_within(root, Path::new("/work/project")));
        assert!(is_within(root, Path::new("/work/project/src/main.rs")));
        // 字符串前缀相同但不是子目录：不能误判为「在里面」。
        assert!(!is_within(root, Path::new("/work/project-other/x")));
        // 比根目录更短：也不是「在里面」。
        assert!(!is_within(root, Path::new("/work")));
        assert!(!is_within(root, Path::new("/etc/passwd")));
    }
}
