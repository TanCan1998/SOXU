//! 项目、Worktree、会话与运行时的身份模型。
//!
//! 关系：ProjectId（项目目录）包含 WorktreeId（工作树路径）；WorktreeId 下挂多个
//! SessionId（Pi 会话文件，跨重启稳定）；RuntimeLink（runtimeId + generation）是
//! 临时执行身份，只用于判断事件是否仍然有效，不参与持久化历史的身份。

use std::fmt;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::hash::{fnv1a64_parts, hex16};

macro_rules! id_type {
    ($name:ident, $prefix:literal, $doc:expr) => {
        #[doc = $doc]
        #[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            pub fn new(value: impl Into<String>) -> Self {
                Self(value.into())
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }

            pub fn into_string(self) -> String {
                self.0
            }

            #[allow(dead_code)]
            pub(crate) fn hashed(seed: u64) -> Self {
                Self(format!("{}_{}", $prefix, hex16(seed)))
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str(&self.0)
            }
        }

        impl AsRef<str> for $name {
            fn as_ref(&self) -> &str {
                &self.0
            }
        }
    };
}

id_type!(
    ProjectId,
    "prj",
    "项目目录的逻辑身份。由规范化后的根路径哈希派生，重启后保持一致；不随目录重命名之外的元数据变化。"
);
id_type!(
    WorktreeId,
    "wkt",
    "工作树身份。由项目 ID 与规范化后的工作树路径派生，切换分支不会改变它。"
);
id_type!(
    SessionId,
    "ses",
    "会话身份。优先使用 Pi 会话头部的 id，因此文件重命名或迁移后仍然稳定。"
);
id_type!(
    RuntimeId,
    "rt",
    "单次 Pi 进程的身份，由 Supervisor 分配，重启后不复用。"
);

/// 把路径规范化为身份比较用的字符串：统一正斜杠、去掉尾部斜杠、Windows 大小写折叠。
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

impl ProjectId {
    pub fn derive(root: &Path) -> Self {
        Self::hashed(fnv1a64_parts(&["project", &normalize_path(root)]))
    }
}

impl WorktreeId {
    /// 分支名有意不参与派生：同一路径切换分支仍是同一个 Worktree。
    pub fn derive(project: &ProjectId, path: &Path) -> Self {
        Self::hashed(fnv1a64_parts(&[
            "worktree",
            project.as_str(),
            &normalize_path(path),
        ]))
    }
}

impl SessionId {
    /// 使用 Pi 会话头部的 id 派生。无法安全内联时（超长、奇怪字符）退化为哈希。
    pub fn from_header_id(raw: &str) -> Self {
        let usable = !raw.is_empty()
            && raw.len() <= 64
            && raw
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.');
        if usable {
            Self(format!("ses_{raw}"))
        } else {
            Self::hashed(fnv1a64_parts(&["session-header", raw]))
        }
    }

    /// 旧格式（无头部 id）会话的稳定身份来源：头部行字节指纹。
    pub fn from_legacy_fingerprint(fingerprint: u64) -> Self {
        Self(format!("ses_l_{}", hex16(fingerprint)))
    }
}

/// 运行时挂载：谁的进程正在写这个会话，属于哪一代。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeLink {
    pub session: SessionId,
    pub runtime: RuntimeId,
    pub generation: u64,
    pub attached_at_ms: u64,
}

impl RuntimeLink {
    pub fn accepts(&self, session: &SessionId, runtime: &RuntimeId, generation: u64) -> bool {
        &self.session == session && &self.runtime == runtime && self.generation == generation
    }

    pub fn next_generation(&self) -> u64 {
        self.generation.saturating_add(1)
    }
}

/// 一次查询得到的完整身份链，用于 UI 展示与错误定位。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionIdentity {
    pub project: ProjectId,
    pub worktree: WorktreeId,
    pub session: SessionId,
    pub runtime: Option<RuntimeLink>,
}

/// 去掉 Windows canonicalize 产生的 verbatim 前缀（\\?\），
/// 保证 ProjectId 与 Pi 会话目录命名使用同一份可读路径。
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
        return PathBuf::from(format!("\\{unc}"));
    }
    path.to_path_buf()
}

/// `candidate` 是否等于 `root` 或位于其下（按规范化字符串比较）。
///
/// 只做字符串比较，不碰文件系统：调用方必须先把两侧解析成真实路径，
/// 否则符号链接 / 目录联接可以伪造包含关系（见 `ProjectCatalog::sync` 的扫描守门）。
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

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

pub(crate) fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_id_is_deterministic() {
        let first = ProjectId::derive(Path::new("/work/project-a"));
        let second = ProjectId::derive(Path::new("/work/project-a/"));
        assert_eq!(first, second);
        assert_ne!(first, ProjectId::derive(Path::new("/work/project-b")));
    }

    #[test]
    fn worktree_id_ignores_branch_but_not_path() {
        let project = ProjectId::derive(Path::new("/work/project-a"));
        let main = WorktreeId::derive(&project, Path::new("/work/project-a"));
        let linked = WorktreeId::derive(&project, Path::new("/work/project-a-branch"));
        assert_ne!(main, linked);
        assert_eq!(
            linked,
            WorktreeId::derive(&project, Path::new("/work/project-a-branch/"))
        );
    }

    #[test]
    fn header_session_id_is_readable() {
        assert_eq!(
            SessionId::from_header_id("7d1c9a2e").as_str(),
            "ses_7d1c9a2e"
        );
    }

    #[test]
    fn hostility_in_header_id_falls_back_to_hash() {
        let id = SessionId::from_header_id("../../etc/passwd");
        assert!(id.as_str().starts_with("ses_"));
        assert!(!id.as_str().contains('/'));
    }

    #[test]
    fn containment_is_prefix_aware_and_not_fooled_by_siblings() {
        assert!(is_within(Path::new("/work"), Path::new("/work/repo")));
        assert!(is_within(Path::new("/work"), Path::new("/work")));
        // 前缀相同但不是子目录：越权路径最容易被这种比较放过。
        assert!(!is_within(Path::new("/work"), Path::new("/workshop/repo")));
        assert!(!is_within(Path::new("/work"), Path::new("/work-secret/a")));
        assert!(is_within(Path::new("/"), Path::new("/etc/passwd")));
    }

    #[test]
    fn runtime_link_filters_late_events() {
        let link = RuntimeLink {
            session: SessionId::new("ses_a"),
            runtime: RuntimeId::new("rt_1"),
            generation: 4,
            attached_at_ms: 0,
        };
        assert!(link.accepts(&SessionId::new("ses_a"), &RuntimeId::new("rt_1"), 4));
        assert!(!link.accepts(&SessionId::new("ses_a"), &RuntimeId::new("rt_1"), 3));
        assert!(!link.accepts(&SessionId::new("ses_b"), &RuntimeId::new("rt_1"), 4));
    }
}
