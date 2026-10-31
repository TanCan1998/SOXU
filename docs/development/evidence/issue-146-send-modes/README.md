# Issue #146 发送模式证据

本目录是 [发送模式协议调查](../send-modes.md) 的原始证据，两条证据链各一组文件：
**协议层探测**（真实 `pi --mode rpc`）与**桌面端实机走查**（真实 Tauri 窗口 + 真实 Pi）。

## 1. 文件

| 文件 | 内容 |
|---|---|
| `probe-windows.json` | 机器可读探测报告：`environment` / `phases` / `limits`，含每个阶段的原始响应帧摘要 |
| `probe-stdout.log` | 同一次运行的终端摘要（便于快速阅读，不替代 JSON；`*.log` 被 `.gitignore` 排除，只在本地生成，不入库） |
| `desktop-send-modes.json` | 实机走查报告：`environment` / `checks`（24 条断言）/ `cases` / `piProcesses` |
| `desktop-stdout.log` | 实机走查的终端输出（同样被 `.gitignore` 排除，只在本地保留） |
| `desktop-followup-queued.png` | 忙碌时选「排到下轮」→ 输入区出现「已排队 1 条」 |
| `desktop-followup-delivered.png` | Pi 消费队列后：回执消失、状态回 ready、助手回复可见 |
| `desktop-steer-queued.png` | 忙碌时选「加入当前」→ 排队回执 |
| `desktop-parallel-new-session.png` | 「并行发送」→ 新建临时会话 Tab |
| `desktop-parallel-original-running.png` | 并行发送后回到原会话：仍在 running |
| `desktop-stop-before.png` / `desktop-stop-after.png` | 「停止」前后：回执消失、文本回填输入框 |
| `desktop-default-delivery.png` | 不选菜单时按「忙碌时发送」默认值投递 |

## 2. 复现命令

```powershell
# 协议层探测（会真实调用模型，约 8 分钟；失败不自动重试）
pnpm probe:send-modes --out docs/development/evidence/issue-146-send-modes/probe-windows.json

# 桌面端实机走查（先构建 app；会真实调用模型 5 次左右）
cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml
node apps/desktop/tests/harness/verify-issue-146-desktop.mjs
```

## 3. 环境

协议层（取自 `probe-windows.json` 的 `environment`）：

```
platform win32 · arch x64 · node v26.10.0 · pi 1.4.0
model auto/deepseek-v4.1-flash · thinkingLevel off
steeringMode one-at-a-time · followUpMode one-at-a-time
startedAt 2026-10-31T10:37:54Z · finishedAt 10:46:24Z · durationMs 510349 · records 4038
```

Pi 以 `--no-tools --no-extensions --no-mcp --no-skills --no-prompt-templates
--no-context-files --thinking off` 启动：只观测投递语义，不加载真实项目资源。

桌面端（取自 `desktop-send-modes.json` 的 `environment`）：

```
target/debug/soxu-desktop.exe · pi 1.4.0 · vite 1420 · CDP 9452 · viewport 1280x820
piLaunch: rustc 转发 shim（本机只有 pi.cmd 包装）
piSessionDir: 临时目录（PI_CODING_AGENT_SESSION_DIR）
```

> **平台风险**：SOXU 用 `Command::new("pi")` 启动 Pi，Windows 的 CreateProcess 只补 `.exe`，
> 本机托管安装只有 `pi.cmd`（`node spawn("pi")` 直接 ENOENT）。走查用 `rustc` 在临时目录
> 编译了一个最小转发 shim（`pi.exe` → `node pi-launcher.js`），**没有改产品代码**。
> 真实用户在同环境下会起不来 Pi，已记录为待办（见 send-modes.md §3.10 末段）。

## 4. 结果

### 4.1 协议层（`probe-windows.json`）

