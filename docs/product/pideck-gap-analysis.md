# PiDeck 差距调研与 SOXU 功能规划

> 调研时间：2026-10-29 · PiDeck 版本：**v0.9.8**（dev 分支，压缩包 31.5 MB / 4528 文件）
> SOXU 基线：dev `6cc0f51`（19 个 Tauri 命令 / 8 个 Vue 组件）

## 1. 调研方法

| 对象 | 方式 | 数据 |
|---|---|---|
| PiDeck | 源码结构统计 + 设计 token 提取 + 19 篇 remote 设计文档 | `src/main` 68 模块 / `src/renderer` 组件 20 组 |
| pi-gui（同类 Electron GUI） | 仓库结构 | features: conversations / follow-ups / review / scheduled-tasks / skills / worktrees / archive |
| ChatGPT | 官方设计指南 + 桌面端视觉 | 中性灰、低饱和、少边框 |
| SOXU | 源码 + PRD + limitations | 19 命令 / 8 组件 / M0–M4 里程碑 |

## 2. PiDeck v0.9.8 功能面（68 模块）

### 2.1 模块规模（文件数）

```
pi(80)      sessions(68)   remote(74)     ipc(68)      dsh(62)
config(53)  web(22)        plugins(18)    update(17)   feishu(16)
voice(15)   browser(14)    cua(13)        git(13)      extensions(12)
projects(12) pet(9)        skills(8)      terminal(8)  mcp(7)
files(7)    logging(7)     videogen(7)    agents(6)    fs(6)
selection(6) prompts(6)    resourceImport(6)           health(5)
imagegen(5) media(5)       usageStats(5)  automation(5)  rewind(4)
notifications(3)           persistence(4) wsl(4)       memory(3)
security(3) settings(3)    dataEnv(3)     localServices(3)  process(4)
acp(18)     clipboard(2)   favorites(2)   floating(2)  sessionGroups(1)
themes(1)   wallpaperEngine(1)           sidecar(1)   lifecycle(1)
announcements(1)           diagnostics(1) notices(1)   tray(2)
```

### 2.2 相对早期版本的增量（v0.9.x → v0.9.8）

| 新增/扩张 | 变化 | 说明 |
|---|---|---|
| `remote` | 0 → **74 文件 + 19 篇设计文档** | 远程开发机托管：bundle 上传、bootstrap 部署、远程项目/会话/Git 读取、host rebind 事务 |
| `web` | 18 → 22 | 外网访问（cloudflare quick tunnel / tailscale serve） |
| `browser` | 1 → **14** | 内置浏览器面板 |
| `terminal` | 3 → **8** | PTY 终端 |
| `git` | 8 → 13 | Git 面板（status/log/branch/diff） |
| `sessionGroups` | 新增 | 会话分组 |
| `favorites` | 新增 | 收藏 |
| `wallpaperEngine` | 新增 | 壁纸引擎 |
| `vision` / `promptSuggestion` / `scratchPad` | 新增 IPC | 图像理解 / 提示建议 / 草稿本 |
| `agent-market` | 二期 | 智能体市场页面化 |

### 2.3 PiDeck 设计 token（提取自 `styles/foundation.css`）

**字号阶梯**（px）
```
micro 11 · tab 11 · caption 12 · control 13 · body 14 · chat 16
input 14 · title 16 · brand 18 · heading 20 · logo 36
```
**行高**：micro 16 · caption 18 · control 20 · body 22 · chat 1.6（16px→25.6）
**字体**：base（系统栈）· mono · brand 用衬线（Plantin/Georgia）
**颜色（浅色）**
```
bg-app #ffffff    bg-sidebar #f0f0f0   bg-panel #ffffff
bg-page = mix(panel 55%, sidebar)      bg-muted #f4f4f4
bg-hover #eaeaea  bg-active #e4e4e4    text-primary #202124
```

关键观察：PiDeck 用 **纯中性灰**（无蓝调），层级靠 `color-mix` 微差而非阴影，hover/active 只差 6–10 个明度值。

## 3. SOXU 现状

### 3.1 已有能力（19 个 Tauri 命令）
```
runtime_info  list_projects  register_project  refresh_project
open_session_history  read_session_texts
list_worktrees  plan_worktree_removal  create_worktree  worktree_diff
remove_worktree  prune_worktrees
start_session  send_prompt  cancel_session  stop_session
runtime_status  retain_session_events  release_session_events
```

### 3.2 已有 UI（8 组件）
ProjectSidebar · ChatPanel · MessageList · ChatComposer · SessionTabs ·
RuntimeInspector · SettingsDialog · WorktreeDialog

### 3.3 已有依赖（Vue 栈）
```
vue 3.5.44        pinia 4.1.0        vue-router 5.4.0
@lucide/vue 1.61  reka-ui 2.11       @vueuse/core 15
@tanstack/vue-virtual 3.13           markdown-it 15
tailwindcss 4.3   cva / clsx / tailwind-merge
@tauri-apps/api 2.12  plugin-dialog
```

## 4. 差距清单（三档）

### A 档：SOXU 路线图内、未实现（必补）

| 缺失 | 依据 | 现状 |
|---|---|---|
| 资源监测 UI | PRD M2 退出条件 | `crates/resource-monitor` 已实现有测试，**界面无入口** |
| Git Diff 查看器 | PRD M3 | 只有 `worktree_diff` 命令 |
| PTY 终端 | PRD M3 | 完全缺失 |
| Skills/Extensions 只读 UI | PRD M3 | 完全缺失（PRD 说不重做，只需查看/开关） |
| 打包签名/公证/自动更新 | PRD M4 | 只有 `tauri:build` |
| P-01/P-03/P-04/P-05 实机复现 | PRD M2 退出条件 | 有单测，缺实机证据 |
| 临时会话转正 | `limitations.md` | 硬失败 `E_TEMPORARY_SESSION_UNPROMOTABLE` |

