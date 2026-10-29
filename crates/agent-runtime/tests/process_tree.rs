//! P-03 验收：退出后受管进程树清理。
//!
//! 复现（Windows 已实机跑过，Linux 有实现但未实机验证，macOS 无 PID 探测实现会自动跳过）：
//!
//! ```powershell
//! # 在 SOXU 仓库根目录执行；环境变量存在时把证据写进 docs/development/evidence/m2-process-tree/
//! $env:SOXU_PROCESS_TREE_EVIDENCE_DIR = "docs/development/evidence/m2-process-tree"
//! cargo test -p soxu-agent-runtime --test process_tree -- --nocapture --test-threads=1
//! ```
//!
//! 两个场景：
//! 1. 正常关闭：两个会话各自带两个孙进程（root → leaf），`PiSupervisor::shutdown()`
//!    后整棵树必须消失，残留计数为 0；
//! 2. 强制终止：根进程拒绝随 stdin 关闭退出，supervisor 只能 `start_kill` 根进程。
//!    孙进程会短暂存活（尚未做 Job Object / 进程组治理），由测试作为上层 owner 显式
//!    释放并断言最终归零——记录的是**实际观测**，不是希望的结果。
//!
//! 进程树的父子关系来自夹具写出的结构化日志（`root-start` / `leaf-spawn` / `leaf-start`），
//! 不依赖 WMI/命令行枚举，避免平台差异与额外依赖；平台侧只实现「PID 是否还活着」。

mod support;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};
use soxu_agent_runtime::{PiSupervisor, SupervisorConfig};
use support::fake_pi_tree;

/// 整棵树消失的可观测预算：验收要求「正常退出后残留 0 个」，不接受「迟早会退」。
const RECLAIM_DEADLINE: Duration = Duration::from_secs(10);
/// 夹具拉起孙进程并写入日志的等待上限。
const TREE_DEADLINE: Duration = Duration::from_secs(15);
/// 轮询间隔：足够细，避免用例里到处写死 sleep。
const POLL_INTERVAL: Duration = Duration::from_millis(25);

mod pid {
    //! 平台侧只回答一个问题：这个 PID 现在还活着吗？
    //! 返回 `None` 表示无法判定（权限/实现缺失），调用方按「未确认回收」处理。
    #[cfg(windows)]
    pub use windows_impl::*;

    #[cfg(target_os = "linux")]
    pub use linux_impl::*;

    #[cfg(not(any(windows, target_os = "linux")))]
    pub use unsupported::*;

    #[cfg(windows)]
    mod windows_impl {
        use windows_sys::Win32::Foundation::{
            CloseHandle, ERROR_ACCESS_DENIED, GetLastError, STILL_ACTIVE,
        };
        use windows_sys::Win32::System::Threading::{
            GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };

        pub const SUPPORTED: bool = true;
        pub const MECHANISM: &str = "OpenProcess + GetExitCodeProcess";

        pub fn alive(pid: u32) -> Option<bool> {
            // SAFETY: 只调用查询接口；拿到的句柄在本函数内配对关闭，不跨线程保存。
            unsafe {
                let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
                if handle.is_null() {
                    // 权限不足说明「存在但看不到」，不能断言已退出；其它错误说明 PID 不存在。
                    return (GetLastError() != ERROR_ACCESS_DENIED).then_some(false);
                }
                let mut code = 0u32;
                let ok = GetExitCodeProcess(handle, &mut code);
                CloseHandle(handle);
                if ok == 0 {
                    return None;
                }
                Some(code == STILL_ACTIVE as u32)
            }
        }
    }

    #[cfg(target_os = "linux")]
    mod linux_impl {
        use std::io::ErrorKind;

        pub const SUPPORTED: bool = true;
        pub const MECHANISM: &str = "/proc/<pid>/stat state";

        pub fn alive(pid: u32) -> Option<bool> {
            let stat = match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
                Ok(stat) => stat,
                // procfs 条目消失即进程已不存在。
                Err(error) if error.kind() == ErrorKind::NotFound => return Some(false),
                Err(_) => return None,
            };
            // comm 字段可以包含空格和括号，状态字符只能从最后一个 ')' 之后取。
            let state = stat.rsplit_once(')')?.1.split_whitespace().next()?;
            // 僵尸态已退出、资源由父进程回收，对本验收按「不残留」计。
            Some(!matches!(state, "Z" | "X" | "x"))
        }
    }

    #[cfg(not(any(windows, target_os = "linux")))]
    mod unsupported {
        pub const SUPPORTED: bool = false;
        pub const MECHANISM: &str = "unsupported";

        pub fn alive(_pid: u32) -> Option<bool> {
            None
        }
    }
}

