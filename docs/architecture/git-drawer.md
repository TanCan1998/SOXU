# Git 抽屉：更改列表与 diff 预览（TASK-029 · Issue #121）

本文件记录 Git 抽屉的**已实现行为**：Git 事实层（crates/git-worktree 的
changes/log/stage/remote 模块）、桌面适配层（apps/desktop/src-tauri/src/git.rs）、
命令层（apps/desktop/src-tauri/src/commands/git.rs）与面板
（apps/desktop/src/workspace/gitWorkspace.ts + components/GitDrawer.vue +
components/GitDiffPanel.vue）。
未验证的部分单列在「验证状态」，不写成已完成。

对应任务：[TASK-029](../../tasks/backlog/TASK-029.md)。工作树能力见
[Git 工作树服务](worktree-service.md)，会话身份见[会话目录契约](session-catalog.md)。

## 1. 范围与非目标

范围内：

- 更改列表：M/A/D/U 徽章、增删行数、暂存/未暂存/未跟踪/冲突标记。
- 单文件 diff：原样透传 git 补丁，界面按 hunk 头对齐旧/新行号并复用 S1 的 shiki 管线着色。
- 树形/平铺切换、全部折叠、刷新、全部暂存、提交、推送、拉取。
- 推送/拉取按钮显示领先/落后提交数；失败时展示 git 的原始错误行。

非目标：

- 不执行 `--force`、`reset`、`clean`、`rebase`、`commit --amend`。
- 不做分支切换、合并、cherry-pick、stash、冲突解决编辑器。
- 不缓存长期 Git 状态：每次打开/刷新都现查。
- 不在本任务内实现「按文件暂存/取消暂存」的细粒度操作（当前是全部暂存）。

## 2. 命令契约

全部命令只做参数映射；身份来自会话目录，前端不能传路径。

| 命令 | 参数 | 返回 | 读写 |
| --- | --- | --- | --- |
| `git_status` | projectId, worktreeId? | `GitStatusView` | 只读 |
| `git_diff` | projectId, worktreeId?, path, staged | `GitFileDiffView` | 只读 |
| `git_log` | projectId, worktreeId?, limit? | `GitLogView` | 只读 |
| `git_branches` | projectId, worktreeId? | `GitBranchesView` | 只读 |
| `git_stage` | projectId, worktreeId?, paths[] | `GitStatusView`（刷新后） | 写索引 |
| `git_commit` | projectId, worktreeId?, message | `GitCommitView`（含新状态） | 写对象库/引用 |
| `git_push` | projectId, worktreeId? | `GitRemoteView`（含新状态） | 网络 |
| `git_pull` | projectId, worktreeId? | `GitRemoteView`（含新状态） | 网络 |

`worktreeId` 省略表示项目主工作树（项目根目录）；给出时必须已在会话目录登记。
命令登记在 `lib.rs` 的「git」占位块内，块内按字母序排列
（`scripts/check-command-blocks.mjs` 校验）。

## 3. 所有权与并发

| 资源 | 唯一 owner | 说明 |
| --- | --- | --- |
| Git 子进程 | `GitRunner`（每次调用一个进程） | 调用返回即回收；超时先 kill 再 wait |
| Git 事实 | `soxu-git-worktree` | 不缓存；徽章与计数共用一份 porcelain 解析 |
| 写操作串行闸门 | `AppState::git_guard` | 暂存/提交/推送/拉取不并发，避免抢 index.lock |
| 面板状态 | `GitWorkspace`（Vue 侧） | `dispose()` 后不再写状态 |
| diff 高亮 | `GitDiffPanel.vue` + `components/gitDiff.ts` | 一次只挂一个面板；递增令牌丢弃迟到结果，卸载时作废 |

关键不变式：

1. 只观察，不改写会话：Git 面板不触碰 Tab、消息或 `activeSessionId`。
2. 迟到响应丢弃：status 与 diff 各有一个递增序号；切换项目/文件后旧结果不写状态。
3. 一次只展开一个文件 diff：抽屉宽 320px，多份补丁同时展开既读不清也占内存。
4. 跨层信息只能收紧权限：路径校验、错误码与「不做强制覆盖」都在 Git 事实层实现。

## 4. 更改列表

`git status --porcelain=v1 -z --branch --no-renames` 解析一次
（`soxu-git-worktree::parse_porcelain`），工作树汇总与抽屉共用同一份记录。

徽章规则（`StatusEntry::badge`）：

| porcelain | 徽章 | 说明 |
| --- | --- | --- |
| `A ` / `??` | A | 新增；未跟踪文件同样按新增展示 |
| `M ` / ` M` / `MM` | M | 修改；同一文件既暂存又未暂存时以索引区字母为准 |
| `D ` / ` D` | D | 删除 |
| `UU` / `AA` / `DU` 等 | U | 冲突 |
| `R` / `T` / `C` | M | 重命名/类型变化/复制按修改处理 |

