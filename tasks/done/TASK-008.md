---
githubIssue: 74
id: TASK-008
milestone: M0
priority: P2
dependencies: []
---

# 在文档中记录局域网复制的回退限制

## 描述

控制台在非安全上下文（例如安卓通过 http://<局域网IP>:47321 访问）时没有 navigator.clipboard，复制依赖 execCommand 回退，必要时提示用户长按手动复制。这一行为目前只在代码与 PR 说明里，没有写进用户文档。

## 范围

- 在 README.md 与 README.en.md 的「热更新」小节之后各补一行说明。
- 只改这两个文档，不动代码、不动其他文档、不加依赖。

## 验收标准

- [ ] README.md 与 README.en.md 各出现一行：局域网 HTTP 下复制使用 execCommand 回退，失败时提示长按手动复制。
- [ ] 两个 README 语义一致，中文/英文措辞对应。
- [ ] 不修改任何代码文件，不改变其他行为。
