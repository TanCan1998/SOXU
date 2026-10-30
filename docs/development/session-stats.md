# 上下文环与统计行（TASK-027 / Issue #119）

本文件描述 composer 右侧的上下文占用圆环、点击展开的统计浮窗与底部统计行的**已实现行为**。
它只记录仓库当前代码真正做的事；未验证的部分单列在第 9 节，不写成已完成。

对应任务：[TASK-027](../../tasks/backlog/TASK-027.md)。契约来源：
[V4 交互盘点](../design/UIUX/V4/interaction-inventory.md) 第 5 节的 session_stats 返回形状。

## 1. 范围与非目标

范围内：

- 新增 Tauri 命令 session_stats(sessionId)，返回 context / turn / process / session 四组指标；
- 圆环：14px SVG、stroke 2.8、按占用率三档变色；
- 浮窗：上下文百分比、首 token、回复耗时、流式速度、均速、缓存命中、内存/CPU/子进程、
  载入数、输入输出 token、重试预算；
- 底部统计行：轮次 / 首 token / 回复耗时 / 流式 / 均速 / 缓存命中 / 输入输出；
- 数据来自**已有事件流**与 runtime_status，不新增轮询。

非目标（本任务不做）：

- 会话级累计费用估算：Pi 的 cost 字段形态未实机核对，宁可留空也不编数字；
- 历史轮次的折线图/趋势：需要持久化统计，本任务只保留内存中的最近一轮；
- CPU 占用采样：当前 soxu-resource-monitor 的采样器不提供该指标（见第 5 节）；
- 模型切换与上下文窗口的手动覆盖（属于 model 领域切片）。

## 2. 分层与唯一 owner

```
SessionStatsRing.vue / SessionStatsRow.vue   ← 只渲染，不判断阈值也不格式化
        ⇅ components/sessionStats.ts          ← 阈值、几何、格式化、刷新判据（纯函数）
ChatPanel.vue → ChatComposer.vue              ← 装配：圆环在输入框右侧，统计行在其下方
        ⇅ workspace/sessionWorkspace.ts       ← Tab 上的 stats 状态与刷新合并规则
        ⇅ WorkspaceBridge.sessionStats()
commands/stats.rs → stats/mod.rs              ← 采集：累加快照 + 按需采样 + 会话身份
        ⇅ stats/accumulator.rs（纯逻辑）、stats/store.rs（有界表）、stats/usage.rs（payload 解析）
        ⇅ driver.rs（事件累加）、session_runtime.rs（执行身份与重试预算）
```

| 资源 | 唯一 owner | 释放时机 |
| --- | --- | --- |
| 统计累加器 | driver::drive 任务（`AppState.stats`） | 进程退出；表按容量淘汰最久未更新项 |
| 进程树采样 | session_stats 命令的一次调用 | 采样完成即结束，无后台线程 |
| Tab 的统计状态 | WorkspaceSession（随 Tab 一起释放） | 关闭 Tab / dispose |
| 浮窗显隐 | SessionStatsRing 的 PopoverRoot | 关闭浮窗（reka-ui 负责焦点归还） |

## 3. IPC 契约

| 命令 | 参数 | 返回 | 说明 |
| --- | --- | --- | --- |
| session_stats | sessionId | SessionStats | 只读；空 sessionId 返回「sessionId 不能为空」 |

返回字段（camelCase，`apps/desktop/src-tauri/src/dto/stats.rs`）：

| 组 | 字段 | 语义 |
| --- | --- | --- |
| 顶层 | sessionId / runtimeId / generation / updatedAtMs | 执行身份与最后一次观测时间 |
| context | used / total / percent | 上一次请求的上下文占用、模型窗口、占用率 |
| turn | turns / inFlight / firstTokenMs / durationMs / streamTokensPerSec / avgTokensPerSec / cacheHitPct | 最近一轮（或进行中这一轮） |
| process | rssMb / cpuPct / childCount / degraded | 受管 Pi 进程树的一次采样 |
| session | entriesTotal / worktree / inputTokens / outputTokens / retry | 会话身份、累计 token、重试预算 |

