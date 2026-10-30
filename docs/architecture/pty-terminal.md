# 终端服务与桌面集成（TASK-030）

本文件记录 SOXU 终端能力的**已实现行为**：PTY 服务层（`crates/pty-service`）、
桌面适配层（`apps/desktop/src-tauri/src/pty.rs`）、命令层（`commands/pty.rs`）与
终端抽屉（`apps/desktop/src/components/TerminalDrawer.vue` + `src/terminal/`）。
未验证的部分单列在「验证状态」，不写成已完成。

对应任务：[TASK-030](../../tasks/backlog/TASK-030.md)。方案已定：**portable-pty**
（Windows 走 ConPTY、Unix 走 forkpty）。会话与运行时见
[多会话工作区](../development/multi-session-workspace.md)，命令落位规则见
[命令层领域块](command-blocks.md)。

## 1. 范围与非目标

范围内：

- 为某个**已登记的会话**打开一个真实 shell（默认平台 PowerShell / bash）。
- 键盘输入原样转发；输出经 **16ms 合并**后推送前端，按 UTF-8 字符边界切分。
- 尺寸变化（拖窗口 / 抽屉宽度变化）同步给内核与 shell。
- 关闭时**回收子进程**：应用退出、抽屉卸载、会话切换都不留孤儿。

非目标：

- 不做终端复用（tmux 式会话保持）：一个 PTY 对应一次打开，关闭即结束。
- 不实现 shell 集成（提示符解析、命令块、目录跟随）。
- 不提供任意程序启动能力：只允许白名单内的交互式 shell。
- 不在终端里注入 SOXU 的凭据或环境变量。

## 2. 身份与所有权

| 身份 | 来源 | 生命周期 |
| --- | --- | --- |
| `sessionId` | Pi 会话文件 | 稳定；终端**绑定**它推导工作目录 |
| `ptyId` | `PtyService` 分配（`pty_<n>`） | 一次打开；进程内不复用，前端不会把旧事件写进新终端 |
| 子进程 pid | portable-pty 的 `Child` | 随 `close_pty` 回收 |

所有权边界（每项只有一个 owner）：

| 资源 | 唯一 owner | 说明 |
| --- | --- | --- |
| 子进程 + PTY 句柄 | `PtySession` | 关闭与 `Drop` 都走同一条回收路径 |
| 读线程 / 合并线程 | `PtySession` | 句柄存在会话里，关闭时有界等待结束 |
| ptyId 注册表 | `PtyService` | `HashMap` + 数量上限；只做查找，不复制句柄 |
| 输出事件订阅 | `TerminalDrawer` | 卸载时取消订阅 |
| 尺寸去重状态 | `TerminalDrawer`（`createResizeGate`） | 每帧的 `onResize` 合并成一次 IPC |
| 输出事件监听（Tauri） | `pty::event_sink` 注册在 `lib.rs` 的 setup | 应用级单例 |

关键不变式：

1. **先订阅再创建**：订阅早于 `create_pty`，创建返回前的输出先进入有界缓冲，
   拿到 ptyId 后按序补写（否则 ConPTY 的首屏内容会丢）。
2. **关闭顺序固定**：kill 子进程 → 释放 master/writer → 有界等待退出。
   反过来（先放 PTY）在 Windows 下会先断输出、进程仍在跑，那就真的留下孤儿。
3. 关闭是幂等的：第二次 `close_pty` 返回 `existed: false`，不动任何进程。
4. **关闭标志与合并线程共享同一个 `Arc<AtomicBool>`**：合并线程靠它丢弃迟到输出。
   两者若是各自独立的标志，「关闭后不再推送」就只是注释里的承诺。
5. **自行退出也要让出名额**：用户在终端里敲 `exit` 不走 `close()`，
   注册表按 `is_finished()`（显式关闭 ∨ 读取流结束 ∨ 子进程已退出）统计与清理，
   否则死终端会一直占着会话上限。

## 3. 输出通路与 16ms 合并

    master.read()  ──reader 线程──▶ mpsc ──pump 线程──▶ sink(PtyOutput) ──▶ soxu://pty-output
                                            （16ms 窗口）

