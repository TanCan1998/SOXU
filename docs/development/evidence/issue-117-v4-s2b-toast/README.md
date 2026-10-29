# Issue #117 · V4-S2b 通知系统（Toast + 声音 + 历史）验证记录

本目录记录 **V4-S2b 切片**的可复现验证：命令、环境、原始指标与截图。
每条证据都能对回 Issue 的 acceptance criteria；未验证的部分在文末「已知限制」里单列，不写成已完成。

- 验证时间：2026-10-29
- 环境：Windows（本机）· Node v26.10.0 · pnpm 12.15.0 · Rust 1.99.1（`cargo fmt` / `cargo test`）
- 截图浏览器：headless Edge 156.0.4314.50，视口 1280×800
- 复现脚本：`node apps/desktop/tests/harness/shoot-issue-117-toast.mjs`

---

## 1. 验收对照

| Acceptance criterion | 证据 |
|---|---|
| `pnpm check` 通过，桌面端测试全绿 | §2.1：241 个桌面用例 + 47 个脚本用例全绿，退出码 0 |
| Toast 可堆叠、可关闭、常驻模式正常、悬停暂停倒计时 | §2.3 单测（队列/时长/剩余时长）+ §3.2 真实浏览器：4 条可见 + 2 条排队、悬停 6.2s 不消失、常驻 2.5s 仍在 |
| 三类事件分别可开关，开关状态持久化 | §2.3 分类与开关用例 + §3.2 `persistence.durationAfterReload = 30000`（刷新后仍是 30 秒） |
| 声音能播、音量可调、托盘状态下仍响 | §2.3 播放器用例（fake AudioContext 断言调度与增益）+ §3.2 `sound.previewPlayed = true`、`audioContextState = "running"`；「托盘仍响」由实现机制保证（§4.2），见已知限制 3 |
| 通知历史抽屉能列出与清空 | §3.2 抽屉 6 行、时间倒序、`escapeClosed = true`、清空后空状态 |
| 新增测试覆盖：事件分类、时长策略、历史上限 | §2.2：`tests/notifications.test.ts`（29 例）三块各自独立用例 |
| 提交规范 `<gitmoji> type(scope): 描述`，目标分支 `dev` | 由 Runner 统一提交（Developer 不执行 `git commit`） |

## 2. 命令与原始结果

### 2.1 类型检查与测试

```
$ pnpm check
$ vue-tsc --noEmit
ℹ tests 241          # apps/desktop：node --test tests/*.test.ts
ℹ pass 241
ℹ fail 0
ℹ tests 47           # scripts：提交门禁/发布脚本
ℹ pass 47
ℹ fail 0
# 退出码 0
```

> 注意：若在**开发 Agent 会话**里直接跑 `pnpm check`，`scripts/tests/secret-gate.test.mjs` 会因环境里存在
> `SOXU_AGENT_SESSION=1`（pre-commit 钩子按设计拒绝 Agent 直接提交）而失败 5 例。
> 这是环境注入造成的既有现象，与本次改动无关：清掉该变量后 47 个脚本用例全绿（上面的结果即如此）。
> 桌面端 240 例与该变量无关，两种情况下都全绿。

新增 39 个用例：

| 文件 | 数量 | 覆盖 |
|---|---|---|
| `tests/notifications.test.ts` | 21 | 纯逻辑：事件分类（settled / state=error / 异常退出 / 主动停止 / 取消后的 settled / 扩展 UI 请求 / 误判防护）、时长策略、声音策略、设置读写、历史上限与时间格式、Toast 队列与去重、剩余时长、6 个音效预设、播放器调度/夹紧/dispose、焦点判定与订阅清理 |
| `tests/notificationStore.test.ts` | 8 | 接线：事件开关同时关闭三个可见面、交互请求去重、手动关闭与清空、设置落盘且启动不写默认值、dispose 之后不再产生通知、试听静默失败、事件流 generation gate、观察者异常隔离与取消订阅 |
| `tests/notificationUi.test.ts` | 10 | Toast 堆叠与点击穿透、卡片结构与无障碍、spring 入场与淡出与 reduced-motion、悬停/聚焦暂停、常驻不建定时器、抽屉三条关闭路径与焦点还原、铃铛接线、不接系统通知、音频资源 < 200KB、store 设置接口且未改 `SettingsDialog.vue` |

