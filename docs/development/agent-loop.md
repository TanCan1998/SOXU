# SOXU 自主开发 Loop 操作手册

## 启动前

1. 使用专用 Windows 账户/隔离开发机，安装 Node >=24、pnpm 12.15.0（已批准，需安装/生成锁文件）、Rust、Tauri 开发依赖、Pi CLI 和 GitHub CLI；`pi` 必须能够使用已授权的模型。
2. `pnpm install --lockfile-only`、`cargo generate-lockfile` 生成并提交两份锁文件，再运行 `pnpm install --frozen-lockfile` 和 `node scripts/init-git.mjs`（不会覆盖已有 Git 仓库）。没有锁文件时，付费任务批次会提前拒绝启动；`--dry-run` 仍可预览。
3. GitHub 新建 SOXU 仓库，创建 `main`；本机 `node scripts/set-remotes.mjs https://github.com/OWNER/SOXU.git`，再 `git push -u origin main`。
4. GitHub 设置 main branch protection：要求 PR、必过 `quality` 检查、禁止强制推送与删除；允许 auto-merge。**首次上线须手工核验有效保护，不能依赖 Agent 自己开启。**
5. `gh auth login`、`pi --version`、`pnpm agent:models`，启动 `pnpm agent:doctor`；设置最低权限的远程认证，不能将 PAT 放到 Issue 或 `.env` 里。
6. `pnpm agent:seed` 创建初始化 Issues；无依赖任务标记 `agent:ready`，有依赖的标记 `agent:waiting`。`agent:blocked` 为人工/故障封锁，不会自行解除。升级自 v1.5 的 TASK-006 可能有旧默认 blocked 标签，需人工核对后改为 waiting。
7. `pnpm agent:once -- --dry-run` 检查队列；`pnpm agent:once` 执行一批；`pnpm agent:loop` 执行 policy 限制的最多 5 轮，不是无保护无限循环。需要持续运行时可显式启动 `pnpm agent:watch`：每 10 分钟轮询，单次最多 8 小时/12 个任务，遇阻塞自动退出；由 OS 任务调度器在授权环境中重启下一轮。运行中按 Ctrl+C 停止。

## 核心算法

GitHub Issues（TASK ID 依赖已满足、`agent:ready` 或可提升的 `agent:waiting`）→ `agent:in-progress` → 为每个 issue 建独立 Git Worktree → 启动 Pi CLI RPC Developer（stdin JSONL） → 根据 `agent_settled` 结束 → 文件路径/密钥/变更量守卫 → Node/Rust checks → 另启 Pi RPC Reviewer → 不通过则至多 retry → commit → GitHub PR → 自动请求合并（仍由主分支的 GitHub Actions 必要检查决定） → Issue 随带有 `Closes #Issue号` 的 PR 合并自动关闭。

**依赖释放规则（v1.5.1）**：调度器从 `tasks/backlog` / `tasks/done` 读取严格的 `priority` 和 `dependencies`，依 TASK ID 解析而不是取 GitHub Issue Number。必须同时看到前置 Issue `CLOSED`，以及目标 `main` 分支的已合并 PR 正文中 `Closes #前置Issue号`，才让下游任务启动；只创建 PR 或人工关闭 Issue 均不满足。旧版错误赋予下游的 `agent:ready` 会降级为 `agent:waiting`。如果历史已合并 PR 超出查询范围，按未完成处理并需人工核实（安全优先）。

**注意：** `git` 锁文件 `.soxu/locks` 防止同任务在本机重复领取。Runner 崩溃后可能保留锁和 Worktree，必须检查 PR/HEAD/目录再清理锁；不要盲删。该锁不跨机器分布式生效，因此只允许一台 Coordinator 执行同仓库任务。Worktree 与主仓库同级。


### Worktree 与最新 main 的同步

已有 Worktree 不会自动接收后续合并到 `main` 的提交。`pnpm agent:resume` 会在模型调用前检查并安全快进所选任务；如存在未提交任务成果或其他风险，则保留检查点并跳过该任务，不能自动合并。也可以执行：

```powershell
git fetch origin main
pnpm agent:worktrees            # 查看各任务落后、工作树修改和活动锁
pnpm agent:worktrees -- --sync  # 只安全更新干净的早期任务
```

