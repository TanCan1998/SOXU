# Recover

用户说“继续 SOXU”时，先 `node ../soxu-agent-loop/automation/loop/src/cli.mjs resume -- --dry-run`，再 `node ../soxu-agent-loop/automation/loop/src/cli.mjs resume`。不要要求提供 Issue 编号或重跑整个循环。

额度、网络、超时状态保存为 `paused`；阶段和 Worktree 保留，恢复后接续。异常退出的 `running` 检查点允许确认原进程不在后恢复。`blocked` 属于安全/质量/编程错误，不得强制跳过。

处理崩溃任务：检查 Issue、Worktree、分支、PR；不得盲删未合并的分支。详见 `docs/development/timeouts-and-recovery.md`。
