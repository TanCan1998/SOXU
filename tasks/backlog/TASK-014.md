---
githubIssue: 109
id: TASK-014
milestone: M0
priority: P1
dependencies: []
---

# 会话内搜索走本地文本缓存（不建倒排索引）

## 描述

会话内全文搜索用文本缓存 + 线性扫描实现，避免维护倒排索引的内存与磁盘开销。

## 范围

- crates/session-index 新增 search 模块（cache/matcher）
- 每会话缓存预算 8 MiB，全局 24 MiB
- search_session command 与前端搜索面板数据源

## 验收标准

- [ ] 10 MiB 会话搜索 < 50ms
- [ ] 缓存预算不超限
- [ ] 测试覆盖匹配与截断
