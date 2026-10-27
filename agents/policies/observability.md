# 开发状态与监控规范

## 状态来源

- GitHub Issue 标签：待办、运行中、暂停、阻塞、PR 等；PR/CI 与实际提交 SHA 是验收依据。
- 本地 `.soxu/checkpoints/`：任务、phase、status、reason、branch、worktree 与测试/审查 tree，用于故障恢复。
- Pi RPC JSONL/本地日志：诊断，不作为完成的唯一证据；不得上传私密提示词或原始密钥。
- PiDeck：用于**由 PiDeck 自身管理**的 Pi 会话及人工操作。调度器独立创建的 Pi 子进程能否附加到 PiDeck 实时监控尚未确认，默认查看终端日志和检查点。

## 进度口径

- 完成任务数 = 已合并、CI 通过、验收点达成的任务；未合并 PR 不是完成。
- 进度分母 = 已确认里程碑范围内所有 Issue；新增/拆分 Issue 会使百分比改变，不能将百分比视为稳定工时预测。
- 未运行/暂停/失败/阻塞/进行中/待审查/已合并状态分开显示。
- 模型 Token/费用只展示 Pi 实际采集的数据；未知显示“未知”，绝不估算成已产生账单。
- 本地监控工具应只监听 127.0.0.1，默认只读，非授权不开放控制和自动重试 API。

## 最小观测面

需要可查询：当前 Issue、Agent 角色、模型 ID（不包含凭据）、Worktree、开始时间、阶段、最近有效事件、CI 链接、失败类型、是否可恢复、停机/子进程状态。未来 `node ../soxu-agent-loop/automation/loop/src/cli.mjs status` / `node ../soxu-agent-loop/automation/loop/src/dashboard-cli.mjs` 需单独实现和测试；本规范不表示它们已经存在。
