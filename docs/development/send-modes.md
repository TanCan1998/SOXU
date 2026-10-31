# 发送模式协议调查与落地（Issue #146 · TASK-036）

本文件回答一个问题：ComposerSendMenu 的三选（加入当前 / 排到下轮 / 并行发送）
在 Pi RPC 上到底能落成什么，以及 SOXU 侧对应实现了什么。

结论先行：

| 发送方式 | Pi RPC 是否原生支持 | SOXU 侧实现 | 证据 |
|---|---|---|---|
| steer（加入当前） | **支持**：`prompt` 带 `streamingBehavior: "steer"`，或独立 `steer` 命令 | 原生：`send_prompt` 带 mode → `streamingBehavior=steer` | §3.3（实测帧）、§3.10（实机） |
| followUp（排到下轮） | **支持**：`streamingBehavior: "followUp"`，或独立 `follow_up` 命令 | 原生排队 + 本地登记（可撤回） | §3.4（实测帧）、§3.10（实机） |
| parallel（并行发送） | 不需要：协议里没有「并行」概念 | 客户端：同一项目下另开临时会话再发送 | §3.8（两个运行时互不干扰）、§3.10（实机） |

因此**没有**「协议不支持 → 从 UI 移除」的情形：三项都真的会发出消息，
菜单里不再有「可见但无效果」的选项。

---

## 1. 调查方法

三条独立证据线，缺一不可（缺任何一条都只能得到「文档说可以」或「替身说可以」）：

1. **官方协议文档**（随 pi 1.4.0 一起安装，本机路径
   `%LOCALAPPDATA%/pi/install/releases/1.4.0/node_modules/@earendil-works/pi-coding-agent/docs/`）：
   - `rpc.md`：记录族、分帧、run 生命周期、`agent_settled` 语义；
   - `rpc-commands.md`：`prompt` / `steer` / `follow_up` / `abort` / `clear_queue` /
     `set_steering_mode` / `set_follow_up_mode` / `get_state` 的字段与取值；
   - `json.md`：`agent_start` / `agent_settled` / `queue_update` / `message_start` 事件字段。
2. **真实 RPC 实测**：`scripts/probe-send-modes.mjs`（`pnpm probe:send-modes`）启动真实
   `pi --mode rpc`，逐阶段发命令并记录**原始响应帧**。结果在
   `docs/development/evidence/issue-146-send-modes/probe-windows.json`。
3. **桌面端实机走查**：`apps/desktop/tests/harness/verify-issue-146-desktop.mjs` 驱动真实
   `soxu-desktop.exe` + 真实 `pi`，判据取自 Pi 自己写的会话 JSONL（§3.10）。

实测环境（取自证据 JSON 的 `environment` 字段）：

```
platform win32 · arch x64 · node v26.10.0 · pi 1.4.0
model auto/deepseek-v4.1-flash · thinkingLevel off
```

探测脚本刻意用 `--no-tools --no-extensions --no-mcp --no-skills --no-prompt-templates
--no-context-files --thinking off` 启动，只观测投递语义，不写文件、不加载真实项目资源。
它会真实调用模型（本次约 10 次短提示），因此**不接入 `pnpm check`**，必须显式执行。

> 复现：`pnpm probe:send-modes --out docs/development/evidence/issue-146-send-modes/probe-windows.json`
> （会消耗模型额度；脚本失败不自动重试，避免重复计费）。

## 2. 协议事实（文档层）

### 2.1 `prompt` 的 `streamingBehavior`

```json
{"id": "req-1", "type": "prompt", "message": "Hello, world!"}
{"type": "response", "command": "prompt", "success": true, "data": {"disposition": "started"}}
```

agent 正在流式输出时，**不带** `streamingBehavior` 的 `prompt` 会被拒绝；
必须显式指定排队方式：

```json
{"type": "prompt", "message": "New instruction", "streamingBehavior": "steer"}
```

- `steer`：当前助手回合（含工具调用）结束后、下一次 LLM 调用前插入；
- `followUp`：等 agent 完全停下（`agent_settled`）后再作为下一轮处理。

`data.disposition` 有三个取值：`handled`（扩展命令/输入处理器消费了它，不会有 run）、
`queued`（排队中）、`started`（接受并开始一轮）。**`success: true` 只表示命令被接受，
不表示执行完成**；接受之后的失败走事件流，不会再有第二条 response。

### 2.2 独立的 `steer` / `follow_up` 命令

```json
{"type": "steer", "message": "Stop and do this instead"}
{"type": "follow_up", "message": "After you're done, also do this"}
```

