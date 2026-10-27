# Pi RPC Supervisor（产品侧 Rust/Tokio）

对应任务：[TASK-001](../../tasks/backlog/TASK-001.md)。本文件只描述**已经实现并有自动化测试覆盖**的行为；未实现的部分列在「已知限制」。

这是**产品侧**运行时，与 `automation/loop` 的 Node 调度器无关：它只负责「一个 Pi 子进程的一生」。

## crate 划分

| crate | 职责 | 不负责 |
| --- | --- | --- |
| `crates/pi-protocol` | `pi --mode rpc` 的 stdio NDJSON 线协议：命令编码、入站记录解码、单条记录上限、事件名常量 | 进程拉起、超时、取消、generation |
| `crates/agent-runtime` | 子进程生命周期、管道分帧、request 关联、超时/取消/异常退出、generation 隔离、有界诊断、向资源监控暴露受管 PID | 会话 JSONL 索引、Git、PTY、UI、内存指标采集 |
| `crates/resource-monitor` | 进程树内存采样、预算阈值、空闲释放请求（只产出指令，不终止进程） | 进程生命周期、会话持久化、UI |

`resource-monitor` **不依赖** `agent-runtime`：本 crate 只暴露「runtime + PID + 状态」，
由上层映射成监控 `Target`，避免监控模块反向耦合 Supervisor 内部结构。指标口径与策略见
[内存预算文档](memory-budget.md)。

依赖方向只有 `agent-runtime → pi-protocol`，两者都不依赖 Tauri，可独立测试。

## 公开接口

```rust
use std::time::Duration;
use soxu_agent_runtime::{PiProgram, PiSupervisor, SupervisorConfig};

let supervisor = PiSupervisor::new(SupervisorConfig::default());
// 结构化 argv，不经过 shell；默认清除 GH_TOKEN / GITHUB_TOKEN / ATOMGIT_TOKEN。
let mut handle = supervisor.start("session-01", &PiProgram::pi_rpc()).await?;
handle.prompt("总结一下这个仓库").await?;
handle.wait_settled(Duration::from_secs(120)).await?;
// 进程树根 PID：资源监控按它采样整棵树（含 Pi 自己拉起的子进程）。
println!("pid: {:?}", handle.pid());
let exit = supervisor.stop(handle.identity().runtime_id.as_str()).await?;
println!("ended: {:?} ({})", exit.code, exit.reason.as_str());

// 所有受管进程的只读视图，供资源监控构造 Target。
for process in supervisor.processes() {
    println!("{} {:?} {:?}", process.identity.runtime_id, process.pid, process.state);
}
```

- `PiSupervisor`：一个实例管理本进程内所有受管 Pi 进程；`start` / `stop` / `shutdown` / `runtime_state` / `active_identities` / `processes`。
- `RuntimeHandle`：单个运行时的观察与命令入口；`request` / `get_state` / `prompt` / `cancel` / `recv` / `recv_timeout` / `wait_settled` / `take_backlog` / `wait_exit` / `stop` / `diagnostics` / `pid`。
- `RuntimeProcess`：`identity` + `pid` + `state`，另有 `is_samplable()` / `is_idle()` / `may_be_busy()`。资源监控**只允许**释放 `is_idle()` 的运行时。
- `drop(RuntimeHandle)` **不会**停止 agent（Pane 销毁不等于停止任务）；停止必须显式调用 `stop` 或 `shutdown`。
- `SupervisorError` 是结构化枚举，`code()` 给 UI/日志稳定的短标识，`Display` 给人类读的说明。

## 所有权与释放

| 资源 | 唯一 owner | 释放时机 |
| --- | --- | --- |
| `Child` | `run_monitor` 任务 | `wait`/kill 后立即记录退出并回收任务句柄 |
| stdin | `run_writer` 任务 | 写入通道关闭 → stdin drop → 子进程收到 EOF |
| stdout | `run_reader` 任务 | EOF 或分帧失步 → 记录原因并请求终止 |
| stderr | `run_stderr` 任务 | EOF/错误 → 结束，只保留脱敏尾部 |
| 共享状态 | `RuntimeShared`（锁内不做 await） | 运行时被回收后由 `Arc` 决定 |

补充约定：

