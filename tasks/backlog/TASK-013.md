---
id: TASK-013
milestone: M1
priority: P1
dependencies: []
---

# 会话主链路：markdown 渲染 + 发送三选 + 消息操作

## 描述

V4 会话区 UI 重写：激活 markdown 渲染（markdown-it + shiki 按需加载）、实现发送三选菜单（加入当前 / 排到下轮 / 并行发送）、消息操作与位置感知 tooltip。

## 范围

- markdown-it + shiki 按需语言包，支持代码块/行内 code/表格/引用
- 发送按钮拆分 + reka-ui DropdownMenu，三项文案与可用条件照决策文档
- 模式横条与设置里的忙碌时发送默认投递
- send_prompt 扩展 mode/thinking 参数（仅管道，不改运行时行为）
- 消息操作：复制 / 重试 / 回退（后两者仅 UI 置灰）

## 验收标准

- [ ] pnpm check 通过，桌面端测试全绿
- [ ] 发送三选交互与原型一致（含忙碌置灰）
- [ ] shiki 语言包按需加载
- [ ] 无 XSS 风险
