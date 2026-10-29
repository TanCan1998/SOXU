# 多会话工作区（TASK-003）

本文件描述 `apps/desktop` 多项目、多会话工作区的**已实现行为**。它只记录本仓库当前代码
真正做的事；未验证的部分单列在「未验证与已知限制」，不写成已完成。

对应任务：[TASK-003](../../tasks/backlog/TASK-003.md)。依赖 [Pi RPC Supervisor](agent-runtime.md)
与 [会话目录契约](../architecture/session-catalog.md)。

## 1. 范围与非目标

范围内：

- 项目导航（登记目录、扫描真实 Pi 会话、手动刷新）、会话 Tab、历史分页、完整正文按需加载、
  Pi RPC 流式追加、取消当前轮次、停止运行时。
- **临时会话**：默认不进入持久化历史、可显式转正为普通会话（见第 6 节）。
- Rust ↔ Vue 的类型化命令与事件、按 `generation` 丢弃迟到事件、关闭 Tab / 卸载组件时的订阅释放。
- 空状态、加载中、错误与重试路径；检查器只展示真实运行时状态。

非目标（本任务不做）：

- 会话的创建/重命名/删除（Pi 拥有会话文件，SOXU 只读）。
- 临时会话的**文件选择器**：转正需要显式绑定 Pi 会话文件，桌面端目前没有浏览文件的入口，
  因此 UI 只能显示后端给出的明确失败原因（见第 10 节）。
- Markdown 渲染、图片/附件、扩展 UI 审批交互。
- 完整的无障碍屏幕阅读器验证与多分辨率截图基线（见第 9 节）。

## 2. 分层与所有权

```
Vue 组件 (App.vue, ProjectSidebar, SessionTabs, ChatPanel, MessageList, ChatComposer, RuntimeInspector)
        ⇅ Pinia store (stores/workspace.ts)
工作区核心 (workspace/sessionWorkspace.ts + workspace/mapping.ts)   ← 纯 TS，可被 node:test 直接驱动
        ⇅ WorkspaceBridge (workspace/bridge.ts)
Tauri 命令 (commands/) → workspace.rs / session_runtime.rs
        → driver.rs (运行时驱动) / watch.rs (generation + 订阅计数) / entry_text.rs (正文按需读取)
        → soxu-agent-runtime / soxu-session-index
```

命令层按领域拆在 `commands/`（session / workspace / worktree / history），DTO 拆在 `dto/`；
新增 command 的登记位置、占位块与扩块规则见 [后端命令层的领域块约定](command-blocks.md)。

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
| `search_session` | `sessionId, query, limit?, afterOrdinal?` | `SessionSearchResult` | 搜**整份会话**（不是已加载的一页）；空查询返回空结果，超过 200 字符返回 `E_SEARCH_QUERY_TOO_LONG` |
| `open_temporary_session` | `projectId` | `TemporarySessionView` | 分配 `ses_tmp_*`：只进 Rust 内存，不写 catalog.json |
| `bind_temporary_session_file` | `sessionId, file` | `TemporarySessionView` | 显式绑定 Pi 会话文件；绑定期间该文件被扫描跳过 |
| `promote_session` | `sessionId` | `{sessionId, project}` | 显式转正；失败保留临时会话并返回稳定错误码 |
| `discard_temporary_session` | `sessionId` | `boolean` | 结束临时会话（幂等，不删除 Pi 会话文件） |
| `start_session` | `sessionId, temporary?` | `{runtimeId, generation, state}` | 幂等：已在运行则直接返回当前身份；`temporary` 时把可写归属登记在内存登记表（不落 catalog.json），持久化会话则落盘 |
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
6. **窗口化缓存**：每个 Tab 最多保留 240 条历史、120 条实时消息、2,000,000 历史字符
   （`workspace/types.ts`）。合并历史页与**新增实时消息**（用户发问、新的流式回复）之后都会
   收敛窗口，释放**最旧**的消息（正在流式的最后一条永不释放）：历史释放记在 `history.evicted`、
   实时释放记在 `history.evictedLive`，界面与检查器如实显示；Pi 的会话文件不受影响。
7. 单条正文超过 20,000 字符时截断并标记 `truncated`（后端 `clipped` + 前端 `capText` 双保险），
   流式增量到顶后丢弃后续增量，不再无限增长。

