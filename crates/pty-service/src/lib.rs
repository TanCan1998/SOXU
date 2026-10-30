//! # soxu-pty-service
//!
//! SOXU 的终端服务：跨平台 PTY（Windows 走 ConPTY、Unix 走 forkpty）+ **16ms 输出合并**。
//!
//! ## 边界
//! - 本 crate 只认「一个 shell 进程 + 一个 PTY」：不认 SessionId / ProjectId，不写 Pi
//!   会话文件，也不认识 Tauri。谁在什么时候开终端、终端的标题是什么，属于桌面层。
//! - 输出不逐字节推送：合并窗口内的分片会合并成一次回调（见 crate::output）。
//! - 输出按 UTF-8 字符边界切分，半个多字节字符不会被解码成替换字符。
//! - 关闭是唯一权威的回收动作：kill 子进程 → 释放 PTY → 有界等待退出；
//!   PtySession 被丢弃时也会走同一路径，避免孤儿进程。
//! - shell 只允许白名单内的程序，参数走结构化 argv，不拼接命令行文本。
//!
//! ## 典型流程
//!
//! 1. PtyService::new(sink)：sink 是输出回调（桌面层在这里 emit 前端事件）。
//! 2. service.create(PtyRequest)：分配 ptyId 并拉起 shell。
//! 3. service.write / service.resize：转发用户输入与尺寸变化。
//! 4. service.close(id)：回收子进程；应用退出时用 service.close_all()。

mod error;
mod manager;
mod output;
mod session;
mod shell;

pub use error::{PtyError, PtyErrorCode, Result};
pub use manager::{DEFAULT_MAX_SESSIONS, PtyRequest, PtyService, PtySessionInfo};
pub use output::{FLUSH_INTERVAL, MAX_PENDING_BYTES, OutputThrottle, PtyOutput};
pub use session::{MAX_DIMENSION, OutputSink, PtyCloseOutcome, PtySession, PtySpec, validate_size};
pub use shell::{ALLOWED_SHELLS, ShellSpec, default_program};
