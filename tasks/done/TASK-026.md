---
githubIssue: 118
id: TASK-026
milestone: M1
priority: P1
dependencies: []
---

# 搜索抽屉：会话内全文搜索 UI

## 描述

会话内搜索的前端实现。后端 command 与 session-index 搜索能力已在 TASK-014（#109）交付并合并，本切片只做 UI。

## 范围

- 右侧抽屉新增「搜索」面板（原型 data-panel="search"）：搜索框 + 结果数 + 快捷键 ⌘F
- 结果列表：命中片段高亮、按消息时间倒序、点击跳转到该条消息
- 空态 / 无结果 / 搜索中 三种状态
- 搜索走已有的 search_session command（若 bridge 未暴露则补前端调用层，不改 Rust）
- 防抖 250ms，输入即搜

## 验收标准

- [ ] pnpm check 通过，桌面端测试全绿
- [ ] 搜索框输入后 250ms 内出结果
- [ ] 点击结果能定位到对应消息并高亮
- [ ] 新增测试覆盖防抖与结果渲染
