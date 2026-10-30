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
- 完整身份派生规则、错误码与恢复路径见 [会话目录与 JSONL 索引契约](session-catalog.md)；
  Git 工作树的事实、确认令牌与删除/清理路径见
  [Git 工作树服务与桌面集成](worktree-service.md)。

## 约束
- 有界缓存、后端分页、前端虚拟列表；长工具输出和图片走按需资源接口。
- Agent Manager、会话索引、Git/PTY 分 crate，禁止超级管理器。
  PTY 见 [终端服务与桌面集成](pty-terminal.md)，Git 见 [Git 工作树服务](worktree-service.md)。
- Rust 不自行管理 Pi Auth 的明文密钥；尽量使用官方 CLI/SDK 的适当通道。
- Tauri 权限最小化；不向 WebView 暴露任意 shell。
- 实现新平台前先做签名、权限、窗口与 WebView 行为兼容测试。

## Tauri 能力清单（最小化）

原生能力只在 `apps/desktop/src-tauri/capabilities/default.json` 授予，逐条评估后再加：

| 能力 | 用途 | 威胁评估 |
| --- | --- | --- |
| `core:default` | 窗口、事件、路径等基础 IPC | 不涉及任意文件读写，也不暴露 shell |
| `dialog:allow-open` | 「添加项目」时由用户挑选项目目录（`tauri-plugin-dialog`） | 只打开系统选择器、只返回用户亲自选中的路径；不授予 `dialog:allow-save`/`allow-message`/`allow-ask`，也不授予 `fs:*`。返回值仍走原有的项目登记路径守卫，选择器不绕过越界检查。 |

取消选择（返回 `null`）必须保持界面与已登记项目不变，不产生错误提示。

## ADR
参见 `docs/architecture/adr/`，首次复杂架构变化先写 ADR。