两者都回 `{"success": true, "data": {"disposition": "queued"}}`。与 `prompt` +
`streamingBehavior` 的区别只在入口：独立命令不允许扩展命令（`/cmd`），`prompt` 允许。
SOXU 走 `prompt` + `streamingBehavior` 这一条路径，因为参数与空闲投递完全同构，
协议层只需要多一个可选字段（见 §4.1），不必为同一种语义维护两条命令。

### 2.3 `clear_queue` 与 `abort` 的交互

```json
{"type": "clear_queue"}
{"type": "response", "command": "clear_queue", "success": true,
 "data": {"steering": ["Change direction"], "followUp": ["Summarize when finished"]}}
```

文档明确写着：**`abort` 会继续执行仍留在会话里的排队消息**；Pi 官方建议的交互式 Esc
行为是「先 `clear_queue`、再 `abort`，然后把返回的文本还原到编辑器」。
这正是 SOXU「停止」按钮必须做的事（见 §4.4）。

### 2.4 队列相关事件与状态

- `queue_update`：字段 `steering` / `followUp` 是**当前完整队列**（不是增量）；
- `get_state` 返回 `steeringMode` / `followUpMode`（`all` 或 `one-at-a-time`，
  默认后者）与 `pendingMessageCount`；
- `agent_settled`：`aborted` 标记这一轮是否因 abort 结束；它是「Pi 不会再有自动后续动作」
  的唯一信号，`agent_end` 不能替代（重试、溢出恢复、compaction、steering、follow-up
  都可能继续）。

## 3. 实测记录（真实帧）

以下全部来自 `probe-windows.json` 的 `phases` 字段，未做改写。

### 3.1 握手：确认基线

```json
{"success": true, "isStreaming": false, "steeringMode": "one-at-a-time",
 "followUpMode": "one-at-a-time", "pendingMessageCount": 0}
```

### 3.2 忙碌时直接发 prompt（不带 streamingBehavior）→ 硬拒绝

先起一轮长任务，确认 `isStreaming: true`，再发普通 prompt：

```json
{"id": "busy-4", "type": "response", "command": "prompt", "success": false,
 "error": "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
 "disposition": null}
```

**这就是「忙碌时发送假可用」的根因**：旧实现（`sessionWorkspace.sendPrompt` 在
running/cancelling/loading 时直接 return）连这条错误都看不到，用户只看到消息消失。

### 3.3 steer：两条路径都排队，且都会投递

```json
{"command": "prompt",   "success": true, "disposition": "queued"}   // prompt + streamingBehavior=steer
{"command": "steer",    "success": true, "disposition": "queued"}   // 独立 steer 命令
```

`queue_update` 依次给出 `steering: 1` → `steering: 2`，`get_state.pendingMessageCount` 为 2；
本轮结束后两条消息都出现在会话历史里（`deliveredA: true`、`deliveredB: true`）。

### 3.4 followUp：两条入口都会投递，但 `agent_settled` 只在最后出现一次

SOXU 线上走的是 `prompt` + `streamingBehavior=followUp`；独立 `follow_up` 命令是另一条入口。
两条都单独实测（`followUpWhileBusy` / `followUpPromptWhileBusy`）：用 A 的结论推断 B
不能算证据。

```json
// prompt + streamingBehavior=followUp（SOXU 的真实线格式）
{"command": "prompt", "success": true, "disposition": "queued"}
{"type": "queue_update", "steering": 0, "followUp": 1}
{"command": "get_state", "data": {"isStreaming": true, "pendingMessageCount": 1}}
```

事件顺序（下标是报告里 `records` 的序号，同一阶段内可比）：

| 下标 | 记录 | 含义 |
|---|---|---|
| 2080 | `queue_update` followUp=1 | 消息进队列 |
| 2925 | `message_start` role=user | 长任务输出结束后，这条消息作为**新的用户消息**进入会话 |
| 3003–3004 | assistant `message_update` → `message_end` | Pi 为它起了一轮新的助手回复 |
| 3005 | `turn_end` | 该助手回合结束 |
| 3007 | `agent_settled` aborted=false | 整个 agent 循环安定（**只有这一次**） |

独立 `follow_up` 命令的同阶段形状一致（队列 1083 → 用户消息 1931 → 助手结束 2068 →
`agent_settled` 2071）。

**关键事实（上一版本文档写错了）**：Pi 不会「先 settled、再重新起一轮」。排队的 followUp
被接入**同一个 agent 循环**，所以两个阶段里 `agent_settled` 都只出现一次，并且出现在投递
**之后**（报告里 `delivery.deliveredAfterSettled: false`）。产品含义：

