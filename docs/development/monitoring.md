# 使用 PiDeck + pnpm + GitHub 监控 SOXU 开发

SOXU 正式项目还未启动；以下为引导工程的已实现入口和未来计划功能。

## 启动

```powershell
cd D:\Projects\SOXU     # 示例目录，按实际位置替换
pnpm install              # 首次联网时生成锁文件，之后应改用 --frozen-lockfile
pnpm agent:models         # 确认 Magpie 模型，不调用模型
pnpm agent:status         # 本地任务与检查点概览（不查询 GitHub）
pnpm agent:doctor         # 检查工具链和暂停任务
pnpm agent:once -- --dry-run
pnpm agent:once           # 人工确认后执行一批
pnpm agent:loop           # 有界多轮开发
# pnpm agent:watch        # 仅专用执行环境、授权 GitHub 后运行
```

产品 UI 开发预览使用 `pnpm tauri:dev`；它只启动桌面应用，不会自动启动 Agent 开发调度器。停止后 `pnpm agent:resume -- --dry-run` 预览，再 `pnpm agent:resume` 继续。

## 三层监控

1. **PiDeck**：交互式 Pi Agent 会话、手动介入与日志；在其终端执行 `pnpm agent:loop` 可以看到 Runner stdout。PiDeck 能否实时接入独立启动的 Runner 子进程仍需实测。
2. **GitHub**：Issues/PR/Actions 是协作真相来源。可用 `gh issue list --label agent:ready`、`gh pr list`、`gh run list --limit 10` 查看进度。
3. **本地状态**：`.soxu/checkpoints/` 保存阶段、Worktree、测试证据、暂停/阻塞原因；可以用 `pnpm agent:doctor` 查看恢复候选。该目录不能提交到 Git。

**当前已实现**：`pnpm agent:status`，离线汇总本地 backlog、已归档任务和检查点；`-- --json` 返回机器可读快照，不读取 GitHub 或真实 Pi。

**计划项（尚未实现）**：`pnpm agent:logs`、`pnpm agent:dashboard`，后续统一展示里程碑完成率、活跃 Agent、模型成本、Worktree 与 CI。

进度统计和错误日志要遵守 [`observability.md`](../../agents/policies/observability.md)，不泄漏 token、完整凭据或敏感会话内容。
