# SOXU 引导工程交付说明（最新：v1.5 已审批基线）

> 产品本身仍为 **0.1.0 开发起点**。本工程包 v1.5 是工程治理迭代标识，不是可安装产品版本。

2026-10-26：项目所有者已确认 Developer/Reviewer 均使用 `magpie / auto/deepseek-v4.1-flash`、按新项目推荐版本选型（Node >=24，pnpm 12.15.0，Rust 1.99.1 / Edition 2024，Tauri 2，Vue 3.5.44，Vite 8.3.5，TypeScript 6.0.3，Pinia 4.1.0，Vue Router 5.4.0），UI/UX 参考 ChatGPT 对话优先布局。现已写入工程配置与 Vue UI 骨架。

离线 Node 22 环境下 **35/35 Node 自动测试通过**。**未验证**：Node 24/26 安装、pnpm/Cargo 锁文件解析、Rust/Tauri 构建、Magpie 认证与额度、Windows PiDeck/GitHub 实际联调。首次在开发机执行需先生成 `pnpm-lock.yaml`、`Cargo.lock` 并提交，否则 CI 冻结安装失败。

详见 `README.md`（中文）、`README.en.md`（英文）、`docs/development/approved-toolchain.md`、`docs/design/gpt-inspired-ui.md`。

---

# SOXU 初始工程交付说明（历史基线）

生成日期：2026-10-26
产品：SOXU（索序）
仓库：Monorepo / 本地 Git Worktree / GitHub Issues+PR+Actions / AtomGit 镜像

## 本次交付

| 组件 | 状态 |
|---|---|
| Tauri 2 + Vue 3 + TypeScript UI 基础工程 | 源码已生成；本环境缺少 Rust 和 pnpm，未编译验证 |
| Rust Workspace / 基础协议数据模型 | 源码已生成；尚未编译 |
| 根目录 AGENTS.md + 多角色提示词与策略 | 已生成 |
| 产品需求、ADR、技术研究、参考文档 | 已生成 |
| Git Worktree + Pi RPC + Reviewer + CI Gate Runner | 已实现初始化版本；基本 Node 测试通过 |
| GitHub Issue 初始化、PR 创建、自动合并请求 | 接口已实现；需实际仓库权限与分支保护联调 |
| 自动 prerelease Tag + GitHub Actions 安装包工作流 | 配置已生成；需实际 GitHub 联调及签名/构建检查 |
| AtomGit 同步 | 已提供 Pull Mirror 官方配置说明与非强制推送脚本 |
| Pi 桌面 App 内部多 Agent 并行功能 | 未实现：列入 TASK-001 至 TASK-005，供后续自治开发 |

## 已完成的离线验证

- Node.js `.mjs` 语法检查。
- `node --test automation/loop/tests/*.test.mjs`：4 项测试通过（RPC JSONL、Reviewer 结构、受保护路径、模拟 Pi 完成事件）。
- 独立临时仓库 `scripts/init-git.mjs` 初始化成功。
- 本地 `agent loop --local --dry-run` 任务枚举成功。
- Git 分支变更二次检查/暂存安全逻辑模拟成功。

## 还需要在开发机器验证

- `pnpm install`、`pnpm tauri:dev`、`pnpm check`、`cargo test --workspace`。
- Pi 认证、Pi 的实际版本与 RPC 的真实事件流。
- GitHub Issues/PR/branch protection/auto-merge 与 Actions 的权限及执行情况。
- AtomGit 源码 Pull Mirror 实时同步；GitHub Release 工件、Windows/macOS 签名和公证。

## 入口

1. 阅读 `README.md`；在 Windows 上安装依赖。
2. `node scripts/init-git.mjs`。
3. `node ../soxu-agent-loop/automation/loop/src/cli.mjs doctor`。
4. 配置 `origin`、AtomGit、main branch protection，再执行 `node ../soxu-agent-loop/automation/loop/src/cli.mjs seed-issues`。
5. 用 `node ../soxu-agent-loop/automation/loop/src/cli.mjs start -- --dry-run` 预览 GitHub 任务，完成配置后执行 `node ../soxu-agent-loop/automation/loop/src/cli.mjs loop` 或受预算约束的 `node ../soxu-agent-loop/automation/loop/src/cli.mjs watch`。

**安全边界**：Agent 本地执行工具不是安全沙箱。正式长期自治运行应使用隔离的低权限账户，禁止让开发 Agent 访问个人凭据与生产资源。请勿把自动执行成功等同于代码已经通过生产审计。