- 「排到下轮」= 本轮输出结束后，作为下一条用户消息处理，而不是「会话先停下再排队」；
- SOXU 用 `agent_settled` 清空本地 `pending` 是对的（那一刻 Pi 才真的没有后续动作），
  但这意味着**排队回执会一直显示到这一轮彻底结束**，而不是长任务一完成就消失。

### 3.5 空闲时带 streamingBehavior 不会被拒

```json
{"command": "prompt", "success": true, "disposition": "started"}
{"type": "agent_settled", "aborted": false}
```

空闲时带上 `streamingBehavior` 也能正常开始一轮，不会被判为错误。SOXU 仍然在空闲时
**省略**该字段：语义上没有需要排队的东西，省略让线格式与旧客户端完全一致。

### 3.6 abort 不会清空队列

先排队一条 `follow_up`，再 `abort`：

```json
{"command": "abort", "success": true}
{"type": "agent_settled", "aborted": true}
```

`abort` 之后 `pendingMessageCount` 仍然是 **1**（队列没被清空），观察窗口内该消息未被投递
（`delivered: false`）。结论：**停止必须自己先 `clear_queue`**，否则用户按了停止，
排队的消息仍会在此后某个时刻跑起来。

### 3.7 clear_queue 真的能撤掉

```json
{"command": "clear_queue", "success": true, "steering": 1, "followUp": 2}
```

清空后两条消息都没有被投递（`deliveredS: false`、`deliveredF: false`）。

### 3.8 两个运行时互不干扰（parallel 的前提）

两个独立 `pi --mode rpc` 进程同时各发一条 prompt：

```json
{"responseA": {"success": true, "disposition": "started"},
 "responseB": {"success": true, "disposition": "started"},
 "crossTalk": false, "ownTextPresent": true}
```

各自的会话里只有自己的消息（`crossTalk: false`），两条都正常结束。因此「并行发送 =
另开一个会话」在协议层成立。

### 3.9 探测脚本的边界

- 只覆盖 Pi RPC 层：Tauri 命令层与 WebView 交互由 §3.10 的实机走查覆盖；
  真实工具调用与内存占用仍未测。
- 本轮证据来自**一次完整运行**（`requestedPhases` 九项全跑、`skippedPhases: []`、
  `records: 4038`），不是多轮拼接；`--only`/`--merge` 只用于局部重测。
- 时长与模型/网络相关，只记录行为，不作为稳定性能指标。

### 3.10 桌面端实机走查（真实 Tauri 窗口 + 真实 Pi）

`apps/desktop/tests/harness/verify-issue-146-desktop.mjs` 启动构建产物
`target/debug/soxu-desktop.exe`，前端由 Vite 开发服务器提供，Pi 是 PATH 上的真实
`pi 1.4.0`。**判据取自 Pi 自己写的会话 JSONL**，不看界面自称。结果在
`docs/development/evidence/issue-146-send-modes/desktop-send-modes.json`，截图同目录。

隔离措施：`PI_CODING_AGENT_SESSION_DIR` 指向临时目录（Pi 文档里的官方环境变量），
项目根是临时空目录，`catalog.json` / `retry/` 跑完原样恢复；结束时 `taskkill /T`
收掉 app 进程树，再按 pi.exe 路径回收残留（本次 `found: 0`）。

24 条断言全部通过，关键几条：

| 检查 | 证据 |
|---|---|
| 排到下轮：忙碌时输入区显示「已排队 1 条」 | `desktop-followup-queued.png` |
| 排到下轮：消息由 Pi 真的写进对话，且在至少一轮助手回复之后 | JSONL `index: 2`，`messagesBefore: ["user","assistant"]` |
| 排到下轮：Pi 消费队列后回执消失 | `noteGone: true` + `desktop-followup-delivered.png` |
| 加入当前：忙碌时可点、消息真的投递 | `desktop-steer-queued.png`，JSONL `index: 6` |
| 并行发送：新建 Tab、active 切过去、标签标明「临时」 | `createdSessionId === activeSessionId` 且不同于原会话 |
| 并行发送：消息写进**新的** Pi 会话文件，且是该会话第一条用户消息 | `newPiFile: true`，`index: 0` |
| 并行发送：原会话仍在 running | `desktop-parallel-original-running.png` |
| 停止：回执消失、文本回填输入框、消息没有被执行 | `desktop-stop-after.png`，`deliveredAfterStop: false` |
| 忙碌时提示语写明默认投递方式；不选菜单按默认值投递 | 提示语「…按「加入当前」投递…」 |