增删行数来自 `git diff --numstat`：未暂存优先、其次已暂存（`--cached`）。
同一文件两处都有改动时展示未暂存那一份，因为那正是下一次 `git add` 的内容。
未跟踪文件与二进制文件没有行数（前端显示「未跟踪」/「二进制」）。

清单有界：`MAX_LISTED_CHANGES`（200）条，计数不受上限影响；超出时
`truncated=true`，界面明确提示而不是静默裁剪。

## 5. diff 渲染

- 后端只做一件事：把 `git diff --no-color --no-ext-diff --no-renames --unified=3` 的
  原始输出按 512 KiB 预算透传（`MAX_FILE_DIFF_BYTES`），超限标记 `truncated`。
- 行号来自补丁自身：`components/gitDiff.ts` 解析 `@@ -a,b +c,d @@`，为每行算出
  旧/新行号；新增行只有新行号，删除行只有旧行号，`\\ No newline at end of file`
  不推进行号。多个 hunk 各自重置。
- 着色复用 S1 的 shiki 管线：`highlightToHtml(patch, "diff")`。`diff` 已在语言
  白名单内，不需要新增依赖；高亮失败退回纯文本，行号与内容仍然完整。
- 一次渲染上限 `MAX_RENDERED_DIFF_ROWS`（1200）行，超出时提示「还有 N 行未渲染」。
  这是显示上限，不影响后端返回的补丁与 `truncated` 标记。
- 只暂存、没有未暂存改动的文件读取 `--cached` 的 diff，否则会是空白。

## 6. 推送与拉取

| 规则 | 实现 |
| --- | --- |
| 不做强制覆盖 | 只执行 `git push` / `git pull --ff-only`，没有 `--force`、没有隐式合并 |
| 非交互 | `GIT_TERMINAL_PROMPT=0`、stdin=null；缺凭据立刻失败而不是挂在终端 |
| 超时 | 网络操作 120s（`NETWORK_TIMEOUT`），超时 kill 并返回 `E_GIT_COMMAND_TIMEOUT` |
| 前置检查 | detached HEAD 与进行中的 merge/rebase 直接拒绝（`E_GIT_BRANCH_INVALID` / `E_GIT_OPERATION_IN_PROGRESS`） |
| 失败提示 | 稳定错误码 + git 的第一行 stderr；界面原样展示，磁盘与远端都不变 |
| 领先/落后 | 来自本地记录的远端跟踪分支，**不会**为刷新计数而自动联网；拉取后重新读取 |

## 7. 路径守卫

前端传来的 `path` 仍是不可信输入。`validate_relative_path`（crate::path）：

- 只接受相对路径，反斜杠统一成正斜杠（git 在 Windows 上也接受正斜杠）；
- 拒绝绝对路径、盘符路径（`C:`、`C:/`）与 UNC 前缀（`E_GIT_PATH_NOT_ABSOLUTE`）；
- 拒绝任何 `..` 段（`E_GIT_PATH_OUTSIDE_ROOT`）；
- 拒绝空路径、空字符与超过 4096 字符的路径（`E_GIT_PATH_INVALID`）。

暂存是「先全部校验、再执行」：任何一个路径被拒绝都不会出现「一半暂存、一半失败」。

## 8. 验证状态

已在本机（Windows 11 + git 2.x）执行：

- `cargo test -p soxu-git-worktree` → 26 单元 + 10 个 `tests/git_drawer.rs` 集成用例通过
  （真实临时仓库：徽章/行数、补丁与 CLI 一致、暂存/提交、日志/分支、本地裸仓库推送拉取、
  路径穿越拒绝、detached HEAD 拒绝）。
- `cargo test -p soxu-desktop --test git_bridge` → 3 个适配层用例通过
  （身份解析、暂存/提交/日志/分支、推送失败提示）。
- `pnpm --filter @soxu/desktop test` → 含 20 个 Git 抽屉用例（含 diff 行号对齐与
  shiki 高亮行数一致）。
- `cargo clippy -p soxu-git-worktree --all-targets` 与 `-p soxu-desktop --all-targets` 无新增 warning。

未验证：

- 真实桌面窗口内的视觉结果（截图）与 macOS/Linux 实机行为；界面改动需要人工截图佐证。
- 真实远端（GitHub/AtomGit）的推送与凭据失败路径：本任务只用本地裸仓库验证协议与错误提示。
- 超大仓库（万级改动）下的抽屉滚动性能。

## 9. 相关测试

```bash
cargo test -p soxu-git-worktree
cargo test -p soxu-desktop --test git_bridge
pnpm --filter @soxu/desktop test
node scripts/check-command-blocks.mjs
```