细节、实测数字与未验证项见[长会话虚拟列表与 5 万事件回归](long-session-virtual-list.md)。

## 6. 临时会话生命周期与转正

| 阶段 | 行为 | 证据 |
| --- | --- | --- |
| 创建 | 后端分配 `ses_tmp_*`，只进内存登记表；侧栏 `recentSessions` 不包含它 | `temporary_session_is_promoted_only_on_explicit_request` |
| 打开 | 不请求历史分页，Tab 直接进入 `ready`（不会因为「会话未登记」报错） | `临时会话不请求历史分页，也不进入侧栏历史` |
| 对话 | Pi 自己管理会话文件；SOXU 不因此把它写进历史 | 同上 |
| 绑定 | `bind_temporary_session_file` 显式绑定 Pi 会话文件；之后扫描跳过该文件 | `bound_file_is_hidden_from_sync_until_promoted` |
| 转正 | 成功：Tab 身份换成 Pi 头部 id、侧栏按后端摘要刷新、按普通会话加载历史 | `转正成功：切到持久化身份、刷新侧栏、加载真实历史` |
| 转正失败 | 保持临时会话与内容、显示 `E_TEMPORARY_SESSION_*` 原因、不写历史 | `转正失败：保留临时会话与内容，显示原因，不伪造成功` |
| 有活运行时 | 前端不发转存请求并提示「先停止 Pi 运行时」；后端也会拒绝（`E_TEMPORARY_SESSION_RUNTIME_ACTIVE`） | `idle 但 runtimeId 仍在的临时会话不允许转存`、`promotion_and_discard_wait_for_the_runtime_to_stop` |
| 结束 | 关闭 Tab 或卸载时先停运行时、再 `discard_temporary_session`：只清内存登记与索引快照 | `关闭临时会话 Tab 先停止运行时再清登记`、`卸载时先停临时会话的运行时再清登记` |
| 崩溃重启 | 内存登记表为空 + 打开目录时清理上一进程运行时挂载 → 无幽灵历史 | `crash_leaves_no_ghost_runtime_and_no_temporary_history`、`restarted_app_reports_no_ghost_runtime` |

运行中的临时会话不允许转正（只登记已经写出的内容，避免把半轮对话当成完整历史）；
`promoting` 为真时 UI 显示「转存中…」，必须等后端结果才能显示成功。

**转正的前提是「没有活运行时」，而不是「status 不是 running」**：idle 但 `runtimeId` 仍非空的
临时会话，其 Pi 进程仍持有该会话文件。允许它转正会让旧进程失去 owner（`stop_session` 对
新身份是 no-op 假成功，进程直到自己退出才被回收），转正后再启动就会对同一 JSONL 双写。
因此两层都在拦：

- 前端：`canPromote` / `promoteSession` 要求 `runtimeId === null`，按钮提示写明原因；
- 后端：`has_live_runtime`（`runs` 表中命令通道未关闭，或启动仍在进行）直接拒绝；
  目录层再用临时会话的可写归属（`claim_temporary_writable`）兜底，任何持有者存在都返回
  `E_TEMPORARY_SESSION_RUNTIME_ACTIVE`。

同理，**结束临时会话**（关闭 Tab、卸载）必须先 `stop_session` 再 `discard_temporary_session`：
登记消失后进程失去 owner，绑定也随之中断，文件可能被下一次扫描当成普通会话，形成幽灵历史。

契约与错误码见 [会话目录契约](../architecture/session-catalog.md) 的「临时会话与转正」。

## 7. 取消、停止与关闭语义

| 动作 | 行为 |
| --- | --- |
| 取消 | 仅 `running` 状态发送一次 `abort`；重复点击不再发命令；失败回滚到 `running` 并显示原因 |
| 停止 | 停止运行时并回收子进程，Tab 保留历史，状态回到 `idle` |
| 关闭 Tab | 只释放该会话订阅，**不停止 Agent**（Pane 销毁 ≠ 停止任务）；重新打开时从 JSONL 历史恢复 |
| 组件卸载 | 摘掉监听器 → 清空 Tab → 逐个 `release_session_events`；之后任何 await 回来的结果都不再写状态 |

