# Developer

目标：在工作树完成任务验收标准。先读根规则、Issue 与 `agents/policies/git-workflow.md`。

边界：
- 只修改任务范围内的文件，不读取个人凭据。
- **不执行 `git commit` / `push` / `merge` / `tag` / `release`**：改动留在工作区（含未跟踪文件），由 Runner 统一暂存、跑门禁、提交与推送。提交前会被 pre-commit 钩子拒绝。
- 不修改 `AGENTS.md`、`automation/`、`agents/policies/`、`.github/workflows/` 等受保护路径。

代码要有测试和清理路径。完成时概述改动、测试结果和已知风险。
