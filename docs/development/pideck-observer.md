# SOXU → PiDeck 只读任务观测

## PiDeck 支持性结论

PiDeck 0.9.x 的宿主插件支持 `network.local`、显式授权的固定回环端口和 `pideck.network.request()`。
它**不提供第三方 Pi RPC 进程的原生实时附加接口**。PiDeck 标准聊天进程仍由 PiDeck 管理；
SOXU 的 Pi 会话历史继续通过工作树对应的 Pi 原生 JSONL 文件查看。本集成只显示协调器的检查点。

## 启动（Windows PowerShell）

```powershell
cd F:\workplace\pi\SOXU
pnpm agent:observe
```

该命令**按需**在 `127.0.0.1:47321` 启动纯 GET 服务，并输出每次随机生成的临时令牌；
不要把令牌粘贴到聊天、Issue 或日志，不要提交 Git。Ctrl+C 停止。**本命令不会启动 Agent Loop。**

在 PiDeck：设置 → PiDeck 插件 → 从文件夹安装，选择
`F:\workplace\pi\SOXU\integrations\pideck\soxu-observer`。
安装后手动授权 `network.local` 的端口 `47321` 并启用；在侧栏打开「SOXU 任务观测」，
粘贴终端令牌并点击「连接 / 刷新」。每 5 秒读取一次，仅查看项目本地检查点。
无需授予 `sessions.read`、`service.local` 或其他权限。

## 契约与安全边界

- `GET http://127.0.0.1:47321/v1/tasks`
- 必需请求头：`X-SOXU-Observer-Token: <启动终端显示的临时令牌>`
- 返回：`schemaVersion`、`source`、`isLive:false`、`generatedAt`、`tasks: [{id,title,status,phase,updatedAt}]`。
- 仅接受本机 IPv4 回环 + 正确 Host；无跨域授权、无写操作、无会话内容/提示词/密钥/绝对目录路径；令牌在内存中，不落盘。
- 所有状态来自 `.soxu/checkpoints` / `tasks/`，包括 `running` 在内**均不证明真实 Pi 进程仍在运行**。
- PiDeck 宿主插件的 `network.local` 不提供 SSE/WebSocket，所以这里采用低频请求，而不是声称实现了实时 RPC 镜像。
- 此服务不记录 Developer/Reviewer 的原始 RPC 帧，不拦截 Pi，和 Agent Runner 相互独立。

## 验证

```powershell
pnpm test:loop
pnpm agent:status
```

若端口被占用，服务将报 `EADDRINUSE` 而不是更换为未授权端口。当前约定固定端口供
PiDeck 插件 manifest 精确授权。如需未来增加完整事件流，应单独设计权限、背压和脱敏策略，
而不是盲目把 Pi RPC 的 stderr、tool output 或 prompt 发给浏览器。

## English summary

PiDeck host plugins can use consented `network.local` HTTP GET, but cannot attach to a third-party Pi
stdio RPC process as a native live chat. Run `pnpm agent:observe` on demand, install the packaged
`integrations/pideck/soxu-observer` directory as a PiDeck host plugin, grant only local port 47321,
then enter the ephemeral token shown in the terminal. The plugin polls **checkpoint states only**;
inspect actual Pi messages in PiDeck's native worktree session history. All routes are read-only.