- **窗口**：`FLUSH_INTERVAL = 16ms`（约 60 次/秒），窗口内的分片合并成一次推送。
- **突发上限**：累计超过 `MAX_PENDING_BYTES`（256 KiB）立刻强制推送，内存有界。
- **UTF-8 边界**：`flush()` 只交出**完整**字符前缀；不完整的尾巴留在缓冲里等下一个分片，
  否则跨 `read` 的汉字会被解码成 U+FFFD（看起来就是乱码）。真实非法字节（`error_len`
  为 `Some`）会立刻按 lossy 推出，不会被永久扣住。
- **流结束**：读取线程结束（EOF/错误）后 `finish()` 把剩余字节一次性交出。
- **关闭后的迟到输出一律丢弃**：`close()` 置位的是合并线程持有的同一个 `closed` 标志，
  关闭期间仍在管道里的字节不会再推给前端。
- 前端**不再做二次节流**：两层窗口叠加会变成可见延迟。

为什么不在后端逐字节 emit：IPC 队列会被打满，表现为「大输出时界面卡住」。
实测（2000 行 / 约 20 KiB）：后端侧 2000 行只产生个位数事件
（`crates/pty-service/tests/pty_lifecycle.rs`），浏览器侧最长帧间隔 16.8ms
（`docs/development/evidence/issue-122-pty-terminal/metrics.json`）。

## 4. 关闭与回收

| 触发 | 路径 |
| --- | --- |
| 点抽屉关闭按钮 | `emit("close")` → App.vue 置 `terminalOpen = false` → 组件卸载 → `close_pty` |
| 切换会话 | 抽屉以 `sessionId` 为 key，切换即卸载重建 → 旧 PTY 被关闭 |
| 应用退出 | `RunEvent::Exit` 里 `PtyService::close_all()`（先于 Pi 运行时回收） |
| 组件异常销毁 | `PtySession::drop` 兜底走同一回收路径 |
| shell 自己退出（用户敲 `exit`） | 不走 `close_pty`；注册表按 `is_finished()` 发现，下一次 `create_pty` 清理时 `drop` 走同一回收路径，名额随之释放 |

回收是**有界**的：等待子进程退出最多 3 秒、等待线程结束最多 1 秒；超时不会卡住界面，
但会如实上报（`exited: false`），命令层同时打印一条诊断——「无残留进程」这条验收不允许
被静默破坏。

## 5. 尺寸同步

- 容器变化由 `ResizeObserver` 驱动 `FitAddon.fit()`。
- xterm 的 `onResize` 只把尺寸交给 `createResizeGate`：**与上次发出去的不同**才发 IPC，
  并且每帧最多一次（`requestAnimationFrame` 合并）。
- 后端校验：`1..=500`，非法尺寸返回 `E_PTY_INVALID_SIZE`，不会去动内核的 winsize。

## 6. 安全边界

终端等于一个**以当前用户身份运行的 shell**，因此按「新增原生能力」处理：

| 风险 | 处理 |
| --- | --- |
| WebView 指定任意目录 | `create_pty` **不接受 cwd 参数**；工作目录由会话目录推导（Pi 记录的 cwd，其次工作树目录），再过守卫：必须落在已登记项目（含其附加工作树）内，`canonicalize` 后按路径分量比较 |
| 启动任意程序 | `ShellSpec` 白名单（pwsh / powershell / cmd / bash / zsh / sh / dash / fish / nu），参数走结构化 argv，程序名里夹带空格/分号/管道一律拒绝 |
| 继承 Runner 凭据 | 子进程启动时移除 `GH_TOKEN`、`GITHUB_TOKEN`、`ATOMGIT_TOKEN`、`GITHUB_PAT`、`NPM_TOKEN` |
| 新增 Tauri capability | **没有新增**：命令由本进程实现，不引入 shell 插件，`capabilities/default.json` 未改动 |
| 资源耗尽 | 同时打开的终端上限 `DEFAULT_MAX_SESSIONS = 8`；输出缓冲与回滚行数都有界 |
| 用别的 `ptyId` 操作终端 | **尚未绑定会话归属**：`write_pty` / `resize_pty` / `close_pty` 只按 id 查找。`ptyId` 在进程内单调分配（`pty_1`、`pty_2`…）因此可猜。当前是单窗口单 WebView，影响仅限于「操作本窗口里已存在的终端」；**多窗口或多 WebView 之前必须把 `ptyId` 与会话绑定**（记录 owner sessionId 并在命令层校验） |

