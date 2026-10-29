# V4 交互定义（决策版）

> 上一份《interaction-inventory.md》是覆盖率盘点；本文档是**决策后的最终定义**，
> 全部条目以 PiDeck v0.9.8 源码实证为依据（文件:行号已标）。
> 决策记录：发送模式照 PiDeck 三选；通知用应用内右下角弹窗（不用 Windows 通知）；
> 更多菜单照 PiDeck 增删；会话分组按设备时区 0 点。

---

## 一、发送行为（Composer 三选菜单）

PiDeck 源码：`components/session/ComposerPanels.tsx:368-410` + `hooks/useAskPanel.ts`

| 界面文案 | 内部名 | 语义 | 可用条件 |
|---|---|---|---|
| **加入当前** | steer | 插进正在进行的回答 | **仅 agent 忙碌时可用** |
| **排到下轮** | followUp | 本轮结束后自动发送 | 总是可用 |
| **并行发送** | parallel | 独立会话后台处理，不打断当前输出 | 草稿非空 + **纯文本**（带图置灰）+ 有 projectId |

> 内部名保留 PiDeck 原词便于对照源码。菜单横条为「下一条消息将 加入当前」。

### 并行发送的完整机制（useAskPanel.ts:1-30 注释实证）

1. **匿名会话**：`sessions.createAnonymous({projectId, title, backend})` —— 独立子进程、
   **不落盘**（noSession）、不进侧栏会话列表，关闭时由 detach 事件回收
2. **上下文注入**：pi RPC 无跨进程上下文通道 → 经 `SendPromptInput.agentMessage` 传给模型
   （模型可见、UI 时间线不可见），首条 user 消息仍是用户原文
3. **originSessionId**：记录发起并行问询的主会话，是「带回主线」的落点
4. **成功后清空草稿**：并行会话已接管这条问题
5. **胶囊 UI**（AskPanelOverlay）：右下角悬浮胶囊，可追问（`sendFollowUp` 复用会话）、可关闭、可带回主线

### SOXU 契约

```ts
// 已有基建：open_temporary_session（不落盘体系）/ E_TEMPORARY_SESSION_UNPROMOTABLE
// 需新增：
send_parallel(projectId: string, text: string, originSessionId: string): Promise<{ tempSessionId: string }>
  // 1. 复用现有临时会话，否则 open_temporary_session(projectId)
  // 2. 组上下文块（从 origin 会话消息缓存取，照 askPanelContext 口径）
  // 3. send_prompt(tempSessionId, text, { agentMessage: contextBlock })
  // 4. 前端胶囊绑定 originSessionId
bring_back_to_main(tempSessionId: string): void   // 并行回复插入主会话 composer
```

**与 PiDeck 的差异**：PiDeck 用 jotai 全局单例（一个并行胶囊），SOXU 照搬即可，不做多胶囊。

### 忙碌时默认投递（设置项）

PiDeck `app-ui-atoms.ts:155`：`busySendDeliveryAtom = atom<BusySendDelivery>("steer")`
设置项两选：`steer`（插入当前回合）/ `followUp`（排队到下一轮）。
**SOXU 照搬**：设置 → 会话 → 新增「忙碌时发送」选择器，默认 `steer`。
点发送按钮（不带菜单）时按此默认行为投递。

---

## 二、通知（应用内右下角弹窗，不用 Windows 通知）

用户决策：**Windows 通知不可靠，全部改应用内 toast（右下角）；iOS 端用系统通知。**

PiDeck 源码：`components/app/settings/NotificationTab.tsx`（220 行）+ `utils/notice.ts`

### 2.1 提醒事件（三事件，每事件独立开关 + 音效）

| 事件 | 触发时机 | 默认 |
|---|---|---|
| 会话完成 | Agent 成功结束一轮回答 | 开 |
| 会话出错 | 状态变为 error | 开 |
| 等待输入 | Agent 发起 select/confirm/input/editor 交互 | **关** |

### 2.2 通知开关

| 开关 | 语义 | 默认 |
|---|---|---|
| 完成响应时通知 | 总开关 | 开 |
| 仅失焦时提醒 | 窗口有焦点时保持安静（应用内 toast 不受此门控） | 关 |
| Ask 提问通知 | Agent 向用户提问时通知 | 关 |
| Agent 数量提醒 | 激活 Agent ≥15 时启动提醒关闭空闲会话 | 开 |
| 公告通知 | 收到新公告弹出（输入/运行中自动延后） | 开 |

