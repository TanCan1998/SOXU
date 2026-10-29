# Issue #97 · 主题切换边缘发光涟漪 + 抵达边界后的水波淡出：实机证据

- 采集日期：2026-10-29
- 采集对象：本工作树 `apps/desktop` 的 Vite 预览（`pnpm exec vite --port 1421`，`http://127.0.0.1:1421/`），
  即 `src/theme/themeTransition.ts` + `src/styles/base.css` 的真实运行结果
- 浏览器：Microsoft Edge 156.0.4314.50（Chromium，`--headless=new`），视口 **1280×860**，DPR 1
- 交互：在主题按钮中心 **(69, 831)** 派发真实 `MouseEvent`（`clientX/Y` = 按钮中心），圆心因此落在按钮上
- 采集：CDP（`Target.attachToTarget` + `Runtime.evaluate` + `Page.captureScreenshot`）

## 复现步骤

```powershell
# 1. 启动前端预览（不需要 Tauri 运行时；浏览器预览走 createUnavailableBridge）
cd apps/desktop; pnpm exec vite --port 1421 --strictPort

# 2. 启动一个带调试端口的 Edge
& 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe' `
  --headless=new --remote-debugging-port=9333 --remote-allow-origins=* `
  --user-data-dir=$env:TEMP\soxu-97-edge-profile --no-first-run --disable-gpu about:blank

# 3. 采集全部场景（每个场景一张 PNG + 一份页面内断言，汇总写 capture-report.json）
cd docs/development/evidence/issue-97-theme-ripple
node shoot.mjs 9333 http://127.0.0.1:1421/

# 4. 像素统计：node analyze.mjs <before.png> <after.png> 69 831
```

## 采集方法（为什么不靠真实计时截图）

`t≈200ms` 这种时刻靠 `click()` 后 sleep 200ms 再截图是不可复现的：截图动作本身要排在一帧之后，
延迟会漂到 200–600ms。这里改成**冻结帧**：

1. 点击后轮询 `document.getAnimations()`，等 View Transition 伪元素动画出现；
2. 对它和两层的 CSS 动画调用 `pause()`，并把 `currentTime` 设为 200ms；
3. 再截一张同帧的**对照组**：把 `.soxu-theme-glow` 摘掉后截图。两张图相减，就只剩"光晕/水波贡献的像素"。

水波阶段（t≈620ms）同理：扩散已经结束、伪元素已销毁，此时暂停水波动画再截图，测到的就是纯水波。
`capture-report.json` 里每个场景都带有页面内断言（层结构、`:popover-open`、残留节点数、`html` 类名）。

## 结论（对应 Issue 验收项）

| 验收项 | 结论 | 证据 |
|---|---|---|
| 点击主题按钮：圆形扩散 + 边缘发光涟漪可见 | 通过 | 冻结同一帧做 A/B：有光晕帧比去掉发光层的帧多出 **32085 px**（占视口 2.92%），最大蓝色富余 **78.5**（深→浅）/ **75.0**（浅→深），差异集中在扩散边缘一圈 |
| 动画结束无残留 DOM | 通过 | `dark-to-light-03-settled` / `light-to-dark-03-settled` 与同主题基线帧 **逐像素完全相同（changedPixels = 0）**；页面内断言 `residualLayers = 0`、`htmlClass = ""` |
| 双向切换都有涟漪 | 通过 | 两个方向的水波环都落在半径 **≈984–1208px**（深→浅）/ **≈1000–1208px**（浅→深），蓝色富余峰值 **35.5 / 29.4**；圆心 (69,831) 到最远角 = 1469px，说明光环在扩散圆盘边缘内侧 |
| 发光色随主题 token 变化 | 通过 | 水波只用 `color-mix(in srgb, var(--soxu-accent) …)`（`tests/themeTransition.test.ts` 断言 CSS 里不得出现硬编码色值）；运行时 `getComputedStyle(ripple).getPropertyValue("--soxu-accent")` 解析到主题 token `#3a83f7` |
| reduced-motion 降级 | 通过 | CDP `Emulation.setEmulatedMedia` 设 `prefers-reduced-motion: reduce` 后点击：主题 dark→light 生效，`MutationObserver` 统计到的发光层插入次数 **0**，`html` 上没有过渡类名 |
| 无 View Transitions 环境降级 | 通过 | 页面内先 `document.startViewTransition = undefined` 再点击：主题 light→dark 生效，发光层插入次数 **0**，无过渡类名；另有单元测试覆盖同一路径（含 `startViewTransition` 同步抛错） |
| `pnpm --filter @soxu/desktop check` | 通过 | `vue-tsc --noEmit` 无错误；`node --test tests/*.test.ts` 84 项全绿 |

