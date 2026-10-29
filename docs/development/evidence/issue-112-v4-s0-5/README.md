# Issue #112 · V4-S0.5 命令层拆分验证记录

本目录记录 **V4-S0.5 后端命令层拆分**的可复现验证：命令、环境与原始输出。
每条证据都能对回 Issue #112 的 acceptance criteria；未验证的部分在文末「已知限制」里单列，不写成已完成。

- 验证时间：2026-10-30
- 环境：Windows（本机）· Node v26.10.0 · pnpm 12.15.0 · rustc 1.99.1 · cargo 1.99.1 · 基线提交 `98cdef7`
- 分支：`agent/github-issue-112-v4-s0-5-commands-dto-lib-rs`
- 规则文档：`docs/development/command-blocks.md`

---

## 1. 验收对照

| Acceptance criterion | 证据 |
|---|---|
| `cargo check` / `cargo clippy` 通过，无新增 warning | §2.1（`cargo check --all-targets`、`cargo clippy -p soxu-desktop -D warnings` 全清；workspace clippy 仅剩 1 条**既有**告警，见 §4） |
| 桌面端现有测试全绿（134+ 用例） | §2.2：202 个用例全绿（本切片未改 UI 逻辑，只改了一处源码扫描路径与一处注释） |
| `git diff` 中 command 函数体逐字节相同（只搬位置） | §2.3：24 个 command、21 个 DTO 条目逐条比对，0 处差异 |
| `lib.rs` 含 9 个 V4 领域占位注释块 | §2.4：13 个领域块 = 4 个既有 + 9 个 V4 占位 |
| 实际验证：start_session / list_worktrees / open_session_history 跑通 | §2.5：编译期路径回归 + §4 说明真实 IPC 冒烟的限制 |
| 提交规范：`<gitmoji> type(scope): 描述`，目标分支 dev | 由 Runner 统一提交（Developer 不执行 `git commit`） |

## 2. 命令与原始结果

### 2.1 Rust 门禁

```
$ cargo check --all-targets
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 21.13s

$ cargo fmt --all -- --check
fmt_exit=0

$ cargo clippy -p soxu-desktop --all-targets -- -D warnings
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 4.22s
```

`-D warnings` 下 `soxu-desktop`（本切片改动的 crate）零告警。

### 2.2 测试

```
$ cargo test --workspace
total_passed=301
failed_markers=0

$ pnpm check
✅ 领域块检查通过：13 个领域块、24 个 command，落位与顺序正确
ℹ tests 202     # apps/desktop（vue-tsc + node --test）
ℹ pass 202
ℹ fail 0
ℹ tests 58      # scripts
ℹ pass 58
ℹ fail 0
```

> 注意：若在**开发 Agent 会话**里直接跑 `pnpm check`，`scripts/tests/secret-gate.test.mjs` 的 5 个用例会因为
> 环境里存在 `SOXU_AGENT_SESSION=1`（pre-commit 钩子按设计拒绝 Agent 直接提交）而失败。
> 这是既有环境注入现象，与本切片无关：清掉该变量后 58 个脚本用例全绿（上面的结果即如此）。

```
$ node --test scripts/tests/command-blocks.test.mjs
ℹ tests 11
ℹ pass 11
ℹ fail 0
```

### 2.3 「只搬位置」的逐条比对

用 `git show HEAD:...` 取拆分前的 `commands.rs` / `dto.rs`，按 `#[tauri::command]` 与
`pub struct|pub enum` 切分条目，逐条比对签名与函数体（忽略注释与空行）：

```
old commands: 24 new commands: 24
command body diffs: none
old dto items: 21 new dto items: 21
dto diffs: none
```

再对两个文件做「有效行」多重集比对（去注释、去 `use`、排序后比较计数），
唯一差异是 `use crate::dto::{...}` 的换行分组不同，代码行零增删。

### 2.4 领域块结构

```
$ node scripts/check-command-blocks.mjs
✅ 领域块检查通过：13 个领域块、24 个 command，落位与顺序正确
```

`lib.rs` 的 `generate_handler![` 内块顺序：

```
session → workspace → worktree → history
        → files → git → pty → model → stats → outline → extension → notify → search
```

前 4 块承接拆分前的 24 个 command，后 9 块是 V4 预置的空占位块（`files` 7 / `git` 8 / `pty` 4 /
`model` 3 / `stats` 1 / `outline` 1 / `extension` 2 / `notify` 1 将分别落在对应块内）。

### 2.5 三个代表命令的路径回归

`apps/desktop/src-tauri/src/lib.rs` 的 `command_reexports_keep_their_paths` 用例直接取用
`commands::start_session` / `commands::list_worktrees` / `commands::open_session_history`
（外加 `runtime_info` / `search_session`）。任一领域的再导出缺失都会让该用例编译失败，
因此在 `cargo test --workspace` 全绿的同时，这三条 `commands::<name>` 路径已被证明可用。

前端 invoke 名称未改：`apps/desktop/src/workspace/bridge.ts` 与本切片无关，
`apps/desktop/tests/sendModes.test.ts` 只在读取源码时把路径从 `src/commands.rs` / `src/dto.rs`
改到 `src/commands/session.rs` / `src/dto/session.rs`，断言内容不变。

### 2.6 空白与冲突标记

```
$ git diff --check
（无输出，退出码 0）
```

## 3. 改动清单

| 文件 | 说明 |
|---|---|
| `src-tauri/src/commands/{mod,session,workspace,worktree,history}.rs` | 新增；`mod.rs` 只做 `pub use` 再导出 |
| `src-tauri/src/commands.rs` | 删除（内容搬进 `commands/`） |
| `src-tauri/src/dto/{mod,session,workspace,worktree}.rs` | 新增；`mod.rs` 只做 `pub use` 再导出 |
| `src-tauri/src/dto.rs` | 删除（内容搬进 `dto/`） |
| `src-tauri/src/lib.rs` | 领域注释块 + 路径回归用例 |
| `scripts/check-command-blocks.mjs` | 新增门禁脚本（5 类断言） |
| `scripts/tests/command-blocks.test.mjs` | 新增 11 个离线回归用例（含临时目录 CLI 夹具） |
| `docs/development/command-blocks.md` | 新增规则文档（含扩块规则表） |
| `package.json` | `check` 串联领域块校验，新增 `check:commands` |
| `apps/desktop/tests/sendModes.test.ts` | 源码扫描路径跟随拆分 |
| `apps/desktop/src/workspace/types.ts` | 注释里的 DTO 路径跟随拆分 |
| `docs/development/multi-session-workspace.md` | 分层图与规则交叉引用 |

## 4. 已知限制

1. **真实 IPC 冒烟未执行**：`start_session` / `list_worktrees` / `open_session_history` 的
   `invoke` 端到端调用需要桌面窗口与真实 Pi 运行时，属实机验收；本切片只提供
   §2.5 的编译期路径回归。命令体逐字节未变（§2.3），行为风险仅限于模块可见性。
2. **未修改 `.github/workflows/`**：该路径属受保护路径。校验已串进 `pnpm check`，
   而 `.github/workflows/ci.yml:89` 与 `release.yml:64` 都执行 `pnpm check`，
   因此 PR 上仍会被拦下；新增独立 workflow 步骤需要维护者授权。
3. **workspace clippy 仍有 1 条既有告警**：`crates/agent-runtime/tests/process_tree.rs:209`
   的 `collapsible_if`（`cargo clippy --workspace --all-targets -- -D warnings` 因此失败）。
   该文件在本切片中未被修改（`git status -- crates/` 为空），属既有问题，需另开任务修复。