### B 档：PiDeck 有、符合 SOXU 定位（建议补）

**会话层**
| 能力 | PiDeck 模块 | SOXU |
|---|---|---|
| 会话分组 | `sessionGroups` | 无 |
| 收藏 | `favorites` | 无 |
| 全局命令面板 | — | 规划文档已写，未实现 |
| 会话内搜索/跳转 | `ConversationNavigator` | 只有侧栏标题搜索 |
| Rewind 回退 | `rewind`(4) | 无 |
| 消息操作（复制/重试/编辑） | `replyactions` | 无 |
| 快捷消息 / 提示词模板 | `quickmessages`、`prompts`(6) | 无 |
| 提示建议 | `promptSuggestionIpc` | 无 |
| 草稿本 | `scratchPadIpc` | 无 |
| 会话导出 | `sessions`(68) | 无 |
| 用量统计 | `usageStats`(5) | 只有重试预算 |

**开发能力**
| 能力 | PiDeck | SOXU |
|---|---|---|
| 文件树 / 预览 | `files`(7)、`fs`(6) | 无 |
| 外部编辑器 | `editors` | 无 |
| Git 面板 | `git`(13) | 只有 worktree |
| 终端 | `terminal`(8) | 无 |
| 内置浏览器 | `browser`(14) | 无 |

**系统**
| 能力 | PiDeck | SOXU |
|---|---|---|
| 自动更新 | `update`(17) | 无 |
| 通知 | `notifications`(3) | 只有托盘隐藏 |
| 健康/诊断页 | `health`(5)、`diagnostics` | 只有 `agent:doctor` CLI |
| 数据备份 | `backupIpc` | 无 |
| 自定义主题 | `themes` | 字体字号刚做，主题未做 |
| 壁纸引擎 | `wallpaperEngine` | 无 |
| WSL | `wsl`(4) | 无 |
| 划词/选中 | `selection`(6) | 无 |
| 剪贴板/文件粘贴 | `clipboard`、`pasteFilesIpc` | 无 |
| MCP 配置 UI | `mcp`(7) | 无 |
| 图像理解 | `visionIpc` | 无 |

**远程（M5 级方向）**
| 能力 | PiDeck | SOXU |
|---|---|---|
| 远程开发机托管 | `remote`(74) | 无 |
| 外网访问 | `web`(22) | 无 |

### C 档：超出 SOXU 定位（不做）

PRD §5 非目标：不重做 Pi 的模型路由/认证/工具/Skills/Extensions/推理核心；不为炫技引入常驻后台进程。

图像生成、视频生成、语音、飞书/微信、桌面宠物、插件系统、公告、悬浮窗、音效、云同步、遥测。

> `remote` / `web` 不属于"炫技"，但要求改 supervisor 进程模型，列为 M5 方向决策，不进当前批次。

## 5. 本批次 8 项任务（已确认全做）

按依赖与价值排序：

| # | 任务 | 档位 | 依赖 |
|---|---|---|---|
| 1 | 资源监测 UI | A | 后端已就绪 |
| 2 | Git Diff 查看器 | A | `worktree_diff` 已就绪 |
| 3 | 会话分组 + 收藏 | B | 无 |
| 4 | 通知 + 自动更新 | B | Tauri 插件 |
| 5 | 临时会话转正 | A | 需文件选择入口 |
| 6 | PTY 终端 | A | 需 Rust PTY |
| 7 | 命令面板 + 会话内搜索 | B | 现有依赖即可 |
| 8 | Skills/Extensions 只读 UI | A | 需读 Pi 扩展目录 |

## 6. 依赖增补建议

| 用途 | 现有 | 建议 | 理由 |
|---|---|---|---|
| 虚拟列表 | @tanstack/vue-virtual | 保持 | 已够用 |
| Markdown | markdown-it | 保持 | 已够用 |
| **代码高亮** | 无 | **加 shiki** | markdown-it 无高亮；PiDeck 也用 shiki |
| **终端** | 无 | **加 @xterm/xterm + Rust portable-pty** | 前端 xterm，PTY 在 Rust 侧 |
| 命令面板 | reka-ui Dialog | 保持 | 够用 |
| 动效 | 无 | **加 motion-v**（可选） | 声明式 spring；也可纯 CSS |
| Toast | 无 | 用 reka-ui Toast | 已含，无需新依赖 |
| 自动更新 | 无 | **tauri-plugin-updater** | 官方 |
| 通知 | 无 | **tauri-plugin-notification** | 官方 |
| 代码编辑器 | 无 | CodeMirror 6（可选） | Diff 查看用得上 |

## 7. 参考要点

- **PiDeck**：三栏骨架（侧栏 / 会话 / 检查器）、中性灰层级、11–16px 字号阶梯、`color-mix` 做层次
- **pi-gui**：follow-ups（追问建议）、review（内联审查）、scheduled-tasks（定时任务）、archive（归档）
- **ChatGPT**：低饱和中性灰、少边框、圆角克制、动效短促（150–250ms）
- **Cursor/Claude Code**：命令面板优先、键盘可达、Diff 内联在会话流里

## 8. 结论

SOXU 的后端能力（19 命令 + worktree + RPC supervisor）已覆盖 A 档的 2/7；
**差距主要在界面层**。本批次 8 项里，1/2/5 是"补界面"，3/7 是"补会话组织"，
4 是"补桌面基建"，6/8 需要新的 Rust 能力。
