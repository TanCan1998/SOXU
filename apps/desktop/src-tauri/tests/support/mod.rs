//! 桌面端集成测试的共享夹具：独立临时沙箱 + 跨平台目录链接。
//!
//! 每个测试用独立目录，Drop 时清理；不依赖用户全局配置、不访问网络。

#![allow(dead_code)]

use std::path::{Path, PathBuf};

pub struct Sandbox {
    root: PathBuf,
}

impl Sandbox {
    pub fn new(name: &str) -> Self {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or_default();
        let root = std::env::temp_dir().join(format!("soxu-files-{name}-{stamp}"));
        std::fs::create_dir_all(&root).expect("创建测试沙箱");
        Self { root }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn path(&self, relative: &str) -> PathBuf {
        self.root.join(relative)
    }
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// 尝试创建指向目录的链接：Unix 用符号链接，Windows 先试符号链接、再退化为目录联接。
///
/// Windows 上普通用户创建符号链接需要开发者模式或管理员权限，目录联接（junction）不需要。
/// 两者都不可用时返回 Err，由测试显式记录平台差异，而不是让用例静默变成绿灯。
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