工作目录守卫的错误码：

| 错误码 | 含义 |
| --- | --- |
| `E_PTY_SESSION_REQUIRED` | 未给出会话 id |
| `E_PTY_UNKNOWN_SESSION` | 会话未登记（无法推导目录） |
| `E_PTY_UNKNOWN_WORKTREE` | 会话所属工作树未登记 |
| `E_PTY_CWD_REQUIRED` / `E_PTY_CWD_MISSING` / `E_PTY_CWD_NOT_DIRECTORY` | 目录为空 / 不可用 / 不是目录 |
| `E_PTY_CWD_OUTSIDE_PROJECT` | 目录不在任何已登记项目内 |

## 7. 桌面 IPC 与 UI

命令名与 `apps/desktop/src/terminal/ptyClient.ts` 一一对应，字段为 camelCase；
四条命令都登记在 `lib.rs` 的 `pty` 领域块内（块内按字母序）。

| 命令 | 参数 | 返回 |
| --- | --- | --- |
| `create_pty` | `sessionId, cols?, rows?, shell?` | `PtySessionView { ptyId, pid, cols, rows, shell }` |
| `write_pty` | `ptyId, data` | `void` |
| `resize_pty` | `ptyId, cols, rows` | `void` |
| `close_pty` | `ptyId` | `PtyClosedView { ptyId, existed, exited, exitCode }` |

输出事件：`soxu://pty-output`，负载 `{ ptyId, seq, data }`；`seq` 单调递增，
前端只放行 `seq > lastSeq`（重复/乱序一律丢弃，避免串屏）。

UI 行为：

- 顶栏终端按钮与「Ctrl + `」快捷键打开/关闭抽屉；打开后焦点直接进 xterm。
- 右侧抽屉一次只显示一个面板：终端、会话状态、搜索三者互斥。
- 标题栏显示「项目名 · 终端」、状态（正在打开 / 已连接 / 已关闭 / 不可用）与解析后的 shell 路径。
- 终端配色取自 V4 token（`--code-bg` / `--fg` / `--accent`），字体取自
  `--soxu-font-family-mono`，因此跟随「设置 → 代码字体」档位。
- **不绑定 Escape 关闭**：Escape 在 vim / less / 菜单里是真实按键，抽屉不能抢。

## 8. 测试与复现命令

```powershell
# PTY 服务：单元（合并器 / 白名单 / 上限）+ 真实 shell 集成
cargo test -p soxu-pty-service

# 桌面适配：工作目录守卫单测 + 真实会话目录与真实 PTY 的集成
cargo test -p soxu-desktop

# 前端纯逻辑与接线（node:test，无需浏览器）
pnpm --filter @soxu/desktop test

# 浏览器实测（自己拉起 Vite + headless Edge，产出截图与 metrics.json）
node apps/desktop/tests/harness/shoot-issue-122-terminal.mjs

