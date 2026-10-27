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

- 2.5 秒轮询本地任务检查点，显示每项任务的状态/阶段/更新时间、活跃调度命令、完成退出码。
- 显示最多 100 条 Runner 协调器日志（最多保留 160 条缓冲，常见令牌文本会脱敏）。
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
The dashboard polls checkpoints, shows bounded runner logs and explicitly starts/resumes/stops only its
own coordinator subprocesses. It cannot take over independently started Pi agents. It never auto-merges
or releases and does not present raw Pi conversations. Access is loopback-only with a server-side session token
and same-origin mutation checks. After first successful login, per-tab sessionStorage retains the token across reloads;
stale tokens are cleared on HTTP 401, and restarting the server requires a new token.
