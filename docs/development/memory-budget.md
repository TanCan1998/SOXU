# 进程级内存预算与空闲释放（TASK-004）

对应任务：[TASK-004](../../tasks/backlog/TASK-004.md)。依赖 [TASK-001](agent-runtime.md) 暴露的受管 PID。

本文件只描述**已经实现且有自动化测试覆盖**的行为。凡是没在实机跑过的平台或数字，
都在文末「未验证」里显式列出，不能读成已经通过。

## 实现范围

| 关注点 | 落地位置 | 不负责 |
| --- | --- | --- |
| 进程树/自身内存采样、平台解释、降级 | `crates/resource-monitor`（`metrics`、`platform`） | 会话 JSONL、UI 布局、进程终止 |
| 采样编排（`self` + 每个受管 runtime 的树） | `crates/resource-monitor` `monitor` | 定时器与线程生命周期 |
| 阈值、滞回、空闲释放请求、失败降级 | `crates/resource-monitor` `governor` | 真正执行停止（由上层调用 Supervisor） |
| 受管 PID + 活动状态 | `crates/agent-runtime` `process` / `PiSupervisor::processes()` | 内存指标采集 |
| 一行诊断摘要（`Sample::summary()`，可直接进日志/本地仪表盘） | `crates/resource-monitor` `monitor` | Tauri 命令与前端面板（**未实现**，下一步） |

设计原则：监控自己**没有**后台线程；采样由调用方既有的 tick 驱动
（`Monitor::due()` → `Monitor::sample()`），因此「谁注册定时器，谁负责释放」的约束天然成立，
也不会为监控引入常驻进程。

## 指标语义（不要跨平台混读）

| 字段 | Windows 来源 | Linux 来源 | 含义与注意事项 |
| --- | --- | --- | --- |
| `resident_bytes` | `GetProcessMemoryInfo` → `WorkingSetSize` | `/proc/<pid>/status` `VmRSS` | 工作集/RSS。含共享页与可被系统裁剪的 standby 页，会随系统压力波动，用于**实时压力判定** |
| `private_bytes` | `PROCESS_MEMORY_COUNTERS_EX.PrivateUsage`（私有提交） | `smaps_rollup` `Private_Clean + Private_Dirty` | 不含共享页，用于解释「因 SOXU 增加了多少不可共享内存」，也是 P-07 资源比较应公布的数 |
| `processes` | Toolhelp32 快照的 parent PID 关系 | `/proc/<pid>/stat` 的 ppid | 进程树进程数，含 root，不含被排除的子树 |
| `missing_processes` | 采样期间退出/无权限的进程数 | 同左 | `>0` 表示这次聚合不完整，**不得**作为释放依据 |

约定：

- `private_bytes` 拿不到就是 `None`，**绝不估算**；只要有一个进程缺失，整棵树的
  `private_bytes` 就是 `None`，不拿部分值冒充全量。
- 「SOXU 自身」只采主进程。Windows 上 WebView2 的 `msedgewebview2.exe` 等是**子进程**，
  不计入 self；需要整机口径时用 `Monitor::tree_usage(pid, &exclude)` 采完整树并排除受管
  Agent 子树（用于 P-07 基准）。
- 同一次采样里，其它受管 root 会从这棵树的聚合里排除，避免父子关系导致同一份内存被算两次。

## 采样间隔

| 项 | 默认值 | 说明 |
| --- | --- | --- |
| `sample_interval` | 5 s | 与诊断面板刷新节奏一致；低于 1 s 会被 `MemoryBudget::validate()` 拒绝（会变成热循环） |
| `history` | 60 个样本 | 有界历史，只用于展示趋势，不落盘、不进 Vue 全局状态 |

实测采样开销（Windows 11 / Rust 1.99.1 / Node 26.10.0 / **debug 构建**）：

| 场景 | 每拍耗时 |
| --- | --- |
| 1 个受管 target（5 s 间隔，100 拍） | 平均 6.7 ms，最差 9.5 ms |
| 3 个受管 target（每棵两进程树，20 拍） | 平均 9.1 ms，最差 15.9 ms |
| 单棵子树聚合（不含系统快照） | 132 µs |