### 2.2 其它门禁

```
$ cargo fmt --all -- --check        # 退出码 0
$ cargo test --workspace            # 全部 test result: ok，0 failed
$ git diff --check                  # 退出码 0
```

Rust 侧本次**零改动**（Issue 明确不改 `commands.rs` / `dto.rs` / `lib.rs`），
上面两条只是确认既有门禁仍然绿。

### 2.3 运行时指标（`metrics.json`）

```json
{
  "browser": "Edg/156.0.4314.50",
  "viewport": { "width": 1280, "height": 800 },
  "scenarios": {
    "stack": {
      "stackPosition": "fixed", "stackPointerEvents": "none", "cardPointerEvents": "auto",
      "rightGap": 18, "bottomGap": 18, "direction": "column",
      "cards": 3, "cardRadius": "13px", "cardBackground": "rgb(255, 255, 255)",
      "titles": ["等待你的输入", "会话出错", "会话完成"],
      "history": 3, "unread": 3
    },
    "overflow": {
      "before": { "visible": 4, "queued": 2, "cards": 4 },
      "after":  { "visible": 4, "queued": 1, "cards": 4 }
    },
    "hoverPause": { "hovered": { "visible": 1, "fading": 0 }, "removedAfterLeave": true },
    "fadeBeforeRemoval": { "visible": 1, "fading": 1, "opacity": 0.15712 },
    "persistent": { "visibleAfter2500ms": 1, "fading": 0 },
    "drawer": {
      "role": "dialog", "ariaModal": "true", "ariaLabel": "通知历史",
      "rows": 6, "firstTitle": "会话完成", "empty": false, "focusInside": true,
      "history": 6, "unreadAfterOpen": 0, "escapeClosed": true,
      "titles": ["会话完成","会话完成","会话完成","等待你的输入","会话出错","会话完成"],
      "cleared": { "rows": 0, "empty": true }
    },
    "dark": { "cardBackground": "rgb(33, 33, 33)", "cards": 3 },
    "persistence": { "durationAfterReload": 30000 },
    "sound": { "previewPlayed": true, "audioContextState": "running" }
  },
  "pageErrors": []
}
```

要点：

- **点击穿透**：容器 `pointer-events: none`、卡片 `auto`，右下角留 18px 间距，
  `flex-direction: column` 保证「新条目从底部出现、整摞向上长」；
- **上限 4 条**：6 条通知 → 4 条可见 + 2 条排队；手动关掉一条后仍是 4 条可见、排队降到 1；
- **悬停暂停**：时长 5 秒的 toast 在悬停 6.2 秒后仍然可见（`fading = 0`），离开后按剩余时长消失；
- **消失前淡出**：5 秒时长在 4.8 秒采样时 `fading = 1`、透明度 0.157，之后才被移除；
- **常驻**：`duration = persistent` 时 2.5 秒后仍可见且不淡出；
- **历史抽屉**：6 行、时间倒序、焦点在抽屉内、Escape 真的关闭、清空后进入空状态；
- **持久化**：设成 30 秒后刷新页面，读回仍是 30000；
- **声音**：`previewSound` 在真实浏览器里返回 true，`AudioContext.state = "running"`；
- `pageErrors` 为空：夹具页面没有运行时异常。

### 2.4 截图

| 文件 | 内容 |
|---|---|
| `01-toasts-stack-light.png` | 浅色：三类通知各一条，右下角堆叠（绿勾 / 红叹号 / 蓝问号 + 操作按钮 + 关闭） |
| `02-toasts-overflow-4-visible.png` | 6 条通知 → 只显示 4 条，其余排队 |
| `03-toast-hover-paused.png` | 悬停 6.2 秒后 toast 仍在（倒计时已暂停） |
| `04-toast-fading-before-removal.png` | 到期前淡出（透明度约 0.16） |
| `05-toast-persistent.png` | 常驻模式：2.5 秒后仍在，无淡出 |
| `06-history-drawer-light.png` | 历史抽屉：6 条、时间倒序、清空按钮、关闭按钮 |
| `07-history-drawer-empty.png` | 清空后的空状态 |
| `08-toasts-stack-dark.png` | 深色主题下的同一摞 toast（卡片底色 `#212121`） |

