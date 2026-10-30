//! 终端（PTY）的 IPC 数据形态。字段名统一 camelCase，与 `terminal/ptyClient.ts` 对应。

use serde::Serialize;

/// 新建终端的返回：ptyId 由后端分配，前端不得自行构造。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtySessionView {
    pub pty_id: String,
    /// 子进程 pid；拿不到时为 null（只影响诊断，不影响使用）。
    pub pid: Option<u32>,
    pub cols: u16,
    pub rows: u16,
    /// 实际启动的 shell 程序（已解析成绝对路径）。
    pub shell: String,
}

/// 关闭终端的返回：`existed: false` 表示这个 ptyId 本来就不在注册表里（幂等）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyClosedView {
    pub pty_id: String,
    pub existed: bool,
    /// 子进程是否已被确认回收。false 表示等待超时，需要按残留进程处理。
    pub exited: bool,
    pub exit_code: Option<i32>,
}
