# V4 交互盘点与契约映射

> 盘点对象：`F:\workplace\pi\soxu-prototype`（105 按钮 / 54 浮窗容器 / 42 个 click 处理）
> 对标实现：PiDeck **v0.9.8**（commit `63a185a`，tag `v0.9.8`，分支 `main`）
> SOXU 现状：10 个 Vue 组件（约 3000 行）+ 22 个 Tauri command
> 结论先行：**现有 command 只覆盖「会话运行」一条链，抽屉四面板、统计、模型切换全部空白**

---

## 一、覆盖率总览

| 状态 | 占比 | 说明 |
|---|---|---|
| 纯前端 | ~38% | 布局、主题、折叠、拖拽、Toast、命令面板 |
| 已有 command | ~20% | 会话开关/发送/取消/worktree |
| 需扩展签名 | ~12% | `send_prompt` 加 mode/thinking；`list_projects` 加分组 |
| 需新增 command | ~30% | 文件系统、Git、PTY、模型、统计、outline、通知 |

---

## 二、按区域逐项盘点

### 1. 顶栏 topbar（11 项）

| 交互 | 键位 | 现状 | 契约 | PiDeck 参考 |
|---|---|---|---|---|
| 收起侧栏 | ⌘B | 无 | 纯前端（布局状态持久化） | `components/app` |
| 后退 | ⌘[ | 无 | 纯前端（会话访问栈） | `components/app` |
| 前进 | ⌘] | 无 | 纯前端 | 同上 |
| 品牌 + 状态徽章 | — | 有 `runtime_status` | 已有 | — |
| 命令面板触发 | ⌘K | 无 | 纯前端 | `components/app` 命令面板 |
| 切换主题 | ⌘⇧L | 有 `setTheme` | 已有（含 View Transition 扩散） | `themeTransition.ts` |
| 设置 | ⌘, | 有 SettingsDialog | 已有 | `components/config` |
| 通知中心 | — | 无 | **需新增** `list_notifications` | `components/app` |
| 抽屉开关 | ⌘I | 无 | 纯前端 | — |

**待定义**：通知中心是"应用内列表"还是"系统通知历史"？PiDeck 是应用内浮层 + 系统通知双通道。

### 2. 侧栏 sidebar（13 项）

| 交互 | 现状 | 契约 | 备注 |
|---|---|---|---|
| 分组折叠（收藏/今天/本周/项目） | 无 | 纯前端 | 折叠态需持久化 |
| 会话行选中 | 有 `openSession` | 已有 | — |
| 收藏（star） | 无 | **需新增** `set_favorite` | PiDeck `components/favorites` |
| 新建会话 ⌘N | 有 | 已有 | — |
| 刷新项目 | 有 `refresh_project` | 已有 | — |
| 添加项目 | 有 `register_project` + dialog | 已有 | — |
| **项目「更多」菜单** | 无 | **待定义** | ⚠️ 见下方 |
| 会话按时间分组 | 无 | 纯前端（从 `updatedAt` 算） | 需确认时区边界 |
| 分组「查看全部」 | 无 | 纯前端（展开） | — |
| 行内 hover 工具条 | 无 | 纯前端 | 刷新 + 更多 |
| 状态点（运行/完成/警告） | 有 `runtime_status` | 已有 | 需映射到色值 |

**⚠️ 待定义：「更多」菜单项**

原型里 3 处「更多」（项目行、分组头、消息操作），都没定义内容。建议照 PiDeck：

| 位置 | 建议菜单项 |
|---|---|
| 项目行 ellipsis | 在文件管理器中打开 / 复制路径 / 重命名 / 从列表移除 / 查看 worktree / 项目设置 |
| 分组头 ellipsis | 全部展开 / 全部折叠 / 按更新时间排序 / 按名称排序 |
| 消息 ellipsis | 复制 Markdown / 复制纯文本 / 重试 / 回退到这里 / 删除这条 |

### 3. 会话区 main（14 项）

| 交互 | 现状 | 契约 |
|---|---|---|
| 标签页切换 | 有 `SessionTabs` | 已有 |
| 标签页关闭 | 有 `closeTab` | 已有 |
| 标签页拖拽排序 | 有 `moveTab` | 已有 |
| 标签页等宽 | 无 | 纯前端 |
| 消息列表虚拟滚动 | 有 `MessageList` + vue-virtual | 已有 |
| 加载更多（上翻分页） | 有 `loadMore` | 已有 |
| 工具调用块折叠 | 有 | 已有 |
| **Diff 块渲染** | 无 | **需新增**（数据来自 tool output，渲染需 shiki） |
| 消息复制 | 无 | 纯前端（clipboard） |
| **消息重试** | 无 | **需新增** `retry_message` |
| **回退到这里** | 无 | **需新增** `rewind_to` |
| **followup 建议** | 无 | **需新增**（PiDeck `promptSuggestion`） |
| 回到最新 | 无 | 纯前端 |
| 正文宽度固定/自适应 | 无 | 纯前端 |

