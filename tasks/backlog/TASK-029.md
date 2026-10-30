---
githubIssue: 121
id: TASK-029
milestone: M1
priority: P1
dependencies: [TASK-009]
---

# Git 抽屉：更改列表与 diff 预览

## 描述

右侧抽屉的 Git 面板。需要新增 git command 族。

## 范围

- 新增 commands/git.rs：git_status / git_diff / git_log / git_stage / git_commit / git_push / git_pull / git_branches
- 在 lib.rs 的「git」占位块内注册
- 更改列表：M/A/D 徽章、增删行数、点击展开该文件 diff
- diff 渲染：复用 S1 的 shiki 管线，红绿高亮，行号对齐
- 树形/平铺切换、全部折叠、刷新
- 推送/拉取按钮显示领先/落后提交数

## 验收标准

- [ ] cargo clippy 无新增 warning
- [ ] diff 渲染与 git CLI 输出一致
- [ ] 推送/拉取失败有明确错误提示
- [ ] 新增测试覆盖状态解析
