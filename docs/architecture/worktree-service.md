# Git 工作树服务与桌面集成（TASK-005）

本文件记录 SOXU 工作树能力的**已实现行为**：Git 事实层（`crates/git-worktree`）、
桌面适配层（`apps/desktop/src-tauri/src/worktree.rs`）与工作树面板
（`apps/desktop/src/workspace/worktreeWorkspace.ts` + `WorktreeDialog.vue`）。
未验证的部分单列在「验证状态」，不写成已完成。

对应任务：[TASK-005](../../tasks/backlog/TASK-005.md)。身份模型见
[会话目录契约](session-catalog.md)，运行时与会话见
[多会话工作区](../development/multi-session-workspace.md)。

## 1. 范围与非目标

范围内：

- 枚举项目下全部 Git 工作树（主/附加、分支、HEAD、locked、prunable）。
- 创建附加工作树（新建分支或检出既有分支），与 `SessionId` 的关联展示。
- 冲突、未提交改动、未跟踪文件、`index.lock`、进行中的 Git 操作检测。
- 有界 Diff 预览（文件统计 + 补丁文本上限）。
- **受确认约束**的删除与失效记录清理（prune），失败可安全恢复。

非目标：

- 不自动清理、不 `reset`、不 `checkout -f`、不 `clean`、不加 `--force`。
- 不合并、推送、打标签或改写历史；这些属于 Runner/人工流程。
- 不修改 Pi 会话文件；会话目录只增加/更新**引用**。
- 不在本任务内实现跨仓库的操作编排或多项目工作树全局视图。

## 2. 身份与所有权

| 身份 | 来源 | 生命周期 |
| --- | --- | --- |
| `ProjectId` | 登记的仓库目录 | 稳定；不随分支变化 |
| `WorktreeId` | `projectId` + 规范化工作树路径 | 稳定；**切换分支不改变** |
| `SessionId` | Pi 会话文件（JSONL） | 稳定；由 Pi 拥有 |
| `runtimeId + generation` | 一次执行 | 临时；迟到事件被丢弃 |

所有权边界：

| 资源 | 唯一 owner | 说明 |
| --- | --- | --- |
| Git 子进程 | `GitRunner`（每次调用一个进程） | 调用返回即回收；超时先 kill 再 wait |
| Git 事实（分支/脏/锁/diff） | `soxu-git-worktree` | 不缓存长期状态，每次现查 |
| 会话目录引用（WorktreeRecord） | `soxu-session-index` | 只增引用；失效只标 `missing`，不删记录 |
| 写操作串行闸门 | `AppState::worktree_guard` | 创建/删除/prune 不并发 |
| 会话目录锁 | `AppState::catalog` | 删除期间持锁，与 `claim_writable` 互斥 |
| 面板状态 | `WorktreeCatalog`（Vue 侧） | `dispose()` 后不再写状态 |

关键不变式：

1. 枚举只读：发现新工作树就登记，目录消失只把 `WorktreeRecord.missing` 置真。
2. 删除必须是「只读计划 → 令牌确认 → 执行」三步；没有令牌一律拒绝。
3. 跨层信息只能**收紧**权限：会话层发现活跃运行时会追加 `active_runtime` blocker，
   但令牌始终由 Git 状态计算。

## 3. 命令执行策略

| 规则 | 实现 |
| --- | --- |
| 结构化 argv | 只用 `Command` + 参数数组，不拼接 shell 文本 |
| 环境隔离 | 移除 `GIT_DIR`、`GIT_WORK_TREE`、`GIT_INDEX_FILE`、`GIT_COMMON_DIR` 等继承变量 |
| 非交互 | `GIT_TERMINAL_PROMPT=0`、`GIT_PAGER=cat`、`PAGER=cat`、stdin=nil |
| 不抢锁 | 只读命令带 `GIT_OPTIONAL_LOCKS=0`；写命令才允许索引刷新 |
| 输出上限 | 默认 4 MiB；超限继续排空管道但丢弃，并标记 `truncated` |
| 超时 | 只读 20s，写操作 180s；超时 kill 并返回 `E_GIT_COMMAND_TIMEOUT` |
| 残缺清单 | `git worktree list` 输出超限时直接报错，不返回不完整列表 |

## 4. 只读事实