### 2.3 应用内 toast 设置

| 项 | 语义 |
|---|---|
| 展示时长 | 预设：5s / 10s / 30s / 常驻（手动关闭）；**覆盖调用方时长，错误/警告除外** |
| 通知历史 | 本次运行期间全部通知，内存记录，重启清空 |

### 2.4 声音提醒

- 总开关 + 音量滑块
- 三事件各自：开关 + 音效下拉（预设：叮咚/铃铛/气泡/蜂鸣/警报/提示音）+ 试听按钮
- 自定义音频：导入 wav/mp3/ogg/m4a/flac ≤5MB，可删除
- **窗口隐藏到托盘也会响**

### 2.5 SOXU 落地形态

```
桌面端：全部应用内 toast（右下角），NotificationTap 组件，reka-ui Toast
        —— 不调用 tauri-plugin-notification
iOS 端：系统通知通道（将来实现时接）
声音：  Web Audio API 播放 wav 资产（PiDeck 同款 sounds/*.wav）
历史：  Pinia store 内存数组，重启清空
```

**契约**：通知是纯前端事件（从 session 事件流派生），**无新增 command**。
例外：`Agent 数量提醒` 需要启动时统计激活数——`runtime_status` 已有。

---

## 三、「更多」菜单（⋯ 按钮）

PiDeck 源码：`components/sidebar/SidebarComponents.tsx:716-860`（项目菜单 130 行）

### 3.1 项目行「⋯」

PiDeck 分四组（新建/打开定位/管理/导入+危险区），SOXU 按功能增删：

| 组 | 菜单项 | SOXU 取舍 |
|---|---|---|
| **新建** | 新会话 / 新临时会话 | ✅ 全留（`start_session` / `open_temporary_session` 已有） |
| **打开定位** | 在文件管理器中打开 / 用编辑器打开 / 复制项目路径 | ✅ 全留（需新增 `reveal_in_fm` / `open_with_editor`，`tauri-plugin-opener` 或 shell） |
| **管理** | 置顶 / 重命名 / 会话管理 / 过滤会话 / 会话排序子菜单 / 刷新项目 / 启用 worktree | ✅ 留：置顶、重命名、刷新项目、worktree 开关（已有）；✂️ 砍：过滤、排序子菜单（首版过度设计） |
| **导入** | Codex/Claude/Qoder/OpenCode/ZCode/WorkBuddy/Cursor/Kimi×2/Minimax/目录 | ✂️ **首版砍掉**，留扩展点 |
| **危险区** | 移除项目（destructive 红色） | ✅ 留（需 `plan_worktree_removal` 式两段确认，已有基建） |

**SOXU 最终菜单**（9 项，3 组）：

```
新建        新会话 ⌘N / 新临时会话 ⌘T
打开        在文件管理器中显示 / 用编辑器打开 / 复制路径
管理        置顶 / 重命名 / 刷新 / 启用 worktree（toggle）/ 移除项目（红）
```

### 3.2 会话行「⋯」

PiDeck 源码：`SidebarComponents.tsx:1114-1258`（SessionContextMenu）

| PiDeck 项 | SOXU 取舍 |
|---|---|
| 重命名 | ✅ 留 |
| 置顶 | ✅ 留 |
| 创建侧边任务 | ✂️ 砍（PiDeck 分屏特性，SOXU 无） |
| 会话代理设置 | ✂️ 砍（SOXU 无 proxy 概念） |
| 复制会话 | ✂️ 砍（导出 HTML 的替代，首版不做导出） |
| 导出 HTML | ✂️ 砍，留扩展点 |
| 复制会话文件路径 | ✅ 留 |
| 打开会话文件 | ✅ 留 |
| RPC 日志开关/查看 | ✂️ 砍（SOXU 无 RPC 日志面板） |
| 关闭 Agent | ✅ 留（= stop_session） |
| 归档会话 | ✅ 留 |
| 删除会话（红） | ✅ 留（两段确认） |

**SOXU 最终菜单**（8 项）：

```
重命名 / 置顶 / 复制文件路径 / 打开会话文件
─────
关闭会话（= stop）/ 归档
─────
删除会话（红，两段确认）
```

### 3.3 消息操作（msg-actions）

