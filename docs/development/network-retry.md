# 网络超时：有界重试与安全恢复

对应任务：[TASK-007](../../tasks/backlog/TASK-007.md)（Issue #37），产品验收口径为 PRD **P-05**。
本文件只写**已经实现并有离线测试覆盖**的行为；未覆盖的部分列在[已知限制](#已知限制)。

## 两个层次，为什么与 automation/policy.json 不矛盾

SOXU 有两条独立的自动化链路，重试预算必须分开说，否则容易读成互相打脸：

| 层次 | 负责什么 | 重试策略 | 权威配置 |
| --- | --- | --- | --- |
| **产品运行时**（`crates/agent-runtime`） | 一个 Pi 子进程的生命周期：拉起、握手、命令、事件 | **有界自动重试**（本文件） | 代码常量 `RetryPolicy::conservative()` |
| **开发调度器**（同级 `soxu-agent-loop` 仓库，Node） | 为 GitHub Issue 派发 Developer/Reviewer、跑检查、发 PR | `automaticApiRetries: 0`，遇故障暂停等人工 | `automation/policy.json` 的 `recovery` |

`automation/policy.json` 里的 `automaticApiRetries: 0` 约束的是**调度器是否自动重跑开发任务**，
它是受保护配置，本任务**没有**、也不应该修改它。产品运行时（用户桌面应用里跑自己会话的那一层）
从来没有被这条配置约束，它现在补上的是「握手/命令超时有界重试」，
两者作用对象不同，因此不存在语义冲突：调度器仍然一次都不自动重跑任务，产品运行时最多自动重试 2 次。

用户在两种场景下看到的表现也不同：开发任务失败 → Issue 转 `agent:paused`、检查点保留、等人工；
桌面会话失败 → 右侧检查器显示重试次数，耗尽后提示人工恢复。

## 失败分类（唯一口径）

分类是硬编码的结构化映射（`soxu_agent_runtime::retry::classify`），**不解析自由文本**：

| 信号 | 分类 | 自动重试 |
| --- | --- | --- |
| 传输层断开（连接重置、管道断开） | `transient` | 是 |
| 握手 / 命令 / 事件超时 | `timeout` | 是 |
| HTTP 408、425 | `timeout` | 是 |
| HTTP 5xx（500–599） | `transient` | 是 |
| HTTP 429、额度/余额不足 | `rate_limited` | **否** |
| HTTP 401、403、鉴权失败 | `auth` | **否** |
| 用户中止（Ctrl+C / cancel） | `cancelled` | **否** |
| 程序缺失、协议不兼容、非法状态迁移 | `permanent` | **否** |
| 已发出但结果未知 | `uncertain` | **否**（先查证） |

429 之所以归入「不重试」而不是「瞬时」：它通常意味着请求已经计入配额，
继续重试只会继续产生费用，而不会改变结果。

## 预算与退避

- 默认策略 `RetryPolicy::conservative()`：最多 **2 次**自动重试，退避 `500ms → 1s`，单次不超过 8 秒。
- 次数硬上限 `MAX_ATTEMPTS_LIMIT = 5`：把配置写成 99 也会被夹到 5，避免「有界」被一行配置作废。
- `RetryPolicy::none()` 表示完全不自动重试，供需要纯手动的场景使用。
- 退避是指数增长并夹在 `max_delay` 内；没有随机抖动（测试需要确定性，抖动对 2 次重试收益极小）。
- 重试**复用同一个 `PiProgram`**：不换模型、不换 Provider、不换凭据。
  已批准模型仍是 [模型选择规范](../../agents/policies/model-selection.md) 中的那一份。

## 持久化：重启不能绕过预算

预算实现在 `crates/agent-runtime/src/retry/`（`mod.rs` 策略与预算、`side_effect.rs` 副作用台账）的
`RetryLedger`，它不做 IO；
磁盘持久化由桌面端 `apps/desktop/src-tauri/src/retry_store.rs` 负责：

- 路径：`<app_data_dir>/retry/<可读前缀>-<16 位摘要>.json`。文件名由「安全前缀 + FNV-1a 摘要」组成，
  `sessionId` 属于外部输入，绝不直接拼进路径。
- 内容：`{"schemaVersion":1,"attempts":2,"exhausted":true,"lastFailure":"timeout"}`。
- 读取时机：**每次启动前**先读盘，再进入重试循环；**每次结束（成功或失败）都写回**。
  因此进程崩溃、正常退出、重启之后，`attempts` 与 `exhausted` 都不会回到 0。
- 恢复语义是单调的：`restore` 只接受历史已用次数，调小策略不会把预算「退回」。
- 文件损坏或 `schemaVersion` 不认识时**失败关闭**：按「已耗尽」处理（`attempts` 仍为 0），
  只允许一次手动尝试，直到某次运行真正成功才清空。宁可少重试，也不静默放行付费重试。
- `exhausted` 是**权威标志**，不是派生的统计值：`RetryLedger::record_failure()` 先看它，
  已耗尽就一律返回 `None`，即使 `attempts < max_attempts`。终态失败（429/鉴权/中止/不确定）
  与损坏快照写出的正是 `exhausted: true, attempts: 0`；如果只按次数判断，重启后那次
  「零次已用」就会换回一次自动重试，把失败关闭变成静默放行。
- 一次运行成功后**只解除耗尽封锁**（`record_success`），并**保留**本次用掉的次数——
  控制台因此能看到「这次用掉了 2 次重试」，而不是被静默清零。
- 下一次运行由 `begin_run()` 重新授予完整额度；`begin_run()` **不会**清除已耗尽的预算，
  所以历史失败不会永久拖累后续会话，也不会被重启绕过。

## 「恢复入口不能绕过预算」

三条入口共用同一份预算，没有旁路：

1. **手动启动**（用户点启动）：允许一次真实尝试；只剩自动重试额度时才继续，
   预算已耗尽时第一次失败就直接报 `retry_budget_exhausted`。
2. **自动重试**：只在 `start_with_retry_cancellable` 内部（进入时先调用 `begin_run()`；
   已被判定耗尽则不再授予任何额度），按 `RetryPolicy` 授予，
   `record_failure` 返回 `None` 时立即停止并返回
   `SupervisorError::RetryBudgetExhausted { attempts, last }`。
3. **显式恢复**：从磁盘读回同一份快照（`RetryStore::load`）后再启动，
   `exhausted` 仍然阻止自动重试；只有一次真正成功（`record_success`）才解除封锁。

## 取消：退避窗口也停得下来

退避等待（默认最多 8 秒）也是用户感知得到的「卡住」，所以它必须能被打断：

- `start_with_retry_cancellable(..., &RetryCancel)` 用 `tokio::select!` 同时等
  「退避睡满」与「取消信号」；桌面端启动会话走的就是这条路径。
- `RetryCancel` 是廉价克隆的共享句柄（原子标志 + 唤醒器），取消粘滞、幂等、没有丢失唤醒的窗口。
- 桌面端在启动前把句柄登记进 `AppState.pending_starts`（`begin_pending_start`），
  `stop` 与 `cancel` 都会先点亮它：启动还没完成时点「停止」，会立刻中止重试，
  **不会再拉起一次子进程**，也不会多发一次可能计费的请求。
- 取消后返回 `SupervisorError::RetryCancelled { attempts }`（`code()` 为 `retry_cancelled`），
  预算被钉成 `cancelled` 并立即写盘：中止不是「重试额度用完了再试一次」的借口。
- 每次尝试**之前**也会检查一次取消标志，所以「已经点了停止」不会再多一次真实尝试。
- `stop` 在点亮取消之后还会等 `start_guard`（取出 `RunHandle` 后立刻释放）：
  这样「启动刚成功、`runs` 还没登记」的空档不会把停止变成空操作，也不会留下
  用户以为已停、实际仍在跑的运行时；取消让这次等待是有界的，回收阶段不占闸门。
- 一次运行成功（`record_success`）同样会清掉 `cancelled` 封锁，下一次运行恢复正常额度。

已知边界：取消只打断**SOXU 自己发起的重试与握手等待**。Pi 进程已经收到 prompt 之后的那一轮
只能通过 `cancel` 命令结束；两者不是同一件事，也不共用预算。

## 结果不确定：不重复产生副作用

模型请求与写操作可能已经生效（典型例子：创建 PR 的请求超时了，PR 可能已经建好）。
`SideEffectLedger` 把这类操作变成显式台账：

| 台账状态 | `decision(op)` | 允许的动作 |
| --- | --- | --- |
| 未登记 | `SafeToReplay` | 可以执行 |
| 已发出、未落定 | `VerifyFirst` | **只能先查证**（例如查询是否已存在 PR） |
| 已确认执行成功 | `NeverReplay` | 禁止重放，避免重复创建 |
| 已确认未执行 | `SafeToReplay` | 可以重放一次 |

- 台账上限 `MAX_SIDE_EFFECT_ENTRIES = 64`；满且仍有未落定项时 `mark_sent` 返回 `false`，
  调用方必须暂停，而不是丢掉证据让重放变成「安全」。
- `start_with_retry` 只重试**进程拉起与握手**这一个幂等动作，
  不会重放任何已经发送过的 prompt——模型请求的重放必须由上层按台账判定。

## 控制台可见性

右侧「运行检查器」新增**重试预算**卡片，数据来自后端 `RetryStatus`
（`dto::RuntimeStarted` / `RuntimeStatus` 的 `retry` 字段）：

| 字段 | 含义 |
| --- | --- |
| `attempts` / `maxAttempts` | 已用自动重试次数 / 上限 |
| `remaining` | 剩余额度 |
| `exhausted` | 已耗尽，只能人工处理后重来 |
| `lastFailure` | 最近一次失败分类（`timeout` / `transient` …） |
| `nextDelayMs` | 下一次重试前的退避 |
| `costNotice` | 固定费用提示，界面必须原样展示 |

`costNotice` 的内容是：**「重试会重新发起模型请求，可能产生新的模型费用；
模型与 Provider 固定不变，也不切换凭据。」**
没有记录时显示「未发生重试」，不伪造 0 次。

## 离线测试证据

全部用例都是离线注入：假 Pi（`crates/agent-runtime/tests/fixtures/fake-pi.mjs` 的 `mute` 模式）
永远不回复握手，因此**不联网、不调用模型、不产生任何费用**。尝试次数由夹具写入的日志文件精确统计，
不依赖计时猜测。

~~~bash
cargo test -p soxu-agent-runtime --lib retry              # retry/tests.rs：22 个单测（分类、退避、预算、取消、副作用台账）
cargo test -p soxu-agent-runtime --test retry_budget      # 10 个集成用例（真实子进程 + 假 Pi mute）
cargo test -p soxu-desktop --lib retry_store              # 持久化单测（5 个）
cargo test -p soxu-desktop --lib state                    # 启动取消句柄登记与清理（2 个）
pnpm --filter @soxu/desktop test                          # 含 retryBudget.test.ts
node --test scripts/tests/recovery-budget.test.mjs        # 调度器侧预算护栏
~~~

| 验收路径 | 用例 |
| --- | --- |
| 瞬时网络故障 / 超时按次数重试（带计数） | `handshake_timeouts_are_retried_then_the_run_pauses` |
| 耗尽后暂停并回收进程（不留孤儿 Pi） | 同上（断言 `supervisor.processes()` 为空 + `retry_budget_exhausted`） |
| 次数与退避写进检查点、重启不重置 | `restart_cannot_reset_the_budget`、`exhausted_budget_from_a_previous_process_allows_only_one_attempt`、`saved_budget_survives_a_restart`、`restored_attempts_are_monotonic_even_with_smaller_policy` |
| 恢复入口不能绕过预算 | `resume_after_exhaustion_requires_a_successful_run`、`exhausted_budget_from_a_previous_process_allows_only_one_attempt` |
| 429 / 鉴权 / 用户中止不重试 | `only_transient_and_timeout_are_retryable`、`terminal_failures_never_consume_budget_but_block_retry` |
| 结果不确定时不盲目重放 | `side_effects_require_verification_before_replay`、`side_effects_confirmed_absent_may_be_retried_once`、`side_effect_ledger_refuses_to_forget_unresolved_entries` |
| 次数上限不可被配置绕过 | `attempt_limit_cannot_exceed_hard_cap`、`configured_attempts_cannot_exceed_the_hard_cap` |
| 重试状态与费用提示可见 | `status_reports_counts_and_cost_notice`、`status_serialises_to_camel_case_for_the_ui`、`retry_status_is_visible_and_warns_about_cost`、前端 `retryBudget.test.ts` |
| 成功后解除封锁、不永久拖累后续会话 | `success_keeps_the_observed_count_but_unblocks_the_next_run`、`a_successful_start_unblocks_the_next_run` |
| 新运行不会清掉已耗尽的预算 | `begin_run_never_clears_an_exhausted_budget`、`resume_after_exhaustion_requires_a_successful_run` |
| 控制台显示真实重试次数 | `status_keeps_the_observed_retry_count_after_a_retry` |
| 损坏快照失败关闭 | `decode_rejects_bad_or_future_payloads`、`corrupt_budget_fails_closed_but_still_permits_one_manual_attempt` |
| 已耗尽标志优先于剩余次数（Review 回归） | `an_exhausted_budget_never_grants_a_retry_even_with_attempts_left`、`restored_terminal_snapshot_keeps_the_exhausted_flag_authoritative`、`terminal_snapshot_fails_closed_without_granting_a_retry`、`corrupt_budget_fails_closed_but_still_permits_one_manual_attempt` |
| 退避窗口可取消、不额外拉起进程 | `cancellation_is_sticky_and_shared_between_handles`、`cancelled_future_stays_pending_until_cancelled`、`cancelling_before_the_first_attempt_never_spawns_a_process`、`cancelling_during_the_backoff_window_stops_without_another_attempt` |
| 桌面端「停止」能打断启动中的重试 | `pending_start_cancellation_is_registered_and_released`、`pending_start_cancellation_is_per_session` |
| 检查修复次数上限 / 恢复入口不越界（调度器侧护栏） | `scripts/tests/recovery-budget.test.mjs`：`automaticApiRetries = 0`、`maxRetries ≤ 3`、超时下界、自动发布关闭且自动合并只能落集成分支 |

### 目标平台验证记录

| 项 | 值 |
| --- | --- |
| 平台 | Windows 11 专业版 10.0.26300（x86_64-pc-windows-msvc） |
| 工具链 | Rust 1.99.1 / cargo 1.99.1 / Node v26.10.0 / pnpm 12.15.0 / PowerShell 7.6.9 |
| 日期 | 2026-10-28 |
| 命令 | `cargo test --workspace --locked`、`pnpm check`、`cargo fmt --all -- --check` |
| 结果 | 全绿（见下） |

~~~text
soxu-agent-runtime: 47 个单测（含 retry/tests.rs 22 个）+ 24 个集成用例（含 retry_budget.rs 10 个）
soxu-desktop:       25 个单测（含 retry_store 5 个、state 2 个）+ 4 个集成用例
@soxu/desktop:      33 个 node --test 用例（含 retryBudget.test.ts 5 个）
scripts:            20 个 node --test 用例（含 recovery-budget.test.mjs 4 个）
~~~
以上数字取自 2026-10-28 本机实际输出（`cargo test --workspace --locked` 与 `pnpm check`），
不是估算；文档与实测不一致时以实测为准并回来修正。

**未验证**：macOS 与 Linux 实机运行（CI 在 ubuntu-24.04 上执行 `cargo test --workspace --locked`，
本机没有对应结果）；真实 Pi 二进制在网络抖动下的行为（夹具用 `mute` 模拟握手不回应，不是真实断网）。

## 已知限制

1. **只覆盖产品运行时的启动/握手阶段**。会话内一轮 prompt 失败仍由用户决定重发；
   自动重放模型请求需要上层先按 `SideEffectLedger` 判定，目前没有接通。
2. **调度器侧不变**。`automaticApiRetries: 0` 保持原样；「检查修复次数上限」
   （`policy.json` 的 `maxRetries`）属于 `soxu-agent-loop` 仓库，不在本仓库实现范围内。
3. **副作用台账只在内存中**。进程重启后台账清空，恢复路径必须自己重新核对远端状态
   （PR 是否已存在），不得因为台账为空就当作「一定没执行」。
4. **本地删除预算文件等于手动放弃历史**。`retry/*.json` 是本地状态，删除或损坏会让预算回到
   初始或失败关闭；这不是「自动绕过」，但也不是防篡改机制。
5. **没有跨机器共享预算**。与调度器的锁一致，只支持单机使用。
