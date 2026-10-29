# Issue #99 · 会话标签页统一宽度与拖拽排序：实机证据

- 采集日期：2026-10-29
- 采集对象：本工作树 `apps/desktop` 的真实 `SessionTabs.vue`，通过
  `tests/harness/session-tabs.html`（`?count=1|3|8`）挂到 Vite 开发服务器上
- 浏览器：Microsoft Edge 156.0.4314.50（Chromium，`--headless=new`，独立 `--user-data-dir`，
  `--hide-scrollbars`），视口 1280×720（窄窗口场景 620×720），DPR 1
- 交互：CDP `Input.dispatchMouseEvent` / `Input.dispatchTouchEvent`（先开启触摸模拟）/
  `Input.dispatchKeyEvent`，截图用 `Page.captureScreenshot`
- 原始数据：同目录 `screens.json`（脚本每次运行都会覆盖）

## 复现步骤

```powershell
# 一条命令跑完：自起 Vite（1423）+ headless Edge（CDP 9455），结束自动回收子进程
node apps/desktop/tests/harness/shoot-session-tabs.mjs
```

脚本会重写本目录的 9 张截图与 `screens.json`；端口冲突时用
`$env:SOXU_HARNESS_PORT` / `$env:SOXU_CDP_PORT` 覆盖。

> 夹具只挂 `SessionTabs`，不连接 Pi：Tab 是内存假数据，排序写回走组件的 `move` 事件
> （生产环境由 `WorkspaceSession.moveTab` 承担同一职责，见 `tests/sessionTabs.test.ts`）。

## 结论（对应 Issue 验收项）

| 验收项 | 结论 | 实测值 |
| --- | --- | --- |
| 1/3/8 个 Tab 宽度统一、随数量变化、不越上下限 | 通过 | 1280px 视口：1 个 = 220px；3 个 = 220px（触顶，故与 1 个相同）；8 个 = 145px；间距恒为 6px；所有 Tab 宽度一致（`uniform: true`） |
| 随数量变化（未被门槛夹住时） | 通过 | 620px 视口：3 个 = 177px；8 个 = 96px（等于下限） |
| 超出上限后横向滚动 | 通过 | 620px 视口 8 个 Tab：`scrollWidth 814 > clientWidth 548`，`scrollLeft` 可推到 266 |
| 拖拽排序（鼠标） | 通过 | 8 个 Tab，把第 1 个拖过第 4 个的中心：顺序 `0,1,2,…,7` → `1,2,3,0,4,5,6,7` |
| 拖拽排序（触屏） | 通过 | 同上场景用 `Input.dispatchTouchEvent`：`0,1,2,…` → `1,0,2,3,4,5,6,7` |
| 关闭一个 Tab 后仍然能拖 | 通过 | 先点掉第 2 个 Tab（剩 7 个），再把第 1 个拖到第 4 个位置：`0,2,3,4,5,6,7` → `2,3,4,0,5,6,7`，拖动中 `.drop-marker` = 1、`.tab-item.dragging` = 1 |
| 阈值 ≥ 6px（避免误触） | 通过 | 位移 3px 后松手：顺序不变；同一次按下仍算点击，`activeSessionId` 正常切到被点的 Tab |
| 拖动中显示插入位置 | 通过 | 拖动中 `.drop-marker` 数量 = 1（目标槽位虚线框），其它 Tab 按 `slotShift` 平移一格 |
| 只改顺序、不改 `activeSessionId` | 通过 | 拖拽完成后顺序变了，`activeSessionId` 仍是 `harness_ses_0` |
| 键盘导航（方向键 / Delete）回归 | 通过 | 3 个 Tab：ArrowRight → active 与焦点同时到第 2 个；ArrowLeft → 回到第 1 个；Delete → 关闭当前，剩余 2 个且 active 落到 `harness_ses_1` |
| `prefers-reduced-motion` 下平移退化 | 通过 | `Emulation.setEmulatedMedia(reduce)` 后 `.tab-item` 的 `transition-property: none`，落位与让位瞬时生效，排序结果与常态一致 |
| `pnpm --filter @soxu/desktop check` | 通过 | `vue-tsc --noEmit` 退出码 0 |
| 拖拽中不弹提示挡住指示 | 通过 | 拖动中 `.soxu-tooltip` 数量 = 0（`AppTooltip` 的 `disabled` 会收起已打开的气泡并撤销延迟计时器） |
| 其它提示不受拖拽改造影响 | 通过 | 回到应用外壳悬停侧栏按钮：约 900ms 后出现 `.soxu-tooltip`「侧栏 (Ctrl+B)」；移开后数量回到 0（`AppTooltip` 改为受控开关后的回归） |

## 宽度与截断（1280×720）

| Tab 数 | 单个宽度 | 间距 | 标题是否需要省略号 | 横向滚动 |
| --- | --- | --- | --- | --- |
| 1 | 220px（上限） | — | 否（165/165） | 否 |
| 3 | 220px（上限） | 6px | 否（165/165、126/126） | 否 |
| 8 | 145px | 6px | 是（标题可用 90px，最宽内容 150px） | 否 |
| 3（620px 视口） | 177px | 6px | 否 | 否 |
| 8（620px 视口） | 96px（下限） | 6px | 是 | 是（814 vs 548） |

