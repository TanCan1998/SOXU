# SOXU 有界超时与一句话恢复

## 用户最简操作（无需记 Issue 编号）

额度或网络恢复后，在 **SOXU 仓库根目录**直接运行：

```powershell
node ../soxu-agent-loop/automation/loop/src/cli.mjs say -- "继续 SOXU"
```

一句话的解析是本地规则匹配，**不调用 LLM，不消耗 Token**。默认只恢复**最后更新的一个 `paused` 检查点**，自动识别它属于 GitHub 任务还是本地任务。它不会误把当前 `running` 或已 `blocked` 的任务接管。正常恢复执行开发环节时才会使用 Pi API。

```powershell
# 只预览，绝不启动模型或工作树修改
node ../soxu-agent-loop/automation/loop/src/cli.mjs say -- "继续 SOXU" --dry-run
# 根据 Issue 编号指定一个任务
node ../soxu-agent-loop/automation/loop/src/cli.mjs say -- "恢复 Issue 123"
# 明确授权批量恢复（受最大并行数限制，一批再次暂停即停止）
node ../soxu-agent-loop/automation/loop/src/cli.mjs say -- "恢复所有暂停的任务"
# 仍可通过以前的命令恢复
node ../soxu-agent-loop/automation/loop/src/cli.mjs start -- 123
```

Pi 项目 Skill 也能识别上述请求，详见 `.pi/skills/soxu-recover/SKILL.md`；**但 API 配额不足时请直接运行终端命令，不要依赖 Pi 对话理解指令**。

## 默认时间预算

| 阶段 | 默认 | 行为 |
| --- | --- | --- |
| Pi 启动/接受指令 | 90 秒 | 未收到 prompt 接受事件则停止 |
| Pi 活跃阶段连续无进展 | 240 秒 | 只有有效 RPC 事件能续空闲计时 |
| Developer 单次总时长 | 35 分钟 | 硬上限，不能因进度事件无限延长 |
| Reviewer 单次总时长 | 12 分钟 | 更短，防止审查耗尽额度 |
| 隔离 Worktree 安装依赖 | 6 分钟 | 到时终止进程树 |
| GitHub 与 Git 网络命令 | 约 45 秒 | 网络持续故障不重复轮询 |
| pnpm check | 8 分钟 | 按检查配置 |
| cargo test --workspace | 12 分钟 | 按检查配置 |
| Pi 退出宽限期 | 5 秒 | 防止终端、工具子进程滞留 |

所有值在 `automation/policy.json` 的 `timeouts` 和 `checks` 中配置，并有配置边界校验；不要为了“大概率成功”直接调成无限时间。

## 故障行为

- **额度不足/429/Rate Limit**：分类为 `quota`，暂停，不自动重发模型请求。额度恢复后手动继续。
- **网络连接重置、DNS 错误、超时、502/503/504**：分类为 `network`，暂停；网络失联不反复提交 GitHub 评论。
- **Pi 长时间无进展或超过硬上限**：分类为 `timeout`，暂停并记录精确阶段。
- **Ctrl+C / 系统中断**：当前可中止 Pi 和测试进程；发生异常退出时由上次 `running` 检查点恢复。
- **安全/代码测试失败**：`blocked`，需要修复，不得自行绕过。Reviewer 明确拒绝按策略允许一次开发修订，不属于网络重试。

每个任务状态原子保存在 `.soxu/checkpoints/local-issue-N.json` 或 `.soxu/checkpoints/github-issue-N.json`（兼容读取并迁移旧的 `issue-N.json`）（被 `.gitignore` 排除）。保留当前 Git Worktree、branch、base commit、阶段、审查意见及提交信息。`resume` 通过当前阶段恢复，禁止无条件重新开始；Commit/PR 创建前检查是否已经完成，避免重复。Reviewer 只读且代码树未变化时复用已通过的质量检查结果，不重复运行长时间的 Cargo 测试；若审查期间内容发生变化则重新执行门禁并重新 Reviewer 审查。提交前再次确认审查过的树与测试树一致。

自动 `loop` / `watch` 遇到暂停会停止，不会持续消耗模型额度。**注意：Runner 设置为零自动 API 重试，但 Pi 内核或服务端自己的重试机制仍可能存在，需另行确认 Pi 设置。**

## 恢复状态机

`ready → running → paused(quota/network/timeout/interrupted) → [显式 resume] → running → PR`。

`blocked` 默认不参与恢复。检查并修复原因后，可先运行 `node ../soxu-agent-loop/automation/loop/src/cli.mjs start -- --blocked --issue 123 --dry-run` 预览，再去掉 `--dry-run` 显式恢复；不指定 Issue 时会包含同一模式下所有 paused、running 和 blocked 任务。安全检查与质量门禁仍会重新执行。若同步了最新 main，旧测试和审查结果失效，将重新安装依赖、检查并审查；存在冲突时由 Developer 基于保留的 stash 解决。Worktree 已修改和 Git 检查点是恢复基础；没有自动删除或复原未提交更改。仅一台 Coordinator 运行同一仓库任务，活跃 PID 锁禁止同时认领。Run 过程中意外崩溃留下锁时，`resume` 只回收已经确认 PID 不再存在的锁。

## 必须验证的边界

- 模拟 API 429、网络断开、Pi 停止响应，确保不会自动再次调用模型。
- 恢复时沿用原 Worktree 和 Git HEAD，且不会重复创建 PR。
- 停止阶段是否已有中途工具写入由 Agent 在现有工作树 `git status` 检查后继续，不能承诺所有外部副作用都自动精确续传。
- 手动恢复若网络/额度仍不可用会再次暂停，无无限循环。

## 自然语言解析边界

- 支持“继续 SOXU / 恢复上次中断任务 / 恢复 Issue 123 / 恢复所有暂停任务”等有限、明确的表达。
- 出现否定、破坏性操作、多个不同 Issue 编号或同时指定“所有”和具体编号时，立即报错，绝不执行句子中的 Shell 命令。
- 没有任何暂停的任务就退出；不会从 `tasks/backlog/` 另外挑选新任务；不会自行重新验证额度并反复请求模型。
- 只有 `paused` 检查点可自动恢复；进程突然被杀留下的 `running` 检查点需要先确认实际进程是否退出，防止与活跃 Agent 抢锁。`blocked` 需要人工检查故障原因。

`agent:say` 使用严格的本地短句匹配：不调用模型解析命令；“继续 SOXU”默认只接续最近一个 **paused** 任务，批量恢复需要明确说“恢复所有暂停的任务”。危险或模糊输入会拒绝执行。`cli.mjs start` 无参数则按设置恢复所有可恢复任务（包括异常退出的 running 检查点，但仍须排除活跃 PID 锁）。

**同号任务隔离**：本地 TASK #N 与 GitHub Issue #N 的检查点、锁、Worktree/分支命名空间相互独立。显式指定编号且两个来源都有暂停记录时，需加 `--local` 或 `--github` 选择范围。