## 8. 测试与复现命令

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
| 长会话：首屏只读一页、窗口上限、DOM 行数、长输出截断 | `tests/longSession.test.ts`（50,000 条夹具，见[长会话虚拟列表](long-session-virtual-list.md)） |
| 取消幂等、取消失败回滚 | `tests/cancelAndDispose.test.ts` |
| 卸载时释放监听器与订阅、卸载后不写状态 | `tests/cancelAndDispose.test.ts`（`dispose`、在途历史响应） |
| Tab 状态必须经 Vue 响应式代理更新 | `tests/storeReactivity.test.ts`（`watch` 能观察到 loading → ready → idle） |
| 关闭 Tab 不停止 Agent | `tests/cancelAndDispose.test.ts` |
| 后端 generation 过滤与订阅计数 | `src/watch.rs` 单测、`src/driver.rs` 驱动测试 |
| 真实 JSONL：标题、分页、正文、越界拒绝、错误码 | `tests/workspace_bridge.rs`（`cargo test -p soxu-desktop`） |
| 临时会话默认不进入历史、显式转正、失败保留内容 | `tests/temporarySession.test.ts`、`src-tauri/tests/temporary_session.rs` |
| 有活运行时（含 idle / 启动中）时转正与结束都被拒绝 | `tests/temporarySession.test.ts`（3 例）、`src-tauri/tests/temporary_session.rs`、`crates/session-index/tests/temporary_lifecycle.rs`（`live_runtime_blocks_promotion_and_discard`） |
| 临时会话的可写归属防双写（幂等声明、抢占失败、释放者校验） | `crates/session-index/tests/temporary_lifecycle.rs` |
| 崩溃后无幽灵运行时/幽灵历史 | `src-tauri/tests/temporary_session.rs`（`restarted_app_reports_no_ghost_runtime`） |
| 多临时会话隔离（跨项目/工作树） | `crates/session-index/tests/temporary_lifecycle.rs` |
| Tab 等宽（96~220 上下限）、拖拽阈值与落位、只改顺序不改 active | `tests/sessionTabs.test.ts`（15 例） |

## 9. 验证状态

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

### 临时会话与转正（Issue #38，2026-10-29）

本机实测（Windows 11 / Node 26.10.0 / Rust 1.99.1 / pnpm 12.15.0）：

| 命令 | 结果 |
| --- | --- |
| `cargo test -p soxu-session-index` | 25 单测 + 10 + 9 + 6 + 8 + 1 集成用例通过（新增 `tests/temporary_lifecycle.rs` 8 例） |
| `cargo test -p soxu-desktop` | 单测与既有集成用例通过；新增 `tests/temporary_session.rs` 4 例通过 |
| `cargo test --workspace` | 全绿 |
| `cargo fmt --all -- --check` | 无差异 |
| `cargo clippy -p soxu-session-index -p soxu-desktop --all-targets -- -D warnings` | 无告警 |
| `pnpm check` | `vue-tsc` 通过；desktop 45 例、scripts 47 例全绿（新增 `tests/temporarySession.test.ts` 13 例） |

**复审修复（同 Issue #38，2026-10-29 第二轮）**：转正原先只按 `status` 拦截，idle 但
`runtimeId` 仍非空的临时会话可以转正，导致旧 Pi 失去 owner、转正后再启动双写同一 JSONL。
现在三层都拦：前端要求 `runtimeId === null`；应用层 `session_runtime::has_live_runtime`
（含启动中的重试退避窗口）；目录层临时会话可写归属（`claim_temporary_writable`）。
结束临时会话同样先停运行时再清登记，避免解除绑定后文件被扫描成幽灵历史。
对应证据：`temporarySession.test.ts`（4 例新增）、`temporary_session.rs`
（`promotion_and_discard_wait_for_the_runtime_to_stop`）、`temporary_lifecycle.rs`
（`live_runtime_blocks_promotion_and_discard`）。

**浏览器 DOM 冒烟**（`vite preview` + Moli `--eval`，来自 `dist` 构建产物，2026-10-29）：

- 打开临时会话后 `button.promote` 文本为「转为普通会话」且可点击，徽标为「临时会话」，
  提示文案与设计一致，无 `role="alert"` 错误。
- 点击转存（浏览器预览没有 Rust 后端）后出现
  「转存失败：当前是浏览器预览，未连接 Rust 运行时…」，临时会话徽标与按钮仍在：
  失败不伪造成功，符合「UI 不能在后端未实现时声称保存成功」的约束。
  （文案在 Issue #89 中统一为「尚未连接本机运行时」，此处保留当时的原始观测记录。）