# 仓库门禁
pnpm check
cargo fmt --all -- --check
cargo test --workspace
git diff --check
```

| 验收点 | 证据 |
| --- | --- |
| clippy 无新增 warning | `cargo clippy --workspace --all-targets`：`soxu-pty-service` / `soxu-desktop` 0 warning（仅 `soxu-agent-runtime` 的 `process_tree` 测试存在既有 warning） |
| 终端可交互，输出不乱码 | `pty_lifecycle.rs`：`real_shell_output_round_trips_through_the_pty`、`write_and_resize_reach_the_running_shell`；`output.rs` 单测：`utf8_split_across_chunks_is_reassembled_without_replacement_chars`；浏览器实测 `banner-rendered` / `cjk-no-mojibake` / `typed-input-echoed` |
| 关闭会话后无残留 pwsh 进程 | `pty_lifecycle.rs`：`closing_a_terminal_reclaims_the_shell_process`（断言 `exited`、退出码、线程结束、重复关闭幂等）、`a_shell_that_exits_by_itself_releases_its_session_slot`（自行退出也释放名额）；`pty_bridge.rs`：`closing_is_idempotent_and_close_all_reclaims_every_terminal`；浏览器实测 `close-reclaims-pty` |
| 输出节流生效（大输出不卡 UI） | `large_output_is_coalesced_into_a_few_events`（2000 行 → 事件数远小于行数，seq 连续）；`burst-keeps-ui-responsive`（最长帧间隔 16.8ms） |
| 尺寸变化时 resize | `resize-on-container-change`（抽屉 320px → 520px，列数 41 → 69）；`createResizeGate` 单测（同尺寸不重复发） |

## 9. 验证状态

本机实测通过（2026-10-30，Windows 11 / Rust 1.99.1 / Node 26.10.0 / pnpm 12.15.0 /
Edge 156.0.4314.50 headless）：

- `cargo test -p soxu-pty-service` → 24 单元 + 7 集成用例通过
  （含 `a_closed_session_never_delivers_late_output`、
  `a_shell_that_exits_by_itself_releases_its_session_slot`）。
- `cargo test -p soxu-desktop` → 6 个守卫单测 + 6 个 `pty_bridge` 集成用例通过。
- `cargo test --workspace` 全绿；`cargo fmt --all -- --check` 与 `git diff --check` 通过。
- `pnpm check` → 桌面端 273 用例 + 脚本 58 用例全绿（在开发 Agent 会话里
  `scripts/tests/secret-gate.test.mjs` 会因 `SOXU_AGENT_SESSION=1` 失败，清掉该变量后全绿，
  与本次改动无关）。
- `node apps/desktop/tests/harness/shoot-issue-122-terminal.mjs` → 11/11 检查通过，
  截图 3 张与 `metrics.json` 见[证据目录](../development/evidence/issue-122-pty-terminal/README.md)。

**未验证**：

- Tauri WebView 内的实机终端（本机未启动 GUI）：浏览器实测用的是同一份组件与真实 xterm.js，
  但 WebView2 的键盘/IME 行为未实机确认。
- macOS / Linux：`portable-pty` 在这两个平台走 forkpty，代码路径已按平台分支并编译过
  （CI 在 ubuntu 上跑 `cargo test --workspace`），但**未在真实 macOS/Linux 桌面**上手动验证终端交互。
- 中文/日文/emoji 的输入法组合（IME）在终端里的表现；仅验证了程序化插入文本。
- 高 DPI 缩放下的字体度量与 `FitAddon` 取整误差。
- 终端里跑全屏 TUI（vim / htop）的重绘表现与滚动条行为。

## 10. 已知限制

1. **一次只活一个终端**：抽屉以 `sessionId` 为 key，切换会话即重建，滚动缓冲随之丢失。
   这是「不增加后台常驻进程」的取舍，不是遗漏。
2. 终端工作目录来自会话记录：附加工作树里的会话，终端落在该工作树目录；若用户手动改过
   JSONL 的 `cwd`，守卫会拒绝并在界面报错，而不是静默改到别处。
3. 没有 shell 集成：不解析提示符、不记录命令历史、不做目录跟随。
4. 关闭时若子进程在 3 秒内不肯退出（极少见），只留诊断日志，不升级为强杀子孙进程树。
5. 输出合并按**字节**切分而不是按行：一条超长行会跨多个事件（xterm 会自行拼接，观感正常）。
6. 终端与 Pi 会话是**松耦合**：停止 Agent 运行时不会关闭终端（终端是用户的工具，
   不是 Agent 的从属资源）；关闭终端也不会影响 Agent。

## 相关文档

- [架构总览](overview.md)
- [命令层领域块](command-blocks.md)
- [多会话工作区](../development/multi-session-workspace.md)
- [Issue #122 验证证据](../development/evidence/issue-122-pty-terminal/README.md)
- [TASK-030](../../tasks/backlog/TASK-030.md)
