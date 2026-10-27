# SOXU 本地 Agent 控制台

## 启动

在 Windows PowerShell 的 SOXU 项目根目录执行：

```powershell
cd F:\workplace\pi\SOXU
pnpm agent:dashboard
```

打开 **http://127.0.0.1:47321/**，从启动终端复制本次生成的临时访问令牌，粘贴到页面后点击「连接」。
控制台不自动运行 Agent；在浏览器主动点击「恢复中断任务」、「执行下一批」、「启动有界循环」
或「持续监控开发」才会触发模型请求。Ctrl+C 退出控制台时会尝试通过 IPC 通知受管 Runner 优雅中断。

### 功能

- 使用 `fetch('/api/events')` 读取经过 `X-SOXU-Control-Token` 鉴权的 SSE 事件流：Runner/日志/Agent 状态变化实时推送；每 15 秒 HTTP `/api/status` 校准，断线采用有界指数退避自动重连；浏览器隐藏时降低渲染开销。
- 协调器最多保留 500 条脱敏日志；前端默认显示最近 50 条，可选 20/50/100/200；来源过滤和自动滚动偏好保存在 `localStorage`。日志容器高度固定，查看旧日志时不会强制滚到底部。
- Dashboard 自身启动的 Developer/Reviewer 通过 Pi RPC → 有界白名单 IPC 展示等待模型、生成中、执行工具、完成/失败、工具名称以及当前状态和总耗时。阶段 Checkpoint 与实时状态分开；外部终端 Agent 只提供锁/检查点信息，不会被伪装成实时活动。
- 显式执行 `once`、`resume`、`loop`、`watch`；`watch` 必须再次确认可能的模型费用。
- 「安全停止」通过仅父子进程可用的 IPC 请求调度器 AbortController 中止任务；保留 Worktree、检查点。
- 对于从其他终端启动的 Agent，展示其本地检查点与 Worktree 锁检测，**但不能接管或停止它**。
- 不自动合并 PR、不自动发布；`automation/policy.json` 是权威来源。
- **不是 PiDeck 替代级聊天查看器**：目前展示的是协调器的日志，不含完整 Pi 模型对话或工具输出。

### 安全约束

仅监听 `127.0.0.1:47321`；访问状态/动作需要启动时生成、内存中保存的随机令牌。
页面静态资产公开但不包含状态和凭据。写入请求必须具备正确同源 `Origin`、JSON content type 和令牌；
没有 CORS、没有跨域 iframe、没有开放 TCP 访问、没有任意命令执行接口。

- 唯一允许的控制命令：`once`、`resume`、`loop`、`watch`、`stop`。
- `running` 标签来自检查点，**不能代表真实 Pi 进程已存活**；控制台对自身启动的 Runner 才提供进程级状态。
- 多个写请求或检测到其他协调器的活跃任务锁时拒绝并行启动，避免抢占工作树。
- SSE 流最多同时支持 8 个客户端，不在 URL、Cookie 或日志中传递令牌；事件只含阶段/角色/工具名/时间戳等白名单元数据。模型原文、工具参数、凭据和完整 Pi 对话不会经该通道输出。
- 令牌仅在服务器当前进程内有效。首次验证成功后，页面将令牌暂存于当前标签页的 `sessionStorage`，以便刷新后自动连接；401（例如服务端重启）会清理对应旧令牌。不会主动存入长期 `localStorage`、Cookie 或 URL；浏览器的“恢复上次会话”功能可能恢复会话存储，使用共享电脑时应特别注意。令牌不应出现在截图和工单中。
- 不暴露完整 Pi RPC event / model prompt / 凭据。协调器输出仅做有限文本脱敏，不建议在日志内输出机密。

### 恢复已有任务

如果 `pnpm agent:status` 显示已有 `running` 检查点但没有实际进程和活跃锁，
打开控制台并点击「恢复中断任务」。如果原任务仍在另一终端执行，则控制台不会抢占。
若遇到断线，先确认原执行进程已退出，再恢复；不要手工删 Worktree 或锁文件。

### 校验

```powershell
pnpm test:loop
pnpm check
```

> 控制台功能可通过 Node 测试验证，但 Windows 实机对 Pi 子进程的取消和 PiDeck 无关，
> 仍需要在本机执行一次真实 Agent 任务进行端到端确认。

## English

Run `pnpm agent:dashboard`, open `http://127.0.0.1:47321/`, and paste the fresh token displayed in the terminal.
The dashboard streams bounded logs and metadata-only agent activity over authenticated SSE, calibrates via HTTP every 15 seconds, and explicitly starts/resumes/stops only its
own coordinator subprocesses. It cannot take over independently started Pi agents. It never auto-merges
or releases and does not present raw Pi conversations. Access is loopback-only with a server-side session token
and same-origin mutation checks. After first successful login, per-tab sessionStorage retains the token across reloads;
stale tokens are cleared on HTTP 401, and restarting the server requires a new token.
