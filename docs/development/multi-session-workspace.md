# 多会话工作区（TASK-003）

本文件描述 `apps/desktop` 多项目、多会话工作区的**已实现行为**。它只记录本仓库当前代码
真正做的事；未验证的部分单列在「未验证与已知限制」，不写成已完成。

对应任务：[TASK-003](../../tasks/backlog/TASK-003.md)。依赖 [Pi RPC Supervisor](agent-runtime.md)
与 [会话目录契约](../architecture/session-catalog.md)。

## 1. 范围与非目标

范围内：

- 项目导航（登记目录、扫描真实 Pi 会话、手动刷新）、会话 Tab、历史分页、完整正文按需加载、
  Pi RPC 流式追加、取消当前轮次、停止运行时。
- Rust ↔ Vue 的类型化命令与事件、按 `generation` 丢弃迟到事件、关闭 Tab / 卸载组件时的订阅释放。
- 空状态、加载中、错误与重试路径；检查器只展示真实运行时状态。

非目标（本任务不做）：

- 会话的创建/重命名/删除（Pi 拥有会话文件，SOXU 只读）。
- 临时会话「转存为普通会话」——需要会话目录的显式创建接口，当前按钮不提供。
- Markdown 渲染、图片/附件、扩展 UI 审批交互。
- 完整的无障碍屏幕阅读器验证与多分辨率截图基线（见第 8 节）。

## 2. 分层与所有权

```
Vue 组件 (App.vue, ProjectSidebar, SessionTabs, ChatPanel, MessageList, ChatComposer, RuntimeInspector)
        ⇅ Pinia store (stores/workspace.ts)
工作区核心 (workspace/sessionWorkspace.ts + workspace/mapping.ts)   ← 纯 TS，可被 node:test 直接驱动
        ⇅ WorkspaceBridge (workspace/bridge.ts)
Tauri 命令 (commands.rs) → workspace.rs / session_runtime.rs
        → driver.rs (运行时驱动) / watch.rs (generation + 订阅计数) / entry_text.rs (正文按需读取)
        → soxu-agent-runtime / soxu-session-index
```

| 资源 | 唯一 owner | 释放时机 |
| --- | --- | --- |
| `RuntimeHandle`（Pi 子进程） | `driver::drive` 任务 | 收到 `Shutdown`、读到 `Exit` 或事件流结束；退出时 `stop()` |
| 运行时事件监听器（Tauri `listen`） | `WorkspaceSession`（整个工作区 1 个） | `dispose()`（组件卸载） |
| 每会话订阅计数 | `watch::EventFanout` | `release_session_events`；计数归零后后端不再 emit |
| generation 水位 | `watch::GenerationGate` | 进程生命周期内保留，只增不减，保证旧事件永不复活 |
| 会话目录 / 索引快照 | `tokio::sync::Mutex<ProjectCatalog>` | 进程退出；不写回 JSONL |

同一 `sessionId` 同时只允许一个驱动任务（`start_guard` + `runs` 表），因此不会出现两个
运行时双写同一 JSONL。

## 3. IPC 契约

命令名与前端 `bridge.ts` 一一对应；字段为 camelCase（Rust 侧 `serde(rename_all = "camelCase")`）。

| 命令 | 参数 | 返回 | 说明 |
| --- | --- | --- | --- |
| `runtime_info` | — | `{appName, appVersion, platform}` | 应用信息 |
| `list_projects` | — | `ProjectSummary[]` | 项目 + 会话摘要（标题来自首条用户消息） |
| `register_project` | `root` | `ProjectSummary` | 登记目录并立即扫描一次 |
| `refresh_project` | `projectId` | `ProjectSummary` | 重新扫描会话目录 |
| `open_session_history` | `sessionId, offset, limit` | `HistoryPage` | `offset` 是**条目序号**，`limit` 由服务端钳制到 1..=200 |
| `read_session_texts` | `sessionId, entries[]` | `EntryText[]` | 按 `offset/length` 读取完整正文，一次最多 40 条、单条 256 KiB |
| `start_session` | `sessionId, temporary?` | `{runtimeId, generation, state}` | 幂等：已在运行则直接返回当前身份 |
| `send_prompt` | `sessionId, text` | `void` | 返回「命令被接收」，不代表本轮结束 |
| `cancel_session` | `sessionId` | `void` | 发送 `abort`，幂等 |
| `stop_session` | `sessionId` | `void` | 停止并回收子进程；没有运行时也算成功 |
| `runtime_status` | `sessionId` | `RuntimeStatus \| null` | 订阅释放后用于重新对齐 UI |
| `retain_session_events` | `sessionId` | `number` | 视图挂载，订阅计数 +1 |
| `release_session_events` | `sessionId` | `number` | 视图卸载，订阅计数 -1（永不为负） |

