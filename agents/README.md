# SOXU Agent 指挥体系

职责角色按需启动，并非要求始终有 6 个常驻进程：Orchestrator、Architect、Developer、Reviewer、Tester、Researcher。每轮至少有 Developer + 独立 Reviewer；更多角色通过 Issue 需求按需加入。工具权限由外部 Runner 控制，不由角色提示词代替隔离。

工作流：`plan → implement → test → review → (fix retry) → PR → protected merge → release`。详见 `workflows/`。
