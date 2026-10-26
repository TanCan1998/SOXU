# 外部研究与规范来源（截至 2026-10-26）

只记录设计事实和官方入口，不将 PiDeck 代码直接复制进 SOXU。

| 项目 | 参考 | 需要验证 |
|---|---|---|
| Pi | https://pi.dev/docs/latest/rpc | stdio JSONL、response `id`、`agent_settled` |
| Pi | https://pi.dev/docs/latest/quickstart | 安装、认证与环境 |
| Pi | https://pi.dev/docs/latest/packages | Skills/Extensions 包与项目级设置 |
| Tauri 2 | https://v2.tauri.app/start/create-project/ | Vue/TS/Tauri 2 工程 |
| Tauri 2 | https://v2.tauri.app/reference/config/ | Tauri 配置 |
| PiDeck | https://github.com/ayuayue/PiDeck/blob/v0.9.6/AGENTS.md | session-first、standby、进程/架构边界 |
| PiDeck | https://github.com/ayuayue/PiDeck/releases/tag/v0.9.6 | 长会话与内存治理经验 |
| GitHub | https://docs.github.com/en/actions | PR checks, release, permissions |
| AtomGit | https://docs.atomgit.com/docs/help/home/org_project/project_manage/project_settings/repository_mirroring/ | GitHub→AtomGit Pull mirror |

**动态接口以锁定的工具版本的官方文档为准。** 需要研究的领域分别在 `docs/research/` 记录决策与可复现证据。