走查还暴露了两个**既有**缺陷（不在本任务原始范围内，但不修就无法给出实机证据）：

1. **扁平事件帧没被解码**：`decode_inbound` 只认 `{"type":"event","event":…}` 包装，
   而 Pi 1.4.0 的帧是 `{"type":"agent_settled",…}`（docs/json.md）。后果是**所有**会话事件
   都落进 `UnhandledRecord`：`agent_settled` 从未生效，Tab 永远停在 running、排队回执不消失、
   「停止」也就永远等不到 idle（修复前截图诊断里就写着「未处理的记录类型：agent_settled」）。
   修法见 §4.1。
2. **用户消息被渲染成助手回复**：修好解码后，`message_end` 里的 user 正文会走实时文本通道，
   `turn_end` 又重复一遍助手正文。修法见 §4.5。

另有一条**平台风险**（未修，记录在案）：SOXU 用 `Command::new("pi")` 启动 Pi，而 Windows 的
CreateProcess 只给无扩展名的程序补 `.exe`；本机托管安装只提供 `pi.cmd`（`node spawn("pi")`
直接 ENOENT）。走查因此用 `rustc` 在临时目录编译了一个最小转发 shim
（`pi.exe` → `node pi-launcher.js`），**没有改动产品代码**。同类环境下的真实用户会起不来 Pi，
建议另开任务决定是解析 `PATHEXT` 还是要求可执行入口。

## 4. SOXU 侧映射（落地实现）

### 4.1 协议层：`crates/pi-protocol`

`PiCommand` 新增：

- `Prompt { id, message, streaming_behavior: Option<StreamingBehavior> }`，
  字段 `streamingBehavior` 在 `None` 时**不序列化**（空闲投递的线格式与改动前逐字节一致）；
- `ClearQueue { id }`；
- `StreamingBehavior::{Steer, FollowUp}`，线取值为 `"steer"` / `"followUp"`。

`crates/agent-runtime` 的 `RuntimeHandle` 增加 `prompt_with(message, behavior)` 与
`clear_queue()`；`prompt()` 保持原语义（空闲投递）。

同一文件还修了 §3.10 暴露的解码缺陷：新增 `SESSION_EVENT_TYPES`（19 个会话事件名）与
`is_session_event()`，`decode_inbound` 在 `"event"` 之外也把**顶层**会话事件认成
`Inbound::Event`，并把除 `type` 之外的字段平铺进 `data`（调用方不必区分包装/扁平两种帧）。
旧的 `{"type":"event",…}` 包装仍然接受，扩展 UI 请求（`extension_ui_request`）仍走
`Other` + 拒绝警告那条路。单测用 §3 的真实帧（`agent_settled` / `agent_start` /
`message_update` / `queue_update`）钉住。

### 4.2 命令层：`send_prompt` 的 mode 真的生效

`apps/desktop/src-tauri/src/commands/session.rs`：

| 前端 mode | 后端行为 |
|---|---|
| `steer` | `Some(StreamingBehavior::Steer)` |
| `followUp` | `Some(StreamingBehavior::FollowUp)` |
| `parallel` | `None`（并行由前端另开会话；到这里只作兜底，绝不静默丢弃） |
| 省略 | `None`（空闲投递） |

新增命令 `clear_queued_prompts(session_id)`，供「停止」先清队列。

### 4.3 工作区层：`WorkspaceSession.sendPrompt`

- **空闲**：普通 prompt，草稿清空、本地回显、状态转 `running`（与旧行为一致）；
- **忙碌 + steer/followUp**：带 mode 投递，同时把这条消息登记进 `tab.pending`
  （`{ messageId, text, mode }`）。失败时**撤回回显与登记、把草稿还给用户**——
  界面上不能留下一条「看起来发出去了、其实被拒绝」的消息；
- **忙碌 + parallel**：`openTemporary(tab.projectId)` 新开临时会话再投递，
  当前会话的运行状态完全不动；active 切到新会话，用户立刻看到「新会话已创建」；
- **忙碌但没给 mode**：按 `followUp` 排队（宁可下一轮发，也不静默丢消息）；
- **loading**：仍然直接返回（历史没读完，运行时状态未知）。

`agent_settled` / `exit` / 显式停止时清空 `tab.pending`：Pi 已消费队列或队列已随进程消失。

### 4.4 取消语义：先清队列再 abort

`cancel()` 在 `pending` 非空时先调 `clearQueuedPrompts`，成功后才 `cancelRuntime`，
并把撤回的文本按顺序拼回输入框、移除对应回显。若 `clear_queue` 失败，
**保留** `pending` 与回显并写一条诊断——Pi 可能仍会执行它们，不能假装已撤回。

