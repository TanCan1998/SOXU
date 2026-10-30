---
githubIssue: 112
id: TASK-009
milestone: M0
priority: P0
dependencies: []
---

# 后端命令层拆分：commands/dto 模块化 + lib.rs 领域占位块

## 描述

V4 需要新增约 27 个 Tauri command。当前 commands.rs（221 行 / 23 个 command）、dto.rs（255 行 / 17 个 struct）、lib.rs 的 generate_handler 都是单点文件，任何后端切片都要改同一处，实测导致 PR #115 与 #114 冲突、孤儿 PR。

## 范围

- commands.rs 拆成 commands/{mod,session,workspace,worktree,history}.rs，23 个 command 签名与行为一字不改
- dto.rs 拆成 dto/{mod,session,workspace,worktree}.rs，17 个 struct 字段一字不改
- lib.rs 预置 9 个 V4 领域占位块（files/git/pty/model/stats/outline/extension/notify/search），顺序固定
- 新增 scripts/check-command-blocks.mjs 并在 CI 接入，校验 command 落在正确块内
- 扩块规则写进 AGENTS.md

## 验收标准

- [ ] cargo check / clippy 通过，无新增 warning
- [ ] 桌面端现有测试全绿
- [ ] git diff 中 23 个 command 函数体逐字节相同
- [ ] lib.rs 含 9 个领域占位注释块
- [ ] CI 校验脚本能拦住错误插入
