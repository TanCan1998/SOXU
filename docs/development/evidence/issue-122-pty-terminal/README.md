# Issue #122 · TASK-030 终端抽屉（PTY 集成）验证记录

本目录记录**终端切片**的可复现验证：命令、环境、原始指标与截图。
每条证据都能对回 Issue 的 acceptance criteria；未验证或已知限制在文末单列，不写成已完成。

- 验证时间：2026-10-30
- 环境：Windows 11（本机）· Node v26.10.0 · pnpm 12.15.0 · Rust 1.99.1 · Edge 156.0.4314.50（headless）
- 复现脚本：node apps/desktop/tests/harness/shoot-issue-122-terminal.mjs
- 原始指标：metrics.json（同目录，11 条 check 全绿）
- 架构与行为契约：[docs/architecture/pty-terminal.md](../../architecture/pty-terminal.md)

---

## 1. 验收对照

| Acceptance criterion | 证据 |
| --- | --- |
| cargo clippy 无新增 warning | §2.1：`cargo clippy --workspace --all-targets` 中 `soxu-pty-service` / `soxu-desktop` 0 warning（唯一 warning 是 `soxu-agent-runtime` 的 `process_tree` 既有项，本切片未改动该文件） |
| 终端可交互，输出不乱码 | §2.2 Rust 真实 shell 往返 + UTF-8 边界单测；§3.2 浏览器实测 `banner-rendered` / `cjk-no-mojibake` / `typed-input-echoed`（截图 01） |
| 关闭会话后无残留 pwsh 进程 | §2.2 `closing_a_terminal_reclaims_the_shell_process`（断言子进程已退出、拿到退出码、转发线程结束、重复关闭幂等）；§3.6 `close-reclaims-pty`（卸载即 `close_pty`） |
| 输出节流生效（大输出不卡 UI） | §2.2 `large_output_is_coalesced_into_a_few_events`（2000 行 → 事件数远小于行数）；§3.3 `burst-completes` + `burst-keeps-ui-responsive`（最长帧间隔 16.8 ms，截图 02） |
| 提交规范 <gitmoji> type(scope): 描述，目标分支 dev | 由 Runner 统一提交（Developer 不执行 git commit） |

## 2. 命令与原始结果

### 2.1 编译、格式与 lint

    $ cargo fmt --all -- --check
    exit=0

    $ cargo clippy --workspace --all-targets
    warning: this `if` statement can be collapsed      # soxu-agent-runtime tests/process_tree.rs（既有）
    Finished `dev` profile
    # soxu-pty-service / soxu-desktop：0 warning

    $ cargo test --workspace
    # 全部测试二进制 0 failed（含新增 soxu-pty-service 的 22 单元 + 6 集成）

    $ git diff --check
    exit=0

### 2.2 新增用例

