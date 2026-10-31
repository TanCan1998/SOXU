---
githubIssue: 144
id: TASK-034
milestone: M1
priority: P0
dependencies: [TASK-033]
---

# i18n 存量迁移：会话区与输入区

## 背景

i18n 框架（TASK-032/#135）已交付但只迁移了顶栏与语言包区。22 个 Vue 模板共 242 行硬编码中文。按 docs/development/i18n.md 阶段 3 排期分四个小任务，本任务是第一个：会话区（ChatPanel、MessageList、MessageActions、SessionTabs、SessionStatsRow/Ring、sendMode.ts、sessionStats.ts 的用户可见文案）与输入区（ChatComposer、ComposerSendMenu）。

## 范围

1. 新建 locales/zh-CN/session.json + composer.json 与 en-US 对应文件，在 locales/index.ts BUILTIN_MODULES 登记
2. 迁移上述组件全部用户可见文案：模板插值、aria-label、tooltip、placeholder、错误文案、sendModeLabel 等动态标签
3. 数据源文案（sendMode.ts 的 SEND_MODE_TEXT、sessionStats.ts 的错误文案）改为从语言包读取，key 命名遵循 i18n.md 第 2 节
4. 消息时间戳改用 formatDateTime（如尚未使用）

## 验收标准

- [ ] 上述组件模板与脚本中不再有硬编码 CJK 用户可见字符串（测试断言）
- [ ] node scripts/check-locales.mjs 通过（key 对齐、无跨模块重复）
- [ ] 切换 en-US 后会话区/输入区完整英文渲染（桌面端截图）
- [ ] t() 缺失 key 回退 zh-CN 行为有测试覆盖
- [ ] pnpm check 全绿

## 非目标

- 设置页/抽屉/通知/侧栏（后续三个 i18n 任务）
- loop 控制台（automation/loop/web/）
