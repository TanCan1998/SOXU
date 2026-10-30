---
githubIssue: 119
id: TASK-027
milestone: M1
priority: P1
dependencies: [TASK-009]
---

# 上下文环与统计行：session_stats

## 描述

composer 右侧的上下文占用圆环 + 点击展开的统计浮窗，以及底部统计行。数据来自新增的 session_stats command。

## 范围

- 新增 command session_stats(sessionId) 返回 context/turn/process/session 四组指标（字段见 interaction-decisions.md）
- 圆环：14px SVG，stroke 2.8，按占用率变色（<60% accent / 60-85% 警告 / >85% 危险）
- 浮窗：上下文已用百分比、首 token、回复耗时、流式速度、均速、缓存命中、内存/CPU/子进程、会话载入数、输入输出 token、重试预算
- 底部统计行：轮次、首 token、回复耗时、流式、均速、缓存命中、输入输出
- 数据来源：现有 session 事件流累积 + runtime_status，不新增额外轮询

## 验收标准

- [ ] pnpm check 通过，测试全绿
- [ ] 圆环颜色随占用率变化
- [ ] 浮窗数值与事件流一致
- [ ] 统计行在无数据时显示占位而不是 0
