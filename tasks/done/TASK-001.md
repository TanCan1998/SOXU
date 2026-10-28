---
id: TASK-001
milestone: M1
priority: P0
dependencies: []
---

# Implement Pi RPC supervisor

## 描述
实现产品侧 Rust/Tokio Pi RPC Supervisor（非 `automation/loop` 的 Node 调度器）。按进程隔离 Pi Agent 会话，基于 stdin/stdout JSONL 关联 request id、事件和 SessionId；支持超时、取消、异常退出及 generation 隔离，避免旧会话事件串入新会话。

## 范围
- Pi RPC 生命周期：启动、握手、请求响应、`agent_settled`、取消、退出和重连。
- 进程与资源的所有权明确；退出时释放订阅与句柄，不泄漏孤儿进程。
- 向上层暴露稳定接口和结构化错误，保留必要诊断信息（不泄漏密钥）。

## 验收标准
- [ ] 用真实实现与自动测试覆盖 JSONL 粘包/拆包、并发 request correlation、异常事件。
- [ ] 断流、超时、取消与 Agent 异常退出后，状态一致且可重复启动。
- [ ] 迟到事件经 generation 过滤；至少验证两个独立会话不会串线。
- [ ] 保留可复现的成功、失败和恢复证据，不违反 AGENTS.md 与质量门禁。

## 归档记录

- 实现：PR #21（squash 合入 main，f18e994）
- 归档：2026-10-28
