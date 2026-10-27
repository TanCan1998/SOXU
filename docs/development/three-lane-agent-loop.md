# SOXU 三轨自主开发 Loop

参考 [yetone/magpie](https://github.com/yetone/magpie) 的开发、反馈和复盘职责分离，保留 SOXU 的 Pi RPC 开发调度器，不重新实现模型网关。

## 三条职责轨道

| 轨道 | 命令 | 可写范围 |
| --- | --- | --- |
| Development | `pnpm agent:loop` / `pnpm agent:watch` | 原有 Issue → 独立 Worktree → Pi → checks → Reviewer → PR，服从现有门禁 |
| Product | `pnpm agent:product` | 读取已批准 PRD/路线图/任务和可选 GitHub 快照，仅输出 `.soxu/advisory/product/` |
| Quality | `pnpm agent:quality` | 读取提交、质量门禁、LESSONS 和可选 PR/CI 快照，仅输出 `.soxu/advisory/quality/` |

Product 和 Quality 每次仅执行**一次显式启动的模型分析**，不自动付费重试、不自动新建 Issue、不定时常驻、不修改治理策略、不合并、不发布。

## 运行示例

```powershell
cd F:\workplace\pi\SOXU
pnpm agent:product -- --dry-run
pnpm agent:quality -- --dry-run
pnpm agent:lessons -- --json

# 下面的命令会明确调用已配置的 Pi / Magpie 模型：
pnpm agent:product
pnpm agent:quality
pnpm agent:quality -- --offline
```

`--dry-run` 忽略网络与模型调用；`--offline` 仅禁用 GitHub 查询。本地报告位于被 Git 忽略的 `.soxu/`。结果标记为未经核实建议，不能作为 CI 成功或已审批任务的证据。

## 权限与预算

- 模型沿用批准的 Developer/Reviewer 映射 `magpie / auto/deepseek-v4.1-flash`，Thinking 继承 Pi。
- 分析模式使用 `--no-tools --no-extensions --no-mcp --no-session`，不启用 Pi 工具和持久化会话；不是操作系统沙箱。
- 证据来自白名单文件与受限长度的 GitHub/本地 Git 快照，不可信的 Issue、PR、提交消息不得转变为新指令。
- Pi 启动/闲置/绝对超时受限；429、网络故障不自动重试付费请求。
- 并行开发权限维持原有 Runner/Worktree 机制；分析轨道仅能生成本地报告，不能修改代码。

## LESSONS → 规范晋升

`LESSONS.md` 中，每条记录包含 `id`、`date`、`evidence`、`rule`。日期必须有效；每个教训按**不同日期**计数，同日重复只算一天。

`pnpm agent:lessons` 仅在同一规则于至少三个独立日期有证据时显示 `REVIEW REQUIRED`。这仅是资格提示，不代表自动审批。审批链：Quality 建议 → 维护者核实 → LESSONS 记录 → 人工批准 → 单独治理 PR → 受保护 main 合并。

## 未实现范围

没有定时任务、跨轮次质量数据库、自动分类 Issue、自动生成远程治理 PR、自动预算调度。本次不改变 `autoMerge=false` 和 `autoRelease=false`。