- `worktrees()`：`git worktree list --porcelain`，解析主/附加、detached HEAD、
  locked（含原因）、prunable（含原因），并反转义 Git 的引号路径。
- `inspect_status(path)`：`git status --porcelain=v1 -z --branch --no-renames`，得到分支跟踪、
  已暂存/未暂存/未跟踪计数、冲突条目、`index.lock`、进行中的操作。
  文件清单上限 200 条（`MAX_LISTED_CHANGES`），**计数不受裁剪影响**。
- `preview_diff(path, options)`：`--name-status -z` + `--numstat -z` + 有界补丁；最多 200 个文件、
  补丁 256 KiB（`DEFAULT_MAX_FILES` / `DEFAULT_MAX_BYTES`）。超限标记 `truncated`，
  不改写磁盘、不写索引。
- 未跟踪文件不在补丁里，由 `inspect_status` 的 `untracked_count` 提示。

## 5. 创建工作树

`create_worktree` 在调用 `git worktree add` 前完成全部检查：

1. **路径边界**：绝对路径、父目录存在、目标当前不存在、不在仓库目录内部、
   位于 `allowed_root` 之内（桌面层传项目根目录的父目录）。
2. **分支校验**：分支名非空且合法；`existing` 必须已存在，`new_branch` 不得已存在；
   同一分支不能被其他工作树检出（`E_GIT_BRANCH_IN_USE`）。
3. **索引锁**：仓库 `index.lock` 存在时拒绝创建，避免与 Agent 抢锁留下半成品。
4. 执行 `git worktree add --no-track -- <path> <branch|base>`；
   `-b` 仅用于新建分支，起点默认 `HEAD`。
5. 创建后重新枚举确认可用；不可用即报错（不使用强制删除掩盖失败）。

桌面层默认目标：`<项目父目录>/<项目名>-worktrees/<分支 slug>`，slug 只保留
ASCII 字母数字与 `-_.`，其余替换为 `-`，保证各平台路径合法。

## 6. 危险操作与确认

### 6.1 删除附加工作树

- `plan_remove` **只读**：返回 `RemovePlan`（blockers + token），不触碰磁盘。
- 令牌 = 路径、HEAD、分支、脏/冲突/索引锁/操作中、git lock 原因的哈希
  （FNV-1a 64，16 位十六进制）。任一要素变化令牌即失效。
- `remove_worktree(plan, token)` 依次校验：令牌非空 → 与计划一致 →
  重新规划后仍一致 → 计划与当前状态均无 blocker，然后才执行
  `git worktree remove -- <path>`（**无 `--force`**）。删除后重新枚举确认已消失。
- 状态在确认之后变化（例如 Agent 刚写入文件）返回 `E_GIT_CONFIRMATION_STALE`，
  磁盘不变，重新计划即可恢复。

阻止删除的原因（`RemovalBlocker`，稳定标识）：

| 标识 | 含义 | 错误码 | 可恢复 |
| --- | --- | --- | --- |
| `primary` | 项目主工作树 | `E_GIT_WORKTREE_PRIMARY` | 否 |
| `path_missing` | 目录已不存在 | `E_GIT_WORKTREE_PATH_MISSING` | 否（改用 prune） |
| `dirty` | 有未提交改动 | `E_GIT_WORKTREE_DIRTY` | 否（先由用户处理） |
| `conflicted` | 有未解决冲突 | `E_GIT_WORKTREE_CONFLICTED` | 否 |
| `index_locked` | `index.lock` 存在 | `E_GIT_INDEX_LOCKED` | 是 |
| `operation_in_progress` | merge/rebase 等进行中 | `E_GIT_OPERATION_IN_PROGRESS` | 是 |
| `git_locked` | `git worktree lock` | `E_GIT_WORKTREE_LOCKED` | 否 |
| `prunable` | Git 已标记失效 | `E_GIT_WORKTREE_PATH_MISSING` | 否（改用 prune） |
| `active_runtime` | 该工作树仍有运行中的会话 | `E_GIT_WORKTREE_BUSY` | 是 |
| `unmanaged` | 不在本仓库工作树清单 | `E_GIT_WORKTREE_UNKNOWN` | 是 |

### 6.2 清理失效记录（prune）

