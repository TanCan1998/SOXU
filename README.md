# SOXU · 索序

**中文** · [English](README.en.md)

> 面向 Pi Agent 的轻量跨平台桌面工作台：多项目、多会话、多 Agent，强调低资源占用和可靠恢复。

**项目状态：准备启动 / 工程原型阶段。** 当前仓库包含早期 Tauri + Vue 工程骨架和可运行的 Node.js Agent 开发调度器；SOXU 最终桌面产品**尚未完成**。历史 ZIP 包版本（如 v1.3）代表原型工程迭代，并非正式 SOXU 软件发行版本。

## 本地 Web Agent 控制台

`pnpm agent:dashboard` 启动按需开放的本地控制台：在浏览器访问 `http://127.0.0.1:47321/`，
输入终端提供的临时令牌，查看任务阶段和有限日志，并手动运行、停止、恢复 Agent Loop。
不依赖 PiDeck、不接管其他终端的 Pi 进程。完整说明见 [Dashboard 操作手册](docs/development/dashboard.md)。

## 产品目标

SOXU 是使用 Rust + Tauri + Vue + TypeScript + Vite 从零开发的 Pi Agent 桌面端，参考 PiDeck 的体验，但不复制其代码。MVP 着重：

1. 同时管理多个项目、多个 Pi 会话与至少两个独立执行的 Agent 任务。
2. 中止/恢复及进程生命周期正确，关闭 SOXU 不留下受管 Pi 子进程。
3. 有界 JSONL 索引和虚拟化时间线，支持长会话而不无限占用内存。
4. Windows 优先，逐步完成 macOS/Linux 兼容与可复现性能评估。

可测量标准（P-01～P-08）、非目标和里程碑详见 [PRD](docs/product/prd.md)。**尚未实测的内存节省比例不得当作成果宣传。**

## 开发与产品的区别

- **Pi Agent**：SOXU 项目的自主编码/审查执行工具，也将是 SOXU 产品集成的 Agent 引擎。
- **PiDeck**：当前开发过程的人机交互和会话观察工具，**不是 SOXU 产品运行时依赖**。独立 Runner 创建的 Pi 会话能否实时附加 PiDeck 仍待实测。
- **SOXU Agent Loop**：Node.js 调度器，负责 Issue → Worktree → Pi → 检查 → Reviewer → PR → CI。
- **SOXU 桌面应用**：尚在开发的 Tauri + Vue 客户端，`pnpm tauri:dev` 仅启动应用。

## 开发环境

- Windows PowerShell；Git、GitHub CLI (`gh`)、Pi CLI、Rust/Cargo 与 Tauri 的平台依赖。
- **Node.js >=24**（开发机已使用 Node 26）。
- 已审批基线：**pnpm 12.15.0、Rust 1.99.1 / Edition 2024、Tauri 2、Vue 3.5.44、Vite 8.3.5、TypeScript 6.0.3、Pinia 4、Vue Router 5**；具体版本见 [工具链清单](docs/development/approved-toolchain.md)。**锁文件尚待在可联网、具备 pnpm 12 / Rust 的环境生成**。
- Pi API 的账户/额度由使用者配置；默认不自动切换到收费服务商。

```powershell
cd D:\Projects\SOXU       # 示例：替换为本机实际仓库目录
node --version
pnpm --version
pi --version
pnpm install                # 首次执行需下载依赖，完成后生成 pnpm-lock.yaml
cargo generate-lockfile       # 首次执行生成 Cargo.lock
pnpm agent:models           # 查看模型路由，不发起付费请求
pnpm agent:doctor           # 工具链、Git、恢复状态检查
```

## 已有任务 Worktree 同步

`main` 更新后，现有 Worktree 不会自动更新。通过 `pnpm agent:worktrees` 检查落后情况，通过 `pnpm agent:worktrees -- --sync` 安全快进干净、无活动锁且处于早期阶段的任务，并同步检查点。已有任务修改绝不会被自动覆盖。`pnpm agent:resume` 会在模型调用前检查基准；需要手工整合的旧分支会保留检查点并跳过该任务。详见 [Agent Loop 手册](docs/development/agent-loop.md)。

