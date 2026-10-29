# 通知系统（V4-S2b，Issue #117）

右下角 Toast、声音提醒与通知历史。**全部在应用内**，不接系统通知通道：
用户明确决策「Windows 系统通知不可靠，经常不弹」，将来只有 iOS 端才走系统通道。

- 代码：`apps/desktop/src/notifications/`（纯逻辑）+ `stores/notifications.ts`（状态与定时器）
  + `components/NotificationToasts.vue`、`components/NotificationHistoryDrawer.vue`（呈现）
- 接线：`composables/useNotifications.ts`，在 `App.vue` 里创建一次
- 验证：`docs/development/evidence/issue-117-v4-s2b-toast/README.md`

---

## 1. 事件从哪来

通知只消费**现有的**会话事件流，不新增后端 command：

```
Pi RPC ──▶ soxu-agent-runtime ──▶ Tauri 事件 soxu://runtime-event
                                        │
                          WorkspaceSession.handleEvent（runtimeId + generation gate）
                                        │
                             onRuntimeEvent(observer)   ← 本切片新增的唯一接缝
                                        │
                     useNotifications ─▶ useNotificationStore.handleRuntimeEvent
```

关键点：

1. **复用同一个 gate**。观察者在 `handleEvent` 的 generation 判定**之后**被调用，
   因此上一代运行时的迟到事件不会弹出通知——否则「停止后旧进程又发一条 settled」
   会变成一条莫名其妙的「会话完成」。观察者同时拿到处理前的 Tab 状态，
   用来区分「这一轮自己结束」与「用户按了停止」。
2. **不另开 Tauri 监听器**。`bridge.subscribe` 是单次注册的全局监听器，
   再加一个就等于同一个事件被消费两遍；观察者模式让通知层与 Tab 状态共享同一条流。
3. **观察者异常隔离**。通知是旁路功能：任何一个观察者抛错都被吞掉，
   主链路的 Tab 状态已经写完，不能因为通知坏了让会话停在错误状态。

## 2. 三类事件怎么判定

| 事件 | 判定依据 | 默认 | 音效 |
|---|---|---|---|
| 会话完成 `sessionCompleted` | `settled` | 开 | chime |
| 会话出错 `sessionError` | `state=error`，或**异常退出**（非 `requested_abort` 且退出码 ≠ 0） | 开 | alert |
| 等待输入 `awaitingInput` | 扩展 UI 交互请求（select / confirm / input / editor） | 关 | pop |

细节：

- **`agent_end` 不能代替 `settled`**：一轮可能有多段回答，只有 `agent_settled` 才是「完全安定」。
- **主动停止不算错误**：`requested_abort` 或退出码 0 一律不提醒（用户自己按的停止键）。
- **取消后到达的 `settled` 也不算完成**：用户按了停止，这一轮不是「成功结束」。
  观察者因此会拿到**事件处理前**的 Tab 状态（`RuntimeEventContext.previousStatus`），
  因为 `settled` 分支本身已经把状态改成 `ready` 了。
- **等待输入的兼容处理**：后端目前把 `extension_ui_request` 记录当作未处理并降级成
  `warning`（`crates/agent-runtime/src/connection.rs`）。分类器同时识别
  - `stream` 事件名属于扩展 UI 请求；
  - `stream.data` 里 `method`/`interaction`/`type`/`kind` 的值是 select/confirm/input/editor；
  - 两种降级文案（`extension ui request is not implemented` 与 `未处理的记录类型：extension_ui_request`）。

  等后端补齐扩展 UI 后，同一段判定不需要改。**只有白名单命中才算交互**：
  普通 `message_update`、`tool_call` 一律返回 null，宁可少提醒也不误报。
- **合并**：一次交互请求会产生多条记录（未处理记录 + 协议警告），
  它们共享 `dedupeKey = awaitingInput:<sessionId>`，队列里已有一条未消失的就不再重复弹。
  其他两类不合并——两次完成就是两次提醒。

## 3. 展示时长策略

```
resolveToastDuration(kind, settings, requestedMs):
  kind === sessionError → requestedMs ?? 10_000      // 错误类不跟随全局
  否则                  → settings.duration === "persistent" ? null : settings.duration
```

- **全局时长覆盖调用方**（5s / 10s / 30s / 常驻），这是 Issue 的明确要求；
- **错误/警告类除外**：出错信息通常更长更需要读，用户把全局调成 5 秒不代表希望错误也只停 5 秒；
- **常驻**返回 `null`，store 不建任何定时器，只能手动关。

淡出：到期前 `TOAST_FADE_LEAD_MS`（320ms，对齐 `--dur-slow`）先置 `fading`，
CSS 把透明度降到 0，随后才真正移除——「消失前淡出」而不是「啪」地消失。

## 4. 队列与并发上限

- 右下角最多同时 4 条（`MAX_VISIBLE_TOASTS`），超出排队；关掉一条，队列头补上。
- 队列是 `ref<ToastItem[]>`，可见段是 `slice(0, 4)`；**上限同时约束渲染与内存**。
- 每条 toast 的淡出/过期定时器登记在 store 的 `Map<id, ToastTiming>` 里：
  创建者与清理者是同一个模块（`dismiss` / `dispose` / 到期回调）。