**未验证（本次改动）**：

- 真实 `pi --mode rpc` 进程下「临时会话 → Pi 写文件 → 绑定 → 转正」的完整链路：
  Pi 目前不回报自己的会话文件路径，测试用夹具 JSONL 代替（第 10 节第 3 条）。
- 真实 Pi 进程下 `start_session(temporary = true)` 是否成功登记内存归属：代码路径已接
  （`claim_catalog` 的 temporary 分支），但需要真实 RPC 进程才能端到端验证；测试用目录层
  的 `claim_temporary_writable` + `has_live_runtime` 分别覆盖两侧。
- Tauri/WebView 里点击「转为普通会话」的实际观感与无障碍朗读（本机未启动 GUI 会话）。
- 仓库根 `cargo clippy --workspace --all-targets -- -D warnings` 在本次改动前就会因
  `crates/agent-runtime/tests/process_tree.rs` 的 `collapsible_if` 失败；该文件未被本次改动触碰，
  需另开任务处理，不能据此宣称整仓 clippy 通过。

**未验证（历史遗留）**：

- Tauri/WebView 实机渲染、真实 `pi --mode rpc` 进程联调（本机未启动 GUI 会话）。
- macOS / Linux 运行；真实 Pi 事件里 `stream.data` 的完整形态（当前只识别
  `delta` / `text` / `content` / `message.content[*].text`，其余事件只记诊断）。
- 屏幕阅读器、1600×950 / 1280×800 / 1024×768 / 750×800 多分辨率截图与对比度基线
  （本机 Moli 无法覆盖视口尺寸）。
- `automation/loop` 的 dashboard 测试在本机因 Windows 临时目录 `EBUSY` 失败；该失败与本次改动
  无关（未修改 `automation/`），需在 CI 或干净环境复核。

### 长会话虚拟列表（Issue #36，2026-10-29）

本机实测（Windows 11 / Node 26.10.0 / pnpm 12.15.0），详细数据见
[长会话虚拟列表与 5 万事件回归](long-session-virtual-list.md)：

| 命令 | 结果 |
| --- | --- |
| `pnpm --filter @soxu/desktop test` | 51 例通过（新增 `tests/longSession.test.ts` 6 例，50,000 条夹具） |
| `node --expose-gc tests/perf/longSessionMemory.mjs` | 首屏 heapUsed 8.9 MiB；翻 25 页后 9.8 MiB（保留 240 条）；对照保留全部 5 万条预览 218.8 MiB |
| `moli fetch --layout --eval-file tests/harness/measure-dom.js`（Chromium 开发服务器） | 240 条与 50,000 条都渲染 15 行 / 89 个节点；滚到底部渲染 49,983..49,999 |

同时修复了一个真实缺陷：Vue 在元素进入布局前调用 `ref` 回调，测量到的 0 被 tanstack 写入尺寸缓存
且不会自愈，导致所有行叠在 0 位置、滚动高度错乱。现在只测量高度大于 0 的元素。

**未验证（Issue #36）**：Tauri WebView2/WKWebView/WebKitGTK 实机、macOS/Linux、真实 5 万事件
JSONL 会话、滚动帧率与 WebView 进程 RSS。

### Tab 等宽与拖拽排序（Issue #99，2026-10-29）

`SessionTabs.vue` 的会话 Tab 有两条规则：等宽的纯函数在
`src/composables/tabStripLayout.ts`（可单独跑用例），拖拽状态机在
`src/composables/useTabDrag.ts`（独占 window 级 listener 的加与摘），
组件本身只负责 DOM 测量与样式绑定：

