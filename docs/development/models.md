# SOXU 中 Pi Agent 模型选择（Windows / PiDeck）

> **SOXU 开发调度器**的 Developer/Reviewer 模型，与**最终桌面产品**中终端用户在 Pi 配置的模型是两回事。项目不要求单一服务商；所有付费 Provider、额度和预算由用户自行授权。

## 1. 已批准的开发模型（优先）

在 `automation/agent-models.json` 中，两种角色均配置 `provider=magpie`、`model=auto/deepseek-v4.1-flash`，`thinking=null`。检查命令：`node ../soxu-agent-loop/automation/loop/src/cli.mjs models`（不会调用付费模型）。请用 Pi 本机的模型列表核实该 Provider 和模型，确保 Magpie 服务认证、余额、网络可用；**没有完成本机验证前不启动无人值守开发**。

## 2. 可选方式：继承 Pi

在 PiDeck 中打开 Pi 会话，通过 `/model` 选择模型。Pi 通常在用户设置 `~/.pi/agent/settings.json` 或项目 `.pi/settings.json` 中管理默认 Provider/Model；运行时 Pi 的 `--provider`、`--model` 参数优先级更高。**不要假定 PiDeck 某个会话内切换模型后，独立调度器就同步了该会话设置**。

只有当所有者将角色 Provider/Model 两个字段**同时**设为 `null` 时才不传 CLI 模型参数，继承 Pi 自身的有效默认配置。当前工程已固定 Magpie 模型。`node ../soxu-agent-loop/automation/loop/src/cli.mjs models` 可以查看本项目正在使用的路由策略（不表示凭据或远程服务已通过验证）。

## 3. 按角色固定（已配置）

编辑 `automation/agent-models.json`：

```json
{
  "schemaVersion": 1,
  "roles": {
    "developer": { "provider": "magpie", "model": "auto/deepseek-v4.1-flash", "thinking": null },
    "reviewer": { "provider": "magpie", "model": "auto/deepseek-v4.1-flash", "thinking": null }
  }
}
```

这是用户指定并批准的真实配置字符串，但尚未在本机 Pi 验证它们是否受当前账户支持。请先通过 `pi --list-models` 查看安装的 Pi 支持的 ID。Provider + Model 必须同时填写；均为 `null` 才继承默认值。`thinking` 可选：`off / minimal / low / medium / high / xhigh`，应按具体模型支持范围选择。

对应启动行为：Developer 使用 `pi --mode rpc --no-session --provider <provider> --model <model> --thinking ...`；Reviewer 独立启动同类型只读审查任务，使用自己配置的模型。

## 4. 不改仓库，PowerShell 临时覆盖

```powershell
$env:SOXU_DEVELOPER_PROVIDER = 'magpie'
$env:SOXU_DEVELOPER_MODEL = 'auto/deepseek-v4.1-flash'
$env:SOXU_REVIEWER_PROVIDER = 'magpie'
$env:SOXU_REVIEWER_MODEL = 'auto/deepseek-v4.1-flash'

node ../soxu-agent-loop/automation/loop/src/cli.mjs models                # 零模型调用，只检查解析后的配置
node ../soxu-agent-loop/automation/loop/src/cli.mjs doctor                # 检查工具安装
node ../soxu-agent-loop/automation/loop/src/cli.mjs once -- --dry-run      # 预览领取任务
node ../soxu-agent-loop/automation/loop/src/cli.mjs once                  # 只有在确认额度/认证/权限后才运行
```

关闭 PowerShell 后该会话环境变量消失。需要恢复继承配置时执行 `Remove-Item Env:SOXU_DEVELOPER_MODEL` 等六个变量，或启动新终端。**不要在脚本、README、Git 仓库保存密钥**；Pi 认证应按官方登录和本机凭据管理办法设置。调度器会隔离部分外部密钥环境变量，因此依赖裸环境 API Key 的供应商应先验证 Pi 本机登录是否可用。

## 5. 模型兼容与安全

- Pi 模型 ID 可能随供应商变动，**先用已安装 Pi CLI 的 `--list-models`** 查实际 ID。
- 已开启任务的模型不会自动随着 PiDeck 中另一会话的选择而切换。
- Runner 对角色模型参数做有限字符集校验，避免 Windows `cmd.exe` 调用时的命令注入。
- 额度错误或网络失败会暂停当前任务、保留 Worktree；人工执行 `node ../soxu-agent-loop/automation/loop/src/cli.mjs resume` 再恢复。
- 模型选择与预算必须经用户确认，不自动选更贵的备选服务商。

参考：[Pi CLI 用法](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent)；[Pi Settings](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/settings.md)；[自定义模型](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/models.md)。