开销主体是 Windows Toolhelp32 全系统进程快照（一次采样只取一次快照）；10 ms / 5 s ≈ 0.2% 的
单核占用。**release 构建未测**，不能把 debug 数字当成产品上限。

## 阈值与默认预算（Windows 16 GB / 3 Agent）

| 参数 | 默认 | 取值理由 |
| --- | --- | --- |
| `warn_bytes` | 4 GiB | 3 个活跃 Agent 的进程树通常 1.5–2.5 GiB，SOXU 自身 0.3–0.6 GiB；留出空间给系统缓存 |
| `critical_bytes` | 6 GiB | 16 GB 机器上继续增长会开始挤压其它应用；此档只预警，不终止活跃 Agent |
| `recover_bytes` | 3.4 GiB | 滞回：必须明显回落才解除预警，避免阈值附近反复报警 |
| `runtime_warn_bytes` | 900 MiB | 单个 Agent 进程树异常膨胀（例如工具输出失控）时单独预警 |
| `idle_after` | 5 min | 「有压力时」允许释放的最小空闲时长 |
| `idle_reclaim_after` | 30 min | 「无压力也释放」的长空闲阈值 |
| `idle_reclaim_min_bytes` | 128 MiB | 省不到这个量就别做无意义的重启 |
| `reclaim_cooldown` | 10 min | 同一 runtime 两次释放请求的最小间隔 |
| `failed_cooldown` | 30 min | 释放失败后的冷却 |
| `max_reclaims_per_tick` | 1 | 一拍最多释放一个，避免一次性停掉全部空闲会话 |

这些都集中在 `MemoryBudget::for_16gb()`，可用 `MemoryBudget::validate()` 校验自洽性
（阈值顺序、间隔下限、冷却下限）。PRD 里明确写了「性能预算待实测校准」，所以这里的数字是
**可调默认值**，不是已经验收的产品承诺；调整后必须重跑基准并更新本文件。

## 释放策略（不会强杀活跃 Agent）

`Governor::evaluate(&sample)` 只产出数据，不动进程：

| 指令 | 触发条件 | 上层动作 |
| --- | --- | --- |
| `Pressure` | 总量跨入/跨出 `warn`/`critical`（带滞回，仅在变化时发一次） | 展示预警；记录诊断 |
| `RuntimeWarning` | 单个 runtime 树 ≥ `runtime_warn_bytes`（进入时一次） | 展示「该会话内存异常」 |
| `ReleaseIdleRuntime` | `Activity::Idle` 且空闲 ≥ `idle_after`（有压力）或 ≥ `idle_reclaim_after`（无压力），且可回收 ≥ `idle_reclaim_min_bytes`，且不在冷却中，且聚合完整 | 调 `PiSupervisor::stop`（abort → 关 stdin → 超时才强杀） |
| `ReclaimFailed` | 上层回报释放失败 | 只降级为预警 + 拉长冷却 |
| `Degraded` | 平台指标不可用（每次运行只报一遍） | 展示「本平台无该指标」 |
| `NeedsAttention` | 刚进入 `critical` | 提示人工介入；**不提供自动杀进程路径** |

不可协商的规则：

1. `Activity::Active` / `Activity::Unknown` 永不进入释放候选——类型上没有 kill 指令，代码里也没有
   按 PID 发信号的路径。
2. 采样失败（`runtime.error` 或 `missing_processes > 0`）的 runtime 一律跳过：宁可少释放，不误判。
3. 释放是**优雅停止**：`PiSupervisor::stop` 先发 `abort`，再关 stdin，超过 `shutdown_grace` 才强杀；
   会话内容由 Pi 自己的 JSONL 持久化，因此**停止不等于丢会话**（下次发送会重新拉起运行时并
   由 Pi 重放历史）。UI 需要把「已被释放的空闲会话」显示成可恢复状态，这是下一步的界面工作。
4. 释放失败只降级为预警并拉长冷却，绝不升级为强杀。

## 平台限制与降级