## v3 增量：自然语言手动恢复

- 新增 `agent:say`：`node ../soxu-agent-loop/automation/loop/src/cli.mjs say -- "继续 SOXU"`，本地词法解析，不请求模型判断恢复意图。
- 支持最近暂停任务、具体 Issue、所有暂停任务；默认单任务，避免意外批量花费额度。
- 只恢复 `paused` 检查点，复用原工作树和阶段；无任务则无操作；仍需在真实 Pi 环境做端到端联调。
- 新增 `.pi/skills/soxu-recover/SKILL.md`；更新 README、恢复策略和 Node 离线测试。

## 2026-10-26 增强：有限时间预算及一句话恢复

- 新增 `node ../soxu-agent-loop/automation/loop/src/cli.mjs start` 和仓库 `.pi/skills/soxu-recover/SKILL.md`，用户对**在本项目中运行的 Pi Agent**说“继续 SOXU”即可触发恢复指引。
- 引入 Pi 启动、无进展、硬上限、Reviewer 和网络等分阶段预算；超时主动终止受管理进程树。
- 额度、网络、超时、中断采用 `paused` 检查点与 `agent:paused` 标签（网络断开时本地状态先行），禁止 Runner 自动重发模型请求。
- 新增 `.soxu/checkpoints/issue-*.json` 原子写入，保留 Worktree、Git Branch、最后阶段、Review 反馈与 PR；支持从上次阶段恢复。
- 优化门禁：通过验证的 staged tree 在只读审查后未变化时不再重复跑全部测试。
- Node.js 自动测试提升至 **14 项**（全部通过），另外通过本地 Git 端到端模拟：部分工作 → 模拟 429 → 暂停 → 一条恢复命令 → Review → Commit。
- **仍待实机验证**：Windows 进程树终止、实际 Pi RPC SDK 版本与 model provider 错误结构、真实 GitHub Issue 状态同步。模拟测试不能代替真实模型费用/网络试验。

恢复细则请看 `docs/development/timeouts-and-recovery.md`。

**v3 验证**：`node --test automation/loop/tests/*.test.mjs` 已通过 14/14；三种语句对应的独立命令行 dry-run 使用模拟 `paused` 检查点验证通过（未执行 Pi RPC）。真实额度/网络恢复后的 Pi 继续执行尚未端到端联调。

- 支持可选自然语言一句话命令 `node ../soxu-agent-loop/automation/loop/src/cli.mjs say -- "继续 SOXU"`；离线意图解析不消耗模型额度，默认为最近一个暂停任务，指明“所有”才批量恢复。

## 2026-10-26 v1.2 验证与审批候选增量

- 从先前保存的 `SOXU-monorepo-v1.1-resume.zip` 接续修改；未重建项目、未访问真实仓库/模型。
- 增加 `local-issue-N` / `github-issue-N` 检查点和锁命名空间；兼容 legacy checkpoint 读取及迁移。
- 变更检测覆盖 Reviewer 前后、最终检查及 Git Commit 前；树变更后须重新执行测试和审查，不复用过期批准。
- Agent Watch 等待可响应中断；Pi 超时子进程树清理的 POSIX 回归测试通过。
- `node --test automation/loop/tests/*.test.mjs`：19 项通过（含 5 项新增边界测试）。
- 新增 `docs/design/version-approval.md` 和 `docs/design/uiux-proposal.md` / `uiux-preview.html`。**尚未**修改根目录或子包版本号，**尚未**正式实施 UI/UX。
- 尚待在真实 Windows / pnpm / Cargo / Tauri / Pi / GitHub / AtomGit 环境验证。尤其 Windows 子进程终止的集成验证仍待完成。

## 2026-10-26 v1.3 增量验证（依赖及界面仍待确认）

- 保留 v1.2 现有所有产品和依赖版本，仅强化 Agent 自动执行与恢复边界。
- 拒绝超限二进制差异和符号链接；恢复提交对比真实 Git 父提交、内容树与已测试/审查证据。
- 普通命令与 Pi RPC 在结束/失败时等待进程退出或有界终止，防止因过早释放操作而发生恢复重叠。
- 新增 5 项独立回归，**Node 自动化 24/24 通过**，离线任务 dry-run / 无暂停恢复 dry-run 通过。
- 详细记录：`docs/development/v1.3-hardening.md`。
- 尚未验证 pnpm、Cargo、Tauri 编译、Windows 与真实 GitHub/Pi/AtomGit 集成，正式版本锁定与 UI/UX 仍待审批。