原型已有三个按钮，PiDeck 对应物 + 建议：

| 按钮 | 语义 | 契约 |
|---|---|---|
| 复制 | 复制该条 markdown 源 | 纯前端 |
| 重试 | 从该条重新生成，截断其后 | **需新增** `retry_message` |
| 回退到这里 | 会话状态回退到该条之前 | **需新增** `rewind_to` |

### 3.4 顶栏后留的三个死按钮

| 按钮 | 定义 |
|---|---|
| 后退 ⌘[ | 会话内导航栈后退（消息锚点级别，随消息点击/刻度跳转入栈） |
| 前进 ⌘] | 同上，向前 |
| 通知铃铛 | 打开**通知历史**抽屉（本次运行期间的全部 toast，内存） |

---

## 四、会话分组（按设备时区 0 点）

用户决策：**收藏 / 今天 / 本周 / 项目**，时间边界 = 设备时区 0 点。

```ts
// 纯前端计算，无 command
function sessionGroup(s: { updatedAt: number; favorite: boolean }): "favorites" | "today" | "week" | "earlier" {
  if (s.favorite) return "favorites";
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()); // 设备时区 0 点
  if (s.updatedAt >= midnight.getTime()) return "today";
  const weekAgo = midnight.getTime() - 6 * 86400_000;   // 今天 + 往前 6 天 = 「本周」7 天
  if (s.updatedAt >= weekAgo) return "week";
  return "earlier";
}
```

原型四组改为：**收藏 / 今天 / 最近 7 天 / 更早**（「本周」有歧义——自然周还是滚动 7 天，用「最近 7 天」消除）。

---

## 五、未使用依赖评估

| 依赖 | 体积 | 结论 | 理由 |
|---|---|---|---|
| `vue-router` | ~30KB | **删** | SOXU 是单窗口工作台（tab 切换），无路由需求；将来要多页面再加回来 |
| `@vueuse/core` | ~20KB tree-shaken | **留** | V4 将大量用到：`useLocalStorage`（布局/设置持久化）、`useEventListener`（快捷键）、`useVirtualizer` 配套、`useResizeObserver`（刻度轴）、`useThrottleFn`（PTY 输出）。**V4 实施前留** |
| `class-variance-authority` | ~2KB | **留** | reka-ui + Tailwind 的组件变体管理标准配对（shadcn 模式），写 UI 组件库时必需，2KB 几乎零成本 |
| `markdown-it` | ~30KB | **留但需激活** | 消息渲染必需（原型里的代码块/表格）。但注意：PiDeck 用的是 TipTap 富文本 + 自己的渲染管线。SOXU 决策：**消息渲染用 markdown-it + shiki 高亮**，不上 TipTap（太重）。markdown-it 需在 S1 切片激活并配 shiki |

**另外确认**：`reka-ui` 只用了 Tooltip——V4 要全面启用（DropdownMenu/Popover/Dialog/Tabs/Switch/Toast），这是 54 个浮窗的行为基座。

---

## 六、更新后的契约缺口（增量）

相对《interaction-inventory.md》的变化：

### 新增
```
send_parallel(projectId, text, originSessionId) → { tempSessionId }
bring_back_to_main(tempSessionId)
reveal_in_fm(path) / open_with_editor(path)     // 也可用 tauri-plugin-opener 现成插件
set_favorite(sessionId, fav)
toggle_pin(sessionId | projectId)
rename_session(sessionId, title)
archive_session(sessionId)
delete_session(sessionId)                        // 两段确认
```

### 扩展
```ts
send_prompt(sessionId, text, opts?: {
  mode?: "steer" | "followUp"        // 忙碌时投递；空闲时忽略
  thinking?: "low" | "medium" | "high"
  attachments?: string[]             // 首版纯文本，字段预留
})
```

### 删除（相对上一份的过度设计）
```
- 并行发送 = 新开会话的旧理解 → 修正为匿名临时会话 + 胶囊
- 通知用系统通道 → 改为纯应用内 toast
```

---

## 七、待实施顺序（不变）

S0 设计 token → S1 会话主链路 → S2 设置 → S3 统计/上下文环 → S4 刻度轴
→ S5 文件抽屉 → S6 Git 抽屉 → S7 搜索 → S8 终端 → S9 命令面板

发送三选与通知 toast 归入 **S1**（会话主链路不可拆分）。