| 平台 | 现状 | 降级行为 |
| --- | --- | --- |
| Windows | 完整实现（工作集 + 私有提交 + 进程树 + 可选 `EmptyWorkingSet` 裁剪自有进程） | 无 |
| Linux | 完整实现（procfs）；`trim_working_set` 明确不支持 | 读不到 `smaps_rollup` 时该进程私有提交为 `None`，聚合整体降级为 `None` |
| macOS | **未实现**（需要 libproc/`proc_pidinfo`，且有实机验证门槛） | 所有指标报 `E_PLATFORM_UNSUPPORTED`；不产生任何预警或释放动作，只展示降级原因 |

降级的语义是「明确说不知道」：不会把不可用的指标当成 0，也不会因此产生释放。

Windows 侧的已知误差：进程树来自一次快照 + 逐进程查询，两者不是同一瞬间；采样期间退出/新建的
进程体现在 `missing_processes` 里。PID 复用理论上会让新进程被当成旧进程的子进程，但快照按父子
关系一次性取回，误判窗口只有一个采样周期，且**不会导致任何释放动作**（释放只针对 Idle runtime 的
root PID，并且要求聚合完整）。

## 接线方式（上层）

```rust
use std::time::Instant;
use soxu_agent_runtime::{RuntimeState, PiSupervisor};
use soxu_resource_monitor::{
    Activity, Directive, Governor, MemoryBudget, Monitor, MonitorConfig, ReclaimOutcome, Target,
    platform::SystemSampler,
};

let budget = MemoryBudget::for_16gb();
let sampler = SystemSampler::new();
let mut monitor = Monitor::new(&sampler, MonitorConfig::from_budget(&budget));
let mut governor = Governor::new(budget.clone());

// 每次 tick（UI 已有 5 s 定时器）执行一次；没有自己的定时器，也没有自己的线程。
fn tick(
    supervisor: &PiSupervisor,
    monitor: &mut Monitor,
    governor: &mut Governor,
    sampler: &SystemSampler,
    now: Instant,
) {
    if !monitor.due(now) {
        return;
    }
    // 活动状态来自 Supervisor 的状态机，不由监控猜测。
    let targets = supervisor
        .processes()
        .into_iter()
        .filter(|process| process.is_samplable())
        .filter_map(|process| {
            let activity = match process.state {
                RuntimeState::Idle => Activity::Idle { since: now }, // 实盘要缓存进入空闲的时刻
                RuntimeState::Starting | RuntimeState::Running | RuntimeState::Stopping => Activity::Active,
                RuntimeState::Exited => Activity::Unknown,
            };
            process.pid.map(|pid| Target::new(process.identity.runtime_id, pid, activity))
        })
        .collect::<Vec<_>>();

    let sample = monitor.sample(sampler, now, &targets);
    for directive in governor.evaluate(&sample) {
        if let Directive::ReleaseIdleRuntime { key, .. } = directive {
            // 必须在异步上下文里用 tokio::spawn 调用，这里只是示意映射关系。
            // governor.record_release(&key, ReclaimOutcome::Released, Instant::now());
            let _ = (&key, ReclaimOutcome::Released);
        }
    }
}
```

要点：`Idle { since }` 必须由上层缓存「进入空闲的时刻」（状态机迁移时间），监控不猜时间。

## 自动化测试与证据

```bash
cargo test -p soxu-resource-monitor -p soxu-agent-runtime
```

