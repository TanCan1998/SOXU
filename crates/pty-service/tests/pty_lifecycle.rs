//! 真实 PTY 的集成测试：拉起真 shell，验证交互、节流与关闭后不留孤儿。
//!
//! 这些用例会真的创建 ConPTY / forkpty 并起子进程，因此在 Windows 与 Linux 上都跑
//! （CI 是 ubuntu-24.04，本机是 Windows 11）。不依赖外网、不依赖 Pi。

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use soxu_pty_service::{
    FLUSH_INTERVAL, OutputSink, PtyOutput, PtyRequest, PtyService, PtySpec, ShellSpec,
};

/// 收集输出，供测试断言。
#[derive(Clone, Default)]
struct Recorder {
    outputs: Arc<Mutex<Vec<PtyOutput>>>,
}

impl Recorder {
    fn sink(&self) -> OutputSink {
        let outputs = Arc::clone(&self.outputs);
        Arc::new(move |output: PtyOutput| {
            outputs.lock().expect("输出缓冲未被投毒").push(output);
        })
    }

    fn chunks(&self) -> Vec<PtyOutput> {
        self.outputs.lock().expect("输出缓冲未被投毒").clone()
    }

    fn text(&self) -> String {
        self.chunks().into_iter().map(|chunk| chunk.data).collect()
    }
}

/// ConPTY 启动时会先发一条 DSR（ESC[6n，查询光标位置），在收到回复之前不会转发
/// shell 的真实输出。真实终端（xterm.js）会自动回答；这里替测试扮演这个角色，
/// 否则 Windows 上只能看到一条 "\u{1b}[6n" 就再无下文。
const DSR: &str = "\u{1b}[6n";
const DSR_REPLY: &str = "\u{1b}[1;1R";

/// 等 marker 出现，同时回答 ConPTY 的光标位置查询。
fn wait_for_output(
    recorder: &Recorder,
    service: &PtyService,
    id: &str,
    marker: &str,
    budget: Duration,
) -> bool {
    wait_until_replying(recorder, service, id, budget, || {
        recorder.text().contains(marker)
    })
}