`--sync` 会对**没有活动锁、处于 worktree/install/develop/checks/review/finalChecks 阶段且可快进**的工作树更新最新 main。对于未提交修改，先用 Git stash（包含未跟踪文件）生成可恢复备份，再快进和恢复变更；有冲突时记录 `mergeConflict` 与 stash SHA，保留原任务代码，由 `pnpm agent:resume` 调用 Developer 自行分析最新 main、解决冲突，经依赖安装、测试、Reviewer 审查后继续。不会自动丢弃 stash、`reset --hard` 或跳过质量门禁。历史分叉、受保护操作、活动锁及备份异常会安全暂停。不自动消耗模型额度重试超过 policy 的限制；本命令本身不调用模型。

### 超时与手动恢复

所有任务均有启动、连续无进展和绝对总时长三类超时保护。出现额度不足、网络中断、超时后，不做自动付费 API 重试；Git Worktree 与当前阶段保存在 `.soxu/checkpoints/`。**只需说“继续 SOXU”或运行 `pnpm agent:resume`**；不需要手动清理 Issue/Worktree。详情参见 `docs/development/timeouts-and-recovery.md`。

### 本地开发模式

`node automation/loop/src/cli.mjs once --local --dry-run` 或 `... once --local`，源自本地 TASK 定义；本地模式只创建独立分支和提交，不进行远程 PR/合并。**后继任务必须等前置任务的具体提交合入本地 `main` 才能运行**，仅有 done checkpoint 不足以解锁；Runner 不自动合并，避免误合并脏 Worktree。执行模式仍要先生成锁文件并安装依赖。

### 一句话恢复

当额度或网络问题解决后，直接在工作目录运行 `pnpm agent:say -- "继续 SOXU"`。它会离线解析指令并优先选择**最后一个暂停**的任务。`--dry-run` 只列出将要恢复的检查点，不调用模型；“恢复所有暂停的任务”必须由用户明确说出才会批量执行。GitHub 与本地模式从检查点自动判断。详见 `.pi/skills/soxu-recover/SKILL.md`。

对于 `blocked`，先人工检查并修复原因，可在 WebUI 的任务列表中选择“恢复此任务”，也可以用 `pnpm agent:resume -- --blocked --issue 123 --dry-run` 预览，去掉 `--dry-run` 执行。同步 main 后会重新执行检查和审查；不会跳过密钥检测。

### 恢复、停机、失败

- 额度/网络/超时：Issue 可达时转 `agent:paused`，本地检查点与 Worktree 保留；使用 `pnpm agent:resume` 按阶段恢复。其他失败转 `agent:blocked`，不得绕过测试或规则。
- 运行时可以 `Ctrl+C` 中断 Runner；中断期间可能保留 Pi 子进程或编译进程，需在隔离环境检查并结束；不能直接删除可能有未提交改动的 Worktree。
- 任何权限/密钥/工具链缺失导致检查无法运行，都属于失败，不得绕过。
- 当前版本对 Pi 和 pnpm/Cargo 的子进程树执行终止与超时保护，但**尚未经过 Windows 实机完整验证，也没有多主机协调**。

## 自动发布

`automation/policy.json` 初始允许 prerelease。把版本号同步到 root package.json、`apps/desktop/package.json`、`tauri.conf.json` 和 Cargo 清单，合并到 main，GitHub main 最新 CI 必须 success。随后受权限约束的 Runner/Release Agent 可调用 `node scripts/release.mjs 0.x.y`；脚本检查干净工作树、main、origin/main、CI 和版本，然后创建推送 tag。GitHub `.github/workflows/release.yml` 监听 tag 建立安装包与 prerelease。

**自治发布入口**：GitHub 创建 Issue 并加 `agent:release` 标签，正文必须单独一行 `version: 0.x.y`。本地 Loop 每轮检查 Release Issues，只有受保护 main 同步、三个版本号一致、对应 CI 已成功且策略允许，才由 Runner 自动打并推 Tag，随后关闭 Release Issue。版本和验收条件均不满足则保持 Issue 开放等待下一轮。Agent 的开发角色不能直接给自己授予 release 标签；这是独立的发布授权规则。

**声明**：这不是生产签名与供应链安全的完整解决方案；Windows 签名、macOS notarization、包管理平台发布均需单独凭据与硬化。跨平台 workflow 必须在仓库实际开启并验证。

## 镜像

GitHub 为唯一写入源，AtomGit 主要用作中国大陆克隆加速。优先在 AtomGit 仓库设置 GitHub → AtomGit Pull Mirror（官方管理页面）；备选将 `atomgit` 作为远程，运行 `pnpm mirror:atomgit` 推 main 和 tags。脚本不执行 force push，不同步未合并临时分支。

**注意**：镜像只加速源码 Git 获取，不自动加速 npm/Cargo 依赖，也不保证 GitHub Release 安装包镜像可下载。镜像时效以 AtomGit 状态为准。


