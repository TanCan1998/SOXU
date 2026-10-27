//! 集成测试共用：真实子进程夹具与断言工具。
#![allow(dead_code)]

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};

/// Node 是已批准的测试期依赖（与 agent-runtime 夹具一致）；缺失时测试显式跳过。
pub fn node_available() -> bool {
    let node = std::env::var("NODE_BINARY").unwrap_or_else(|_| "node".to_owned());
    Command::new(node)
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join(name)
}

/// 真实内存占用子进程；`Drop` 保证任何断言失败都不会留下孤儿进程。
pub struct Hog {
    child: Child,
    stdout: Option<BufReader<std::process::ChildStdout>>,
    mb: u32,
}

impl Hog {
    pub fn spawn(megabytes: u32, hold_ms: u32, children: u32) -> Self {
        let node = std::env::var("NODE_BINARY").unwrap_or_else(|_| "node".to_owned());
        let mut child = Command::new(node)
            .arg(fixture("hog.mjs"))
            .arg(megabytes.to_string())
            .arg(hold_ms.to_string())
            .arg(children.to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn hog fixture");
        let stdout = child.stdout.take().map(BufReader::new);
        Self {
            child,
            stdout,
            mb: megabytes,
        }
    }

    pub fn pid(&self) -> u32 {
        self.child.id()
    }

    pub fn megabytes(&self) -> u32 {
        self.mb
    }

    /// 等到夹具确认内存已经写完，避免采样到「刚 spawn 还没占内存」的瞬间。
    pub fn wait_ready(&mut self) {
        let reader = self.stdout.as_mut().expect("stdout 必须被 pipe");
        let mut line = String::new();
        reader.read_line(&mut line).expect("读取 ready 行");
        assert!(
            line.starts_with("ready "),
            "夹具没有报告 ready，实际是 {line:?}"
        );
    }

    pub fn is_running(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }
}

impl Drop for Hog {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// 轻量的内存格式化，只用于测试输出。
pub fn mib(bytes: u64) -> String {
    format!("{:.1} MiB", bytes as f64 / (1024.0 * 1024.0))
}