| 规则 | 实现 | 用例 |
| --- | --- | --- |
| 同一栏内所有 Tab 等宽 | 容器宽度经 `ResizeObserver` 量一次，`tabWidth(count, width)` 均分后夹到 **[96, 220]**，结果写进 `--soxu-tab-width`，单个 Tab 不再自带 min/max 宽度 | `tabWidth`、`overflows` |
| 放不下时横向滚动 | 等宽被下限夹住即判定溢出，沿用 `.tabs-scroll` 的 `overflow-x: auto` | `overflows` |
| 拖拽阈值 ≥ 6px | `exceedsDragThreshold`：不到阈值仍是一次点击（照常切换会话） | `exceedsDragThreshold` |
| 落位与让位动画一致 | `dropIndex`（其余 Tab 中「中心仍在指针左侧」的个数）决定目标位；`slotShift`（-1/0/+1 槽位）决定其它 Tab 的平移量，空位用虚线框标出 | `dropIndex`、`slotShift` |
| 只改顺序，不改 `activeSessionId` | `WorkspaceSession.moveTab(fromIndex, toIndex)` 重排数组、原样搬运 Tab 对象；store 暴露同名 action，`App.vue` 只接 `@move` | `moveTab`（4 例，含 reactive 观察） |
| 键盘导航不受影响 | 拖拽只监听 pointer 事件，`@keydown` 仍是同一处理器（方向键 / Home / End / Delete） | 结构断言 + 浏览器实测 |
| 触屏可用 | 统一走 pointer events；`.tab-item` 设 `touch-action: pan-y`，横向滑动归拖拽、纵向留给页面滚动 | 浏览器实测（CDP 触摸派发） |
| `prefers-reduced-motion` 退化 | 组件内 `@media` 去掉 transform 过渡（`base.css` 另把全局时长压到 0.01ms） | 结构断言 + 浏览器实测 `transition-property: none` |