| 验收点 | 用例 |
| --- | --- |
| 指标可用性与平台解释 | `metrics::tests::*`、`own_process_reports_platform_metrics`、`system_snapshot_lists_own_process` |
| 进程树真实聚合（含子进程） | `tree_sums_parent_and_grandchild`、`excluded_subtree_is_not_counted_twice`、`collect_tree` 系列 |
| 采样开销与有界历史 | `sampling_overhead_stays_small`、`monitor_history_stays_bounded` |
| 诊断展示（不含密钥/路径） | `summary_mentions_platform_totals_and_degradation` |
| 3 Agent 并发 | `three_agents_survive_sampling_and_only_the_idle_one_is_released`（真实 3 棵两进程树 + 20 拍） |
| 长时间空闲（4 小时） | 同上测试的虚拟段：2880 拍 × 5 s，只释放唯一空闲 Agent |
| 不干扰活跃 Agent | 同上的存活断言 + `active_runtime_is_never_released_even_over_critical`、`unknown_activity_is_never_released` |
| 超限只预警不杀 | `Pressure`/`NeedsAttention` 断言；`Directive` 类型里没有 kill 变体 |
| 释放失败不丢会话 | `failed_release_downgrades_to_warning_and_extends_cooldown` |
| 采样失败不误释放 | `snapshot_failure_blocks_release`、`incomplete_tree_is_not_used_as_release_evidence` |
| 平台降级 | `degraded_platform_reports_once_and_still_warns`、`platform::unsupported` 编译通过 |
| Supervisor 集成点 | `managed_runtimes_expose_distinct_samplable_pids`（agent-runtime） |

已验证环境（2026-11-05）：Windows 11 / PowerShell 7 / Rust 1.99.1 / Node 26.10.0，
`cargo test -p soxu-resource-monitor -p soxu-agent-runtime` 全绿（resource-monitor：23 单测 +
11 + 5 + 1 集成用例；agent-runtime：既有 31 单测 + 13 集成 + 新增 1 集成）。

实测记录（同一台机器，debug 构建）：

- 3 Agent 实时采样：进程树总量 448.0 MiB，20 拍平均 9.1 ms / 最差 15.9 ms 每拍；
- 单棵两进程树：`processes=2 resident=132.1 MiB private=56.6 MiB missing=0`；
- 整树 vs 仅 root：120.1 MiB vs 74.1 MiB（证明子进程确实被计入）；
- 虚拟 4 小时空闲：`ticks=2880 releases=[("agent-2", 300s)]`，活跃的两个 Agent 零次被选中。

## 基准方法（Windows 16 GB / 3 Agent）

1. 记录环境：OS 版本、CPU/内存、Rust 与 Node 版本、Pi 版本、模型 ID、启用的 Skills/Extensions、会话集。
2. 冷启动 SOXU，静置 5 分钟，记录自身基线（`sample.self_usage`）。
3. 启动 3 个真实 Pi 会话，各跑一轮同等长度的任务；稳定后连续采样 10 分钟（5 s 一拍）。
4. 采集：`total_resident_bytes`、`total_private_bytes`、每棵树的 `resident/private/processes`、
   每拍 `sample_cost`；原始数据保留为 JSON/CSV 并附在 PR 里，不要只贴汇总结论。
5. 空闲释放验证：让 2 个会话空闲 30 分钟，确认只释放空闲的那个、活跃会话 PID 与状态不变，
   且被释放会话再次发送时能恢复（P-02）。
6. 报告门槛：同硬件、同 Pi 版本、同模型/扩展、同会话集、多次完整进程树采样；未达成目标不得
   宣称节省比例（`agents/policies/testing.md`）。

## 未验证 / 已知限制

- **Linux 未实机运行**：仅通过 `cargo check -p soxu-resource-monitor --all-targets --target x86_64-unknown-linux-gnu`
  编译验证（含测试目标）。CI 会在 ubuntu-24.04 上跑 `cargo test --workspace --locked`。
- **macOS 未实现**：只保证降级路径编译通过（`--target aarch64-apple-darwin`）。
- **release 构建未测**：采样开销数字来自 debug 构建。
- **未接入 UI/诊断面板**：crate 与 Supervisor 集成点已就绪，但 Tauri 命令与前端展示是后续任务；
  当前没有面向用户的「内存诊断」入口。
- **未接管真实 Pi 的长时间压测**：自动化用 Node 夹具（真实子进程树）与虚拟时钟覆盖；真实
  `pi --mode rpc` 的 3 Agent 长跑仍需人工按上面的基准方法实测。
- `EmptyWorkingSet`（裁剪自有进程工作集）已实现但**默认不启用**，且没有调用方；它能立刻降低工作集，
  代价是后续访问要换页，属于需要单独评审的优化。