## 帧数据

同一按钮位置 (69,831)，圆心到最远角半径 1469px。

| 场景 | 与对照帧的差异 | 蓝色富余峰值 | 环带半径 |
|---|---|---|---|
| t≈200ms 深→浅 vs 同帧无光晕 | 32085 px（2.92%） | 78.5 | — |
| t≈200ms 浅→深 vs 同帧无光晕 | 32085 px（2.92%） | 75.0 | — |
| t≈200ms 深→浅 vs 深色稳定帧 | 1042940 px（94.7%，扩散已覆盖大部分视口） | 233 | 0–1208 |
| t≈620ms 深→浅水波 vs 浅色稳定帧 | 329444 px（29.9%） | 35.5 | 984–1208 |
| t≈620ms 浅→深水波 vs 深色稳定帧 | 325446 px（29.6%） | 29.4 | 1000–1208 |
| 稳定帧 vs 基线帧（浅色/深色） | **0 px** | 0 | — |

- 「蓝色富余」= `B − (R+G)/2` 相对对照帧的增量；「环带半径」= 以点击点为中心、逐半径（步长 8px，每圈 180 个角度采样）统计有差异像素占比 > 10% 的连续半径区间。
- 水波画面占视口近 30% 是因为光环本身很宽（渐变 60%→84% 半径），环带内侧被完全覆盖。
- 原始数据：`capture-report.json`（每个场景的页面内断言）、`pixel-metrics.json`（每对比较的逐半径曲线与环带区间）。

## 截图

| 文件 | 说明 |
|---|---|
| `dark-to-light-01-t200ms.png` | 深→浅，冻结在扩散 t=200ms（含边缘光晕） |
| `dark-to-light-01b-t200ms-noglow.png` | 同帧对照：摘掉发光层（用于 A/B 量化） |
| `dark-to-light-02-ripple-fade.png` | 深→浅，扩散结束后 t≈620ms 的水波淡出 |
| `dark-to-light-03-settled.png` | 深→浅 完成（无残留） |
| `light-to-dark-01-t200ms.png` / `…-01b-…-noglow.png` | 浅→深，同上 |
| `light-to-dark-02-ripple-fade.png` | 浅→深 水波淡出 |
| `light-to-dark-03-settled.png` | 浅→深 完成（无残留） |
| `baseline-light.png` / `baseline-dark.png` | 同主题、未触发任何过渡的基线帧（证明稳定帧没有残留绘制） |

## 实现要点与踩坑

1. **水波必须挂在真实节点上，不能写成 `::view-transition-*` 动画**：View Transitions 的伪元素在
   `transition.finished` 之后就销毁，而"抵达边界后再淡出 300–600ms"正好发生在这之后。
   因此容器在 finished 后仍然保留，等 `THEME_RIPPLE_FADE_MS + SETTLE` 计时而后再摘节点
   （`--soxu-theme-ripple-delay` = 扩散时长 420ms，`--soxu-theme-ripple-duration` = 480ms）。
2. **`[popover]` 的 UA 样式带 `overflow: auto`**：容器从"自己就是光晕"改成"0×0 容器 + 两层子圆"后，
   不显式写 `overflow: visible` 会把子层裁成 0×0（单元测试专门守住这条）。
3. **`radial-gradient(circle, …)` 默认 `farthest-corner`**：百分比按 1.41R 算，光环被推到视口之外，
   实测整条水波**完全不可见**（连拍出来的帧与稳定帧字节相同）。改成 `circle closest-side` 后立刻出现，
   这条也写进了 CSS 合同测试。
4. **倒序清理**：连续切换时新过渡会先摘掉上一代容器；被浏览器跳过的过渡（`AbortError`）不做淡出等待，
   避免旧一代拖住新一代。

## 未覆盖 / 风险

- 只在 Windows + Chromium（Edge 156）验证；macOS/Linux 与 WebKit 系未验证（WebKit 的 View Transitions 与
  popover top layer 行为可能不同，至少会走"保留扩散、放弃光晕"的降级）。
- 水波的亮度/宽度是按 1280×860、R≈1469px 调的；超大视口（4K）下环带相对视口更靠外，观感需要重新校准。
- 帧数据来自冻结帧而不是 60fps 录屏，能证明"该时刻确实画出了光晕/水波"，但不覆盖帧率与合成性能。