### 4. 刻度轴 rail（4 项）

| 交互 | 现状 | 契约 |
|---|---|---|
| 刻度渲染 | 无 | **需新增** `session_outline` |
| 刻度点击跳转 | 无 | 同上（跳到消息 id） |
| 预览卡（标题+描述） | 无 | 同上 |
| 临时会话 ⌘T | 有 `open_temporary_session` | 已有 |

**契约细节**：`session_outline` 需返回 `[{ id, role, title, time, entryId, pending }]`，与 PiDeck `OutlineRailItem` 一致。数据源是 `crates/session-index`。

### 5. 输入区 composer（8 项）

| 交互 | 现状 | 契约 |
|---|---|---|
| 发送 | 有 `send_prompt` | 已有 |
| **发送模式三选**（加入当前/排到下轮/并行发送） | 无 | **需扩展** `send_prompt(sessionId, text, mode)` |
| **模型切换** | 无 | **需新增** `list_models` / `set_model` |
| **思考强度** | 无 | **需扩展** `send_prompt(…, thinking)` |
| **上下文环 + 浮窗** | 无 | **需新增** `session_stats` |
| 附加文件 ⌘U | 无 | **需新增** `attach_file` |
| 输入框自动伸缩 | 无 | 纯前端 |
| 统计行（轮次/token/缓存） | 无 | **需新增**（同 `session_stats`） |

**契约细节**：`session_stats` 需返回：
```ts
{
  context: { used: number; total: number },
  turn: { firstTokenMs, durationMs, streamTokPerSec, avgTokPerSec, cacheHitPct },
  process: { rssMb, cpuPct, childCount },
  session: { loaded, total, worktree, inputTokens, outputTokens, retryBudget }
}
```

### 6. 抽屉 inspector × 4（31 项，**全部需新增**）

#### 6.1 文件（7 项）
| 交互 | 契约 |
|---|---|
| 目录树懒加载 | `list_dir(path)` → `[{name, kind, size, mtime}]` |
| 排序（名称/时间/大小） | 纯前端 |
| 树形/平铺切换 | 纯前端 |
| 文件内搜索 | `search_files(root, q)` |
| 新建文件 | `write_file(path, content)` |
| 刷新 | 重调 `list_dir` |
| 点击打开 | `read_file(path)` |

#### 6.2 Git（7 项）
| 交互 | 契约 |
|---|---|
| 更改列表（M/A/D） | `git_status(cwd)` → `[{path, status, add, del}]` |
| 单文件 diff | `git_diff(cwd, path)` |
| 树形/平铺切换 | 纯前端 |
| 全部折叠 | 纯前端 |
| 刷新 | 重调 |
| 推送 | `git_push(cwd)` |
| 拉取 | `git_pull(cwd)` |

#### 6.3 终端（2 项）
| 交互 | 契约 |
|---|---|
| PTY 创建/输入/输出 | `create_pty` / `write_pty` / `resize_pty` / `close_pty` |
| 终端渲染 | 前端 xterm.js |

#### 6.4 搜索（2 项）
| 交互 | 契约 |
|---|---|
| 会话内搜索 | **已有规划**（Issue #109 `session-index` 线性扫描） |
| 结果跳转 | 纯前端 |

### 7. 命令面板 palette（4 项）

| 交互 | 契约 |
|---|---|
| 拼音首字母搜索（`dk` → 打开设置） | 纯前端（需 `pinyin-pro`） |
| 模糊匹配 + 高亮 | 纯前端 |
| ↑↓ 选择 / ↵ 执行 / Esc 关闭 | 纯前端 |
| 命令注册表 | 纯前端（需与设置项共用一份元数据） |

### 8. 设置 settings × 4 页（26 项）

| 页 | 项数 | 契约 |
|---|---|---|
| 外观 | 6（主题/强调色/字号/界面字体/代码字体/正文宽度） | 纯前端 + `setTheme` |
| 会话 | 6（滚动/Enter/工具调用/时间戳/思考强度/清空） | 纯前端 + `set_model` |
| 扩展 | 12+（扩展开关、技能、MCP） | **需新增** `list_extensions` / `set_extension` |
| 系统 | 7（更新/通知/托盘/检查更新/重置布局/数据目录/关于） | 混合，托盘已有 |

