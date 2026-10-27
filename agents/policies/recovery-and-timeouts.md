# SOXU Agent 时间预算与手动恢复策略

## 预算（可在 `automation/policy.json` 调整）

- Developer：单次 35 分钟硬上限；RPC 4 分钟无有效协议事件则停止；持续输出不会突破硬上限。
- Reviewer：12 分钟硬上限，同样受 8 分钟空闲检测约束。
- Worktree 依赖安装：6 分钟；TypeScript 检查：8 分钟；Rust 测试：12 分钟。
- 并行最多 2 个任务，每个任务审查失败最多重新开发 1 次。限时不代表必须等待满额，任务完成立刻结束。
- 网络、HTTP 429、余额/额度不足、Pi 进程异常退出或超时，默认暂停该 Issue，不自动无限重试。

## 一句话恢复（本地无模型解析）

处理好额度、网络问题后，在 SOXU 根目录运行：

```powershell
node ../soxu-agent-loop/automation/loop/src/cli.mjs say -- "继续 SOXU"
```

- `node ../soxu-agent-loop/automation/loop/src/cli.mjs say -- "恢复上次因网络问题中断的任务"`：恢复最近一次暂停任务。
- `node ../soxu-agent-loop/automation/loop/src/cli.mjs say -- "恢复 Issue 123"`：指定任务。
- `node ../soxu-agent-loop/automation/loop/src/cli.mjs say -- "恢复所有暂停的任务"`：明确执行所有已暂停任务。
- `node ../soxu-agent-loop/automation/loop/src/cli.mjs say -- "继续 SOXU" --dry-run`：只预览，无 Pi 模型调用。

解析器不通过网络、不调用大模型。恢复依赖 `.soxu/checkpoints/issue-123.json`，会复用已保存的分支、Worktree 与阶段。若再次触发同类错误，立刻暂停，不自动重试。

旧命令 `node ../soxu-agent-loop/automation/loop/src/cli.mjs resume -- 123` 保持兼容。若希望在 Pi Agent 对话中用自然语言，可以加载 `.pi/skills/soxu-recover/SKILL.md`；额度耗尽时使用终端入口。

## 限制

恢复依赖于失败时保留的本地 Worktree；迁移机器或删除工作树后无法直接原位恢复。RPC 超时可能终止 Pi 进程，进程中的未持久化上下文不会恢复，但已写入工作树的文件不会自动丢弃。中途执行的外部工具进程仍需人工核实。
