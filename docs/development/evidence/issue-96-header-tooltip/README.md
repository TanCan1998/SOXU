# Issue #96 · 顶栏重构与交互基建：实机证据

- 采集日期：2026-10-29
- 采集对象：本工作树 `apps/desktop` 的 Vite 预览（`pnpm --filter @soxu/desktop exec vite --port 1422 --strictPort --host 127.0.0.1`），
  即 `App.vue` + `components/AppTooltip.vue` + `components/SessionTabs.vue` + `components/ProjectSidebar.vue` + `styles/base.css` 的真实运行结果
- 浏览器：Microsoft Edge 156.0.4314.50（Chromium，headless=new，`--remote-debugging-port=9444`，独立 `--user-data-dir`），视口 1280×860，DPR 1
- 交互：CDP `Input.dispatchMouseEvent`（先移到中性点，再移到目标按钮中心）与 `Page.captureScreenshot`
- 说明：浏览器预览没有 Tauri 桥（`createUnavailableBridge`），因此没有真实会话与 Tab；
  后退/前进的真实切换行为由 `apps/desktop/tests/sessionHistory.test.ts` 覆盖，这里验证的是按钮存在、顺序与禁用态。

## 复现步骤

```powershell
# 1. 启动前端预览（不要占用其他工作树正在使用的 1420/1421 端口）
pnpm --filter @soxu/desktop exec vite --port 1422 --strictPort --host 127.0.0.1

# 2. 启动一个独立 profile 的 headless Edge，并暴露 CDP
& 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe' --headless=new `
  --remote-debugging-port=9444 --user-data-dir=$env:TEMP\soxu-96-edge-iso `
  --no-first-run --disable-extensions --hide-scrollbars about:blank

# 3. CDP 脚本（Node 26 自带 WebSocket）：
#    PUT /json/new?url=http://127.0.0.1:1422/ 建立页面 →
#    Emulation.setDeviceMetricsOverride 1280x860 → Page.navigate →
#    等 .app-shell 出现 → Input.dispatchMouseEvent 悬停 → 读取 computed style → Page.captureScreenshot
```

## 结论（对应 Issue 验收项）

| 验收项 | 结论 | 证据（本文件下方同样列出原始值） |
|---|---|---|
| 普通界面文本无法拖蓝选中；输入框与会话正文仍可选中复制 | 通过 | `.app-shell` 与顶栏文本 `user-select: none`；页面内 3 个 `input/textarea` 全部 `text`；会话正文容器带 `.soxu-selectable` |
| 顶栏无「SOXU / 多会话工作区」字样，最左是折叠按钮，其后是后退/前进 | 通过 | 顶栏文本只剩「未连接」；按钮 X 坐标 280（侧栏）、324（后退）、368（前进）、928（检查器） |
| 后退/前进可在会话间切换，边界禁用态正确 | 通过（逻辑）/ 禁用态实机可见 | 无会话时两个按钮均 `disabled: true`；切换逻辑与边界见 `sessionHistory.test.ts`（8 个用例） |
| 顶栏背景与页面融为一体 | 通过 | 浅色：顶栏 `rgb(252, 252, 252)`＝body＝shell；深色：顶栏 `rgb(25, 23, 23)`＝body＝shell；仅 1px `rgb(233, 233, 237)` / `rgb(54, 51, 51)` 分隔线 |
| 所有 icon-button / link-button hover 有可见反馈 + tooltip | 通过 | hover 后 `transform: matrix(1.04, 0, 0, 1.04, 0, 0)`、背景切到 `--soxu-hover`（浅色 `rgb(236, 236, 238)`）；提示文案与无障碍接线见下表 |
| `grep 'title=' apps/desktop/src` 归零 | 通过 | 源码扫描 0 处；同一页面运行期 `document.querySelectorAll('[title]').length === 0` |
| `pnpm --filter @soxu/desktop check` 通过 + 截图 | 通过 | `vue-tsc --noEmit` 退出码 0；截图见下表 |

## 悬浮提示（tooltip）实测

| 检查点 | 实测值 |
|---|---|
| 延迟出现 | 悬停 180ms 时 `.soxu-tooltip` 数量 = 0；悬停约 880ms 后出现（参数 `TOOLTIP_DELAY_MS = 400`） |
| 文案 | 侧栏按钮 → 「侧栏 (Ctrl+B)」；禁用态后退按钮 → 「后退：上一个查看过的会话」 |
| 无障碍接线 | 可见气泡内包含 `<span role="tooltip" id="reka-tooltip-content-v-3">`，触发器 `aria-describedby="reka-tooltip-content-v-3"`，且 `document.getElementById(id)` 命中 |
| 挂载位置 | portal 到 `body`（父级为 `[data-reka-popper-content-wrapper]`，`position: fixed`），不会被侧栏 overflow 裁掉 |
| 样式来源 | 背景 `rgb(252, 252, 252)`（浅）/ `rgb(25, 23, 23)`（深）、`border-top-width: 1px`、`animation-name: soxu-tooltip-in` |
| 移开后消失 | 移到空白区 700ms 后 `.soxu-tooltip` 数量 = 0 |
| 禁用态按钮 | 后退按钮 `disabled: true`，提示挂在容器 `span.icon-button-frame` 上（`anchorTag: SPAN`）——disabled 按钮不派发指针事件，直接挂在按钮上会完全看不到说明 |

