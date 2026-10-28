# M0 退出证据与 M1 Windows 冒烟（Issue #41）

对应 Issue：[#41](https://github.com/TanCan1998/SOXU/issues/41)。
判定口径来自 PRD 的 M0 退出条件（依赖/版本审批完成，`agent:doctor` 和 CI 可实际运行）与 P-02（会话停止/恢复）。

> 本文件只写**实际执行过**的检查。凡未执行、缺凭据或只覆盖其中一层的，都写在
> [第 5 节「未验证与限制」](#5-未验证与限制不得读成通过)。完整三平台验收仍归
> [#6](https://github.com/TanCan1998/SOXU/issues/6)，本文件不代替它。

## 1. 取证环境

| 项 | 值 |
| --- | --- |
| 日期（UTC） | 2026-10-28 |
| 宿主 | Windows 11 x64（桌面构建与窗口启动在本机执行） |
| 分支 / 工作树 | `agent/github-issue-41-m0-issue-41-m1-windows` |
| 基线提交 | `d6cae06d1da2facebde50633faea1ae660694811`（即推送时的 `dev` 末次提交） |
| Node / pnpm | `v26.10.0` / `12.15.0` |
| Rust / Cargo | `1.99.1` / `1.99.1` |
| Pi | `1.4.0` |

本 Issue 的结论分两层：**M0 证据**绑在上表的基线提交上；**M1 冒烟**绑在本机工作树（其代码改动见第 6 节）。

## 2. M0：依赖与版本基线

### 2.1 已批准版本 vs 本机实测

基线来源：[approved-toolchain.md](approved-toolchain.md)。实测值来自 `pnpm agent:doctor`，不是文档抄写。

| 组件 | 批准基线 | 本机实测 | 结论 |
| --- | --- | --- | --- |
| Node.js | `>=24` | `26.10.0` | 符合 |
| pnpm | `12.15.0` | `12.15.0` | 符合 |
| Rust (rustc) | `1.99.1` | `1.99.1` | 符合 |
| Cargo | `1.99.1` | `1.99.1` | 符合 |
| Pi Agent | 无批准版本，仅要求可运行 | `1.4.0` | 可运行 |

### 2.2 锁文件

| 文件 | 大小 | SHA256 | 是否入库 |
| --- | --- | --- | --- |
| `pnpm-lock.yaml` | 64,826 字节 | `27577BA0F6533BD865ACBFFAC411AE987AA504D03C4552F06D68052467B4CCCF` | 是（`git ls-files` 可查） |
| `Cargo.lock` | 105,170 字节 | `0DFCE96EC9F5F21C2CA1FA1A6F2E174F6AA8B91C3C08B3B1A7A1A3117B5AD9CB` | 是 |

可复现性实测：

```text
pnpm install --frozen-lockfile
  -> Scope: all 5 workspace projects
  -> Lockfile is up to date, resolution step is skipped
  -> Done in 29ms using pnpm v12.15.0   退出码 0

cargo metadata --locked --offline --format-version 1 --no-deps
  -> 退出码 0，6 个 workspace crate 全部解析成功，未触网
```

哈希只对应本机这一份文件内容；换了锁文件就必须重新记录，不能沿用旧哈希。

### 2.3 `agent:doctor` 实际输出

实现：`scripts/agent-doctor.mjs`（CLI）+ `scripts/lib/agent-doctor.mjs`（纯逻辑），
离线单元测试 `scripts/tests/agent-doctor.test.mjs`。只读：不安装、不联网、不改版本、不调用模型。

```powershell
pnpm agent:doctor                  # 文本报告
pnpm agent:doctor --json           # 机器可读
node scripts/agent-doctor.mjs --json --out docs/development/evidence/agent-doctor-windows.json
```

本机原始输出（退出码 0）：

```text
SOXU agent:doctor · win32 · node v26.10.0
基线来源: docs/development/approved-toolchain.md
  [PASS] tool:node - Node.js 版本符合批准基线 >=24 :: 实际 26.10.0
  [PASS] tool:pnpm - pnpm 版本符合批准基线 12.15.0 :: 实际 12.15.0
  [PASS] tool:rustc - Rust (rustc) 版本符合批准基线 1.99.1 :: 实际 1.99.1
  [PASS] tool:cargo - Cargo 版本符合批准基线 1.99.1 :: 实际 1.99.1
  [PASS] tool:pi - Pi Agent 可执行 :: 实际 1.4.0
  [PASS] file:pnpm-lock.yaml - pnpm 锁文件 存在且非占位（≥ 1024 字节） :: 实际 64826 字节
  [PASS] file:Cargo.lock - Cargo 锁文件 存在且非占位（≥ 1024 字节） :: 实际 105170 字节
  [PASS] file:rust-toolchain.toml - rust-toolchain.toml 的 toolchain channel 符合批准基线 :: channel=1.99.1
结论: pass (8/8 通过, 0 失败)
```

完整 JSON 报告（含平台、Node 可执行路径、每条 check 的状态与明细）：
[`evidence/agent-doctor-windows.json`](evidence/agent-doctor-windows.json)。

行为边界：版本不符、命令缺失、锁文件缺失或小于 1 KiB、channel 不等于批准版本，
都会让对应项变 FAIL 且退出码为 1；doctor **不会**自动改版本或补锁文件。

### 2.4 指定 SHA 的 CI 检查

基线提交 `d6cae06` 的 CI 运行：[run 40715406266](https://github.com/TanCan1998/SOXU/actions/runs/40715406266)（push 事件，已完成）。

| 检查项 | 状态 | 开始（UTC） | 结束（UTC） |
| --- | --- | --- | --- |
| Detect affected areas | success | 2026-10-28T15:23:12Z | 2026-10-28T15:23:19Z |
| quality (24) | success | 2026-10-28T15:23:21Z | 2026-10-28T15:23:34Z |
| quality (26) | success | 2026-10-28T15:23:21Z | 2026-10-28T15:23:40Z |
| Rust / Tauri | success | 2026-10-28T15:23:21Z | 2026-10-28T15:26:17Z |
| Validate commit messages | success | 2026-10-28T15:23:12Z | 2026-10-28T15:23:19Z |
| SOXU CI Gate | success | 2026-10-28T15:26:20Z | 2026-10-28T15:26:24Z |

CI 配方本身（只读引用，未修改）：`pnpm install --frozen-lockfile`、`pnpm check`、
`cargo fmt --all -- --check`、`cargo test --workspace --locked`、Node 24/26 矩阵。

**重要限制：** 上述检查属于**基线提交**。本 Issue 新增的提交尚未推送（Developer 不 push），
因此**还没有**针对它们的 CI 运行；合并前必须由 Runner 推送后重新取证，不能把基线绿灯当成新提交的绿灯。

### 2.5 分支保护状态

只读查询（`gh api .../branches/<branch>/protection`），未做任何修改：

| 项 | `dev`（集成分支） | `main`（发布分支） |
| --- | --- | --- |
| 必需状态检查 | `SOXU CI Gate`、`Validate commit messages` | 同左 |
| strict（要求分支最新） | false | false |
| 管理员同样受限（enforce_admins） | **false** | true |
| 必需 PR 审查 | 未配置 | 未配置 |
| 禁止强推 / 禁止删除 | true / true | true / true |

结论口径：必需检查确实存在且本次运行的结论都是 success；但 `dev` 上管理员不受限、两条分支都不要求 PR 审查，
所以「分支保护」目前只覆盖**状态检查**这一层，不能宣称「合并需要人工审查」。

## 3. M1：Windows 启动

命令与结果（本机 release profile）：

```powershell
pnpm tauri:build            # 内含 pnpm icons:generate + 前端构建
#   -> Finished `release` profile [optimized] target(s) in 2m 13s
#   -> 产物 target/release/soxu-desktop.exe、MSI 3.69 MiB、NSIS setup 2.45 MiB，退出码 0

$p = Start-Process -FilePath target/release/soxu-desktop.exe -PassThru
Start-Sleep -Seconds 8
$p.Refresh()
$p.HasExited          # False
$p.Responding         # True
$p.MainWindowHandle   # 3344662（非 0）
$p.MainWindowTitle    # "SOXU · 索序"
Stop-Process -Id $p.Id
# 随后 Get-Process -Name soxu-desktop -> 0 个残留
```

子进程快照：启动 8 秒内只有 `msedgewebview2.exe`（WebView2 运行时），没有 SOXU 自行拉起的 Pi 进程
（此时尚未创建会话，符合预期）。

判定：**Windows 上应用能构建、能拉起主窗口并响应**。安装包安装/卸载未执行，见第 5 节。

## 4. M1：Pi RPC 最小冒烟与 P-02 演示

一键脚本（**真实调用模型，1~2 次提示，会产生费用**，因此不接入 `pnpm check`）：

```powershell
pnpm smoke:rpc            # 文本报告，退出码 0=全部通过
pnpm smoke:rpc --json     # 机器可读
node scripts/m1-pi-rpc-smoke.mjs --out docs/development/evidence/m1-pi-rpc-smoke-windows.json
```

本机原始输出（2026-10-28，退出码 0）：

```text
SOXU M1 Pi RPC 冒烟 · win32 · pi 1.4.0
模型: auto/deepseek-v4.1-flash
  [PASS] pi-version - pi 可执行文件可运行 :: 1.4.0
  [PASS] handshake - get_state 返回 sessionId 与 sessionFile
  [PASS] prompt-accepted - prompt 被 Pi 接收（success 与 disposition） :: {"success":true,"command":"prompt","error":null,"disposition":"started"}
  [PASS] settled - 整轮以 agent_settled 结束且期间有流式事件 :: message_update=11, agent_settled=1
  [PASS] assistant-reply - 助手回复含冒烟标记，且只出现一次 :: markerReplies=1
  [PASS] abort - 运行中 abort 成功并能回到非流式状态 :: {"prompt":{...},"response":{"success":true,"command":"abort","disposition":null},"isStreaming":false}
  [PASS] shutdown - 关闭 stdin 后进程自行退出（未强制结束） :: {"code":0,"forced":false}
  [PASS] resume-session - 重启后仍指向同一 sessionId :: faeaf7f2-2cac-4a7f-92e2-d23e1698801f
  [PASS] messages-persisted - 重启后历史消息不丢（含冒烟标记回复） :: before=5, after=5
  [PASS] no-duplicate-execution - 同一提示未被重复执行（消息数不变、无重复提示） :: before=5, after=5, duplicates=0
  [PASS] record-parse - 全部 stdout 记录均可解析（无失步）
结论: pass (11/11 通过, 2959ms)
```

完整报告：[`evidence/m1-pi-rpc-smoke-windows.json`](evidence/m1-pi-rpc-smoke-windows.json)。

### 4.1 这 11 项各自证明什么

| 检查 | 覆盖的协议事实 |
| --- | --- |
| `pi-version` | pi 可执行、版本可读（Windows 上经 `cmd.exe /d /s /c` 启动 npm 包装） |
| `handshake` | `get_state` 回执含 `sessionId` 与 `sessionFile`，且 sessionId 与启动时指定的一致 |
| `prompt-accepted` | `prompt` 回执 `success=true`、`disposition=started` |
| `settled` | 事件在**顶层**到达（`{"type":"agent_settled"}`），且期间有 `message_update` 流式事件 |
| `assistant-reply` | 助手回复含标记 `SOXU-SMOKE-OK` 且恰好一次 |
| `abort` | 运行中 `abort` 回执成功，`get_state.isStreaming=false`、`agent_settled.aborted=true` |
| `shutdown` | 关掉 stdin 后进程以 0 退出，`forced=false`（没有走 `taskkill /T /F` 兜底） |
| `resume-session` | 用同一 `sessionFile` 重启进程，`get_state.sessionId` 仍是原值 |
| `messages-persisted` | 重启后 `get_messages` 仍有历史（含唯一一次标记回复） |
| `no-duplicate-execution` | 重启后消息总数不变、没有重复的用户提示（P-02 的「不存在重复任务执行」） |
| `record-parse` | 两个进程的全部 stdout 行都能解析为 JSON，没有分帧失步 |

### 4.2 P-02 演示的边界

上面「abort → shutdown → 同 sessionFile 重启 → 历史不变 → 无重复执行」覆盖的是
**Pi 会话/RPC 层**，也就是 P-02 判据「持久化消息不丢；不存在重复任务执行」在协议层的证据。
它**不**覆盖：Tauri 窗口重启、前端 store 恢复、多标签切换后的状态一致性。
这些属于应用层，本 Issue 未验证，不能读成 P-02 整体通过。

### 4.3 一个需要如实记录的观测

冒烟进程以 `--thinking off` 启动，但 `get_state` 回报 `thinkingLevel=low`。
这只影响本次调用使用了多少思考预算，不影响上面任何判据；本 Issue 未追查原因，
在 [#6](https://github.com/TanCan1998/SOXU/issues/6) 做跨平台验收时应一并确认。

## 5. 未验证与限制（不得读成通过）

- **三平台**：本文件只有 Windows 实机证据。macOS / Linux 的启动与 RPC 冒烟**未执行**，
  归 [#6](https://github.com/TanCan1998/SOXU/issues/6)。
- **应用级恢复**：见 4.2，窗口重启与前端状态恢复未验证。
- **安装/卸载**：MSI/NSIS 安装会写注册表与系统目录，属破坏性操作，未执行，需所有者显式授权。
- **签名/公证**：未配置，产物未签名（与 [release-readiness.md](release-readiness.md) 一致）。
- **新提交的 CI**：第 2.4 节绑定基线 `d6cae06`；本 Issue 的改动尚未推送，**没有**对应的 CI 运行。
  合并前必须在推送后重新取证。
- **冒烟未接入 CI**：`pnpm smoke:rpc` 需要真实模型额度与凭据，无法在无人值守 CI 里默认跑；
  接入需要维护者批准改 `.github/workflows/`（受保护路径）。
- **doctor 的覆盖范围**：只核对版本号、锁文件存在性与 channel；不验证安装包、不验证运行时行为、
  不检查模型额度。
- **单次采样的局限**：冒烟结果是一次成功运行，不构成稳定性统计；失败时脚本不会自动重试，
  也不会把失败改成通过。

## 6. 本次改动与复现

| 文件 | 作用 |
| --- | --- |
| `scripts/agent-doctor.mjs` | `pnpm agent:doctor` CLI：探测版本、锁文件、工具链文件，只读 |
| `scripts/lib/agent-doctor.mjs` | 纯逻辑：版本解析/比较、基线匹配、报告与文本渲染 |
| `scripts/m1-pi-rpc-smoke.mjs` | `pnpm smoke:rpc`：RPC 冒烟 + P-02 协议层演示（真实模型） |
| `scripts/lib/pi-rpc-smoke.mjs` | NDJSON 分帧、消息分析、RpcSession（进程生命周期单一 owner） |
| `scripts/lib/command-plan.mjs` | Windows npm .cmd 包装统一走 `cmd.exe`，其它平台直连 |
| `scripts/lib/redact.mjs` | 写证据文件前把主目录前缀替换成 `~`，避免把本机目录结构入库 |
| `scripts/tests/agent-doctor.test.mjs` | doctor 纯逻辑与 CLI 参数容错测试（9 例） |
| `scripts/tests/pi-rpc-smoke.test.mjs` | 分帧/分析/等待/启动计划 + 假运行时生命周期测试（11 例） |
| `scripts/tests/redact.test.mjs` | 脱敏测试（2 例） |
| `scripts/tests/fixtures/fake-pi-rpc.mjs` | 测试用假 Pi RPC 运行时（不联网、不调模型） |
| `docs/development/evidence/*.json` | 本次两次实机运行的原始报告 |

复现顺序：

```powershell
pnpm agent:doctor                       # M0：版本与锁文件
pnpm test:scripts                       # 离线：doctor 与冒烟逻辑的单元测试
pnpm tauri:build                        # M1：构建（含图标生成）
# 启动 target/release/soxu-desktop.exe 并检查 MainWindowTitle
pnpm smoke:rpc --out docs/development/evidence/m1-pi-rpc-smoke-windows.json
```

冒烟会真实产生 1~2 次模型调用；失败时脚本只报告失败，不自动重试，避免重复计费。
