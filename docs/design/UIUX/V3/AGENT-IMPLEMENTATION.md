# SOXU V3 — Agent Implementation Contract

## 来源与适用范围

本规范针对用户确认的 V3 视觉和已有 GitHub 仓库 `TanCan1998/SOXU`。**UI 不可自行更换 Design Tokens/品牌标志，不可把 `pic_temp/` 视为产品界面。**

仓库已存在：
- `apps/desktop/src/App.vue`：M0 单文件本地预览；具备页面切换、文本输入、浅深色切换和 inspector 基础布局，但持久化/RPC 未接入。
- `apps/desktop/src/UiIcon.vue`：手写图标，`settings` 路径几何不对称，正式实现替换为现有标准 Lucide 组件。
- `apps/desktop/src/assets/soxu-64.png`, `soxu-256.png`：已确认的交织 S/X 图标，**优先使用**。
- 包内可用依赖（不新增）`Vue 3.5.44, Pinia 4.1.0, @lucide/vue 1.61.0, Reka UI 2.11.0, Tailwind CSS 4.3.3, @vueuse/core 15.0.0, @tanstack/vue-virtual 3.13.41, vue-router 5.4.0`；依赖版本以仓库实际锁文件为准。

## Token 表

| token | light | dark | 定义 |
|---|---|---|---|
| `--soxu-bg` | `#fcfcfc` | `#191717` | 主背景，用户明确要求精确值 |
| `--soxu-accent` | `#3a83f7` | `#3a83f7` | 强调色，用户明确要求精确值 |
| `--soxu-sidebar` | `#f5f5f6` | `#222020` | 左栏建议值 |
| `--soxu-panel` | `#fcfcfc` | `#191717` | 面板建议值 |
| `--soxu-selected` | `#e8f0ff` | `#2c3445` | 选中态建议值 |
| `--soxu-fg` | `#191919` | `#f4f3f3` | 主文本建议值 |
| `--soxu-border` | `#e9e9ed` | `#363333` | 分隔线建议值 |

将 Token 放在 `apps/desktop/src/styles/tokens.css` 或等效文件，严禁组件中散布硬编码颜色；截图验收保证主工作区的 computed background 与上述精确值一致。浅深主题均可按系统偏好联动。

## 组件映射（尽可能复用已有依赖）

| V3 元素 | 推荐 Vue 实现 | 优先已有组件/依赖 |
|---|---|---|
| AppShell / 左侧栏 / 项目列表 | `AppShell.vue`, `ProjectSidebar.vue` | Vue Router / Pinia |
| SOXU 图标 | `BrandMark.vue` | `src/assets/soxu-64.png`, `soxu-256.png`（真实 PNG） |
| 导航图标、设置齿轮 | `SidebarNav.vue`, `SettingsButton.vue` | **@lucide/vue** `Settings`, `MessageCircle`, `Folder`, `PanelsTopLeft` 等；统一 `size=20` / `strokeWidth=1.75` |
| 临时会话 | `TemporarySessionAction.vue` + `sessions` Store | Vue/Pinia；`type: 'temporary'`（**禁止自动落盘**） |
| 对话右侧快捷跳转 | `ConversationNavigator.vue` | `@tanstack/vue-virtual` + 服务器 cursor / stable message ID |
| 全局搜索/命令 | `CommandPalette.vue` | Reka UI `Dialog`, VueUse 快捷键 |
| 上下文 `···` 菜单 | `ConversationMenu.vue` | Reka UI `DropdownMenu` + Lucide `Ellipsis`；**不可使用 Terminal 图标** |
| Tooltip、Switch、Popover | 统一原语 | Reka UI + class-variance-authority + clsx + tailwind-merge |
| 已加载消息 | `MessageList.vue` | `@tanstack/vue-virtual`，不要渲染整段大 JSONL |

### 设置齿轮硬约束

在 `App.vue` 的左下侧导航位置采用：

```vue
<script setup lang="ts">
import { Settings } from '@lucide/vue';
</script>
<template>
  <button class="soxu-rail-button" aria-label="设置" title="设置">
    <Settings :size="20" :stroke-width="1.75" aria-hidden="true" />
  </button>
</template>
<style scoped>
.soxu-rail-button { width: 42px; height: 42px; display: grid; place-items: center; padding: 0; }
.soxu-rail-button > svg { display: block; flex: none; transform: none; }
</style>
```

`Settings` 图形来自标准 Lucide；不继续维护本仓库 `UiIcon.vue` 中手写的 `settings` 多边形路径。若 `@lucide/vue` 未实际导出该命名组件，先检查当前包导出并在**现有图标包**中选其等价组件，勿额外安装另一套图标库。

### 临时会话生命周期（产品语义）

```ts
type SessionMode = 'persistent' | 'temporary';
interface SessionDraft { id: string; projectId: string; mode: SessionMode; }
```

1. 创建临时会话：仅在内存 Session Store 中分配 ID，UI 显示“临时”，侧栏 `recentSessions` 不包含该 ID。
2. 可在临时会话中对话；与 Pi 的运行 SessionId 可以存在，但不能把聊天内容自动写入普通会话历史。具体是否存临时文件/日志要有明确生命周期和清理策略，且不向普通历史泄漏。
3. 用户选择转存时，调用 Session Catalog 的显式创建/提交接口，成功后更改 `mode` 并加入左侧历史；失败保留临时会话及原始内容，显示原因。
4. 应用关闭、明确结束临时会话或超过明确约定的生命周期时，释放订阅和相关资源；切换到其他会话时可以保留本次运行时临时会话，但默认不进入历史。
5. UI 不能在后端尚未实现时声称“保存成功”。

## 无视觉模型的 UI 实施闭环

- 以本包 HTML + 截图 + Token 表为不可随意修改的基准，Agent 读取 DOM/CSS 和组件映射实现 Vue。
- Playwright 同分辨率运行快照，对比布局 box、颜色、溢出、焦点、点击、主题/临时会话状态；截图 diff 只量化差异，不等价于设计美观确认。
- 正式品牌图标来源严格限定为现有仓库 `src/assets/soxu-256.png`，不从静态截图裁剪替代，不新增视觉重绘。
- 场景至少包括：1600×950 浅色/深色、1280×800、1024×768、750×800；临时会话空状态、有消息、转存失败、无搜索结果、对话跳转、输入与快捷键。

## 不能绕过的既定安全/工程约束

- `autoMerge=false` / `autoRelease=false`；Agent 并发上限 2，Developer/Reviewer `magpie / auto/deepseek-v4.1-flash`，thinking 继承 Pi。
- GitHub Issues/PR/Checks 是质量门禁事实源，AtomGit 只作镜像或加速；状态未知必须显示未知。
- Pi Runtime、Session Catalog、Agent Loop、Worktree 的 ID 和状态独立；失败恢复验证 generation/checkpoint/外部副作用。
- 本次为**设计交付**，不修改用户仓库、Git 提交、Issues、PR，也不代表已接入 Pi RPC。
