//! 集成测试公共夹具：临时目录与 Pi JSONL 行生成器。
//!
//! JSON 一律用 serde_json 构造，避免手工转义带来的脆弱测试。
#![allow(dead_code)]

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{Value, json};

static COUNTER: AtomicU64 = AtomicU64::new(0);

pub struct TempDir {
    path: PathBuf,
}

impl TempDir {
    pub fn new(label: &str) -> Self {
        let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "soxu-session-index-{label}-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("创建临时目录");
        Self { path }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn child(&self, name: &str) -> PathBuf {
        self.path.join(name)
    }

    pub fn mkdir(&self, name: &str) -> PathBuf {
        let path = self.child(name);
        fs::create_dir_all(&path).expect("创建子目录");
        path
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        // 夹具清理失败也忽略，不掩盖测试断言结果。
        let _ = fs::remove_dir_all(&self.path);
    }
}

pub fn header_line(session_id: &str, cwd: &str) -> String {
    json!({
        "type": "session",
        "version": 3,
        "id": session_id,
        "timestamp": "2026-01-01T00:00:00.000Z",
        "cwd": cwd,
    })
    .to_string()
}

pub fn message_value(id: &str, parent: Option<&str>, role: &str, text: &str) -> Value {
    json!({
        "type": "message",
        "id": id,
        "parentId": parent,
        "timestamp": "2026-01-01T00:00:01.000Z",
        "message": {
            "role": role,
            "content": text,
            "timestamp": 1_767_225_601_000_u64,
        },
    })
}

pub fn message_line(id: &str, parent: Option<&str>, role: &str, text: &str) -> String {
    message_value(id, parent, role, text).to_string()
}

pub fn write_text(path: &Path, text: &str) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("创建父目录");
    }
    fs::write(path, text).expect("写入文件");
}

pub fn append_text(path: &Path, text: &str) {
    let mut file = fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(path)
        .expect("打开待追加文件");
    file.write_all(text.as_bytes()).expect("追加内容");
    file.flush().expect("刷新文件");
}

/// 生成 n 条消息（含头部）的完整会话文本。
pub fn session_text(session_id: &str, cwd: &str, messages: usize) -> String {
    let mut text = header_line(session_id, cwd);
    text.push('\n');
    let mut previous: Option<String> = None;
    for index in 0..messages {
        let id = format!("m{index:06}");
        let role = if index % 2 == 0 { "user" } else { "assistant" };
        text.push_str(&message_line(
            &id,
            previous.as_deref(),
            role,
            &format!("message {index}"),
        ));
        text.push('\n');
        previous = Some(id);
    }
    text
}

pub fn session_dir(sessions_root: &Path, worktree: &Path) -> PathBuf {
    sessions_root.join(soxu_session_index::project_sessions_dir_name(worktree))
}