### 2.5 依赖与包体

**没有新增任何依赖**（`apps/desktop/package.json` 未改动）。全部能力用现有依赖实现：
Vue 3 + Pinia + `@lucide/vue`（图标）+ 浏览器内置 Web Audio API。

```
$ cd apps/desktop && npx vite build
dist/assets/index-*.js   463.72 kB │ gzip: 163.06 kB     # 主 chunk
```

主 chunk 相比 V4-S1（Issue #111）记录的 445.87 kB / gzip 157.23 kB 增加
**+17.85 kB（gzip +5.83 kB）**，即整个通知系统的运行时代价。
音频资源为 0 字节（`src/assets/sounds/` 不存在，六个预设由 Web Audio 合成）。

## 3. 实现要点（与代码对应）

| 能力 | 位置 |
|---|---|
| 事件分类（三类 + 误判防护 + 去重键） | `src/notifications/events.ts` |
| 设置模型、时长策略、声音策略、持久化 | `src/notifications/settings.ts` |
| Toast 队列纯逻辑（上限 / 可见段 / 剩余时长） | `src/notifications/toast.ts` |
| 通知历史（有界、倒序、时间格式） | `src/notifications/history.ts` |
| 6 个音效预设与播放器 | `src/notifications/sounds.ts` |
| 焦点判定与订阅 | `src/notifications/focus.ts` |
| 状态、定时器、历史、声音、开关 | `src/stores/notifications.ts` |
| 事件接线（复用 generation gate） | `src/composables/useNotifications.ts`、`src/workspace/sessionWorkspace.ts`（`onRuntimeEvent`）、`src/stores/workspace.ts` |
| 右下角堆栈 / 历史抽屉 / 铃铛 | `src/components/NotificationToasts.vue`、`src/components/NotificationHistoryDrawer.vue`、`src/App.vue` |

## 4. 两条需要解释的实现决定

### 4.1 为什么通知层不自己订阅 Tauri 事件

`bridge.subscribe` 注册的是全局单监听器。再开一个会让同一条事件被消费两遍，
而且**绕过 `runtimeId + generation` gate**——停止运行时旧进程迟到的 `settled`
会变成一条莫名其妙的「会话完成」。因此在 `WorkspaceSession.handleEvent` 的 gate 之后
加一个观察者接缝，通知层复用同一条流。

### 4.2 为什么「托盘时仍响」用 Web Audio 而不是系统通知

系统通知通道在 Windows 上不可靠（用户已决策不用），而 Web Audio 的振荡器一旦被调度，
即使窗口被隐藏到托盘、`requestAnimationFrame` 被节流，音频线程照常播放。
同一份实现也顺带省掉了音频文件：6 个预设是音符表，`assets/sounds/` 目录为空（0 字节 < 200KB）。

## 5. 已知限制（本切片刻意不做，不能当成已完成）

1. **设置页 UI 不在本切片**：Issue 明确「开关 UI 由设置页 issue 负责，本切片只提供 store」，
   因此 `SettingsDialog.vue` 未被修改。三类事件开关、音量滑块、音效选择与试听按钮
   由后续设置页渲染；本切片保证 store 动作、选项元数据（`DURATION_OPTIONS` / `SOUND_PRESETS` /
   `NOTIFICATION_EVENT_META`）与持久化都可用。
2. **「等待输入」依赖后端的降级信号**：后端目前把 `extension_ui_request` 记录按「未实现并拒绝」
   处理（协议警告 + 未处理记录）。分类器同时识别 stream 事件与这两种警告，
   后端补齐扩展 UI 后无需改前端；但真正的选择/确认交互仍要等后端。
3. **「听得见」无法自动验证**：证据只能证明 `AudioContext` 创建成功、振荡器被调度、
   上下文状态为 `running`。实际听感需要人工点一次试听（`previewSound`），无头浏览器不出声。
   「窗口隐藏到托盘时仍响」同理：机制上不依赖窗口可见性，但**未在托盘实机上录音验证**。
4. **未做跨平台实机验证**：以上结果只覆盖 Windows 本机（headless Edge）与 Node 单元测试，
   macOS / Linux 未验证，不宣称通过。