| 文件 | 数量 | 覆盖 |
| --- | --- | --- |
| `crates/pty-service/src/output.rs`（单测） | 8 | 16ms 窗口常量；分片不逐条推送；超上限强制推送；跨分片的 UTF-8 字符重组（不乱码）；不完整尾巴等待下一个分片；非法字节不被永久扣住；`finish` 交出 lossy 尾巴；seq 单调 |
| `crates/pty-service/src/shell.rs`（单测） | 6 | 白名单全部通过；`.exe`/大小写规范化；非白名单拒绝；程序名夹带参数拒绝；PowerShell 家族 `-NoLogo`；空白请求回落平台默认 |
| `crates/pty-service/src/manager.rs`（单测） | 5 | 未知 ptyId 的稳定错误码；关闭幂等；非法尺寸/非法 shell 在启动前被拒；id 不复用；上限至少为 1 |
| `crates/pty-service/src/session.rs`（单测） | 2 | 尺寸上下限；幂等关闭结果 |
| `crates/pty-service/tests/pty_lifecycle.rs`（集成，真实 shell） | 6 | 真实往返输出；关闭回收子进程；write + resize 到达 shell；2000 行输出被合并；会话上限；默认 shell 在白名单内 |
| `apps/desktop/src-tauri/src/pty.rs`（单测） | 6 | 项目内放行；项目外拒绝；前缀比较按路径分量；工作树放行 / 失效工作树拒绝；空目录与不存在目录的显式错误；无项目即无终端 |
| `apps/desktop/src-tauri/tests/pty_bridge.rs`（集成，真实会话目录 + 真实 PTY） | 6 | 由会话目录推导 cwd 并报告 pid；未登记会话拒绝；临时会话回落到工作树；输入回显 + 事件数远小于字节数；关闭幂等与 `close_all`；非白名单 shell 拒绝 |
| `apps/desktop/tests/terminalPanel.test.ts` | 15 | 尺寸夹紧/兜底/去重；seq 单调放行；状态与关闭结论文案；IPC 名称与 Rust 命令对应；事件名两侧一致；16ms 常量跨语言断言；组件先订阅后创建、卸载清理；可访问性与 token；App.vue 接线（Ctrl+`、抽屉互斥、以 sessionId 为 key） |

### 2.3 新增依赖

| 依赖 | 版本 | License | 用途 / 必要性 | 包体 |
| --- | --- | --- | --- | --- |
| `portable-pty`（Rust） | 0.9.0 | MIT | 跨平台 PTY；Windows 走 ConPTY、Unix 走 forkpty。方案在 TASK-030 中已定 | 约 60 KiB 源码；运行时无额外进程 |
| `@xterm/xterm`（前端） | 6.0.0 | MIT | Issue 明确要求的前端终端渲染 | 解包约 5.9 MiB（含类型与 sourcemap，打包后按需） |
| `@xterm/addon-fit`（前端） | 0.11.0 | MIT | 按容器尺寸计算 cols/rows；手写字体度量会引入跨平台偏差 | 约 20 KiB |

没有引入 Tauri 插件或新的 capability。

## 3. 浏览器实测（metrics.json）

脚本自己拉起 Vite（1427）与 headless Edge，通过 CDP 真实输入、点击并截图。
夹具里的「后端」是 FakePty（按 16ms 批量投递），组件与 xterm.js 都是生产代码。

### 3.1 首屏与乱码检查

| check | 结果 |
| --- | --- |
| `banner-rendered` | 通过：`.xterm-rows` 文本包含「SOXU 索序终端夹具」与「pty-service」 |
| `cjk-no-mojibake` | 通过：文本包含「索序」且**不含** U+FFFD |
| `shell-reported` | 通过：标题栏显示后端返回的 shell |

> 这一条同时验证了「先订阅再创建」：首屏在 `create` 返回之前就开始投递，
> 组件用有界缓冲接住并在拿到 ptyId 后补写。此前没有缓冲时首屏确实会丢（本次实测发现并修复）。

### 3.2 键盘输入

| check | 结果 |
| --- | --- |
| `typed-input-echoed` | 通过：`Input.insertText` → xterm `onData` → `write_pty`（FakePty 记到 1 次写入）→ 回显出现在终端 |

### 3.3 大输出（2000 行）

| 指标 | 值 |
| --- | --- |
| 投递方式 | 40 次事件 × 50 行（每次间隔 16ms，与后端合并窗口一致） |
| 全部渲染完成 | 707 ms |
| 观测帧数 | 43 |
| **最长帧间隔** | **16.8 ms** |
| 末行是否出现 | 是（`第 2000 行`） |

最长帧间隔 ≈ 一帧（16.8ms），说明合并后的批量写入没有造成可感知的主线程阻塞。

### 3.4 尺寸变化

| 指标 | 值 |
| --- | --- |
| 抽屉宽度 | 320px → 520px（等价于拖动分隔条） |
| 上报列数 | 41 → 69（行数保持 42） |
| `resize_pty` 调用 | 1 次（同尺寸不会重复发） |

### 3.5 主题

| check | 结果 |
| --- | --- |
| `dark-theme-applied` | 通过：切到深色后抽屉背景为 `rgb(33, 33, 33)`（= V4 `--bg-panel` 深色值） |

### 3.6 关闭

| check | 结果 |
| --- | --- |
| `close-reclaims-pty` | 通过：点关闭 → 组件卸载 → `close_pty` 被调用 1 次 |
| `close-bubbles-up` | 通过：关闭事件冒泡到外壳 |
| `no-console-errors` | 通过：无控制台错误 |

## 4. 截图

| 文件 | 内容 |
| --- | --- |
| `01-light-terminal.png` | 浅色首屏：标题栏、状态、shell 路径与带颜色的 CJK 输出 |
| `02-light-burst.png` | 2000 行输出后的滚动状态 |
| `03-dark-terminal.png` | 深色主题 |

## 5. 未验证与已知限制

- **Tauri WebView2 实机**：本机未启动 GUI，浏览器实测用的是同一份组件与真实 xterm.js，
  但 WebView2 的键盘/IME 路径未实机确认。
- **macOS / Linux**：`portable-pty` 的 forkpty 分支已编译并通过 CI（ubuntu 的
  `cargo test --workspace`），但未在真实桌面环境手动验证交互。
- **输入法组合**：只验证了程序化插入文本，未验证中文 IME 的候选窗与终端焦点交互。
- **全屏 TUI**：未在终端里跑 vim / htop 这类程序，重绘与滚动条行为未记录。
- **切换会话会重建终端**：抽屉以 `sessionId` 为 key，切换即关闭旧 PTY（有意取舍，
  见架构文档第 10 节）。
- 关闭时若子进程 3 秒内不肯退出，只记录诊断，不升级为强杀子孙进程树。

## 6. 复现步骤

    pnpm install --frozen-lockfile
    pnpm icons:generate
    cargo test -p soxu-pty-service
    cargo test -p soxu-desktop
    pnpm --filter @soxu/desktop test
    node apps/desktop/tests/harness/shoot-issue-122-terminal.mjs
    pnpm check
    cargo fmt --all -- --check
    cargo test --workspace
    git diff --check

> 在开发 Agent 会话里直接跑 `pnpm check` 时，`scripts/tests/secret-gate.test.mjs` 会因环境里存在
> `SOXU_AGENT_SESSION=1`（pre-commit 钩子按设计拒绝 Agent 直接提交）而失败。这是环境注入造成的
> 既有现象，与本次改动无关：清掉该变量后 58 个脚本用例全绿。
