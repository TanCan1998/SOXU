//! 真实 Git 仓库测试夹具：独立临时沙箱 + 可复现的 git 调用。
//!
//! 每个测试用独立目录，Drop 时清理；不使用网络、不依赖用户全局 git 配置。

#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

pub struct Sandbox {
    root: PathBuf,
}

impl Sandbox {
    pub fn new(name: &str) -> Self {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or_default();
        let root = std::env::temp_dir().join(format!("soxu-git-{name}-{stamp}"));
        std::fs::create_dir_all(&root).expect("创建测试沙箱");
        Self {
            root: canonical_root(root),
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn path(&self, relative: &str) -> PathBuf {
        self.root.join(relative)
    }
}

/// 统一成 git 会返回的形式：真实大小写、长文件名、无 Windows verbatim 前缀。
///
/// 临时目录在不同平台可能是符号链接（macOS `/var` → `/private/var`）或 8.3 短名
/// （Windows runner 的 `RUNNER~1`），不规范化就让「测试给的路径」和「git 枚举的路径」
/// 永远不相等，测试在 CI 上必挂而本机通过。
fn canonical_root(path: PathBuf) -> PathBuf {
    let Ok(canonical) = std::fs::canonicalize(&path) else {
        return path;
    };
    let text = canonical.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(rest) if rest.as_bytes().get(1) == Some(&b':') => PathBuf::from(rest),
        _ => canonical,
    }
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// 尝试创建指向目录的链接：Unix 用符号链接，Windows 先试符号链接、再退化为目录联接。
///
/// Windows 上普通用户创建符号链接需要开发者模式或管理员权限（SeCreateSymbolicLinkPrivilege），
/// 目录联接（junction）不需要。两者都不可用时返回 Err，由测试显式记录平台差异，
/// 而不是让"符号链接用例"静默变成绿灯。
pub fn try_dir_link(target: &Path, link: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, link)
            .map_err(|error| format!("创建符号链接失败：{error}"))
    }
    #[cfg(windows)]
    {
        match std::os::windows::fs::symlink_dir(target, link) {
            Ok(()) => Ok(()),
            Err(symlink_error) => {
                // mklink 是 cmd 内置命令，参数逐个传递，不做字符串拼接。
                let output = std::process::Command::new("cmd")
                    .arg("/C")
                    .arg("mklink")
                    .arg("/J")
                    .arg(link)
                    .arg(target)
                    .output()
                    .map_err(|error| {
                        format!("符号链接失败（{symlink_error}），目录联接也无法启动：{error}")
                    })?;
                if !output.status.success() {
                    return Err(format!(
                        "符号链接与目录联接都不可用：{symlink_error} / {}",
                        String::from_utf8_lossy(&output.stderr).trim()
                    ));
                }
                if link.is_dir() {
                    Ok(())
                } else {
                    Err("目录联接创建后不可用".to_owned())
                }
            }
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (target, link);
        Err("当前平台不支持目录链接".to_owned())
    }
}

/// 尝试创建指向文件的符号链接。Windows 上需要额外权限，不可用时返回 Err。
pub fn try_file_link(target: &Path, link: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, link)
            .map_err(|error| format!("创建文件符号链接失败：{error}"))
    }
    #[cfg(windows)]
    {
        std::os::windows::fs::symlink_file(target, link)
            .map_err(|error| format!("Windows 创建文件符号链接需要开发者模式或管理员权限：{error}"))
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (target, link);
        Err("当前平台不支持文件符号链接".to_owned())
    }
}

pub fn git_raw(dir: &Path, args: &[&str]) -> Output {
    Command::new("git")
        .current_dir(dir)
        .args(args)
        .env("GIT_AUTHOR_NAME", "SOXU Test")
        .env("GIT_AUTHOR_EMAIL", "soxu-test@example.invalid")
        .env("GIT_COMMITTER_NAME", "SOXU Test")
        .env("GIT_COMMITTER_EMAIL", "soxu-test@example.invalid")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .expect("运行 git")
}

pub fn git(dir: &Path, args: &[&str]) -> String {
    let output = git_raw(dir, args);
    assert!(
        output.status.success(),
        "git {:?} 失败：{}\n{}",
        args,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).to_string()
}

/// 建一个带一次提交的 main 分支仓库（a.txt 内容为 "one"）。
pub fn init_repo(sandbox: &Sandbox) -> PathBuf {
    let repo = sandbox.path("repo");
    std::fs::create_dir_all(&repo).expect("创建仓库目录");
    git(&repo, &["init", "-b", "main", "."]);
    std::fs::write(repo.join("a.txt"), "one\n").expect("写入初始文件");
    git(&repo, &["add", "a.txt"]);
    git(&repo, &["commit", "-m", "init"]);
    repo
}
