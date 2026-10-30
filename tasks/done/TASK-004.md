---
githubIssue: 4
id: TASK-004
milestone: M2
priority: P1
dependencies: [TASK-001]
---

# Add process memory budget

## 描述
在进程级监控 Supervisor 管理的 Pi 子进程树和 SOXU 自身资源，支持空闲资源释放，优先解决多 Agent 场景的内存占用。不得因为预算超限强杀正在执行任务的 Agent。

## 范围
- 记录进程树 RSS/私有内存等具有平台解释的指标并展示诊断。
- 空闲态资源回收、阈值预警、平台不支持时的降级处理。
- Windows 16GB 内存、3 Agent 场景的基准方法、采样开销与报告。

## 验收标准
- [ ] 测量指标、采样间隔、阈值与平台限制均被文档化。
- [ ] 压力测试覆盖 3 Agent 并发和长时间空闲，不干扰活跃 Agent。
- [ ] 超限仅采取安全可恢复的释放/预警策略，失败不丢会话。
- [ ] 性能基准与自动测试有真实记录，符合质量门禁。

## 归档记录

- 实现：PR #42（squash 合入 main，3c50216）
- 归档：2026-10-28