事件（`soxu://runtime-event`）是扁平结构，`type` 为判别字段：

```json
{ "sessionId": "ses_…", "runtimeId": "ses_…#3", "generation": 3,
  "type": "stream", "event": "message_update", "data": { "delta": "…" } }
```

`type` 取值：`state`（`state`）、`stream`（`event` + `data`）、`settled`、`stderr`（`line`）、
`warning`（`detail`）、`exit`（`code` + `reason`）。

## 4. 身份与事件过滤

- `sessionId` 稳定；`runtimeId` 与 `generation` 只代表一次执行。
- 后端：`GenerationGate.accept(sessionId, generation)` 为假时整条事件丢弃，状态注册表也不改写。
- 后端：`EventFanout.wants(sessionId)` 为假（没有视图在观察）时不 `emit`，但仍更新状态，
  因此重新订阅后可用 `runtime_status` 对齐。
- 前端：`WorkspaceSession.handleEvent` 二次校验 `runtimeId + generation`，不匹配直接返回。
  双保险保证「旧会话的工具结果不会画到新会话上」。
- `settled` 才代表一轮真正结束；`exit` 后置空 `runtimeId`，此后该运行时的事件全部失效。

## 5. 历史分页与正文补齐

1. `open_session_history` 返回**条目视图**（元数据 + ≤240 字符预览），不返回整段正文。
2. 前端按 `ordinal` 有序插入并按 `id = sessionId:h:ordinal` 去重，重叠页不会产生重复消息。
3. 每个历史页对 `kind === "message"` 的条目（最多 40 条）调用 `read_session_texts` 补齐完整正文；
   失败只记录诊断，**保留预览并把消息标记为「预览未载入」**，不伪装成完整内容。
4. `next === null` 表示到底；`loadMore` 在到底或加载中时不再请求。
5. 用户消息会由 Pi 写入 JSONL；页面重新加载历史后，本地乐观回显若与历史条目角色相同且
   历史文本是其前缀，则被移除，避免重复。

## 6. 取消、停止与关闭语义

| 动作 | 行为 |
| --- | --- |
| 取消 | 仅 `running` 状态发送一次 `abort`；重复点击不再发命令；失败回滚到 `running` 并显示原因 |
| 停止 | 停止运行时并回收子进程，Tab 保留历史，状态回到 `idle` |
| 关闭 Tab | 只释放该会话订阅，**不停止 Agent**（Pane 销毁 ≠ 停止任务）；重新打开时从 JSONL 历史恢复 |
| 组件卸载 | 摘掉监听器 → 清空 Tab → 逐个 `release_session_events`；之后任何 await 回来的结果都不再写状态 |

## 7. 测试与复现命令

```powershell
# 前端核心逻辑（node:test 直接运行 TypeScript，Node >= 24 类型擦除）
pnpm --filter @soxu/desktop test

# 类型检查与生产构建
pnpm --filter @soxu/desktop check
pnpm --filter @soxu/desktop build

# Rust：适配层单测 + 驱动任务 + 真实 catalog 集成测试
cargo test -p soxu-desktop
cargo clippy -p soxu-desktop --all-targets -- -D warnings
cargo fmt --all -- --check
```

覆盖点与用例：

