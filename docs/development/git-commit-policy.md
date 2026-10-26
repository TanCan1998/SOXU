# SOXU Git 提交消息与提交前自检规范

> 生效日期：2026-10-14。对 Developer、Reviewer、Orchestrator 和人工提交一视同仁。

## 1. 提交消息（强制）

格式：`<gitmoji> type(scope): 描述`

| Gitmoji | type | 用途 |
|---|---|---|
| ✨ | `feat` | 新功能 |
| 🐛 | `fix` | Bug 修复 |
| 📚 | `docs` | 文档更新 |
| 💎 | `style` | 代码格式 |
| ♻️ | `refactor` | 重构 |
| 🧪 | `test` | 测试 |
| 🔧 | `chore` | 构建/工具/杂项维护 |
| ⚡ | `perf` | 性能优化 |
| 📦 | `build` | 构建产物/构建系统 |
| 👷 | `ci` | CI 配置 |
| ⏪ | `revert` | 回退 |

- Gitmoji 与 `type` 必须精确对应；不得省略 Gitmoji、`type` 或 `scope`。
- `scope`：小写字母或数字开头，之后可以包含小写字母、数字、`.`、`_`、`/`、`-`。例如：`desktop`、`desktop/ui`、`agent-loop`、`repo`、`ci`。
- `描述`：非空，单行标题；可使用中文或英文。可在标题下方附加空行及正文。
- squash、amend、Agent 自动提交以及回退提交同样遵循规范。Git 默认生成的 merge/revert 消息不自动豁免；如果使用合并提交，应手动提供合规标题。
- 校验实现的唯一真源：`scripts/check-commit-msg.mjs` 中的 `COMMIT_TYPES` 与 `GITMOJI`。

合法示例：

```text
✨ feat(desktop/ui): 实现会话导航布局
🐛 fix(agent-loop): 修复任务状态标题缺失
📚 docs(agents): 补充自主开发规范
💎 style(desktop): 统一样式格式
♻️ refactor(runtime): 解耦会话索引服务
🧪 test(loop): 增加断线恢复测试
🔧 chore(repo): 初始化 SOXU 仓库
⚡ perf(session-index): 优化查询路径
📦 build(desktop): 更新构建脚本
👷 ci(github): 增加提交消息质量门禁
⏪ revert(desktop): 回退会话布局改动
```

不合法：`chore: setup`、`✨ fix(loop): bad mapping`、`🔧 chore: missing scope`。

## 2. 提交前轻量自检（强制）

`pre-commit` 校验 **Git 暂存区内容**，而不是误用未暂存的工作区内容：

1. `git diff --cached --check`：检查行尾空格、EOF 多余空行等问题。
2. 检查暂存路径：禁止真实 `.env`、常见密钥/证书私有文件；允许 `.env.example`。
3. 对暂存的文本内容检查 Git 冲突标记、明显的私钥或 GitHub Token（并非完备的密钥扫描器）。
4. 对暂存的 `.mjs`、`.cjs` 进行 Node 语法检查（不执行脚本）。
5. 失败时阻止提交；Agent 应修复暂存内容，重新 `git add` 后再提交。

**性能约束**：pre-commit 不执行完整 `pnpm build`、`cargo build/test` 或网络操作。PR 和 Release 阶段仍须经过仓库原有的质量门禁；不得把轻量检查视为完整测试。

## 3. 安装与手动自检

每个本地克隆首次执行：

```powershell
node scripts/setup-git-hooks.mjs
```

手动自检：

```powershell
node scripts/check-staged.mjs
node scripts/check-commit-msg.mjs --message "🔧 chore(repo): 初始化 SOXU 仓库"
git config --local --get core.hooksPath
```

本地 Hook 不是强安全边界，`--no-verify` 可以绕过。GitHub Actions 的 `Commit policy / Validate commit messages` 也校验提交历史；如需强制主分支，须在 GitHub Branch Protection / Rulesets 中将该检查设为 Required。

## 4. Git worktree 与 Agent

`.githooks` 纳入版本控制；`core.hooksPath` 是本地 Git 配置，不随 clone 自动启用。每个独立克隆执行一次设置；共享同一个 Git 管理目录的 worktree 通常可复用配置。Agent 负责规范提交消息，禁止为绕过格式门禁而使用 `--no-verify`。