**除 sessionId 外所有数值字段都是可空（null）。**「没有观测到」与「观测到 0」是两件事：
前端不得用 `?? 0` 抹平，否则「本轮耗时 0 ms」「缓存命中 0%」会凭空出现。

## 4. 事件累加口径

driver 在**分发事件的同一条路径**上顺手累加（迟到事件已过 generation 闸门，既不上屏也不进统计），
因此浮窗里的数字与消息流同源。

| 指标 | 定义 |
| --- | --- |
| 轮次 | 收到 settled 的次数；未正常结束的一轮（exit）不计数 |
| 首 token | prompt 被 Pi 接受 → 第一个带文本的流式事件 |
| 回复耗时 | prompt 被接受 → settled；进行中时为「到目前为止」 |
| 流式速度 | 本轮输出 token / 首 token 到结束的秒数 |
| 均速 | 本轮输出 token / 整轮耗时 |
| 缓存命中 | cacheRead / (input + cacheRead + cacheWrite) |
| 上下文占用 | 最近一次 usage 的 input + cacheRead + cacheWrite |
| 输入/输出 token | 每轮 settled 时累加一次该轮的 usage（同一轮多次 message_update 只算一次） |

usage 的解析在 `stats/usage.rs`：宽容但保守——

- 字段名同时接受 camelCase 与 snake_case（cacheRead / cache_read）；
- 只认明确的数字字段，找不到就返回 None，绝不估算；
- 只在 payload 内部向下找 3 层（message / result / data / usage），不为任意深度的工具输出付代价。

新一代运行时开始时丢弃**未完成**的一轮（`StatsStore::begin_generation`）：
上一代的 prompt 计时不能算到新代头上，累计 token 与轮次则保留。

## 5. 进程采样

- 只有 session_stats 被调用时才采样一次（用户打开浮窗 / 事件边界），**没有常驻采样线程**；
- 复用 `soxu-resource-monitor` 的 `SystemSampler` 与 `collect_tree`（与内存预算同一套平台实现），
  采样在 `spawn_blocking` 里执行，不在异步线程上做进程枚举；
- 根进程采样失败 → 返回错误并降级为「不可用」，不拿 0 MB 冒充成功；
- 部分子进程已退出 → rssMb 是**下限**，degraded 里带 `process_tree_partial`；
- 当前采样器不提供 CPU 占用 → cpuPct 恒为 null，degraded 里带 `cpu_unsupported`，
  浮窗显示「当前平台采样器不提供 CPU 占用」而不是 0%。

## 6. 前端渲染规则

| 规则 | 实现位置 |
| --- | --- |
| 圆环 14px / stroke 2.8 / 半径扣掉半个线宽 | `RING_SIZE`、`RING_STROKE`、`ringGeometry` |
| <60% 强调色、60–85% 警告、>85% 危险 | `ringTone`（60 与 85 都归警告档） |
| 窗口未知时不画弧（空心圆环） | `ringTone(null) === "unknown"`，组件用 v-if 去掉弧 |
| 无数据一律显示「—」 | `PLACEHOLDER` 与各 format* 函数 |
| 浮窗与统计行读同一个视图对象 | `composeStatsView` 的结果在 ChatPanel 只算一次 |
| 载入数来自 Tab 的内存窗口，条目总数优先用后端索引 | `composeStatsView(stats, tab)` |

浮窗的样式写在**非 scoped** 块里（类名 `soxu-stats-popover*`）：PopoverContent 经 Portal 传送到 body，
reka-ui 的弹层根元素不带本组件的 `data-v-*`，scoped 选择器会全部落空。
实测回退表现为「透明背景 + 16px 正文字号」，证据脚本已把它变成断言（见第 8 节）。

## 7. 刷新时机（无轮询）

| 触发 | 位置 |
| --- | --- |
| 打开会话 | `WorkspaceSession.openSession` |
| 启动运行时成功 | `startRuntime` |
| prompt 被接受 | `sendPrompt` |
| 运行时状态变化 / settled / exit | `handleEvent` + `shouldRefreshStats` |
| 停止运行时 | `stopRuntime` |
| 打开统计浮窗（用户手势） | `SessionStatsRing` 的 watch → `refresh` |