- `plan_prune` 只列出 Git 已标记 `prunable` 的条目，令牌是清单哈希。
- `prune(plan, token)` 校验令牌与最新清单一致后才执行 `git worktree prune`；
  只清理管理记录，不删除任何真实目录。
- 这是「异常退出 / 手工删掉目录」后的恢复路径：会话记录与会话文件不受影响。

## 7. 桌面 IPC 与 UI

命令名与 `workspace/bridge.ts` 一一对应，字段为 camelCase。

| 命令 | 参数 | 返回 | 只读 |
| --- | --- | --- | --- |
| `list_worktrees` | `projectId` | `WorktreeWorkspace` | 是（仅登记引用） |
| `create_worktree` | `projectId, input` | `WorktreeSummary` | 否 |
| `plan_worktree_removal` | `projectId, worktreeId` | `WorktreeSummary`（含 token/blockers） | 是 |
| `worktree_diff` | `projectId, worktreeId, staged` | `WorktreeDiffView` | 是 |
| `remove_worktree` | `projectId, worktreeId, token` | `WorktreeRemovalView` | 否（危险） |
| `prune_worktrees` | `projectId, token` | `number` | 否（危险） |

`WorktreeWorkspace` 返回 `worktrees`、`stale`（prunable 路径）与 `pruneToken`；
`WorktreeSummary` 叠加 Git 事实、会话关联（`sessionIds`）、活跃会话
（`activeSessionIds`）、blockers、`removable` 与 `token`。
`ProjectSummary.sessions[]` 增加 `worktreeId`，会话与工作树的归属来自会话目录。

UI 行为：

- 项目侧栏的「分支」按钮打开工作树面板；面板一次只观察一个项目。
- 左列列出工作树与徽标（冲突 > 索引锁 > 进行中 > Git 锁 > 脏改动 > 目录缺失 > 主工作树）。
- 右列展示路径、HEAD、会话数、活跃会话数、该工作树下的会话清单（可点击打开，
  运行中会话带标记），以及「工作区改动 / 已暂存」只读 Diff。
- **选择工作树只影响面板**：Tab 的 `worktreeId`、消息、状态与 `activeSessionId`
  都不改变，因此多 Agent 在不同工作树间切换不会串会话。
- 删除为两段式：先「准备删除…」获取只读计划与令牌；计划不可删时按钮禁用并列出原因；
  点「确认删除」才调用后端。失败保留计划与错误文本，可重新计划恢复。
- `stale` 非空时提供「清理失效记录」按钮；没有令牌或没有失效记录时不发请求。
- 面板卸载（`WorktreeCatalog.dispose()`）后，在途枚举/预览的响应不再写状态。

## 8. 错误码契约

错误码是稳定字符串（`GitErrorCode::as_str`），只追加不修改。通用：

| 错误码 | 含义 |
| --- | --- |
| `E_GIT_REPO_MISSING` | 目录不存在或不是仓库 |
| `E_GIT_NOT_WORKTREE` | 不是 Git 工作树 |
| `E_GIT_UNAVAILABLE` | 找不到 git 可执行文件 |
| `E_GIT_COMMAND_FAILED` | git 命令非零退出（附首行 stderr） |
| `E_GIT_COMMAND_TIMEOUT` | 命令超时，已终止 |
| `E_GIT_CONFIRMATION_REQUIRED` | 未提供确认令牌 |
| `E_GIT_CONFIRMATION_STALE` | 令牌与当前状态不一致 |
| `E_GIT_IO_FAILURE` | 本地 IO 失败 |

业务码见 6.1 与 `crates/git-worktree/src/error.rs`；创建类还包括
`E_GIT_BRANCH_INVALID`、`E_GIT_BRANCH_EXISTS`、`E_GIT_BRANCH_IN_USE`、
`E_GIT_PATH_NOT_ABSOLUTE`、`E_GIT_PATH_INSIDE_REPO`、`E_GIT_PATH_OUTSIDE_ROOT`、
`E_GIT_PATH_EXISTS`。

## 9. 测试与复现命令

```powershell
# 工作树服务：单元 + 真实 git 仓库集成
cargo test -p soxu-git-worktree

# 会话目录的工作树引用
cargo test -p soxu-session-index --test worktree_records

# 桌面适配与 IPC（含真实 JSONL 目录）
cargo test -p soxu-desktop

# 前端工作树面板逻辑（node:test，无需浏览器）
pnpm --filter @soxu/desktop test

# 类型检查与生产构建
pnpm --filter @soxu/desktop check
pnpm --filter @soxu/desktop build

# 仓库门禁
pnpm check
cargo fmt --all -- --check
cargo test --workspace
git diff --check
```

