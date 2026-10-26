# 开发任务（v1.5.1 依赖门禁）

`tasks/backlog/TASK-*.md` 保存可审计的任务定义，`tasks/done/` 可存放归档定义，均不代替 GitHub 的状态。Frontmatter 严格使用 `id: TASK-001`、`priority: P0|P1|P2`、`dependencies: [TASK-001, TASK-002]`；依赖写 **TASK ID，不是 GitHub Issue 编号**。必须无环、无未知 ID。

- `pnpm agent:once -- --dry-run`：预览当前可执行的远端 Issue（不修改标签、不调用模型）。
- `pnpm agent:once -- --local --dry-run`：离线任务预览，无 GitHub 或模型调用。
- `pnpm agent:seed`：仅对不存在的 TASK 创建 Issue，根任务加 `agent:ready`，有依赖的任务加 `agent:waiting`，不覆盖已存在的 Issue 正文。
- 真实远端调度：前置 Issue 必须 **CLOSED** 且存在以 `Closes #issue号` 引用它的、已合并到 `main` 的 PR，才可从 `agent:waiting` 提升为 `agent:ready`。只是创建 PR、手动关闭 Issue 都不算完成。升级旧版时，错误的 `agent:ready` 会自动降为 `agent:waiting`。
- `agent:blocked`、`agent:paused`、`agent:in-progress`、`agent:pr` 都不会被自动启动。人工创建的无 TASK 前缀任务仍须明确 `agent:ready` 才可执行。
- 本地模式：任务 checkpoint 为 `done` **且对应提交已经进入本地 main** 才解除其后继依赖。本地 `done` 只表示 Worktree 中完成，Runner 不会替用户把工作树自动合并到 main。

如果曾用 v1.5 `agent:seed` 创建 TASK-006，它可能带有旧版初始化的 `agent:blocked` 标签；系统为尊重人工封锁**不会自动去掉该标签**。核对确认它只是旧版默认标签、而非真实故障后，可以把它手动改为 `agent:waiting`，等待全部依赖合并。

**前置准备**：工程包没有 `pnpm-lock.yaml` 和 `Cargo.lock`。实际付费 Agent 调度会提前检查两份文件，缺失时直接停止，避免浪费额度。先运行 `pnpm install --lockfile-only`、`cargo generate-lockfile` 并提交锁文件，再按 README 启动。