流式增量（stream）**不**触发刷新：每条 token 拉一次统计等于把轮询搬进事件里。

并发与迟到：

- 请求序号 `seq`：Tab 已关闭、已 dispose 或更新的请求已发出时，迟到响应整条丢弃；
- `pending` 合并：请求进行中再来触发只排队一次补拉，因此「state 紧跟 settled」不会丢掉最后一次刷新，
  也不会因为一串事件打出一串 IPC；
- 失败保留上一次快照并显示原因，不清空成「没有数据」。

## 8. 验证证据

命令（仓库根目录，2026-02 本机 Windows 11 / Node 26 / Rust 1.99.1）：

```
cargo test -p soxu-desktop --lib        # 50 passed（含 stats 的 12 条：累加、解析、有界表、采样失败）
cargo test --workspace                  # 全绿
cargo clippy --workspace --all-targets  # soxu-desktop 无 warning（agent-runtime 测试里的 1 条为既有）
cargo fmt --all -- --check              # 通过
node --test apps/desktop/tests/*.test.ts            # 275 passed（含 sessionStats 17 条）
node scripts/check-command-blocks.mjs   # 13 个领域块 / 25 个 command，落位正确
git diff --check                        # 通过
node apps/desktop/tests/harness/shoot-issue-119-stats.mjs   # 17 项检查全 PASS
```

验收对照：

| Issue 验收点 | 证据 |
| --- | --- |
| cargo clippy 无新增 warning | 上表 clippy 命令：soxu-desktop 0 warning |
| 圆环颜色随占用率变化 | `sessionStats.test.ts` 的三档阈值用例 + 证据脚本读到的计算后描边色 rgb(58,131,247) / rgb(168,118,42) / rgb(192,57,43) |
| 浮窗数值与事件流一致 | `driver::tests::statistics_are_accumulated_from_the_same_event_stream`（同一批事件累加）+ 浮窗与统计行同名项相等用例 |
| 无数据时显示占位而不是 0 | 空快照用例断言每一项都含「—」且不含「0」；证据脚本读到的空态统计行 |
| 提交规范 | 提交由 Runner 执行，消息为 `<gitmoji> type(scope): 描述` |

截图与原始指标在 `docs/development/evidence/issue-119-session-stats/`：

- `stats-rings.png`：42% / 72% / 92% 三档圆环 + 无数据空态；
- `stats-popover.png`：点击圆环展开的统计浮窗（四组指标 + CPU 降级说明）；
- `metrics.json`：视口、浏览器版本、每项检查的实际值与四档 data-tone。

## 9. 未验证与已知限制

1. **真实 Pi 的 usage 事件形态未实机核对**：`docs/development/agent-runtime.md` 已把「事件全集」列为未验证项，
   本任务的解析器覆盖 message_update / message_end / turn_end 常见的 usage 承载位置；
   解析不到时界面显示占位（不是错误数字）。真机联调后需要把实测 payload 补进 `stats/usage.rs` 的用例。
2. **Linux / macOS 未实机验证**：进程采样走 soxu-resource-monitor 的对应平台实现（CI 只跑 cargo test），
   本机只有 Windows 结果；macOS 目前落到 unsupported 实现，会如实降级为「不可用」。
3. **CPU 占用不可用**：采样器不提供，浮窗显示原因而不是 0%。若要补齐，需要先在 resource-monitor 里
   增加带时间窗的 CPU 采样（会产生新的常驻状态），属于独立任务。
4. **未做性能基准**：本任务只增加了一次按需采样与一张有界表（默认 64 个会话），
   没有测量其对启动/内存的影响；按 testing.md 的口径，不能宣称「几乎不占资源」。
5. **未做读屏实测**：圆环按钮有 aria-label、统计行是 dl/dt/dd 结构，但没有跑屏幕阅读器；
   只完成了结构与文案层面的无障碍检查。