/// 一个受管会话的进程树：根是 supervisor 拉起的 Pi，叶子是 Pi 自己拉起的子进程。
#[derive(Debug, Clone)]
struct Tree {
    session_id: String,
    runtime_id: String,
    root_pid: u32,
    leaves: Vec<Leaf>,
}

#[derive(Debug, Clone, Copy)]
struct Leaf {
    pid: u32,
    parent_pid: u32,
}

impl Tree {
    fn all_pids(&self) -> Vec<u32> {
        let mut pids = vec![self.root_pid];
        pids.extend(self.leaves.iter().map(|leaf| leaf.pid));
        pids
    }

    fn as_json(&self) -> Value {
        json!({
            "sessionId": self.session_id,
            "runtimeId": self.runtime_id,
            "rootPid": self.root_pid,
            "leaves": self
                .leaves
                .iter()
                .map(|leaf| json!({ "pid": leaf.pid, "parentPid": leaf.parent_pid }))
                .collect::<Vec<_>>(),
        })
    }
}

fn workspace(name: &str) -> PathBuf {
    static SEQ: AtomicU32 = AtomicU32::new(0);
    let seq = SEQ.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("soxu-tree-{}-{name}-{seq}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("创建临时目录");
    dir
}

fn now_unix_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or_default()
}

/// 解析夹具日志里的进程树行；日志由多个进程追加写入，顺序不保证，按 PID 归类。
fn parse_tree(log: &Path) -> Option<(u32, Vec<Leaf>)> {
    let text = fs::read_to_string(log).ok()?;
    let mut root = None;
    let mut leaves = Vec::new();
    for line in text.lines() {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        match value["event"].as_str() {
            Some("root-start") => root = value["pid"].as_u64().map(|pid| pid as u32),
            Some("leaf-start") => {
                if let (Some(pid), Some(parent)) = (value["pid"].as_u64(), value["ppid"].as_u64()) {
                    leaves.push(Leaf {
                        pid: pid as u32,
                        parent_pid: parent as u32,
                    });
                }
            }
            _ => {}
        }
    }
    leaves.sort_by_key(|leaf| leaf.pid);
    Some((root?, leaves))
}