### 4.5 UI：三选与「忙碌时发送」默认值真的联动

- `sendMode.ts` 的 `SEND_MODES_READY` 置为 `true`：三项不再统一置灰；
  条件判定保持原样（steer 仅忙碌可用、followUp 总是可用、parallel 需要草稿+纯文本+项目）；
- 主发送按钮在忙碌时**可用**：没显式选过投递方式就按设置里的「忙碌时发送」默认值
  （`busyDelivery`：steer / followUp）走；
- 输入区显示「已排队 N 条」回执（`tab.pending.length`），让「停止会撤回」这件事有解释；
- 只有 `loading` 与 `cancelling` 两个状态禁用发送。

实时窗口（`sessionWorkspace.applyStream`）同时加了角色门禁：只有 `message_update` 与
**助手角色**的 `message_start`/`message_end` 能进入文本通道。Pi 的扁平帧里
`message_end` 也带 user 正文、`turn_end` 又重复助手正文，不过滤就会出现
「用户那句话被再渲染成助手回复」和「同一条回复出现两遍」。
单测：`apps/desktop/tests/streamEventShapes.test.ts`。
已知限制：`message_update` 的真实增量在 `assistantMessageEvent.delta` 里，本轮没有接入，
助手正文在 `message_end` 一次性出现（不影响本轮验收，另开任务做增量渲染）。

## 5. 不可行 / 不做的事

1. **协议里没有「并行发送」命令**：Pi 的会话是单线程 agent 循环，并发只能在会话之外，
   因此 parallel 只能是「另开会话」。SOXU 不为此新增常驻进程——临时会话复用已有的
   `open_temporary_session` 与独立运行时。
2. **不在客户端自建排队队列**：Pi 原生支持 `followUp`，客户端再排一遍会出现两份真相
   （Pi 队列 + SOXU 队列），停止/重连时必然错位。SOXU 只在本地登记「我排了什么」，
   用于撤回与 UI 回执，不负责投递。
3. **不实现 `set_steering_mode` / `set_follow_up_mode` 切换**：默认 `one-at-a-time`
   已经符合「一条一条插进当前回合」的产品语义，没有需要暴露给用户的场景。
4. **不做 thinking 强度联动**：`send_prompt` 的 `thinking` 仍然只做参数管道，
   要等 `set_thinking_level` 接入（另开任务）。

## 6. 验收对照

| 验收标准 | 证据 |
|---|---|
| `docs/development/send-modes.md` 存在且引用真实协议帧/实测记录 | 本文件 §2（文档帧）与 §3（实测帧），JSON 在 `docs/development/evidence/issue-146-send-modes/` |
| followUp：忙碌时排到下轮，settled 后自动发出（单测 + 实机） | 单测 `apps/desktop/tests/sendModes.test.ts`「忙碌时排到下轮…」；实机 §3.10（回执出现 → JSONL 里作为用户消息投递 → 回执消失，截图 `desktop-followup-*.png`） |
| parallel：忙碌或空闲时新开临时会话并发出，不打断当前会话（测试 + 实机） | 单测「并行发送：同项目下另开临时会话再发出…」；后端真实链路 `apps/desktop/src-tauri/tests/send_modes_bridge.rs`；实机 §3.10（新 Tab + 新 Pi 会话文件 + 原会话仍 running） |
| steer：真实生效（实测证据） | 单测「忙碌时加入当前…」；实机 §3.10（忙碌可点、JSONL 里真的投递） |
| 发送菜单不再有「可见但无效果」的选项 | `SEND_MODES_READY = true` + 回滚路径仍整体置灰（单测覆盖） |
| `pnpm check` 全绿 | 结果记录在 evidence README §5 |

## 7. 未覆盖 / 未验证

- macOS / Linux 未验证：实机走查只在 Windows 11 + WebView2 上跑过。
- 队列上限与并发上限：Pi 侧未定义硬上限，SOXU 也不额外限制；超长队列的内存表现未测。
- 真实工具调用场景下的 steer 时点（工具执行中途 vs 回合结束）只按文档描述，
  实测里没有工具调用。
- 助手正文的**增量**渲染（`assistantMessageEvent.delta`）尚未接入：正文在
  `message_end` 一次性出现（见 §4.5）。
- Windows 上 `pi` 只有 `.cmd` 包装时应用起不来 Pi 的平台风险（见 §3.10 末段）**未修**，
  本轮用临时 shim 绕过，不改变产品启动方式。
