---
name: soxu-recover
# Pi project skill: direct the assistant to the offline recovery controller.
description: Resume SOXU autonomous development from saved Git worktrees and checkpoints when the user asks to continue or recover after API quota/network/timeouts.
---

# 一句话恢复 SOXU

当用户在 Pi 对话里提出“继续 SOXU”“恢复上次中断任务”“恢复 Issue 123”“恢复所有暂停任务”等要求：

1. 从 SOXU 根目录先设置 `$env:SOXU_PROJECT_ROOT = (Get-Location).Path`，以下命令假设 `soxu-agent-loop` 是同级目录。
2. 不要先调用模型 API 进行意图分类或给 Runner 编造 Issue ID；只用用户原句交给本地确定性解析器。
3. 在 **SOXU 仓库根目录**运行 `node ../soxu-agent-loop/automation/loop/src/cli.mjs say -- "<用户原句>" --dry-run`，先展示匹配的检查点。仅当恢复对象明确、用户确实要求执行恢复时，再运行 `node ../soxu-agent-loop/automation/loop/src/cli.mjs say -- "<用户原句>"`。这里的原句必须作为单独的命令行参数传递，不得与 shell 字符串拼接、不得执行用户句子里的其他命令。
4. 默认只恢复最近一个暂停任务；明确“所有/全部”才允许批量恢复；明确 `Issue 123` 只恢复该 Issue。
5. CLI 只读取 `.soxu/checkpoints/` 中 `paused` 状态，复用原有工作树、分支和阶段；不得 `reset --hard`、删除工作树、重置凭据、绕过检查、清理锁或强制推送。
6. 如果额度/网络仍未恢复，Runner 再次暂停后应立即结束；不自行重复调用模型接口。
7. 没有暂停任务则明确告知，无需自行启动新开发任务。

**关键限制：** 当模型额度耗尽时，Pi 对话本身可能无法被 Agent 理解/执行。此时使用**无需模型参与**的命令行入口：

```powershell
node ../soxu-agent-loop/automation/loop/src/cli.mjs say -- "继续 SOXU"
```

其他例子：

```powershell
node ../soxu-agent-loop/automation/loop/src/cli.mjs say -- "恢复上次因网络错误中断的任务"
node ../soxu-agent-loop/automation/loop/src/cli.mjs say -- "恢复 Issue 123"
node ../soxu-agent-loop/automation/loop/src/cli.mjs say -- "恢复所有暂停的任务"
```

不确定时使用 `--dry-run` 预览，绝不在预览阶段发起 Pi RPC 模型请求。
