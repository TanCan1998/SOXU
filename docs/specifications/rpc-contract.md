# Pi RPC 适配契约

- 启动 `pi --mode rpc`；命令 `{"id":"...","type":"prompt","message":"..."}` 作为一行写入 stdin。
- stdout 严格按 LF 分帧，不可使用将 Unicode U+2028/U+2029 当作行分隔符的解析器；stderr 仅日志。
- `response` 的 success 代表命令接收，不代表运行结束；`data.disposition=handled` 无需等待运行结束。
- 等待 `agent_settled` 才算这一轮完全安定；`agent_end` 不能代替它。
- 处理流式输出、请求 id、取消、子进程异常退出、超时与扩展 UI；严格避免旧 `runtimeGeneration` 的事件更新新会话。
- 针对第三方扩展的审批请求默认拒绝而非自动确认；未实现的扩展 UI 必须显式警告。