## Pi 模型分配与项目目标

本工程的 Developer 和 Reviewer 可在 `automation/agent-models.json` 使用不同 Pi Provider/Model，或保持 `null` 继承 Pi 默认。`pnpm agent:models` 仅显示路由而不调用模型。详见 [模型选择手册](models.md)。PiDeck 仅作为开发监控工具；独立启动的 Pi 会话能否在 PiDeck 实时附加需实测。进度以 GitHub Issue/PR/CI 和本地检查点为准，详见 [监控手册](monitoring.md)。

M0～M4 和可量化 P-01～P-08 标准见 [PRD](../product/prd.md)。新项目尚未完成，UI/UX 与依赖版本须单独获得所有者批准。


## 三轨 Loop / Magpie 开发机制借鉴

现有开发 Loop 不变；另外两个自愿启动的 Product/Quality 轨道分别产生未核实的建议报告。其只读 Pi RPC 参数、证据输入、成本边界、复盘/晋升审批规则见 [`three-lane-agent-loop.md`](three-lane-agent-loop.md)。`autoMerge=false` 与 `autoRelease=false` 仍然生效，不能把上面的理论性自动合并描述当成当前已启用能力。

WebUI 每 60 秒在后台只读查询 GitHub Issue 与 PR 检查状态，展示 PR 是否待合并、CI 状态和未满足的依赖；本地执行结束不代表代码已合并。查询依赖 `gh` 登录及网络；不可用时页面标记 GitHub 状态未知，调度判断仍由原有队列逻辑负责。

WebUI 支持点击任务 PR 标题打开 GitHub，并在检查通过后显式合并并删除对应远程分支；服务端重新核对目标分支、PR 头、检查和审查状态，以租约保护远程分支，不删除本机 worktree。自动合并开关仅影响本次 WebUI 会话中后续启动的任务，默认关闭；仍要求原有分支保护检查，GitHub 拒绝或不支持自动合并时不会绕过门禁。重启后关闭；关闭开关不会取消此前已经提交给 GitHub 的自动合并请求，也不会替既有 PR 自动发起合并。自动合并不执行本地分支删除。

本地控制台采用 V3 深浅色主题，并在浏览器保存选择。整体路线图展示 M0～M4，按 Issue 的 GitHub 里程碑、明确的 `[M0]`～`[M4]` 标题或 backlog 前置元数据动态归类。显示已归类任务合入数量和实时运行/暂停状态，不等同阶段验收；GitHub 不可用、结果达上限或没有归类时显示待核实。新增需求可在确认提交前选择归属；未归类的需求会单独计数。

需求弹窗可显式启动一次只读 Pi 评估，显示可行性、安排、依赖和验收建议，评估不会创建 Issue。确认后创建带评估内容的 GitHub Issue；默认标记 `agent:blocked` 等待人工核对，用户勾选已核实前置依赖后可标记 `agent:ready`。评估不会自动重试；结果仅保存在运行中的控制台内，控制台重启会丢失未提交的草稿。提交报错可能已经创建 Issue；提交锁定会保留到重启后，必须先核对 GitHub，再由用户手动解除锁定。

控制台以只读卡片展示三轨职责、产品和质量建议报告的本地数量与更新时间，以及 LESSONS 的申请资格数量；报告存在不代表轨道正在运行。可从 Product 或 Quality 的独立弹窗手动启动一次分析并查看最近报告；启动前提示模型费用，同一时刻只允许运行一个分析轨道，不自动重试、修改规则或发起发布。报告仍须人工核实。

WebUI 通过 Pi 的 `--list-models` 显式读取可用模型（不代表每次调用均可成功），可按 provider 展开、搜索和置顶，分别设置全局与角色池。配置保存在被 Git 忽略的 `.soxu/model-settings.json`，不保存认证信息；默认沿用已审批的配置。Developer/Reviewer 的环境变量仍优先。开发任务以 Issue 编号取模从有序池中选择，并将结果保存在检查点，恢复、复审及重试不因配置变化而换模型；旧版检查点没有模型记录时无法还原历史选择，恢复时会警告并将当前显式配置固定于检查点；产品、质量和需求评估在本次控制台会话内按启动顺序轮换，重启后从首项开始。模型不可用时报告错误，不自动切换或重试付费调用。页面分区切换不重新加载，不停止当前任务。

普通质量检查命令非零退出时，Runner 保留有界、脱敏的 stdout/stderr 诊断，并在 `maxRetries` 限额内交由 Developer 修复后重跑检查与 Reviewer；网络、额度、超时和保护路径/密钥门禁不触发自动修复或付费重试。