| 阶段 | 观测到的事实 | 关键字段 |
|---|---|---|
| `busyPromptWithoutBehavior` | 忙碌时发普通 prompt **被拒绝** | `success:false`，`error:"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp')…"` |
| `steerWhileBusy` | `prompt+steer` 与独立 `steer` 都排队、都会投递 | 两次 `disposition:"queued"`；`queue_update` steering 1→2；`pendingMessageCount:2`；`deliveredA/B:true` |
| `followUpWhileBusy` | 独立 `follow_up` 排队，长任务结束后作为新用户消息投递 | `disposition:"queued"`；队列下标 1083 → 用户消息 1931 → `agent_settled` 2071（**只有一次**） |
| `followUpPromptWhileBusy` | **`prompt+streamingBehavior=followUp`（SOXU 的真实线格式）同样投递** | `disposition:"queued"`；队列 2080 → 用户消息 2925 → 助手输出 3003-3004 → `agent_settled` 3007（只有一次） |
| `idleWithStreamingBehavior` | 空闲时带 `streamingBehavior` 不被拒 | `disposition:"started"`；`agent_settled aborted:false`；`delivered:true` |
| `abortWithQueuedFollowUp` | `abort` **不清空**队列 | `abort success:true`；`agent_settled aborted:true`；`pendingMessageCount:1`；`delivered:false` |
| `clearQueue` | `clear_queue` 真的撤掉排队消息 | `data.steering:1`、`data.followUp:2`；`deliveredS/F:false` |
| `parallelTwoRuntimes` | 两个独立运行时互不干扰 | 两条 `disposition:"started"`；`crossTalk:false`；`ownTextPresent:true` |
| `sessionHealth` | 全程无失步 | `parseErrors:[]`，`records:4038` |

### 4.2 桌面端（`desktop-send-modes.json`）

24 条断言全部通过（`checks` 里 `ok:true`），判据是 Pi 自己写的会话 JSONL 与界面状态：

| 用例 | 结果 |
|---|---|
| 排到下轮 | 回执「已排队 1 条」→ JSONL 里作为用户消息投递（`index:2`，之前已有 `user`+`assistant`）→ 回执消失、状态回 `ready` |
| 加入当前 | 忙碌时可点 → 回执出现 → JSONL 里真的投递（`index:6`） |
| 并行发送 | 新 Tab（`ses_tmp_*`）+ active 切过去 + 消息写进**新的** Pi 会话文件的**第一条**用户消息 + 原会话仍 `running` |
| 停止 | 回执消失 + 文本回填输入框 + 6 秒内该消息没有被 Pi 执行（`deliveredAfterStop:false`） |
| 忙碌时默认投递 | 提示语写明「按「加入当前」投递」，不选菜单直接发送也进了队列 |
| 残留进程 | `piProcesses: {found:0, killed:0}` |
| 前端异常 | `consoleIssues: []`，`stderr: ""` |

走查还暴露了两个**既有**缺陷（已随本任务修复，详见 send-modes.md §3.10）：

1. Pi 1.4.0 的会话事件是**扁平帧**（`{"type":"agent_settled",…}`），旧解码只认
   `{"type":"event",…}` 包装 → 所有事件都落进 `UnhandledRecord`，
   `agent_settled` 从未生效（修复前截图诊断里就写着「未处理的记录类型：agent_settled」）。
2. 修好解码后 `message_end` 的 user 正文会被渲染成助手回复、`turn_end` 会重复一遍 →
   实时窗口加了「只收助手正文」的门禁。

## 5. 门禁结果（同一 Git tree）

下表是本次把任务改动与最新 main（已含 Issue #147 扩展页）合并后，在**同一个 Git tree** 上重跑的结果——
而不是合并前那次运行的旧数字。

| 命令 | 结果 |
|---|---|
| `pnpm check` | 通过（桌面端 475 个测试 + 脚本 71 个测试全绿） |
| `cargo fmt --all -- --check` | 通过 |
| `cargo clippy --workspace --all-targets --locked -- -D warnings` | 通过 |
| `cargo test --workspace` | 通过 |
| `git diff --check` | 通过 |

注意：在**开发 Agent 会话**里直接跑 `pnpm check` 会在
`scripts/tests/secret-gate.test.mjs`「暂存普通文本时门禁放行」上失败——因为
`.githooks/pre-commit` 依赖的 `scripts/check-staged.mjs` 会拒绝
`SOXU_AGENT_SESSION=1` 的会话提交（Issue #97 之后刻意加的门禁，
防止 Agent 自己 commit 绕过 testedTree/reviewedTree 校验）。该用例在
Runner 环境（没有这个变量）下 71/71 通过，本次已在清掉该变量的同一 shell 里复现全绿。

## 6. 本次没有验证的

- macOS / Linux（只在 Windows 11 + WebView2 上走查）。
- 真实工具调用场景下的 steer 时点（协议层实测没有工具调用）。
- 助手正文的增量渲染：正文在 `message_end` 一次性出现。
- 队列长度上限、并发上限与内存占用。
- Windows 上「pi 只有 .cmd 包装」的产品侧修法（本轮只记录风险，用临时 shim 绕过）。
