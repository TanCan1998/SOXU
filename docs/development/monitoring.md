# 使用 SOXU 本地 Dashboard + pnpm + GitHub 监控开发

SOXU 当前处于自主开发阶段。SOXU 自带的本地 Web 控制台用于 Agent Loop 调度与阶段监控，不依赖 PiDeck。

## 启动

```powershell
cd D:\Projects\SOXU     # 示例目录，按实际位置替换
pnpm install              # 首次联网时生成锁文件，之后应改用 --frozen-lockfile
pnpm agent:models         # 确认 Magpie 模型，不调用模型
pnpm agent:dashboard      # 启动本地 Web 控制台，需手工输入访问令牌
pnpm agent:status         # 本地任务与检查点概览（不查询 GitHub）
pnpm agent:doctor         # 检查工具链和暂停任务
pnpm agent:once -- --dry-run
pnpm agent:once           # 人工确认后执行一批
pnpm agent:loop           # 有界多轮开发
# pnpm agent:watch        # 仅专用执行环境、授权 GitHub 后运行
```

产品 UI 开发预览使用 `pnpm tauri:dev`；它只启动桌面应用，不会自动启动 Agent 开发调度器。停止后 `pnpm agent:resume -- --dry-run` 预览，再 `pnpm agent:resume` 继续。

## 三层监控

1. **SOXU 本地 Web Dashboard**：`pnpm agent:dashboard`，浏览器打开 `http://127.0.0.1:47321/`，输入本次启动终端显示的随机令牌。可查看 checkpoint 进度、最近日志，手动执行/恢复/停止控制台启动的任务。不接管其他终端的 Pi 子进程。
2. **GitHub**：Issues/PR/Actions 是协作真相来源。使用 `gh issue list --label agent:ready`、`gh pr list`、`gh run list --limit 10` 查看远端进度；Dashboard 目前不直接拉取远端状态。
3. **本地检查点**：`.soxu/checkpoints/` 保存阶段、Worktree、测试证据、暂停/阻塞原因；`pnpm agent:doctor` 可列出恢复候选。目录不可提交 Git。PiDeck 可选用于查看原生 Pi 会话历史。

**当前已实现**：`pnpm agent:status`，离线汇总本地 backlog、已归档任务和检查点；`-- --json` 返回机器可读快照，不读取 GitHub 或真实 Pi。

**已实现**：`pnpm agent:dashboard` 的任务状态、有限 stdout/stderr 日志和显式控制。**未实现**：独立的 `pnpm agent:logs` 命令，以及跨终端 Pi 会话全文、模型成本、远端 CI 实时聚合；不得将 checkpoint `running` 解释为实际 Pi 心跳。详见 [Dashboard 说明](dashboard.md)。

进度统计和错误日志要遵守 [`observability.md`](../../agents/policies/observability.md)，不泄漏 token、完整凭据或敏感会话内容。


## 产品/质量 Loop 本地建议（显式触发）

运行 `pnpm agent:product -- --dry-run` 和 `pnpm agent:quality -- --dry-run` 预览要分析的证据；仅明确运行非 dry-run 命令才请求模型。结果位于 `.soxu/advisory/product/`、`.soxu/advisory/quality/`，不显示成 GitHub 或 CI 已完成状态。`pnpm agent:lessons` 无模型调用，只检查核实后的跨日经验是否满足**建议晋升**阈值。详见 [`three-lane-agent-loop.md`](three-lane-agent-loop.md)。