### 9. Toast（1 项）

纯前端。需支持 `{ icon, title, text, actions[] }`。

---

## 三、契约缺口汇总

### 需新增 command（按模块）

```
filesystem:  list_dir, read_file, write_file, create_file, rename_path, delete_path, search_files
git:         git_status, git_diff, git_log, git_stage, git_commit, git_push, git_pull, git_branches
pty:         create_pty, write_pty, resize_pty, close_pty
model:       list_models, set_model, get_model
stats:       session_stats
outline:     session_outline
session:     retry_message, rewind_to, set_favorite, attach_file
extension:   list_extensions, set_extension
notify:      list_notifications
```

### 需扩展签名

```ts
// 现在
send_prompt(sessionId: string, text: string): Promise<void>
// 需要
send_prompt(sessionId, text, opts?: {
  mode?: "current" | "next" | "parallel";
  thinking?: "low" | "medium" | "high";
  attachments?: string[];
}): Promise<void>
```

### 纯前端（不需要接口）

布局宽度/折叠态、主题/强调色/字号/字体、命令面板、Toast、拖拽排序、虚拟滚动、Diff 渲染、快捷键。

---

## 四、技术选型核对

### 已有，够用

| 能力 | 现状 |
|---|---|
| 框架 | Vue 3.5.44 + TS 6.0.3 + Vite 8.3.5 |
| 样式 | Tailwind 4.3.3 + tailwind-merge + cva + clsx |
| 无样式组件 | **reka-ui 2.11**（Radix Vue：DropdownMenu/Popover/Dialog/Tooltip 行为全现成） |
| 图标 | @lucide/vue 1.61 |
| 状态 | Pinia 4.1 |
| 虚拟滚动 | @tanstack/vue-virtual 3.13 |
| 工具 | @vueuse/core 15.0 |

### 缺口

| 需求 | 建议 | 理由 |
|---|---|---|
| PTY | `portable-pty`（Rust） | Tauri 生态标准方案，跨平台 |
| 文件监听 | `notify` crate | 文件树自动刷新 |
| Git 操作 | 调 `git` CLI（不用 `git2`） | 与现有 `gh` 一致，避免 libgit2 编译负担 |
| 代码高亮 / Diff | `shiki` | PiDeck 同款，体积可控，按需加载 |
| 拼音搜索 | `pinyin-pro` | 3KB gzip，支持首字母 |
| 终端渲染 | `@xterm/xterm` | 事实标准 |
| Markdown 渲染 | 已有 `markdown-it` | 需加 `shiki` 高亮插件 |

### 性能约束（用户明确目标：减少资源占用）

1. **虚拟滚动必须覆盖消息列表 + 文件树 + Git 列表**（三者都可能是万级条目）
2. **shiki 按需加载语言包**，不要全量引入（全量约 3MB）
3. **PTY 输出要节流**，后端 16ms 合并一次，不要逐字节发事件
4. **刻度轴沿用 PiDeck 的滑动窗口**（最多 30 条），不要渲染全部检查点
5. **session-index 用线性扫描**（Issue #109 已定），不建倒排索引

---

## 五、建议的实施顺序（纵向切片）

每个切片端到端：`command → Pinia store → Vue 组件 → 交互`。

| 批次 | 内容 | 理由 |
|---|---|---|
| **S0** | 设计 token 落地（原型 CSS 变量 → Tailwind theme） | 所有后续切片的前提，纯机械 |
| **S1** | 会话主链路 UI 重写（tabs / 消息 / composer 基础） | 接口全有，最快见效 |
| **S2** | 设置 4 页（纯前端） | 无接口依赖，可与 S1 并行 |
| **S3** | 统计 + 上下文环（`session_stats`） | 单接口，视觉收益大 |
| **S4** | 刻度轴（`session_outline`） | 依赖 session-index，已有基础 |
| **S5** | 文件抽屉（`list_dir` 等 7 个） | 第一个"新世界"抽屉 |
| **S6** | Git 抽屉（8 个 command） | 依赖 git CLI 封装 |
| **S7** | 搜索抽屉（Issue #109） | 依赖 session-index 扩展 |
| **S8** | 终端抽屉（PTY 4 个） | 最重，放最后 |
| **S9** | 命令面板 + 拼音 | 纯前端，最后统一接 |