## `prefers-reduced-motion`

CDP `Emulation.setEmulatedMedia` 设 `prefers-reduced-motion: reduce` 后：

- hover 缩放退化为 `matrix(1, 0, 0, 1, 0, 0)`（即 scale(1)，只剩颜色变化）
- tooltip 仍然出现（可读性优先），但 `animation-name: none`

## 截图

| 文件 | 说明 |
|---|---|
| `01-light-header.png` | 浅色主题顶栏：仅图标，无品牌文案，与页面同色 |
| `02-light-tooltip-sidebar.png` | 悬停侧栏按钮：hover 底色 + 提示「侧栏 (Ctrl+B)」 |
| `03-light-tooltip-disabled-back.png` | 悬停禁用的后退按钮：仍显示「后退：上一个查看过的会话」 |
| `04-reduced-motion-hover.png` | reduced-motion 下悬停：无缩放，提示仍出现且无入场动画 |
| `05-dark-header.png` | 深色主题顶栏，与深色页面同色 |
| `06-dark-tooltip-sidebar.png` | 深色主题下的提示气泡 |

## 原始结构化结果（节选）

```json
{
  "light": {
    "text": "未连接",
    "buttons": [
      { "label": "收起侧栏", "disabled": false, "x": 280 },
      { "label": "后退到上一个查看过的会话", "disabled": true, "x": 324 },
      { "label": "前进到下一个查看过的会话", "disabled": true, "x": 368 },
      { "label": "关闭会话状态面板", "disabled": false, "x": 928 }
    ],
    "headerBg": "rgb(252, 252, 252)",
    "bodyBg": "rgb(252, 252, 252)",
    "shellBg": "rgb(252, 252, 252)",
    "headerBorder": "1px solid rgb(233, 233, 237)",
    "shellUserSelect": "none",
    "headerTextUserSelect": "none",
    "inputUserSelect": ["text", "text", "text"],
    "titleAttrCount": 0,
    "dragRegionCount": 0
  },
  "tooltipBeforeDelay": 0,
  "tooltipAfterDelay": {
    "accessibleText": "侧栏 (Ctrl+B)",
    "accessibleRole": "tooltip",
    "describedBy": "reka-tooltip-content-v-3",
    "describedTargetExists": true,
    "rect": { "x": 254, "y": 53, "w": 85, "h": 29 },
    "background": "rgb(252, 252, 252)",
    "borderWidth": "1px",
    "animationName": "soxu-tooltip-in",
    "animationDuration": "0.18s"
  },
  "hoverEffect": {
    "transform": "matrix(1.04, 0, 0, 1.04, 0, 0)",
    "backgroundColor": "rgb(236, 236, 238)",
    "transitionDuration": "0.12s, 0.12s, 0.12s"
  },
  "tooltipOnDisabledBack": {
    "accessibleText": "后退：上一个查看过的会话",
    "anchorTag": "SPAN",
    "anchorClass": "icon-button-frame",
    "rect": { "x": 262, "y": 52, "w": 158, "h": 29 }
  },
  "tooltipAfterLeave": 0,
  "reducedMotion": {
    "hoverTransform": "matrix(1, 0, 0, 1, 0, 0)",
    "tooltip": { "accessibleText": "侧栏 (Ctrl+B)", "animationName": "none" }
  },
  "dark": {
    "headerBg": "rgb(25, 23, 23)",
    "bodyBg": "rgb(25, 23, 23)",
    "shellBg": "rgb(25, 23, 23)",
    "headerBorder": "1px solid rgb(54, 51, 51)"
  },
  "darkTooltip": { "background": "rgb(25, 23, 23)", "animationName": "soxu-tooltip-in" }
}
```

## 未覆盖 / 风险

- 只在 Windows + Chromium（Edge 156）验证；Tauri 实际 WebView、macOS/Linux 与 WebKit 系未验证。
- 浏览器预览没有 Tauri 桥，无法在实机里连开多个会话；后退/前进的真实切换、跳过已关闭 Tab、
  50 条上限与边界禁用都由单元测试覆盖（`apps/desktop/tests/sessionHistory.test.ts`），
  未在 Tauri 窗口内做端到端点击验证。
- 顶栏高度 52px、按钮仍处于应用内容区；如果后续把标题栏改成 `data-tauri-drag-region`，
  需要重新确认拖拽区域不会覆盖这三个按钮（当前源码中该属性出现 0 次）。
- hover 放大 `scale(1.04)` 是固定 token；在 `prefers-reduced-motion` 下为 1。若未来提高倍率，
  需要用像素差复核相邻按钮是否会互相压盖。
