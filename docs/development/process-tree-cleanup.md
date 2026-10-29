# 退出后受管进程树清理验收（P-03）

对应 Issue：#39（[M2] [ISSUE-39] 退出后受管进程树清理验收），关联 PRD P-03 与基础实现 #21（Pi RPC Supervisor）。

本文件记录**实机验收的方法、结果与未验证限制**。代码功能以 `crates/agent-runtime` 的
Supervisor 为准（接口与预算见 [agent-runtime.md](agent-runtime.md)），此处只回答验收问题：
**SOXU 正常退出后，受管的完整进程树（含 Pi 自己拉起的子进程）是否残留。**

## 验收口径

- 「受管进程」指 `PiSupervisor` 拉起的 Pi 根进程及其全部后代；验收要求正常退出后**残留 0 个**。
- 进程树由夹具结构化日志（`root-start` / `leaf-spawn` / `leaf-start` 行，含 pid/ppid）还原，
  不依赖 WMI/命令行枚举；PID 存活探测按平台实现（Windows：`OpenProcess` + `GetExitCodeProcess`；
  Linux：`/proc/<pid>/stat`）。
- 冒烟用两个会话（Issue 要求）各带 2 个孙进程：root → leaf×2，共 6 个受管 PID。

## 冒烟夹具

`crates/agent-runtime/tests/fixtures/fake-pi.mjs` 新增两种模式（均为先完成 get_state 握手的合法 RPC 进程）：

| 模式 | 行为 | 覆盖路径 |
| --- | --- | --- |
| `tree` | 拉起 2 个孙进程（`fake-pi-leaf.mjs`，读 stdin）；root 随 stdin EOF 退出 | 正常关闭：abort → 关 stdin → 自行退出 |
| `tree-stubborn` | 孙进程不读 stdin、root 拒绝随 stdin 关闭退出 | 强制终止：shutdown_grace 超时 → `start_kill` 根进程 |

孙进程有 20 秒兜底 TTL 与释放开关文件，保证测试异常中断时不留下真实孤儿进程。

## 复现命令

```powershell
# 在 SOXU 仓库根目录；环境变量存在时把证据写入 docs/development/evidence/m2-process-tree/
$env:SOXU_PROCESS_TREE_EVIDENCE_DIR = "docs/development/evidence/m2-process-tree"
cargo test -p soxu-agent-runtime --test process_tree -- --nocapture --test-threads=1
```

不设置环境变量时测试照常运行，只是不写证据文件（常规 `cargo test --workspace` 零仓库副作用）。
用例在`tests/process_tree.rs`：`graceful_shutdown_releases_the_whole_managed_tree` 与
`forced_kill_reclaims_the_root_and_descendants_need_the_owner`。

## 实测结果（Windows，2026-11-24）

环境：Windows 11 / x86_64 / Rust 1.99.1 / Node 26.10.0；探测：`OpenProcess + GetExitCodeProcess`。
原始机器可读报告：[graceful-shutdown.json](evidence/m2-process-tree/graceful-shutdown.json)、
[forced-kill.json](evidence/m2-process-tree/forced-kill.json)。

### 正常关闭

两个会话（`session-tree-a#1`、`session-tree-b#2`）各 1 根 + 2 孙，共 6 个受管 PID。

| 项 | 结果 |
| --- | --- |
| `PiSupervisor::shutdown()` 用时 | 18 ms |
| 退出原因 | 两个 runtime 均 `child_exited`（未落强制终止路径） |
| 树完全消失用时 | < 25 ms（首轮轮询即归零） |
| **残留受管进程** | **0 个** |

### 异常路径（强制终止）

根进程拒绝随 stdin 关闭退出，supervisor 只能走 `shutdown_grace` 超时 → `start_kill`：

| 项 | 结果 |
| --- | --- |
| 根进程退出原因 / 码 | `requested_abort` / 1（强杀后非 0） |
| 根进程回收用时 | 1518 ms（≈ fast 预算的 shutdown_grace 1500ms + kill） |
| 孙进程 | 随根进程管道断裂在 25ms 内自行退出，**残留 0**；测试仍保留「释放开关 + 兜底回收」路径，若平台行为不同可如实记录 |
| **验收结束残留** | **0 个** |

### Windows 实际行为与机制说明

- Windows 上 `start_kill` 即 `TerminateProcess`，**只保证终结直接子进程**。本机观测：读 stdin 的
  孙进程会在管道句柄失效后随 `EPIPE`/EOF 自行退出，因此实测归零——但这依赖后代进程读了父管道，
  **不是** Job Object 那样的硬保证。
- 若后代自行重定向 stdio 或完全脱离管道（例如某些 CLI 工具进程），强杀根进程后它仍可能存活。
  这是尚未做平台级进程树治理时的已知缺口（`ExitReason::KillTimeout` 为该路径预留诊断），
  后续如需硬保证应在 Windows 上引入 Job Object、POSIX 上用进程组 `killpg`，属新的架构决策。

## 未验证限制（不得据此宣称）

1. **macOS**：测试没有 PID 存活探测实现，用例自动跳过；未实机验证。
2. **Linux**：`/proc` 探测已实现但未实机跑过（CI 的 ubuntu 任务会执行编译与运行，结果以 CI 为准）。
3. **真实 Pi 进程树**：冒烟用 Node 夹具模拟（合法 RPC 行为 + 真实进程树）；真实 `pi --mode rpc`
   运行期是否拉起自己的工具子进程、其 stdio 行为如何，需在接入真实 Agent 后另行观察。
   `pnpm smoke:rpc` 只验证协议层，未覆盖进程树。
4. **桌面端窗口关闭路径**：`apps/desktop` 的 `RunEvent::Exit → shutdown_all` 复用同一个
   `PiSupervisor::shutdown()`，本验收在 Supervisor 层完成；Tauri 窗口交互路径（点击关闭按钮、
   会话运行中退出）未做端到端实测。
5. **崩溃 / 断电场景**：supervisor 自身被强杀时只剩 `kill_on_drop` 与管道断裂兜底，未经专门用例覆盖。

## 验收结论

- P-03（Windows、夹具进程树）：**通过**。正常退出后受管 Pi 进程树残留 0 个；强制终止路径
  根进程必被回收，行为良好的后代随管道退出，脱离 stdio 的后代存活是已记录的已知缺口。
- 跨平台结论以各平台实机/CI 运行为准，当前仅 Windows 有实机证据。