/// 一边回答 ConPTY 的 DSR 查询、一边轮询条件。
///
/// ConPTY 在收到回应之前**连子进程都不会真正开跑**（只会吐出那一条 ESC[6n），
/// 所以「等 shell 自己退出」这类用例必须先扮演终端，否则测到的只是「ConPTY 在等回应」。
fn wait_until_replying(
    recorder: &Recorder,
    service: &PtyService,
    id: &str,
    budget: Duration,
    mut condition: impl FnMut() -> bool,
) -> bool {
    let deadline = Instant::now() + budget;
    let mut replied = 0;
    loop {
        let pending = recorder.text().matches(DSR).count();
        while replied < pending {
            let _ = service.write(id, DSR_REPLY);
            replied += 1;
        }
        if condition() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// 跨平台的「跑一条命令」shell：Windows 用 cmd /C，Unix 用 sh -c。
fn shell_for(command: &str) -> ShellSpec {
    let (program, args): (&str, Vec<String>) = if cfg!(windows) {
        ("cmd", vec!["/C".to_owned(), command.to_owned()])
    } else {
        ("sh", vec!["-c".to_owned(), command.to_owned()])
    };
    ShellSpec::new(program, args).expect("cmd / sh 必须在 shell 白名单内")
}

fn temp_dir(name: &str) -> std::path::PathBuf {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or_default();
    let dir = std::env::temp_dir().join(format!("soxu-pty-{name}-{stamp}"));
    std::fs::create_dir_all(&dir).expect("创建临时目录");
    dir
}

#[test]
fn real_shell_output_round_trips_through_the_pty() {
    let recorder = Recorder::default();
    let service = PtyService::new(recorder.sink());
    let info = service
        .create_with(PtySpec {
            id: "pty_round_trip".to_owned(),
            cols: 100,
            rows: 30,
            cwd: None,
            shell: shell_for("echo soxu-pty-ok"),
        })
        .expect("应能创建 PTY");

    assert_eq!(info.cols, 100);
    assert_eq!(info.rows, 30);
    assert!(
        info.pid.is_some(),
        "必须能拿到子进程 pid，否则无法核对孤儿进程"
    );
    // 这里不断言 is_open：`echo` 会立刻退出，读取流可能在断言前就结束，
    // 那时 is_open 为 false 是**正确**行为（见 a_shell_that_exits_by_itself_*）。
    // 终端是否可用由下面的输出断言覆盖。

    assert!(
        wait_for_output(
            &recorder,
            &service,
            "pty_round_trip",
            "soxu-pty-ok",
            Duration::from_secs(10)
        ),
        "终端输出没有回传：{:?}",
        recorder.text()
    );

    let outcome = service.close("pty_round_trip").expect("关闭终端");
    assert!(outcome.existed);
    assert_eq!(service.open_count(), 0);
}

#[test]
fn closing_a_terminal_reclaims_the_shell_process() {
    // 长时间运行的子进程：如果不 kill，测试进程退出后它会变成孤儿。
    let command = if cfg!(windows) {
        "ping -n 60 127.0.0.1"
    } else {
        "sleep 60"
    };
    let recorder = Recorder::default();
    let service = PtyService::new(recorder.sink());
    let info = service
        .create_with(PtySpec {
            id: "pty_orphan_check".to_owned(),
            cols: 80,
            rows: 24,
            cwd: None,
            shell: shell_for(command),
        })
        .expect("应能创建 PTY");
    let pid = info.pid.expect("必须有 pid");

    let outcome = service.close("pty_orphan_check").expect("关闭终端");
    assert!(outcome.existed);
    assert!(
        outcome.exited,
        "关闭必须等到子进程真的退出（pid {pid}），否则就是留了孤儿"
    );
    assert!(outcome.exit_code.is_some(), "必须拿到退出码");
    assert!(outcome.threads_finished, "转发线程必须在关闭时结束");
    assert!(!service.is_open("pty_orphan_check"));

    // 关闭是幂等的：第二次不报错，也不会再动任何进程。
    let again = service.close("pty_orphan_check").expect("重复关闭不算失败");
    assert!(!again.existed);

    // 关闭之后再写必须被明确拒绝，而不是写进一个已死的管道。
    let error = service
        .write("pty_orphan_check", "x")
        .expect_err("已关闭的终端不可写");
    assert_eq!(error.code().as_str(), "E_PTY_UNKNOWN_SESSION");
}

#[test]
fn write_and_resize_reach_the_running_shell() {
    // 交互式 shell：先起一个持续进程，再用 write 送命令、用 resize 改尺寸。
    let command = if cfg!(windows) { "cmd" } else { "sh" };
    let recorder = Recorder::default();
    let service = PtyService::new(recorder.sink());
    service
        .create_with(PtySpec {
            id: "pty_interactive".to_owned(),
            cols: 80,
            rows: 24,
            cwd: None,
            shell: shell_for(command),
        })
        .expect("应能创建交互式 PTY");

    service
        .resize("pty_interactive", 120, 40)
        .expect("resize 必须成功");

    // 写入一条会回显的命令：命令本身出现在输出里就说明输入真的进了 shell。
    service
        .write("pty_interactive", "echo soxu-pty-write\r\n")
        .expect("写入必须成功");
    assert!(
        wait_for_output(
            &recorder,
            &service,
            "pty_interactive",
            "soxu-pty-write",
            Duration::from_secs(10)
        ),
        "写入的内容没有回到输出：{:?}",
        recorder.text()
    );

    // 非法尺寸被拒绝，且不会把终端搞坏。
    let error = service
        .resize("pty_interactive", 0, 24)
        .expect_err("0 列必须被拒绝");
    assert_eq!(error.code().as_str(), "E_PTY_INVALID_SIZE");
    assert!(service.is_open("pty_interactive"));

    service.close("pty_interactive").expect("关闭终端");
}

#[test]
fn large_output_is_coalesced_into_a_few_events() {
    // 2000 行 ≈ 20 KiB：逐字节推送会产生上千次事件，节流后应该只有个位数。
    const LINES: usize = 2000;
    let dir = temp_dir("throttle");
    let file = dir.join("big.txt");
    let mut content = String::new();
    for index in 0..LINES {
        content.push_str(&format!("line-{index}\n"));
    }
    std::fs::write(&file, &content).expect("写临时文件");

    let command = if cfg!(windows) {
        format!("type {}", file.display())
    } else {
        format!("cat {}", file.display())
    };
    let recorder = Recorder::default();
    let service = PtyService::new(recorder.sink());
    service
        .create_with(PtySpec {
            id: "pty_throttle".to_owned(),
            cols: 120,
            rows: 40,
            cwd: Some(dir.clone()),
            shell: shell_for(&command),
        })
        .expect("应能创建 PTY");

    assert!(
        wait_for_output(
            &recorder,
            &service,
            "pty_throttle",
            &format!("line-{}", LINES - 1),
            Duration::from_secs(20)
        ),
        "大输出没有完整回传（节流不得丢字节）：{:?}",
        recorder.text()
    );
    let chunks = recorder.chunks();
    let text = recorder.text();
    assert!(text.contains("line-0"), "第一行必须在");
    assert!(
        chunks.len() < LINES / 4,
        "输出必须被合并：{LINES} 行产生了 {} 次推送（窗口 {}ms）",
        chunks.len(),
        FLUSH_INTERVAL.as_millis()
    );
    // seq 单调递增：合并器是唯一出口，不存在两路并发推送。
    for (expected, chunk) in (1..).zip(chunks.iter()) {
        assert_eq!(chunk.seq, expected, "seq 必须连续递增");
    }

    service.close("pty_throttle").expect("关闭终端");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_shell_that_exits_by_itself_releases_its_session_slot() {
    // 用户在终端里敲 exit 不走 close_pty：只有「显式关闭」才会置 closed 标志。
    // 若注册表只看 is_closed，死终端会一直占着上限（默认 8 个），
    // 表现为「开关几次之后再也开不出终端」。
    let recorder = Recorder::default();
    let service = PtyService::with_limit(recorder.sink(), 1);
    let exited = service
        .create_with(PtySpec {
            id: "pty_self_exit".to_owned(),
            cols: 80,
            rows: 24,
            cwd: None,
            shell: shell_for("exit 0"),
        })
        .expect("应能创建 PTY");

    assert!(
        wait_until_replying(
            &recorder,
            &service,
            &exited.id,
            Duration::from_secs(10),
            || !service.is_open(&exited.id)
        ),
        "shell 自行退出后必须不再算作可交互的终端"
    );
    assert_eq!(service.open_count(), 0, "自行退出的终端不得计入打开数量");

    // 上限是 1：还能再开一个，说明死终端没有占位。
    let next = service
        .create_with(PtySpec {
            id: "pty_after_exit".to_owned(),
            cols: 80,
            rows: 24,
            cwd: None,
            shell: shell_for(if cfg!(windows) {
                "ping -n 60 127.0.0.1"
            } else {
                "sleep 60"
            }),
        })
        .expect("自行退出的终端不得占用会话上限");
    assert!(service.is_open(&next.id));

    let outcome = service.close(&next.id).expect("关闭终端");
    assert!(outcome.exited, "关闭必须等到子进程退出");
    assert_eq!(service.open_count(), 0);
}

#[test]
fn session_limit_rejects_extra_terminals() {
    let recorder = Recorder::default();
    let service = PtyService::with_limit(recorder.sink(), 1);
    let spec = |id: &str| PtySpec {
        id: id.to_owned(),
        cols: 80,
        rows: 24,
        cwd: None,
        shell: shell_for(if cfg!(windows) {
            "ping -n 60 127.0.0.1"
        } else {
            "sleep 60"
        }),
    };
    service
        .create_with(spec("pty_a"))
        .expect("第一个终端应成功");
    let error = service
        .create_with(spec("pty_b"))
        .expect_err("超过上限必须被拒绝");
    assert_eq!(error.code().as_str(), "E_PTY_SESSION_LIMIT");
    assert_eq!(service.open_count(), 1);

    // close_all 是退出路径：必须把所有子进程都回收掉。
    assert_eq!(service.close_all(), 1);
    assert_eq!(service.open_count(), 0);
}

#[test]
fn default_request_uses_a_whitelisted_shell() {
    let recorder = Recorder::default();
    let service = PtyService::new(recorder.sink());
    // 不指定 shell：走平台默认（Windows 优先 pwsh，Unix 优先 bash/zsh/sh）。
    let info = service
        .create(PtyRequest {
            cols: Some(80),
            rows: Some(24),
            cwd: None,
            shell: None,
        })
        .expect("默认 shell 应能启动");
    assert!(
        info.shell.to_ascii_lowercase().contains("pwsh")
            || info.shell.to_ascii_lowercase().contains("powershell")
            || info.shell.to_ascii_lowercase().contains("cmd")
            || info.shell.to_ascii_lowercase().contains("sh"),
        "默认 shell 异常：{}",
        info.shell
    );
    let outcome = service.close(&info.id).expect("关闭终端");
    assert!(outcome.exited);
}
