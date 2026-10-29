# Issue #100 · 交互小修集合（面板关闭按钮 / 添加项目按钮 / 临时会话图标）：实机证据

- 采集日期：2026-10-29
- 采集对象：本工作树 `apps/desktop` 的 Vite 预览（`App.vue` + `components/ProjectSidebar.vue` +
  `components/RuntimeInspector.vue` + `styles/base.css`），即真实运行结果，不是设计稿
- 浏览器：`Edg/156.0.4314.50`（Chromium，`--headless=new`，`--remote-debugging-port=9456`，
  独立 `--user-data-dir`，`--hide-scrollbars`），视口 1280×800，DPR 1
- 交互：CDP `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent`（Ctrl+I）
- 主题：01–04 用 `Emulation.setEmulatedMedia` 钉住 `prefers-color-scheme: light`，
  05 切到 `dark` 后重载；每张图前都断言 `<html data-theme>` 与 body 计算色，
  不符就让脚本失败（见下节「证据自检」）
- 原始数据：同目录 `screens.json`（含 `lightTheme` / `darkTheme` / `checks` / `shots`，
  脚本每次运行都会覆盖）

## 复现步骤

```powershell
# 一条命令跑完：自起 Vite（1424）+ headless Edge（CDP 9456），结束自动回收子进程
node apps/desktop/tests/harness/shoot-issue-100.mjs
```

脚本会重写本目录的 5 张截图与 `screens.json`；端口冲突时用
`$env:SOXU_HARNESS_PORT` / `$env:SOXU_CDP_PORT` 覆盖。

> 浏览器预览没有 Tauri 桥（`createUnavailableBridge`），因此两个「添加项目」按钮以**禁用态**
> 渲染——这恰好是「未连接时不假装能登记」的正确表现。系统目录选择器的真实行为由
> `tests/projectDirectory.test.ts` 与 `composables/useProjectDirectoryPick.ts` 覆盖，
> 本目录的截图只证明「入口已经是按钮、不再是输入框」。

## 证据自检：浅色 / 深色都是真的

**上一版的问题（Reviewer 指出）**：脚本只在最后一步模拟 `prefers-color-scheme: dark`，
前面 4 张图完全依赖系统默认主题。全新 profile 没有 `localStorage` 偏好，主题由系统决定，
而 headless Edge 跟随本机 Windows 的深色设置，于是 5 张图**全是深色**，
`05-dark-inspector-no-close.png` 与 `01-welcome-add-project-button.png` 字节完全相同——
README 里「浅色 / 深色」两行属于未经验证的描述。

**这一版的修法**：主题变成被断言的证据，而不是假设。

1. 首屏之前先 `Emulation.setEmulatedMedia` 把 `prefers-color-scheme` 钉成 `light`，
   01–04 因此是真实的浅色渲染；
2. 每张图前读 `THEME_PROBE`：`<html data-theme>`、`.app-shell[data-theme]`、
   `getComputedStyle(document.body).backgroundColor`、`localStorage['soxu.theme']`；
3. 用 WCAG 相对亮度判定「确实是浅色 / 确实是深色」，并要求浅深两色互不相同；
4. 最后比对 PNG 字节哈希，`05 ≠ 01`，否则说明主题切换根本没生效。

10 项断言全部记录在 `screens.json` 的 `checks` 字段里，任何一项失败脚本都以非 0 退出。

| 断言 | 实测值 |
| --- | --- |
| 浅色 `<html data-theme>` / `.app-shell[data-theme]` | `light` / `light` |
| 浅色 body 背景 + 相对亮度 | `rgb(252, 252, 252)`，0.9734（阈值 > 0.8） |
| 深色 `<html data-theme>` / `.app-shell[data-theme]` | `dark` / `dark` |
| 深色 body 背景 + 相对亮度 | `rgb(25, 23, 23)`，0.0088（阈值 < 0.05） |
| 浅深背景不同 | `rgb(252, 252, 252)` ≠ `rgb(25, 23, 23)` |
| 两次采集都无持久化偏好 | `localStorage['soxu.theme']` = `null` |
| `01` 与 `05` 字节不同 | 69152 B ≠ 73803 B（哈希见 `screens.json` 的 `shots[].sha256`） |

## 结论（对应 Issue 验收项）