## 如何启动与监控自主开发

```powershell
# 首次本地仓库初始化（如果已有 Git 仓库不会覆盖）
node scripts/init-git.mjs

# 配好远端和分支保护后，初始化 GitHub Issues（仅一次）
pnpm agent:seed

# 先预览，再人工授权执行
pnpm agent:status           # 已实现：本地离线任务状态，不代表 GitHub 实时数据
pnpm agent:once -- --dry-run
pnpm agent:once
pnpm agent:loop             # 有界自动循环
# pnpm agent:watch          # 仅专用执行环境且确认权限后使用

# 中断/额度/网络问题：本地检查点恢复
pnpm agent:resume -- --dry-run
pnpm agent:resume
pnpm agent:say -- "继续 SOXU"

# 启动桌面应用（与 Agent Loop 独立）
pnpm tauri:dev
```

自主开发以 SOXU 本地 Web 控制台作为主要监控入口（`pnpm agent:dashboard`）；GitHub Issues/PR/Actions 记录远端协作进度，本地 `.soxu/checkpoints/` 负责诊断和恢复。PiDeck 仅用于查看已有 Pi 会话历史，不承担 Agent Loop 控制。参见 [监控手册](docs/development/monitoring.md)。

新版任务调度会读取 `priority` 和 `dependencies`：TASK-001/002 首批可运行，其余任务等待前置 PR 已合并且 Issue 已关闭。旧 v1.5 已创建的 TASK-006 可能带有 `agent:blocked` 标签，核对不是实际阻塞后才能手工修改为 `agent:waiting`；绝不自动解除人工封锁。**缺少 pnpm/Cargo 锁文件时真实 Agent 执行被阻止，`--dry-run` 可以正常预览。** 详见 [任务说明](tasks/README.md)。

`agent:status` 仅统计本地 backlog 和检查点；`agent:dashboard` 已实现本地任务看板、有限日志和显式调度控制，不查询远端 GitHub 最新状态。单独的 `agent:logs` 命令尚未实现。

## 如何指定 Agent 模型

开发调度器提供两个独立角色：**Developer** 与 **Reviewer**。**已由项目所有者批准两者都使用 `magpie / auto/deepseek-v4.1-flash`**，Thinking 不强制设置，继承 Pi 的支持情况。必须在本机确认 Magpie Provider、模型 ID、认证和额度实际可用。

```powershell
# 以下为当前已经落盘的模型选择，无需每次都设置环境变量
# pi --list-models magpie     # 验证 Pi 本机可解析时使用
# 临时覆盖仅用于经批准的特殊任务，例如：
$env:SOXU_DEVELOPER_PROVIDER = 'magpie'
$env:SOXU_DEVELOPER_MODEL = 'auto/deepseek-v4.1-flash'
pnpm agent:models
```

长期配置文件是 [`automation/agent-models.json`](automation/agent-models.json)。无需将 API Key 放在此文件；详情见 [模型配置说明](docs/development/models.md)。

## 三轨开发、产品与质量复盘（显式启动）

开发 Loop 保留既有 Issue → Worktree → Review → PR 流程。新增**显式启动、单轮、只生成本地建议**的 Product/Quality 分析，参考 Magpie 的质量反馈闭环；不在后台常驻，不自动创建 Issue、修改受保护规则或发布。

```powershell
pnpm agent:product -- --dry-run  # 离线预览，不使用模型
pnpm agent:quality -- --dry-run
pnpm agent:lessons -- --json    # 按不同日期统计复盘证据
pnpm agent:product              # 显式触发一次付费模型分析
pnpm agent:quality              # 显式触发一次付费模型分析
```

报告存放 `.soxu/advisory/`（不提交 Git），经验记录模板见 [`LESSONS.md`](LESSONS.md)。只有至少三个不同日期的同类真实证据才能**建议**晋升规范，维护者仍须审批。参见 [三轨 Loop 设计](docs/development/three-lane-agent-loop.md)。

