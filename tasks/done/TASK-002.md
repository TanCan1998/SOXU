---
githubIssue: 2
id: TASK-002
milestone: M1
priority: P0
dependencies: []
---

# Implement project and session catalog

## 描述
构建项目目录、Worktree、Runtime 和稳定 SessionId 之间的映射，读取 Pi JSONL 会话历史，建立可增量更新的索引与分页 API；不把运行中的 Pi 进程与历史会话文件强绑定。

## 范围
- 项目根目录和 Worktree 识别、SessionId 稳定映射、持久化元数据。
- 大型 JSONL 增量索引、流式分页、并发读取与写入处理。
- 文件被截断/替换、损坏行、旧 Session 重命名/迁移的可恢复行为。

## 验收标准
- [ ] 自动测试覆盖重启后 ID 稳定、并发写入、部分 JSONL 行、索引失效重建。
- [ ] 长会话按页查询，不要求把完整 JSONL 一次性加载进内存。
- [ ] 明确 Runtime/Project/Worktree 的身份关系与错误码。
- [ ] 保存真实代码、测试、异常恢复路径证据，满足项目质量门禁。

## 归档记录

- 实现：PR #22（squash 合入 main，48874d2）
- 归档：2026-10-28