| 验收项 | 结论 | 实测值 |
| --- | --- | --- |
| 会话状态面板内无关闭按钮 | 通过 | `.inspector-head button` = 0；面板内带「关闭」字样的按钮 = 0；面板内仅剩一个按钮「重新扫描全部项目」（无活动会话时） |
| 顶栏 PanelRight 可正常开关面板 | 通过 | 点击顶栏按钮后 `.inspector` 数量 1 → 0，按钮 `aria-expanded` `true` → `false`，`aria-label` 切到「打开会话状态面板」 |
| Ctrl+I 可正常开关面板 | 通过 | `Input.dispatchKeyEvent` 派发 Ctrl+I 后 `.inspector` 数量 0 → 1，`aria-expanded` `false` → `true`；按钮 `aria-keyshortcuts` = `Control+I` |
| 主区「添加项目」是按钮，不再是输入框 | 通过 | `.welcome` 内 `input` = 0、`form` = 0；`.welcome-add` 是 `BUTTON`，文案「添加项目」，带 + 图标，尺寸 104×34 |
| 侧栏「添加项目目录」是按钮，不再是输入框 | 通过 | `.add-project` 是 `BUTTON`，文案「添加项目目录」，带 + 图标，尺寸 237×36（262px 侧栏减去左右 12px 内边距）；`.sidebar` 内该区域 `input` = 0 |
| 点击弹系统目录选择器；取消无副作用 | 通过（结构 + 单测） | 两个入口的点击处理都先 `await pick()`，`if (!picked) return` 之后才登记/emit；取消路径见 `tests/projectDirectory.test.ts`，接线断言见 `tests/interactionPolish.test.ts` |
| 临时会话按钮为虚线气泡图标 | 通过 | `.new-session svg` 的 class = `lucide lucide-message-square-dashed`，18×18，10 个图形节点；按钮文案仍是「临时会话」+ `Ctrl K` |
| `grep -n "例如 F:" apps/desktop/src` 无残留 | 通过 | 0 处；同一次全量扫描确认 `soxu-welcome-root` 也归零（`tests/interactionPolish.test.ts`） |
| `pnpm --filter @soxu/desktop check` 通过 + 截图 | 通过 | `vue-tsc --noEmit` 退出码 0；根 `pnpm check`（含桌面 133 项 + 脚本 47 项测试）退出码 0；截图见下表，证据脚本自身 10 项断言全过（退出码 0） |

## 三个改动点的运行期数据

### 1. 面板关闭入口收敛到顶栏

| 检查点 | 实测值 |
| --- | --- |
| 面板头部按钮数 | `headButtons: 0` |
| 面板内「关闭」类按钮 | `closeButtonCount: 0` |
| 面板内剩余按钮 | 仅「重新扫描全部项目」（`BUTTON`） |
| 点顶栏按钮前 | `aria-label` = 关闭会话状态面板，`aria-expanded` = true |
| 点顶栏按钮后 | `.inspector` 数量 0，`aria-label` = 打开会话状态面板，`aria-expanded` = false |
| Ctrl+I 之后 | `.inspector` 数量 1，`aria-label` = 关闭会话状态面板，`aria-expanded` = true |

### 2. 「添加项目」改为按钮

| 检查点 | 主区（`.welcome-add`） | 侧栏（`.add-project`） |
| --- | --- | --- |
| 标签 | `BUTTON` | `BUTTON` |
| 文案 | 添加项目 | 添加项目目录 |
| + 图标 | 有 | 有 |
| 尺寸 | 104×34 | 237×36 |
| 区域内的 `input` / `form` | 0 / 0 | 0（`addProjectInputCount` = 0） |
| 禁用态 | 是（浏览器预览无桥） | 是（浏览器预览无桥） |

### 3. 临时会话图标

| 检查点 | 实测值 |
| --- | --- |
| 图标 class | `lucide lucide-message-square-dashed` |
| 尺寸 | 18×18 |
| 图形节点 | 10 |
| 文案 / 快捷键 | 「临时会话」/ `Ctrl K`（未改动） |

## 截图

| 文件 | 主题（已断言） | 说明 |
| --- | --- | --- |
| `01-welcome-add-project-button.png` | 浅色 | 主区「添加项目」按钮（无输入框），右侧面板头部无关闭按钮 |
| `02-sidebar-temp-session-dashed.png` | 浅色 | 侧栏顶部「临时会话」的虚线气泡图标，底部「添加项目目录」按钮 |
| `03-panel-closed-by-topbar.png` | 浅色 | 点顶栏 PanelRight 后：面板消失，主区自动居中 |
| `04-panel-reopened-by-ctrl-i.png` | 浅色 | Ctrl+I 重新打开面板，状态与初始一致 |
| `05-dark-inspector-no-close.png` | 深色 | `prefers-color-scheme: dark` 下同一组控件：面板仍无关闭按钮 |

> 字节数与 SHA-256 以同目录 `screens.json` 的 `shots` 为准（每次运行重写）。
> `01` / `02` / `03` / `05` 多次运行逐字节一致；`04` 会在 ±100 B 内浮动，
> 原因是面板滚动条的自动淡出时机不同（`.visually-scroll`），不影响任何验收结论。

## 原始结构化结果（节选）

