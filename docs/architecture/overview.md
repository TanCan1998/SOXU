# 架构总览

```
Vue 3 + TS (window, sidebar, tabs, timeline, composer)
         ⇅ Tauri Commands / Channel
Rust Tauri Adapter → Runtime Supervisor → Pi CLI RPC (stdio NDJSON)
                   → Session Index (read-only JSONL offsets)
                   → Git Service / PTY / Process Monitor
Pi native settings/auth/session files remain Pi-owned.
```

## 身份与状态
- `ProjectId`：项目目录逻辑身份；`WorktreeId`：分支工作树。
- `SessionId`：跨重启稳定；`RuntimeId`：单次 Pi 进程；`RuntimeGeneration`：递增计数，防止过期事件污染。
- `PaneId`：UI 显示区域，多个 Pane 可观察不同 Session，Pane 销毁不等于停止 Agent。
- 同一 Pi JSONL 仅允许一个可写的运行时所有者，其他视图只读。
- 完整身份派生规则、错误码与恢复路径见 [会话目录与 JSONL 索引契约](session-catalog.md)。

## 约束
- 有界缓存、后端分页、前端虚拟列表；长工具输出和图片走按需资源接口。
- Agent Manager、会话索引、Git/PTY 分 crate，禁止超级管理器。
- Rust 不自行管理 Pi Auth 的明文密钥；尽量使用官方 CLI/SDK 的适当通道。
- Tauri 权限最小化；不向 WebView 暴露任意 shell。
- 实现新平台前先做签名、权限、窗口与 WebView 行为兼容测试。

## ADR
参见 `docs/architecture/adr/`，首次复杂架构变化先写 ADR。
