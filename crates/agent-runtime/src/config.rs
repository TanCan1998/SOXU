//! Supervisor 的启动参数与预算。所有可调项都有小默认值，避免无上限等待。

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// 默认从 Pi 子进程环境清除的凭据变量（agents/policies/security.md）。
pub const SECRET_ENV_VARS: [&str; 3] = ["GH_TOKEN", "GITHUB_TOKEN", "ATOMGIT_TOKEN"];

/// 子进程启动计划：结构化 argv，不经过 shell 拼接。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PiProgram {
    program: OsString,
    args: Vec<OsString>,
    current_dir: Option<PathBuf>,
    env_remove: Vec<OsString>,
}

impl PiProgram {
    /// 默认清除 SECRET_ENV_VARS 中的凭据变量。
    pub fn new(program: impl Into<OsString>) -> Self {
        Self {
            program: program.into(),
            args: Vec::new(),
            current_dir: None,
            env_remove: SECRET_ENV_VARS.iter().map(OsString::from).collect(),
        }
    }

    /// 产品默认入口：pi --mode rpc。
    pub fn pi_rpc() -> Self {
        Self::new("pi").with_args(["--mode", "rpc"])
    }

    pub fn with_program(mut self, program: impl Into<OsString>) -> Self {
        self.program = program.into();
        self
    }

    pub fn with_arg(mut self, arg: impl Into<OsString>) -> Self {
        self.args.push(arg.into());
        self
    }

    pub fn with_args<I, S>(mut self, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        self.args.extend(args.into_iter().map(Into::into));
        self
    }

    pub fn with_current_dir(mut self, dir: impl Into<PathBuf>) -> Self {
        self.current_dir = Some(dir.into());
        self
    }

    pub fn with_env_removed<I, S>(mut self, names: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        self.env_remove.extend(names.into_iter().map(Into::into));
        self
    }

    pub fn program(&self) -> &OsStr {
        &self.program
    }

    pub fn args(&self) -> &[OsString] {
        &self.args
    }

    pub fn current_dir(&self) -> Option<&Path> {
        self.current_dir.as_deref()
    }

    pub fn env_removed(&self) -> &[OsString] {
        &self.env_remove
    }

    /// 诊断用的可读描述（不含密钥，仅程序名与参数）。
    pub fn describe(&self) -> String {
        let mut text = self.program.to_string_lossy().into_owned();
        for arg in &self.args {
            text.push(' ');
            text.push_str(&arg.to_string_lossy());
        }
        text
    }
}

/// Supervisor 行为预算。默认值偏保守，测试会显式缩短。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SupervisorConfig {
    /// 命令接收（response）的最长等待。
    pub response_timeout: Duration,
    /// 启动握手的超时；握手失败按启动失败处理。
    pub handshake_timeout: Duration,
    /// 停止时发送 abort 的等待上限。
    pub cancel_timeout: Duration,
    /// 关闭 stdin 后等待进程自行退出的宽限期。
    pub shutdown_grace: Duration,
    /// 强制终止后等待回收的上限。
    pub kill_timeout: Duration,
    /// 事件通道容量；高频事件满了就计数丢弃，控制事件优先。
    pub event_capacity: usize,
    /// stderr 诊断环保留的行数。
    pub stderr_ring: usize,
    /// 单条 NDJSON 记录字节上限。
    pub max_frame_bytes: usize,
    /// handle 侧事件积压上限（wait_settled 期间暂存）。
    pub backlog_capacity: usize,
}

impl Default for SupervisorConfig {
    fn default() -> Self {
        Self {
            response_timeout: Duration::from_secs(30),
            handshake_timeout: Duration::from_secs(20),
            cancel_timeout: Duration::from_secs(2),
            shutdown_grace: Duration::from_secs(5),
            kill_timeout: Duration::from_secs(2),
            event_capacity: 256,
            stderr_ring: 32,
            max_frame_bytes: soxu_pi_protocol::MAX_RECORD_BYTES,
            backlog_capacity: 64,
        }
    }
}

impl SupervisorConfig {
    /// 测试与快速冒烟用的短预算。
    pub fn fast() -> Self {
        Self {
            response_timeout: Duration::from_millis(500),
            handshake_timeout: Duration::from_millis(1500),
            cancel_timeout: Duration::from_millis(500),
            shutdown_grace: Duration::from_millis(1500),
            kill_timeout: Duration::from_millis(1000),
            ..Self::default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pi_rpc_uses_structured_args() {
        let program = PiProgram::pi_rpc();
        assert_eq!(program.program(), OsStr::new("pi"));
        assert_eq!(
            program.args(),
            [OsString::from("--mode"), OsString::from("rpc")]
        );
        assert!(program.env_removed().iter().any(|name| name == "GH_TOKEN"));
    }

    #[test]
    fn describe_never_includes_env_values() {
        let program = PiProgram::new("pi").with_args(["--mode", "rpc"]);
        let text = program.describe();
        assert_eq!(text, "pi --mode rpc");
    }
}