```json
{
  "browser": "Edg/156.0.4314.50",
  "viewport": { "width": 1280, "height": 800 },
  "initial": {
    "inspector": { "present": true, "headButtons": 0, "closeButtonCount": 0 },
    "welcome": { "inputCount": 0, "formCount": 0, "button": { "tag": "BUTTON", "text": "添加项目", "disabled": true, "hasPlusIcon": true } },
    "sidebar": { "inputCount": 0, "button": { "tag": "BUTTON", "text": "添加项目目录", "disabled": true, "hasPlusIcon": true } },
    "temporarySession": { "text": "临时会话Ctrl K", "iconClass": "lucide lucide-message-square-dashed", "iconPaths": 10 },
    "topbarToggle": { "label": "关闭会话状态面板", "expanded": "true", "shortcuts": "Control+I" },
    "titleAttrCount": 0
  },
  "afterTopbarClick": { "inspectorVisible": 0, "topbarToggle": { "label": "打开会话状态面板", "expanded": "false" } },
  "afterCtrlI": { "inspectorVisible": 1, "topbarToggle": { "label": "关闭会话状态面板", "expanded": "true" } },
  "lightTheme": {
    "datasetTheme": "light",
    "shellTheme": "light",
    "bodyBg": "rgb(252, 252, 252)",
    "colorScheme": "light",
    "storedTheme": null,
    "relativeLuminance": 0.9734452903984125
  },
  "darkTheme": {
    "datasetTheme": "dark",
    "shellTheme": "dark",
    "bodyBg": "rgb(25, 23, 23)",
    "colorScheme": "dark",
    "storedTheme": null,
    "relativeLuminance": 0.00881327291395034
  },
  "checks": { "total": 10, "passed": 10 }
}
```

## 门禁失败复盘：`cargo test --workspace` exit=101

**现象**：Reviewer 门禁里 `cargo test --workspace` 以 101 失败，报错落在 `soxu-desktop` 的
build script 上：

```text
package.metadata does not exist
`...\apps\desktop\src-tauri\icons/icon.ico` not found;
required for generating a Windows Resource file during tauri-build
```

**根因**：不是本次改动的代码问题。`apps/desktop/src-tauri/icons/` 是 `.gitignore` 排除的
生成产物（`.gitignore` 第 30 行），干净工作树里根本不存在；`tauri-build` 在 Windows 上编译
`soxu-desktop` 时必须读到 `icons/icon.ico` 才能生成 Windows 资源文件。CI 的 Rust job
（`.github/workflows/ci.yml` 第 176 行）在 `cargo test` 之前先跑 `pnpm icons:generate`，
所以 CI 一直没暴露这个问题；门禁在本工作树直接调 `cargo test --workspace` 时跳过了这一步。

**修复**（两处，都不碰受保护路径）：

1. 本工作树补齐生成产物：`pnpm --filter @soxu/desktop icons:generate`（产物不入库，与 CI 一致）。
2. 根 `package.json` 的 `check` 前置 `pnpm icons:generate`：门禁先跑 `pnpm check`、再跑
   `cargo test --workspace`，前置补齐后 Rust 步骤不再依赖「上一轮遗留的生成产物」。
   这正是 CI 的既有顺序，没有引入新的构建逻辑。

> 仍存在的残余风险：若门禁**单独**、在从未生成过图标的干净工作树里只跑 `cargo test --workspace`，
> 仍会失败。彻底解法是把 `pnpm icons:generate` 写进 `automation/policy.json` 的 Rust 检查前置
> 命令——该文件是受保护路径，需维护者批准，本次不修改。

**复跑结果（本工作树）**：

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm icons:generate` | 0 | 生成 17 个平台变体（含 `icon.ico`） |
| `pnpm check`（含新增前置） | 0 | `vue-tsc` 0 错、桌面测试 133 项、脚本测试 47 项全绿 |
| `cargo test --workspace` | 0 | 各测试二进制全绿（desktop 47 项、协议/运行时/索引/资源/工作树 crate 合计 200+ 项，0 failed） |
| `cargo fmt --all -- --check` | 0 | 无格式差异 |

## 已知限制与未在本工作树执行的检查

1. **系统目录选择器未在真实 Tauri 运行时复测**：本次只改入口形态（输入框 → 按钮），
   选择器本身沿用 Issue #87 的实现；取消/不可用的无副作用路径由
   `tests/projectDirectory.test.ts`（Node 内直接测）与 `useProjectDirectoryPick` 保证。
2. **「临时会话」按钮没有 tooltip**（改动前后一致）：按钮本身带可见文案「临时会话」与
   `Ctrl K`，因此没有额外的悬浮提示；本次只换图标，未新增提示。
3. **Rust 侧只做了门禁复跑，没有新增 Rust 断言**：本次 diff 只涉及 Vue/TS，Rust 改动为零；
   `cargo test --workspace` 已在补齐图标前置后跑通（见下节），退出码 0，47 项 desktop 测试全绿。
4. **证据脚本目前只在 Windows 上跑通**：它硬编码 Edge 路径（`C:\Program Files (x86)\Microsoft\Edge\...`）
   并占用 1424 / 9456 端口；macOS 与 Linux 需要换 Chromium 可执行文件路径后才可用，
   本次未在其它平台复测。