| 验收点 | 证据 |
| --- | --- |
| 多 Agent 使用不同工作树时隔离正确，切换工作树不串会话 | `crates/git-worktree/tests/isolation.rs`（一个工作树的改动不出现在另一个）；`apps/desktop/tests/worktreeIsolation.test.ts`（选择/刷新/工作树消失都不改写 Tab 与 active 会话）；`crates/session-index/tests/worktree_records.rs`（同一项目下会话归属互不串）；`apps/desktop/src-tauri/tests/worktree_bridge.rs`（会话 JSONL 的 cwd 决定归属，工作树删除后会话记录保留） |
| 脏工作树、Git 锁冲突、删除与异常退出 | `tests/worktree_lifecycle.rs`：`dirty_or_conflicted_worktree_is_never_removed`、`index_lock_is_detected_and_blocks_mutations`、`merge_conflict_is_reported_and_blocks_removal`、`removes_clean_worktree_only_after_matching_confirmation`、`deleted_worktree_is_pruned_only_with_confirmation`、`diff_preview_is_bounded_and_reports_truncation`、`create_refuses_unusable_destinations_and_branches` |
| 危险操作受确认/权限约束，失败后可安全恢复 | `safety.rs` 单测（令牌随状态变化、blocker 稳定码）；`worktreeIsolation.test.ts`（无计划不调用后端、脏/锁拒绝、`E_GIT_CONFIRMATION_STALE` 后重新计划成功、prune 需令牌）；`worktree_bridge.rs`（活跃运行时返回 `E_GIT_WORKTREE_BUSY`、脏工作树返回 `E_GIT_WORKTREE_DIRTY`，目录保持不变；空令牌 prune 被拒绝） |
| 功能与恢复路径可复现 | 上述命令均为本机实测，详见第 10 节 |

## 10. 验证状态

本机实测通过（2026-10-27，Windows 11 / Rust 1.99.1 / Node 26 / pnpm 12.15.0）：

- `cargo test -p soxu-git-worktree` → 16 单元 + 1 隔离 + 8 生命周期用例通过。
- `cargo test -p soxu-session-index --test worktree_records` → 1 passed。
- `cargo test -p soxu-desktop --test worktree_bridge` → 2 个真实 git 仓库集成用例通过。
- `cargo test --workspace` 全绿（含 `soxu-desktop` 既有单测与集成用例）。
- `pnpm --filter @soxu/desktop test` → 28 passed（其中工作树用例 12 个）。
- `pnpm --filter @soxu/desktop check`（vue-tsc）与 `build`（vite）通过。

**未验证**：

- Tauri/WebView 实机渲染工作树面板（本机未启动 GUI），面板交互仅经 node:test 与
  Vue 类型检查验证。
- macOS / Linux 下的 `git worktree` 行为与路径大小写差异。
- 超大型仓库（>200 改动文件、>256 KiB 补丁）在真实 UI 中的滚动体验。
- 与 Pi Agent 进程同时写同一工作树的压力场景（当前以 `GIT_OPTIONAL_LOCKS=0`
  与 `index.lock` 检测规避，未做长时压测）。

## 11. 已知限制

1. 枚举是显式刷新（打开面板、手动刷新、创建/删除后），不监听文件系统事件。
2. Diff 预览只显示已跟踪文件的改动；未跟踪文件由计数提示，不内联展示内容。
3. 删除只支持附加工作树；主工作树永远不可删除（`primary` blocker）。
4. 清理失效记录只作用于 Git 已标记 `prunable` 的管理记录，不推断其他残留目录。
5. 面板一次观察一个项目，没有跨项目聚合视图。
6. 令牌是 16 位十六进制哈希：用于**状态一致性**确认，不是密码学授权凭据；
   真正的权限边界是本地桌面进程与用户操作。

## 相关文档

- [多会话工作区](../development/multi-session-workspace.md)
- [会话目录与 JSONL 索引契约](session-catalog.md)
- [架构总览](overview.md)
- [TASK-005](../../tasks/backlog/TASK-005.md)