- 悬停暂停把「已消耗时间」折算成剩余时长写回 `remaining`，恢复时按剩余时长重新计时；
  反复进出不会让倒计时变长或变短。键盘用户把焦点移进卡片同样暂停（`focusin/focusout`）。

## 5. 声音

- **Web Audio 合成，不放音频文件**：6 个预设集中在 `notifications/sounds.ts` 的 `SOUND_TONES`
  音符表里（wave / frequency / startMs / durationMs / gain），仓库里 `assets/sounds/` 不必存在。
  测试会断言该目录总大小 < 200KB（现在为 0）。
- **托盘状态下仍会响**：音频由 `AudioContext` 调度，不依赖窗口可见性或系统通知通道；
  窗口隐藏/最小化时 `requestAnimationFrame` 会被节流，但已调度的振荡器照常播放。
- 播放器只持有一个 `AudioContext`（首次播放时创建），`dispose()` 关闭；
  每个音在 `onended` 里断开节点，长时间运行不会累积音频节点。
- 音量 0 直接不播（不创建节点）；没有 AudioContext（测试环境 / 被策略禁用）时静默返回 false，绝不抛错。

## 6. 焦点与「仅失焦时提醒」

`notifications/focus.ts` 用一层最小表面（`hasFocus` / `visibilityState` / `on` / `off`）判定：

```
有焦点 = document.hasFocus() && document.visibilityState !== "hidden"
```

两个条件都要：只看 `hasFocus` 时，隐藏到托盘的窗口在部分平台上仍报「有焦点」，
「托盘时也要响」就失效；只看 visibility 时，可见但被切到后台的窗口会被当成有焦点。

**仅失焦时提醒只影响声音，不影响 toast**：窗口有焦点时通知照常显示（用户可能正看着别的 Tab），
只是不发声。默认开启——通知的意义就是「你不在看的时候提醒你」。

## 7. 设置与持久化

存储键 `soxu.notifications`（独立成键，清主题/投递方式不会连带清掉通知设置），
值是一份 JSON：

```json
{
  "duration": 10000,
  "onlyWhenUnfocused": true,
  "soundEnabled": true,
  "volume": 0.6,
  "events": {
    "sessionCompleted": { "enabled": true, "sound": "chime" },
    "sessionError": { "enabled": true, "sound": "alert" },
    "awaitingInput": { "enabled": false, "sound": "pop" }
  }
}
```

- **逐字段校验**：不认识的值退回默认，一个坏字段不会把整份设置清空；JSON 坏掉才整体回退。
- **只在用户改动时写盘**：启动不把默认值当用户偏好写进去（与 `useBusyDelivery` 同一套纪律）。
- **事件开关关闭时三个可见面同时关闭**：不弹窗、不记历史、不发声。
  否则会出现「弹窗关了但历史里还一直长」的半开状态。

### 给设置页（下一个切片）的接口

本切片**不改 `SettingsDialog.vue`**，只把能力放在 store 上：

| store 成员 | 用途 |
|---|---|
| `settings` | 只读快照（duration / onlyWhenUnfocused / soundEnabled / volume / events） |
| `setDuration` / `setOnlyWhenUnfocused` / `setSoundEnabled` / `setVolume` | 全局设置 |
| `setEventEnabled(kind, enabled)` / `setEventSound(kind, sound)` | 三类事件各自开关与音效 |
| `previewSound(kind?)` | 试听（不受「仅失焦」与事件开关限制，仍用当前音量） |
| `resetSettings()` | 恢复默认 |
| `DURATION_OPTIONS` / `SOUND_PRESETS` / `NOTIFICATION_EVENT_META` | 选项文案与默认值（唯一真源） |

## 8. 通知历史

- **只在本次运行内存在**：内存数组、重启清空，不写 localStorage（正文里可能带会话标题/片段）。
- **有硬上限** `MAX_NOTIFICATION_HISTORY = 200`：超出丢弃最旧的，避免长时间运行缓慢泄漏。
- 时间倒序；时间格式固定 `HH:MM:SS`（不用 `toLocaleTimeString`，各语言环境输出不一致，列对不齐）。
- 抽屉三条关闭路径（× / 遮罩 / Escape），打开时把焦点移进抽屉、关闭时还给原元素。
- 未读数：抽屉打开即清零，但不清空历史。

## 9. 已知限制

1. **设置页 UI 不在本切片**：三类事件的开关、音量滑块、音效选择与试听按钮由设置页 issue 渲染，
   本切片只保证 store 接口与持久化可用（证据脚本里用 store 动作演示）。
2. **扩展 UI 交互请求在后端仍是「未实现并拒绝」**：等待输入通知能识别到这类记录，
   但真正的选择/确认交互要等后端补齐扩展 UI。
3. **无法自动验证「听得见」**：证据脚本只能证明 `AudioContext` 创建成功、振荡器调度成功、
   状态为 `running`；实际听感需要人工试听（`previewSound`）。
4. **未做跨平台实机验证**：仅 Windows 本机（headless Edge 156）与 Node 26 单元测试，macOS/Linux 未验证。
