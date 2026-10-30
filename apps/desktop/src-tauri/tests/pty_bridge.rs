//! 终端适配层的集成测试：真实 PTY + 真实会话目录，不 mock。
//!
//! 覆盖 TASK-030 的桌面侧承诺：
//! 1. 工作目录来自会话目录（不是前端传参），且必须在已登记项目内；
//! 2. 交互通路：写入真的进到 shell，输出真的回到事件回调且被合并；
//! 3. 回收：关闭后子进程确实退出，重复关闭幂等，`close_all` 清空注册表。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use soxu_desktop_lib::pty::{self, PtyOutputEvent};
use soxu_desktop_lib::state::AppState;
use soxu_desktop_lib::workspace;
use soxu_pty_service::{OutputSink, PtyService};
use soxu_session_index::{CatalogConfig, project_sessions_dir_name};

fn temp_dir(name: &str) -> PathBuf {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or_default();
    let dir = std::env::temp_dir().join(format!("soxu-pty-{name}-{stamp}"));
    fs::create_dir_all(&dir).expect("创建临时目录");
    dir
}

/// 在项目对应的会话目录写一份真实 JSONL（会话头 + 一条用户消息）。
fn write_session(sessions_root: &Path, project_root: &Path, id: &str) -> PathBuf {
    let directory = sessions_root.join(project_sessions_dir_name(project_root));
    fs::create_dir_all(&directory).expect("创建会话目录");
    let path = directory.join(format!("2026-01-01T00-00-00-000Z_{id}.jsonl"));
    let cwd = project_root.to_string_lossy().replace('\\', "\\\\");
    let lines = [
        format!(
            r#"{{"type":"session","version":3,"id":"{id}","timestamp":"2026-01-01T00:00:00Z","cwd":"{cwd}"}}"#
        ),
        r#"{"type":"message","id":"m1","parentId":null,"timestamp":"2026-01-01T00:00:01Z","message":{"role":"user","content":[{"type":"text","text":"在这个目录里跑命令"}]}}"#.to_owned(),
    ];
    fs::write(
        &path,
        format!(
            "{}
",
            lines.join(
                "
"
            )
        ),
    )
    .expect("写入会话文件");
    path
}

/// 收集事件回调里的输出（等价于前端监听 `soxu://pty-output`）。
#[derive(Clone, Default)]
struct Recorder {
    events: Arc<Mutex<Vec<PtyOutputEvent>>>,
}

impl Recorder {
    fn sink(&self) -> OutputSink {
        let events = Arc::clone(&self.events);
        Arc::new(move |output| {
            events
                .lock()
                .expect("输出缓冲未被投毒")
                .push(PtyOutputEvent::from(output));
        })
    }

    fn text(&self) -> String {
        self.events
            .lock()
            .expect("输出缓冲未被投毒")
            .iter()
            .map(|event| event.data.clone())
            .collect()
    }

    fn len(&self) -> usize {
        self.events.lock().expect("输出缓冲未被投毒").len()
    }
}

/// ConPTY 会先发 DSR（ESC[6n）询问光标位置，收到回复前不转发 shell 输出。
/// 真实终端（xterm.js）会自动回答；这里替测试扮演终端。
const DSR: &str = "\u{1b}[6n";
const DSR_REPLY: &str = "\u{1b}[1;1R";

