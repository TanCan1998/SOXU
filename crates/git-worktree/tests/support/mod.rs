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
