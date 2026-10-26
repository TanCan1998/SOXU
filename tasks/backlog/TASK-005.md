---
id: TASK-005
priority: P1
dependencies: [TASK-002]
---

# Implement worktree integration

## 描述
在产品侧展示并管理 Git Worktree；将项目目录、Git 分支、Agent 会话分别建模，避免 Git 操作误伤活跃工作树。

## 范围
- Worktree 枚举、选择、创建及与 SessionId 的关联。
- Diff 预览、冲突检测、未提交改动提示和只读安全检查。
- 不允许自动清理、reset 或回滚活跃/脏 Worktree。

## 验收标准
- [ ] 多 Agent 使用不同 Worktree 时隔离正确，切换工作树不会串会话。
- [ ] 测试覆盖脏工作树、Git 锁冲突、Worktree 删除与异常退出。
- [ ] 危险操作必须受确认/权限约束；失败后仍可安全恢复。
- [ ] 功能及恢复路径有可复现证据，符合质量门禁。