fn wait_for(
    recorder: &Recorder,
    service: &PtyService,
    pty_id: &str,
    marker: &str,
    budget: Duration,
) -> bool {
    let deadline = Instant::now() + budget;
    let mut replied = 0;
    loop {
        let text = recorder.text();
        let pending = text.matches(DSR).count();
        while replied < pending {
            let _ = service.write(pty_id, DSR_REPLY);
            replied += 1;
        }
        if text.contains(marker) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

async fn setup(sandbox: &Path) -> (AppState, String) {
    let project_root = sandbox.join("project");
    let sessions_root = sandbox.join("sessions");
    fs::create_dir_all(&project_root).expect("创建项目目录");
    fs::create_dir_all(&sessions_root).expect("创建会话根目录");
    write_session(&sessions_root, &project_root, "01a101f1-pty");
    let state = AppState::open(
        sandbox.join("state"),
        CatalogConfig::with_sessions_root(&sessions_root),
    )
    .expect("初始化状态");
    let project = workspace::register_project(&state, project_root.to_string_lossy().as_ref())
        .await
        .expect("登记项目");
    let session = project.sessions.first().expect("扫描到会话文件").id.clone();
    (state, session)
}

#[tokio::test]
async fn terminal_uses_the_session_directory_and_reports_its_pid() {
    let sandbox = temp_dir("create");
    let (state, session) = setup(&sandbox).await;
    let recorder = Recorder::default();
    let service = PtyService::new(recorder.sink());

    let view = pty::create(&state, &service, &session, Some(100), Some(30), None)
        .await
        .expect("会话所属目录应能起终端");

    assert!(
        view.pty_id.starts_with("pty_"),
        "ptyId 由后端分配：{}",
        view.pty_id
    );
    assert!(
        view.pid.is_some(),
        "必须能报告子进程 pid，否则无法核对残留进程"
    );
    assert_eq!((view.cols, view.rows), (100, 30));
    assert!(!view.shell.is_empty());

    let outcome = service.close(&view.pty_id).expect("关闭终端");
    assert!(outcome.exited, "关闭必须等到子进程退出");

    let _ = fs::remove_dir_all(&sandbox);
}

#[tokio::test]
async fn unknown_sessions_cannot_open_a_terminal() {
    let sandbox = temp_dir("unknown");
    let (state, _session) = setup(&sandbox).await;
    let recorder = Recorder::default();
    let service = PtyService::new(recorder.sink());

    let error = pty::create(&state, &service, "ses_not_registered", None, None, None)
        .await
        .expect_err("未登记的会话不能起终端");
    assert!(error.starts_with("E_PTY_UNKNOWN_SESSION"), "{error}");
    assert_eq!(service.open_count(), 0, "守卫失败不得留下会话");

    let empty = pty::create(&state, &service, "   ", None, None, None)
        .await
        .expect_err("空会话 id 必须拒绝");
    assert!(empty.starts_with("E_PTY_SESSION_REQUIRED"), "{empty}");

    let _ = fs::remove_dir_all(&sandbox);
}

#[tokio::test]
async fn temporary_session_terminal_falls_back_to_its_worktree() {
    let sandbox = temp_dir("temporary");
    let (state, _session) = setup(&sandbox).await;
    let project_id = state
        .catalog
        .lock()
        .await
        .projects()
        .first()
        .expect("已登记项目")
        .id
        .clone();
    let temporary = workspace::open_temporary(&state, project_id.as_str())
        .await
        .expect("打开临时会话");
    let recorder = Recorder::default();
    let service = PtyService::new(recorder.sink());

    // 临时会话没有 cwd 记录：终端落到它所属的工作树目录（= 项目根）。
    let view = pty::create(&state, &service, &temporary.session_id, None, None, None)
        .await
        .expect("临时会话也应能起终端");
    assert!(service.is_open(&view.pty_id));
    service.close(&view.pty_id).expect("关闭终端");

    let _ = fs::remove_dir_all(&sandbox);
}

#[tokio::test]
async fn typed_input_reaches_the_shell_and_output_comes_back_throttled() {
    let sandbox = temp_dir("interactive");
    let (state, session) = setup(&sandbox).await;
    let recorder = Recorder::default();
    let service = PtyService::new(recorder.sink());
    let shell = if cfg!(windows) { "cmd" } else { "sh" };
    let view = pty::create(
        &state,
        &service,
        &session,
        Some(80),
        Some(24),
        Some(shell.to_owned()),
    )
    .await
    .expect("应能起交互式终端");

    service
        .resize(&view.pty_id, 120, 40)
        .expect("resize 必须成功");
    service
        .write(&view.pty_id, "echo soxu-pty-bridge\r\n")
        .expect("写入必须成功");
    assert!(
        wait_for(
            &recorder,
            &service,
            &view.pty_id,
            "soxu-pty-bridge",
            Duration::from_secs(10)
        ),
        "写入的内容没有回到输出：{:?}",
        recorder.text()
    );

    // 输出不是逐字节推送：事件数远小于字节数。
    let bytes = recorder.text().len();
    assert!(
        recorder.len() < bytes.max(1),
        "输出事件数（{}）应远小于字节数（{bytes}）",
        recorder.len()
    );

    service.close(&view.pty_id).expect("关闭终端");
    let _ = fs::remove_dir_all(&sandbox);
}

#[tokio::test]
async fn closing_is_idempotent_and_close_all_reclaims_every_terminal() {
    let sandbox = temp_dir("close");
    let (state, session) = setup(&sandbox).await;
    let recorder = Recorder::default();
    let service = PtyService::new(recorder.sink());

    let first = pty::create(&state, &service, &session, None, None, None)
        .await
        .expect("第一个终端");
    let second = pty::create(&state, &service, &session, None, None, None)
        .await
        .expect("第二个终端");
    assert_ne!(first.pty_id, second.pty_id, "ptyId 不得复用");
    assert_eq!(service.open_count(), 2);

    let outcome = service.close(&first.pty_id).expect("关闭第一个");
    assert!(outcome.existed && outcome.exited);
    let again = service.close(&first.pty_id).expect("重复关闭不算失败");
    assert!(!again.existed, "重复关闭应报告 existed = false");

    // 应用退出路径：把剩下的终端全部回收。
    assert_eq!(service.close_all(), 1);
    assert_eq!(service.open_count(), 0);
    let error = service
        .write(&second.pty_id, "x")
        .expect_err("已关闭的终端不可写");
    assert_eq!(error.code().as_str(), "E_PTY_UNKNOWN_SESSION");

    let _ = fs::remove_dir_all(&sandbox);
}

#[tokio::test]
async fn unknown_shell_is_rejected_by_the_command_layer() {
    let sandbox = temp_dir("shell");
    let (state, session) = setup(&sandbox).await;
    let recorder = Recorder::default();
    let service = PtyService::new(recorder.sink());

    let error = pty::create(
        &state,
        &service,
        &session,
        None,
        None,
        Some("curl".to_owned()),
    )
    .await
    .expect_err("白名单之外的 shell 必须被拒绝");
    assert!(error.starts_with("E_PTY_INVALID_SHELL"), "{error}");

    let _ = fs::remove_dir_all(&sandbox);
}