实机证据（headless Edge + CDP，1/3/8 个 Tab 截图、鼠标与触屏拖拽、键盘回归）见
[Issue #99 证据](evidence/issue-99-tab-width-drag/README.md)。
复跑：`node apps/desktop/tests/harness/shoot-session-tabs.mjs`。

### 未验证（Issue #99）

- 真实触摸屏设备上的拖拽手感（本次用 CDP `Input.dispatchTouchEvent` 模拟触摸，非实体设备）。
- Tauri WebView2/WKWebView/WebKitGTK 内的 `ResizeObserver` 首帧宽度与拖拽观感。
- 键盘用户无法重排顺序：本 Issue 只要求不破坏既有键盘导航，键盘排序另开任务。

### 会话内搜索（Issue #109，2026-10-30）

抽屉搜索面板不再只过滤已加载的一页：`search_session` 走本地正文缓存 + 线性扫描，
搜的是整份会话。设计、预算与证据见 [会话内搜索](session-search.md)。

界面（抽屉、三种状态、命中高亮、点击跳转）由 Issue #118 交付：
`components/SearchDrawer.vue` + `components/searchPanel.ts`，右侧抽屉与「会话状态」面板互斥，
Ctrl+F / ⌘F 打开并把焦点放进搜索框。证据见
[issue-118-search-drawer](evidence/issue-118-search-drawer/README.md)。

| 规则 | 实现 | 用例 |
| --- | --- | --- |
| 搜全整份会话 | 后端缓存所有条目正文（受 8 MiB / 24 MiB 预算约束），线性扫描 | `finds_every_hit_not_only_the_first_page`（1,235 条 → 206 命中）、`search_covers_the_whole_session_and_pages_by_ordinal` |
| 追加不重建 | `(mtime_ms, size)` 指纹：变大只解析新增字节 | `appends_new_entries_without_rebuilding` |
| 外部改写不返回旧内容 | 变小 / mtime 倒退 / 等长改写都整份重建 | `rewritten_file_drops_removed_content`、`equal_size_rewrite_is_detected_by_mtime` |
| 超长条目只给截断片段 | 单条正文上限 20,000 字符，超出只留前 200 + `truncated` | `oversized_entry_is_truncated_and_flagged` |
| 预算有界且如实报告 | 超预算丢最旧正文并置 `degraded`；全局超限淘汰最久未用会话 | `budget_evicts_oldest_text_and_reports_degraded`、`global_budget_evicts_least_recently_used_session` |
| 边界输入不 panic | 空查询空结果、超长 `E_SEARCH_QUERY_TOO_LONG`、未登记会话给稳定错误码 | `empty_and_overlong_queries_have_explicit_behaviour`、`search_limits_and_boundary_inputs_are_explicit` |
| 前端防抖 200 ms | `WorkspaceSession.scheduleSearch`：只保留最后一次查询，定时器随 Tab/组件释放 | `sessionSearch.test.ts`（3 次输入 → 1 次请求） |
| 迟到响应不覆盖新结果 | `tab.search.seq` 请求序号守卫 | `sessionSearch.test.ts`（迟到响应用例） |
| 片段高亮由后端给偏移 | `splitSnippet` 按码点切片，前端不重算匹配位置 | `sessionSearch.test.ts`（emoji / 越界偏移） |

性能基线（Windows 11 / release，5 次采样）：50,001 条 / 11.9 MB 会话，建缓存 96–135 ms、
单次查询 5–9 ms、缓存占用 6.19 MiB。复跑：`cargo test --release -p soxu-session-index --test search_perf -- --ignored --nocapture`。

**未验证（Issue #109）**：Tauri WebView2/WKWebView/WebKitGTK 实机、macOS/Linux 的 `mtime` 行为、
真实（非合成）10 MiB 会话；搜索面板组件尚未迁移到本仓库，本 Issue 只交付数据层、防抖与高亮助手。

## 10. 已知限制

1. 会话标题取首条用户消息的预览（≤44 字符），Pi 会话没有显式标题字段时回退到文件名。
2. 临时会话使用 `ses_tmp_*` 身份，只登记在 Rust 进程内存里，**不写入 catalog.json**，
   因此不会出现在历史列表，重启后也不存在（不会留下幽灵历史）。转正需要先显式绑定
   Pi 会话文件（`bind_temporary_session_file`）；桌面端还没有文件选择入口，所以 UI 在没有绑定
   时会显示 `E_TEMPORARY_SESSION_UNPROMOTABLE` 的明确原因，而不是假装保存成功。
   转正与结束都要求**先停止运行时**（`E_TEMPORARY_SESSION_RUNTIME_ACTIVE`），运行中的进程
   仍持有会话文件的可写权。
3. Pi 目前不会向 SOXU 回报它自己创建的会话文件路径，因此「绑定」必须由调用方给出路径。
   在拿到可靠路径之前，自动绑定会带来「把别人的会话内容写进历史」的风险，故不做猜测。
4. 消息按纯文本渲染（`white-space: pre-wrap`），不解析 Markdown，避免不可信内容注入 HTML。
5. 工具输出超过 360 字符时折叠为 `<details>`，完整内容仍在内存中的该条消息里（受正文上限约束）。
6. 关闭全部 Tab 后监听器仍在（单个监听器成本固定），只有组件卸载才彻底注销。
7. 索引快照由 `soxu-session-index` 维护，SOXU 不订阅文件系统事件；实时性取决于刷新时机。
8. `list_projects` 首次会为每个会话读取首页并在有界页面里找首条用户消息作为标题（结果缓存）；
   会话数量很多时首次加载会明显变慢，后续可改为在扫描阶段提取标题。
9. 分页方向仍是「从最早一条往后」：打开长会话先看到最早一页，按钮是「加载更多历史」；
   尾部分页需要后端提供 `prev`/尾部偏移，尚未实现（见
   [长会话虚拟列表](long-session-virtual-list.md) 第 6 节）。
10. Tab 窗口释放后的更早消息不会自动回补：要么关闭并重新打开 Tab（重新从第 0 页加载），
   要么等尾部分页/按需回补实现。
11. Tab 顺序只存在本次会话的内存里（`state.tabs`）：刷新或重启后按打开顺序重建，
   不写入 Pi 会话数据，因此不会污染用户的 JSONL 与目录索引。
12. 会话内搜索的缓存按 `(mtime_ms, size)` 指纹判断一致性：文件系统 `mtime` 精度不足时，
   等长外部改写可能漏判（后续 `size` 变化或截断检测仍会纠正）。搜索面板组件尚未迁移到本仓库，
   目前只有 `WorkspaceSession.search` / `scheduleSearch` 与高亮助手可供接线。

## 相关文档

- [Git 工作树服务与桌面集成](../architecture/worktree-service.md)（工作树枚举、创建、
  Diff 与受确认删除；本文件的 Tab/事件规则同样适用）
- [Pi RPC Supervisor](agent-runtime.md)
- [会话目录与 JSONL 索引契约](../architecture/session-catalog.md)
- [会话内搜索：文本缓存 + 线性扫描](session-search.md)
- [Pi RPC 适配契约](../specifications/rpc-contract.md)
- [UI/UX 基线](../design/gpt-inspired-ui.md)