- `Command::kill_on_drop(true)` 是最后一道防线：即使 supervisor 被 drop，也不留下孤儿进程。
- pending request 用 `oneshot` + RAII 守卫：超时、取消、任务被 drop 都不会泄漏等待者。
- 进程退出时先让读取任务收尾（最多 700ms），再发布退出通知，避免丢掉最后一条 `agent_settled`。
- 退出通知走独立的 `watch` 通道，不占事件通道容量：上层不读事件时 `stop()` 也不会卡住。

## 状态机

```
Starting ──get_state 成功──▶ Idle ──prompt/agent_start──▶ Running
   │                          │                            │
   ├──启动失败──▶ Stopping      ├──stop──▶ Stopping          ├──agent_settled──▶ Idle
   └──进程退出──▶ Exited        └──进程退出──▶ Exited        └──stop/进程退出──▶ Stopping/Exited
```

非法迁移返回 `SupervisorError::IllegalTransition` 且**不改写**状态；同状态迁移是幂等的。

## 时间预算

`SupervisorConfig::default()` 偏保守，测试用 `SupervisorConfig::fast()`：

| 项 | 默认 | fast | 含义 |
| --- | --- | --- | --- |
| `handshake_timeout` | 20s | 1.5s | 启动后 `get_state` 必须在此内完成 |
| `response_timeout` | 30s | 0.5s | 单条命令等 response 的上限 |
| `cancel_timeout` | 2s | 0.5s | 等 `abort` response 的上限 |
| `shutdown_grace` | 5s | 1.5s | 关闭 stdin 后等进程自行退出的宽限 |
| `kill_timeout` | 2s | 1s | 强杀后等回收的上限 |
| `event_capacity` | 256 | 256 | 事件通道容量（满了丢弃高频事件并计数） |
| `stderr_ring` | 32 | 32 | stderr 诊断环行数 |
| `backlog_capacity` | 64 | 64 | `wait_settled` 期间暂存事件上限 |

## request 关联与并发

- 每条命令带唯一 `id`（`{runtimeId}:{label}:{seq}`），response 按 id 关联，**不看到达顺序**。
- 并发请求互不影响；同一 id 在途时重复使用返回 `DuplicateRequestId`，且**不会顶掉**原等待者。
- 超时返回 `ResponseTimeout` 并从 pending 移除；进程退出/断流时所有在途请求立即失败（`RequestChannelClosed`），不会静默挂起。
- `success` 只代表命令被接收；一轮真正结束必须等 `agent_settled`。

## generation 隔离

- `sessionId` 稳定；`runtimeId` 与 `generation` 只代表一次执行。
- 同一 `sessionId` 再次 `start` 会先把 generation +1，旧 handle 立刻 `Superseded`，之后**不再交出任何事件**（即使通道里已有积压）。
- 新运行时就绪后才终止旧运行时；新运行时启动失败时同样终止旧运行时，保证同一 JSONL 只有单一写者。
- 两个不同 `sessionId` 的运行时各有独立管道、事件通道与退出通知，不存在串线路径。

## 错误码

| `code()` | 场景 | 上层建议 |
| --- | --- | --- |
| `empty_session_id` | 传入空 sessionId | 修正调用 |
| `spawn_failed` | 程序不存在/argv 非法 | 提示安装或路径问题 |
| `missing_pipe` | spawn 配置被破坏 | 内部错误 |
| `handshake_timeout` | 握手超时 | 终止并重试一次，或提示额度/网络 |
| `response_timeout` | 命令无响应 | 可 `cancel`，必要时重启 |
| `event_timeout` | 等事件超时 | 可重试等待 |
| `duplicate_request_id` | 同 id 在途 | 编程错误 |
| `request_channel_closed` | 进程退出/断流 | 视为该轮失败，重启会话 |
| `stdin_closed` | stdin 已关闭 | 重启会话 |
| `runtime_not_running` | 状态不允许接受命令 | 等待或重启 |
| `unknown_runtime` | runtimeId 未受管 | 修正调用 |
| `superseded` | 旧 generation handle | 丢弃该 handle |
| `illegal_transition` | 状态机拒绝 | 内部错误 |
| `protocol` | 线协议/握手被拒 | 检查 Pi 版本 |
| `runtime_ended` | 等事件时进程已结束 | 重启会话 |
| `shutdown_timeout` / `exit_timeout` | 回收超时 | 记录诊断，人工核查进程树 |

## 诊断与脱敏