async fn wait_until(window: Duration, mut predicate: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + window;
    loop {
        if predicate() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

/// 等待根进程与全部孙进程都在日志里登记完成（每会话固定 2 个叶子）。
async fn wait_for_tree(log: &Path) -> Option<(u32, Vec<Leaf>)> {
    let deadline = Instant::now() + TREE_DEADLINE;
    loop {
        if let Some((root, leaves)) = parse_tree(log) {
            if leaves.len() >= 2 {
                return Some((root, leaves));
            }
        }
        if Instant::now() >= deadline {
            return None;
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

/// 关闭/中止前的反向检查：整棵树必须都确认存活，否则用例失去证明力。
fn assert_all_alive(pids: &[u32], context: &str) {
    for pid in pids {
        assert_eq!(
            pid::alive(*pid),
            Some(true),
            "{context}：PID {pid} 未确认存活（探测 {}）",
            pid::MECHANISM
        );
    }
}

/// 仍能判定为活着的 PID（含「无法判定」），用于生成残留清单。
fn survivors(pids: &[u32]) -> Vec<u32> {
    pids.iter()
        .copied()
        .filter(|pid| !matches!(pid::alive(*pid), Some(false)))
        .collect()
}

async fn wait_gone(pids: &[u32], window: Duration) -> (bool, u64) {
    let started = Instant::now();
    let gone = wait_until(window, || survivors(pids).is_empty()).await;
    (gone, started.elapsed().as_millis() as u64)
}

fn evidence_dir() -> Option<PathBuf> {
    std::env::var_os("SOXU_PROCESS_TREE_EVIDENCE_DIR")
        // cargo 以 crate 目录为 cwd 运行测试；给相对路径时要换算回仓库根。
        .map(|dir| {
            let dir = PathBuf::from(dir);
            if dir.is_absolute() {
                dir
            } else {
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../..")
                    .join(dir)
            }
        })
}

/// 只有显式指定目录时才写文件：常规 `cargo test` 不产生仓库外副作用。
fn emit_evidence(name: &str, report: &Value) {
    let Some(dir) = evidence_dir() else {
        return;
    };
    fs::create_dir_all(&dir).expect("创建证据目录");
    let text = serde_json::to_string_pretty(report).expect("证据必须可序列化");
    fs::write(dir.join(format!("{name}.json")), text + "\n").expect("写入证据文件");
    println!("证据已写入 {name}.json");
}

const LIMITS: [&str; 4] = [
    "进程树由夹具模拟（Node 孙进程），不是真实 pi 进程树；真实 pi 的工具子进程行为需另行观察。",
    "macOS 没有 PID 存活探测实现，用例自动跳过；申报前不得声称 macOS 已验证。",
    "正常路径验证的是「随管道 EOF 退出的后代」；自行重定向 stdio 或脱离管道的后代不适用。",
    "强杀只终结根进程：本机 Windows 观测到读 stdin 的孙进程随管道断裂退出，但未做 Job Object / 进程组治理，脱离 stdio 的后代仍可能残留（见 docs/development/process-tree-cleanup.md）。",
];

#[tokio::test]
async fn graceful_shutdown_releases_the_whole_managed_tree() {
    if !pid::SUPPORTED {
        eprintln!("跳过 graceful_shutdown：当前平台没有 PID 存活探测实现");
        return;
    }
    let workdir = workspace("graceful");
    let supervisor = PiSupervisor::new(SupervisorConfig::fast());
    let mut trees = Vec::new();

    for session_id in ["session-tree-a", "session-tree-b"] {
        let log = workdir.join(format!("{session_id}.log"));
        let release = workdir.join(format!("{session_id}.release"));
        let handle = supervisor
            .start(
                session_id,
                &fake_pi_tree("tree", session_id, &log, &release),
            )
            .await
            .expect("带孙进程的会话必须完成握手");
        let (root_pid, leaves) = wait_for_tree(&log)
            .await
            .unwrap_or_else(|| panic!("{session_id} 的进程树未在预算内成形"));
        assert_eq!(
            handle.pid(),
            Some(root_pid),
            "handle 上报的进程树根必须与夹具一致"
        );
        trees.push(Tree {
            session_id: session_id.to_owned(),
            runtime_id: handle.identity().runtime_id.clone(),
            root_pid,
            leaves,
        });
    }

    // 树结构自检：两个会话各 1 根 + N 叶，叶子必须挂在根下，PID 不能重复。
    let mut all_pids = Vec::new();
    for tree in &trees {
        assert_eq!(
            tree.leaves.len(),
            2,
            "夹具必须拉起两个孙进程才能验证整棵树，实际 {:?}",
            tree.leaves
        );
        for leaf in &tree.leaves {
            assert_eq!(leaf.parent_pid, tree.root_pid, "叶子的父进程必须是根进程");
        }
        all_pids.extend(tree.all_pids());
    }
    let mut distinct = all_pids.clone();
    distinct.sort_unstable();
    distinct.dedup();
    assert_eq!(
        distinct.len(),
        all_pids.len(),
        "受管 PID 必须互不相同：{all_pids:?}"
    );
    assert_all_alive(&all_pids, "关闭前");

    // 正常关闭：abort → 关 stdin → 进程自行退出。
    let started = Instant::now();
    let results = supervisor.shutdown().await;
    let shutdown_ms = started.elapsed().as_millis() as u64;
    assert_eq!(results.len(), trees.len(), "shutdown 必须覆盖全部受管会话");
    for (runtime_id, outcome) in &results {
        let info = outcome
            .as_ref()
            .unwrap_or_else(|error| panic!("{runtime_id} 未能回收: {error}"));
        assert_eq!(
            info.reason.as_str(),
            "child_exited",
            "正常关闭不允许落到强制终止路径：{info:?}"
        );
    }
    assert!(supervisor.is_empty(), "关闭后受管集合必须为空");

    let (gone, reclaim_ms) = wait_gone(&all_pids, RECLAIM_DEADLINE).await;
    let residual = survivors(&all_pids);
    assert!(
        gone,
        "正常关闭后仍有受管 Pi 进程残留：{residual:?}（受管树 {trees:?}）"
    );

    println!(
        "graceful: {} 个受管进程 → 残留 0（shutdown {shutdown_ms}ms，树消失 {reclaim_ms}ms）",
        all_pids.len()
    );
    emit_evidence(
        "graceful-shutdown",
        &json!({
            "kind": "soxu-m2-process-tree-cleanup",
            "scenario": "graceful-shutdown",
            "recordedAtUnixMs": now_unix_ms(),
            "environment": {
                "platform": std::env::consts::OS,
                "arch": std::env::consts::ARCH,
                "pidProbe": pid::MECHANISM,
            },
            "trees": trees.iter().map(Tree::as_json).collect::<Vec<_>>(),
            "result": {
                "managedPids": all_pids.len(),
                "managedPidsBeforeShutdown": all_pids.len(),
                "residualCount": residual.len(),
                "residualPids": residual,
                "exitReasons": results
                    .iter()
                    .map(|(runtime_id, outcome)| json!({
                        "runtimeId": runtime_id,
                        "reason": outcome.as_ref().map(|info| info.reason.as_str()).ok(),
                        "code": outcome.as_ref().ok().and_then(|info| info.code),
                    }))
                    .collect::<Vec<_>>(),
                "shutdownMs": shutdown_ms,
                "reclaimMs": reclaim_ms,
            },
            "verdict": "pass",
            "limits": LIMITS,
        }),
    );

    let _ = fs::remove_dir_all(&workdir);
}

#[tokio::test]
async fn forced_kill_reclaims_the_root_and_descendants_need_the_owner() {
    if !pid::SUPPORTED {
        eprintln!("跳过 forced_kill：当前平台没有 PID 存活探测实现");
        return;
    }
    let workdir = workspace("forced");
    let supervisor = PiSupervisor::new(SupervisorConfig::fast());
    let log = workdir.join("forced.log");
    let release = workdir.join("forced.release");
    let handle = supervisor
        .start(
            "session-tree-forced",
            &fake_pi_tree("tree-stubborn", "forced", &log, &release),
        )
        .await
        .expect("顽固进程树也必须先完成握手");
    let (root_pid, leaves) = wait_for_tree(&log).await.expect("顽固进程树未在预算内成形");
    assert_eq!(handle.pid(), Some(root_pid));
    let tree = Tree {
        session_id: "session-tree-forced".to_owned(),
        runtime_id: handle.identity().runtime_id.clone(),
        root_pid,
        leaves: leaves.clone(),
    };
    assert_all_alive(&tree.all_pids(), "中止前");

    // 根进程拒绝随 stdin 关闭退出：supervisor 只能走 shutdown_grace → start_kill。
    let started = Instant::now();
    let exit = supervisor
        .stop(handle.identity().runtime_id.as_str())
        .await
        .expect("强制终止路径必须返回退出信息");
    let root_reclaim_ms = started.elapsed().as_millis() as u64;
    assert_eq!(
        exit.reason.as_str(),
        "requested_abort",
        "根进程拒绝退出时必须走强制终止：{exit:?}"
    );
    assert!(
        wait_until(RECLAIM_DEADLINE, || matches!(
            pid::alive(root_pid),
            Some(false)
        ))
        .await,
        "受管的根进程必须被回收"
    );
    assert!(supervisor.is_empty(), "根进程回收后受管集合必须为空");

    // 终结点只作用于根进程。孙进程没有任何终止机制，能否归零取决于它们自己的行为：
    // 读 stdin 的后代会因管道断裂退出，重定向/脱离 stdio 的后代会存活。这里等待并记录
    // 实际结果；若到期仍有残留，按「上层 owner 显式释放」兜底并如实上报，不伪造归零。
    let leaf_pids: Vec<u32> = leaves.iter().map(|leaf| leaf.pid).collect();
    let (gone, leaf_reclaim_ms) = wait_gone(&leaf_pids, RECLAIM_DEADLINE).await;
    let mut residual = survivors(&leaf_pids);
    let mut reclaimed_by = "pipe-broken-children-exited";
    if !gone {
        // 兜底：写出释放开关，证明残留可控、不是永久泄漏。
        fs::write(&release, b"release").expect("写出孙进程释放开关");
        let (released, release_ms) = wait_gone(&leaf_pids, RECLAIM_DEADLINE).await;
        assert!(released, "释放开关后孙进程必须退出，仍存活：{residual:?}");
        residual.clear();
        reclaimed_by = "test harness (release file)";
        println!(
            "forced-kill: 根进程 {root_reclaim_ms}ms 内回收，孙进程残留 {} 个，释放后 {release_ms}ms 归零",
            leaves.len()
        );
    } else {
        println!(
            "forced-kill: 根进程 {root_reclaim_ms}ms 内回收，孙进程随管道断裂 {leaf_reclaim_ms}ms 内自行退出"
        );
    }
    assert!(
        residual.is_empty(),
        "验收结束时仍有孙进程残留：{residual:?}"
    );
    emit_evidence(
        "forced-kill",
        &json!({
            "kind": "soxu-m2-process-tree-cleanup",
            "scenario": "forced-kill",
            "recordedAtUnixMs": now_unix_ms(),
            "environment": {
                "platform": std::env::consts::OS,
                "arch": std::env::consts::ARCH,
                "pidProbe": pid::MECHANISM,
            },
            "trees": [tree.as_json()],
            "result": {
                "rootExitReason": exit.reason.as_str(),
                "rootExitCode": exit.code,
                "rootReclaimMs": root_reclaim_ms,
                "leafReclaimMs": leaf_reclaim_ms,
                "residualCount": residual.len(),
                "residualPids": residual,
                "residualReclaimedBy": reclaimed_by,
            },
            "verdict": "pass",
            "limits": LIMITS,
        }),
    );

    let _ = fs::remove_dir_all(&workdir);
}