## 自主权限及质量门禁

每个 Issue 拥有隔离 Worktree；开发角色不能主动 push/merge/tag/release，不得修改安全规则、模型治理配置或私密资料。Runner 对测试/审查后的 Git tree 做一致性校验，PR 要通过 CI 才允许自动合并。额度、网络、超时发生时优先暂停，避免无限重试与浪费。

详细规范：[`AGENTS.md`](AGENTS.md) · [开发指南](docs/development/agent-loop.md) · [代码规范](agents/policies/coding-standards.md) · [测试与完成定义](agents/policies/testing.md) · [安全规则](agents/policies/security.md)。

**警告**：开发 Agent 能调用本地命令，Runner 不是安全沙箱；请使用低权限专用账号。GitHub 模式必须先由管理员配置分支保护、认证及权限。**未在实际 Windows/Pi/GitHub 环境完成联调，不能视为正式可发布版本。**

## 界面方案

UI 已批准采用 **参考 ChatGPT 的清爽对话优先体验**（不复制其品牌、代码和资产）。当前 M0 桌面工程包含：可折叠侧栏、对话输入区、右侧 Agent 检查器、明暗切换和键盘快捷键。**本轮仅实现本地交互原型**：消息不发送给 Pi、不持久化，不提供伪造的实时运行数据。详细设计规范见 [UI/UX 基线](docs/design/gpt-inspired-ui.md)。

## 依赖锁文件与 CI 门禁

当前提交已固定一级依赖的具体版本，Node.js 最低 `>=24`，开发机可以使用 Node 26。当前执行环境无法访问 npm/Cargo Registry，也没有 Rust，因此 **`pnpm-lock.yaml` 与 `Cargo.lock` 尚未生成**。首次在已配置好的 Windows 机器完成依赖解析后，需要提交这两份锁文件，再执行 `pnpm install --frozen-lockfile`；CI 使用冻结锁文件模式，缺少锁文件时会明确失败，不会无声更新依赖。参见 [锁定与验证步骤](docs/development/approved-toolchain.md)。

## 目录与文档导航

| 路径 | 用途 |
| --- | --- |
| `apps/desktop/` | Tauri + Vue 产品界面骨架 |
| `crates/` | Rust Runtime、会话索引与资源监测模块 |
| `automation/loop/` | Agent 自主开发调度器与离线测试 |
| `agents/` + `AGENTS.md` | Agent 角色、开发/安全/测试规范与工作流 |
| `docs/product/prd.md` | 产品范围与验收指标 |
| `docs/development/models.md` | 模型选择、角色、额度与命令 |
| `docs/development/monitoring.md` | 本地 Web 控制台、pnpm、GitHub 进度监控 |
| `docs/design/` | 已审批的 UI/UX 设计基线与历史提案 |

## 已确认与仍待授权事项

所有者已确认主要依赖版本、参考 ChatGPT 的 UI/UX 方向，以及 Developer/Reviewer 使用的 Magpie 模型。**尚未授权无限额付费调用**；服务认证、费用预算、实际系统构建、签名及公开发布仍需另外核验/批准。当前一级依赖已在 manifest 固定，但锁文件还未生成，不得把它描述为已完整验收。

本项目采用仓库 `LICENSE` 所列许可证；第三方依赖与参考项目的版权需分别遵守。

### SOXU 品牌图标

已确认的品牌图标为深色圆角底、蓝青渐变 S/X 交织造型。唯一高分辨率源文件为 `apps/desktop/assets/soxu-master.png`；Web UI 使用 `apps/desktop/src/assets/soxu-{64,256}.png`。不再使用青绿色 C 形占位图或字母 S 替代品牌图标。Tauri 的 32/128/256 PNG、Windows ICO 和 macOS ICNS 不提交到 Git，运行 `pnpm icons:generate` 从源图生成。`pnpm tauri:dev`、`pnpm tauri:build` 会自动生成；直接运行 `cargo check/test` 前先执行 `pnpm icons:generate`。
