# Pi Agent 模型与额度治理

- **仅 Pi Agent 负责调用模型**，SOXU 不实现第二套认证或转发层；模型选择通过 `automation/agent-models.json` 和受支持的环境变量控制。
- Developer 和 Reviewer 是**独立 Pi RPC 进程**，可以指定不同 Provider/Model；两者模型相同不等于审查不独立，后者仍必须只读并返回结构化审批结论。
- 配置文件**不得包含 API Key、Bearer Token、登录 Cookie 或个人凭据**。认证由 Pi 用户环境/官方登录渠道管理。不要在 Issue、PR 日志或 Agent 输出中回显密钥。
- **已批准模型**：Developer 与 Reviewer 都使用 `magpie` Provider、`auto/deepseek-v4.1-flash` Model；两者独立 RPC 进程，但共享模型本身不等于完全独立意见。`thinking=null` 表示继承 Pi。配置读取仍支持 `null` 兼容模式，但当前仓库不是 `null`。需在 Pi 本机验证该模型和额度，不能把批准模型选择等同于授予无限付费权限。
- `pnpm agent:models` 仅显示有效路由，不触发付费请求；`pnpm agent:doctor` 做环境探测。实际可用模型仍以本机 Pi `pi --list-models` 和认证状况为准。
- 缺少 Provider/Model 任一字段、非法思考等级、疑似 shell 注入的模型名必须拒绝，不能自动回退到另一个收费模型。
- 429、无额度、支付失败、网络超时：保存检查点，退出等待人工恢复，不进行自动无限付费重试。
- 配置修改进入正常 PR/Review；本地临时选择可用环境变量覆盖，避免在仓库留下个人账户配置。
