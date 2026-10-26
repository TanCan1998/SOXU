# Git/Worktree 规范

- 单 Issue 单分支 `agent/issue-<id>-<slug>`；主仓库 main 只由合并流程更新。
- Worktree 根目录在 SOXU 同级 `soxu-worktrees`。
- 仅 Runner 负责 push、PR、merge/tag/mirror；开发 Agent 只改文件。
- `git diff --check`、测试、Reviewer 全通过才允许 commit/push。
- GitHub main 必须启用 branch protection/ruleset：必过 `quality`、禁止 force push、禁止删除；自动合并仅在门禁正确配置后开启。
- AtomGit 镜像不接受直接开发提交；禁止 `push --mirror` 到含独立分支的仓库。

<!-- SOXU_GIT_POLICY_V1 -->
## 强制提交约定（2026-10-14 起）
- 提交标题：`<gitmoji> type(scope): 描述`，Gitmoji 和 type 严格一一对应，scope 必填。
- 参见 `docs/development/git-commit-policy.md`，以 `scripts/check-commit-msg.mjs` 的 `COMMIT_TYPES` / `GITMOJI` 为唯一映射源。
- 提交前：`git add ...`，运行 `node scripts/check-staged.mjs`，提交时 commit-msg hook 自动校验消息。
- Developer、Reviewer、Orchestrator 均不得绕过 hook；出现拒绝时修复代码或暂存内容后重试。
- 所有工作分支的 pull request 须通过 Commit policy GitHub Actions，并保留既有 CI/构建/测试门禁。