等宽公式（`src/composables/tabStripLayout.ts`）：
`clamp(floor((容器宽度 - 6 × (N-1)) / N), 96, 220)`，向下取整保证
`N × 宽度 + (N-1) × 间距` 不超过容器，不会出现「只多 1px」的假滚动条。
620px 视口下 8 个临时/普通 Tab 的 `临时` 徽标在 96px 宽时会挤掉标题，
因此宽度 < 132px 时不渲染徽标，改为在悬浮提示里补一句「（临时会话）」。

## 截图

| 文件 | 说明 |
| --- | --- |
| `01-tabs-1.png` | 1 个 Tab：宽度触上限 220px |
| `02-tabs-3.png` | 3 个 Tab：仍为 220px（上限），等宽且不滚动 |
| `03-tabs-8.png` | 8 个 Tab：等宽 145px，标题省略号 |
| `04-drag-mid-mouse-8tabs.png` | 鼠标拖到第 4 个位置：被拖 Tab 抬起跟手，目标槽位显示虚线框，其它 Tab 已让位 |
| `05-drag-mid-touch-8tabs.png` | 触屏拖动中：同样进入拖动态并显示目标槽位 |
| `06-reduced-motion-drag-8tabs.png` | `prefers-reduced-motion: reduce` 下拖动：无补间，仍有槽位指示 |
| `07-tabs-3-narrow-620.png` | 620px 视口 3 个 Tab：177px，随容器变窄 |
| `08-tabs-8-narrow-620.png` | 620px 视口 8 个 Tab：夹到下限 96px，进入横向滚动 |
| `09-tabs-8-narrow-scrolled-end.png` | 同上，横向滚到最右（`scrollLeft = 266`） |
| `10-app-tooltip-regression.png` | 应用外壳悬停侧栏按钮：`AppTooltip` 改为受控开关后气泡仍按延迟出现 |

## 原始结构化结果（节选自 `screens.json`）

```json
{
  "widths": {
    "1": { "widths": [220], "tabWidthVar": "220px", "scrollable": false },
    "3": { "widths": [220, 220, 220], "gaps": [6, 6], "scrollable": false },
    "8": { "widths": [145, 145, 145, 145, 145, 145, 145, 145], "gaps": [6, 6, 6, 6, 6, 6, 6], "scrollable": false }
  },
  "narrow": {
    "3": { "widths": [177, 177, 177], "scrollable": false, "scrollWidth": 548, "clientWidth": 548 },
    "8": { "widths": [96, 96, 96, 96, 96, 96, 96, 96], "scrollable": true, "scrollWidth": 814, "clientWidth": 548, "scrolledBy": 266 }
  },
  "mouseDragAfter": {
    "order": ["harness_ses_1", "harness_ses_2", "harness_ses_3", "harness_ses_0", "harness_ses_4", "harness_ses_5", "harness_ses_6", "harness_ses_7"],
    "active": "harness_ses_0"
  },
  "mouseDragMid": { "markers": 1, "tooltips": [] },
  "touchDragAfter": {
    "order": ["harness_ses_1", "harness_ses_0", "harness_ses_2", "harness_ses_3", "harness_ses_4", "harness_ses_5", "harness_ses_6", "harness_ses_7"],
    "active": "harness_ses_0"
  },
  "belowThreshold": { "order": ["harness_ses_0", "harness_ses_1", "…"], "active": "harness_ses_2" },
  "keyboard": {
    "afterRight": { "active": "harness_ses_1", "focusedId": "soxu-tab-harness_ses_1", "selected": ["false", "true", "false"] },
    "afterLeft": { "active": "harness_ses_0", "focusedId": "soxu-tab-harness_ses_0", "selected": ["true", "false", "false"] },
    "afterDelete": { "count": 2, "active": "harness_ses_1" }
  },
  "reducedMotion": { "transitionProperty": "none" }
}
```

## 门禁（2026-10-29，本机 Windows 11 / Node 26.10.0 / pnpm 12.15.0 / Rust 1.99.1）

| 命令 | 结果 |
| --- | --- |
| `pnpm --filter @soxu/desktop check` | `vue-tsc --noEmit` 退出码 0 |
| `pnpm check` | desktop 112 例（新增 `tests/sessionTabs.test.ts` 16 例）+ scripts 47 例全绿 |
| `pnpm icons:generate && cargo test --workspace` | 全绿。注：`src-tauri/icons/` 是 gitignore 的生成产物，缺它会先在 `tauri-build` 阶段失败（与本次改动无关），CI 也是先生成图标再编译 |
| `cargo fmt --all -- --check` | 无差异 |
| `git diff --check` | 无空白问题 |

## 未验证

- 实体触摸屏（本次是 CDP 触摸模拟，pointerType = touch，但未经硬件验证手感与惯性）。
- Tauri WebView2 / WKWebView / WebKitGTK 内的首帧 `ResizeObserver` 宽度、拖拽观感与
  系统级触摸滚动交互。
- 拖拽过程中容器自动横向滚动（当前实现不会在拖到边缘时自动滚动 `.tabs-scroll`）。
- 键盘用户的排序入口：本 Issue 只要求不破坏既有键盘导航，未提供键盘重排。