- 事件通道分两级：关键事件（agent 事件、settled）满了会等；高频诊断事件满了直接丢弃并计数 `dropped_events`。
- stderr 只保留有界环（默认 32 行），每行截断到 512 字符，并把 `ghp_`/`sk-` 等密钥前缀与长 token 形态替换为 `<redacted>`。
- 协议异常（坏 JSON、分帧失步）进入 `ProtocolWarning`，最后一条存进 `RuntimeDiagnostics::last_protocol_warning`。
- 扩展 UI 请求（`extension_ui_request`）**不会被自动确认**：显式记录「未实现，按拒绝处理」并上报 `UnhandledRecord`。
- 诊断快照不含完整 stdout 历史，也不含密钥。

## 测试与复现证据

集成测试用 `crates/agent-runtime/tests/fixtures/fake-pi.mjs` 作为假 Pi（Node >= 24，已批准基线），覆盖真实子进程 + 真实管道：

```bash
cargo test -p soxu-pi-protocol -p soxu-agent-runtime
```

夹具模式（`node fake-pi.mjs <mode> <label>`）：`ok`、`fragment`（2 字节切片 + 一次写两条记录）、`reverse`（乱序回复）、`chatty`、`slow`、`crash`、`noreply`、`garbage`、`noisy`。

| 验收点 | 用例 |
| --- | --- |
| JSONL 粘包/拆包 | `frame::tests::*`（确定性单测）+ `coalesced_and_fragmented_frames_round_trip` |
| 并发 request correlation | `concurrent_requests_are_correlated_by_id_not_arrival_order`、`duplicate_request_id_is_rejected_without_dropping_the_in_flight_request` |
| 超时 / 取消 / 异常退出 | `timeout_then_stop_then_restart_stays_consistent`、`cancel_ends_the_turn_and_keeps_the_runtime_usable`、`abrupt_exit_fails_pending_requests_and_stop_is_idempotent` |
| 状态一致与可重复启动 | `handshake_reports_idle_and_rejects_empty_session`、`shutdown_reclaims_every_runtime` |
| 迟到事件按 generation 丢弃 | `late_events_of_a_replaced_generation_are_dropped`、`restarting_a_session_reclaims_the_previous_process` |
| 两个独立会话不串线 | `independent_sessions_never_cross_wire_events` |
| 资源监控集成点（PID 唯一、活动状态可靠） | `managed_runtimes_expose_distinct_samplable_pids` |
| 异常事件与脱敏 | `malformed_records_and_extension_ui_requests_warn_but_keep_the_stream`、`stderr_diagnostics_are_bounded_and_redacted` |

已验证环境（2026-10-27）：Windows 11 / PowerShell 7 / Rust 1.99.1 / Node 26.10.0，
`cargo test -p soxu-pi-protocol -p soxu-agent-runtime` 全绿（31 个单测 + 13 个集成用例）。

2026-11-05（TASK-004）：新增 `tests/process_identity.rs`（1 个集成用例，验证 PID 唯一、
`Running` 不被误判为空闲、停止后从受管集合移除），`cargo test -p soxu-agent-runtime` 仍全绿。

**未验证**：Linux/macOS 实机运行（CI 会在 ubuntu-24.04 上执行 `cargo test --workspace --locked`，但本机没有对应结果）；真实 `pi --mode rpc` 二进制的事件全集（夹具只模拟已确认的 `agent_start` / `agent_settled` / response 形态）。

## 已知限制

1. **进程树回收**：停止路径先 abort、再关 stdin、超时才 `start_kill`。Windows 上 `start_kill` 只保证结束直接子进程；如果 Pi 再拉起自己的子进程树，需要后续的平台级 Job Object / 进程组治理（`ExitReason::KillTimeout` 就是为这条路径留的诊断）。
2. **扩展 UI 未实现**：审批请求一律按拒绝处理并告警，不做交互。
3. **不保存完整 stdout 历史**：只保留有界 stderr 环与结构性事件；完整会话内容以 Pi 自己的 JSONL 为准。
4. **重启不重放上下文**：进程崩溃后未持久化的上下文不会恢复；已写入工作树的文件不受影响。
5. **Node 夹具是测试期依赖**：集成测试要求 PATH 上有 `node`（或 `NODE_BINARY` 指向它）；产品运行时不需要 Node。
6. **generation 计数表不回收**：`sessions` 为每个出现过的 sessionId 保留一个 generation 计数（每条约百字节），保证旧 handle 永远不可能重新「变新」。当前没有会话关闭信号可安全清理，属于已知的小规模保留，不是进程或管道泄漏。