| 验收点 | 证据 |
| --- | --- |
| 多 Tab 并发事件不串线、迟到 generation 丢弃 | `tests/multiTabEvents.test.ts`（2 个 Tab 交错流式、串名 runtimeId、过期 generation） |
| 历史恢复、分页去重、正文补齐、错误重试 | `tests/historyRestore.test.ts` |
| 取消幂等、取消失败回滚 | `tests/cancelAndDispose.test.ts` |
| 卸载时释放监听器与订阅、卸载后不写状态 | `tests/cancelAndDispose.test.ts`（`dispose`、在途历史响应） |
| Tab 状态必须经 Vue 响应式代理更新 | `tests/storeReactivity.test.ts`（`watch` 能观察到 loading → ready → idle） |
| 关闭 Tab 不停止 Agent | `tests/cancelAndDispose.test.ts` |
| 后端 generation 过滤与订阅计数 | `src/watch.rs` 单测、`src/driver.rs` 驱动测试 |
| 真实 JSONL：标题、分页、正文、越界拒绝、错误码 | `tests/workspace_bridge.rs`（`cargo test -p soxu-desktop`） |

## 8. 验证状态

已在本机实测通过（2026-10-28，Windows 11 / Node 26.10.0 / Rust 1.99.1）：

- `pnpm --filter @soxu/desktop test` → 16 passed。
- `pnpm --filter @soxu/desktop check`（vue-tsc）与 `build`（vite）通过。
- `cargo test -p soxu-desktop` → 16 单测 + 2 集成用例通过；`clippy -D warnings` 无告警。
- 仓库根 `cargo test --workspace`、`cargo fmt --all -- --check` 全绿。
- 浏览器渲染（`vite preview` + Moli `--layout`，来自 `dist` 构建产物）：视口 1920×1080 时
  侧栏 262×1080、主列 1358×1080、无横向溢出；浅色主背景 computed 值 `rgb(252, 252, 252)`，
  深色 `rgb(25, 23, 23)`，深色侧栏 `rgb(34, 32, 32)`，与 V3 Token 一致；切换主题、
  打开临时会话 Tab、错误提示与重试按钮在 DOM 层可观察。
- 无障碍关键路径：`role="tablist"/"tab"/"tabpanel"` 结构存在；两个 Tab 时按 `ArrowLeft`
  会切换选中项并把焦点移动到目标 Tab；输入框由 `label[for]` 关联可访问名称「消息内容」；
  错误区域使用 `role="alert"`。

**未验证**：

- Tauri/WebView 实机渲染、真实 `pi --mode rpc` 进程联调（本机未启动 GUI 会话）。
- macOS / Linux 运行；真实 Pi 事件里 `stream.data` 的完整形态（当前只识别
  `delta` / `text` / `content` / `message.content[*].text`，其余事件只记诊断）。
- 屏幕阅读器、1600×950 / 1280×800 / 1024×768 / 750×800 多分辨率截图与对比度基线
  （本机 Moli 无法覆盖视口尺寸）。
- `automation/loop` 的 dashboard 测试在本机因 Windows 临时目录 `EBUSY` 失败；该失败与本次改动
  无关（未修改 `automation/`），需在 CI 或干净环境复核。

## 9. 已知限制

1. 会话标题取首条用户消息的预览（≤44 字符），Pi 会话没有显式标题字段时回退到文件名。
2. 临时会话使用 `ses_tmp_*` 身份启动 Pi，但**不写入 SOXU 会话目录**，因此不会出现在历史列表；
   转存需要会话目录的显式创建接口，尚未实现。
3. 消息按纯文本渲染（`white-space: pre-wrap`），不解析 Markdown，避免不可信内容注入 HTML。
4. 工具输出超过 360 字符时折叠为 `<details>`，完整内容仍在内存中的该条消息里（受正文上限约束）。
5. 关闭全部 Tab 后监听器仍在（单个监听器成本固定），只有组件卸载才彻底注销。
6. 索引快照由 `soxu-session-index` 维护，SOXU 不订阅文件系统事件；实时性取决于刷新时机。
7. `list_projects` 首次会为每个会话读取首页并在有界页面里找首条用户消息作为标题（结果缓存）；
   会话数量很多时首次加载会明显变慢，后续可改为在扫描阶段提取标题。

## 相关文档

- [Pi RPC Supervisor](agent-runtime.md)
- [会话目录与 JSONL 索引契约](../architecture/session-catalog.md)
- [Pi RPC 适配契约](../specifications/rpc-contract.md)
- [UI/UX 基线](../design/gpt-inspired-ui.md)
