# Issue #86 · 顶部工具栏与窗口标题栏跟随主题：实机证据

- 采集日期：2026-10-29
- 采集对象：本工作树 `apps/desktop` 的 Vite 预览（`pnpm --filter @soxu/desktop dev`，`http://127.0.0.1:1420/`），
  即 `App.vue` + `src/theme/theme.ts` + `src/theme/windowTheme.ts` + `src/styles/base.css` 的真实运行结果
- 应用内顶部栏：moli 1.1.17（headless Chromium，`--layout` 真实布局/绘制），视口 1920×1080
- 原生窗口标题栏：真实 Tauri 2 窗口（`cargo build -p soxu-desktop` + `target/debug/soxu-desktop.exe`，
  前端仍由 Vite 提供），`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222` 后用 CDP
  `Runtime.evaluate` 点击同一个主题按钮，再用 `user32!PrintWindow(PW_RENDERFULLCONTENT)` 截整窗
- 交互：点击侧栏主题按钮（`[aria-label="切换到深色主题"]`），等待 1400–1800ms 让圆形扩散过渡结束
- 像素采样：`System.Drawing.Bitmap` 直接读 PNG 的 header 区 (600,26)、正文区 (600,400)，以及整窗截图的标题栏行 (w/2, 10/24/40)

## 复现步骤

```powershell
# 1. 启动前端预览（浏览器预览模式，不需要 Tauri 运行时）
pnpm --filter @soxu/desktop dev

# 2. 读浅色/深色下的 computed 样式（切主题在脚本里完成）
moli fetch --layout --wait-selector '.app-header' --timeout 30000 `
  --eval-file docs/development/evidence/issue-86-header-theme/measure-theme.js `
  'http://127.0.0.1:1420'

# 3. 截图（moli 输出二进制到 stdout，必须用重定向落盘，不能走 PowerShell 管道）
$moli = "$env:LOCALAPPDATA\Moli\bin\moli.exe"
Start-Process $moli -ArgumentList 'fetch','--layout','--wait-selector','.app-header',
  '--timeout','30000','--dump','screenshot','http://127.0.0.1:1420' `
  -RedirectStandardOutput header-light.png -NoNewWindow -Wait
Start-Process $moli -ArgumentList 'fetch','--layout','--wait-selector','.app-header',
  '--timeout','30000','--eval-file','switch-to-dark.js','--dump','screenshot','http://127.0.0.1:1420' `
  -RedirectStandardOutput header-dark.png -NoNewWindow -Wait
```

## 根因（两条都要修，缺一条顶部就还是割裂的）

1. **应用内 header 没有背景**：`.app-header` 原来只有 `border-bottom`，没有任何 `background`。
   顶部栏因此没有自己的底色，深色主题下会透出 Tauri 窗口的 `backgroundColor`（`tauri.conf.json` 里的纯白），
   形成一条浅色带。header 子元素本身（`.badge`、`.icon-button`、`.location-*`）已经全部走 `--soxu-*` token，
   没有硬编码色值，问题只在 header 容器缺背景。
2. **深色 token 只挂在 `.app-shell` 上**：`<html>`/`<body>` 停留在 `color-scheme: light` 与浅色 token，
   `body` 背景、原生滚动条、表单控件在深色下仍是浅色；V3 设计（`docs/design/UIUX/V3/reference/tokens.css`）
   的写法是 `:root[data-theme="dark"]`，应用内却只覆盖了组件根节点。
3. **原生窗口标题栏从未同步**：窗口装饰由系统绘制，CSS 影响不到它；Tauri 2 默认跟随系统主题，
   应用内切到深色后标题栏仍是浅色。`core:default` 只包含只读的 window 权限（含 `theme()` 查询），
   不包含 `setTheme`，所以光调 API 不声明权限也会被 ACL 拒绝。

## 改动

| 文件 | 改动 |
|---|---|
| `apps/desktop/src/App.vue` | `.app-header` 显式 `background: var(--soxu-sidebar)` + `color: var(--soxu-fg)`；`.location-name` 显式文字色；主题 watcher 拆成两个：持久化只在用户切换时执行，落地 watcher 用 `flush: "sync", immediate: true` 写 `<html data-theme>` 并同步原生窗口主题 |
| `apps/desktop/src/theme/theme.ts`（新增） | 主题偏好纯逻辑：读取/持久化、系统偏好、`applyDocumentTheme`、`syncWindowTheme`（失败降级为 `failed`/`skipped`，不抛错） |
| `apps/desktop/src/theme/windowTheme.ts`（新增） | Tauri 适配层：`isTauri()` + `getCurrentWindow().setTheme()`，浏览器预览返回 `null` |
| `apps/desktop/src/main.ts` | 挂载前落地初始主题（`resolveInitialTheme` → 写 html + 同步窗口），满足"启动时给出与 `soxu.theme` 一致的初始值" |
| `apps/desktop/src/theme/themeTransition.ts` | `ThemeName` 改为从 `theme.ts` 引入并转发，保持既有导入路径 |
| `apps/desktop/src/styles/base.css` | 深色 token 选择器改为 `:root[data-theme="dark"], .app-shell[data-theme="dark"]`（一份声明，两个入口） |
| `apps/desktop/src-tauri/capabilities/default.json` | 新增 `core:window:allow-set-theme`（唯一需要的原生权限） |
| `apps/desktop/tests/theme.test.ts`（新增） | 9 个用例：偏好读取/持久化、初始值优先级、html 属性写入、窗口同步失败降级、header 样式 token 守卫、深色大面积背景亮度上限 |

配色映射（不新增 token）：顶部栏与侧栏同色，即 V3 的 rail 色 = 现有 `--soxu-sidebar`
（浅色 `#f5f5f6` / 深色 `#222020`），与 `ProjectSidebar.vue` 的 `background: var(--soxu-sidebar)` 一致。

## 原生窗口标题栏（Windows 11，真实 Tauri 窗口）

```powershell
pnpm --filter @soxu/desktop icons:generate        # 首次 cargo 构建前需要，图标不入库
cargo build -p soxu-desktop --offline
pnpm --filter @soxu/desktop dev                   # dev 构建从 devUrl 取前端

$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9222'
Start-Process target/debug/soxu-desktop.exe

# 1. CDP 找到页面，Runtime.evaluate 点击主题按钮（WebView2 的 --remote-debugging-port）
# 2. user32!PrintWindow(hwnd, hdc, PW_RENDERFULLCONTENT=2) 截整窗，取标题栏像素
```

| 状态（同一进程内切换，未重启） | 标题栏 (w/2, 10/24/40) | 应用内 header (w/2, 70) |
|---|---|---|
| 浅色 | `R244 G241 B249` | `R245 G245 B246` = `#f5f5f6` |
| 点击主题按钮 → 深色 | `R33 G30 B39` | `R34 G32 B32` = `#222020` |
| 再点一次 → 浅色（回切） | `R244 G241 B249` | `R245 G245 B246` |

标题栏与 header 同步翻转，且双向可逆、不需要重启：说明 `getCurrentWindow().setTheme()` 生效，
`core:window:allow-set-theme` 权限声明正确（缺权限时 IPC 会被 ACL 拒绝，标题栏不会变）。

## 验收对照

| 验收项 | 结论 | 证据 |
|---|---|---|
| 浅色/深色切换后 header 背景、文字、边框、badge、hover 全部跟随 | 通过 | 下表 computed style：背景 245/245/246 → 34/32/32，文字 25/25/25 → 244/243/243，边框 233/233/237 → 54/51/51，badge 与 icon 颜色同样翻转；hover 走 `--soxu-hover`（`#ececee` → `#2b2929`） |
| 原生标题栏深色下也是深色、切主题立即生效 | 通过 | 见上表：真实 Tauri 窗口内切换，标题栏 `R244 G241 B249` ↔ `R33 G30 B39`，双向可逆、无需重启；Linux/浏览器预览的降级由 `theme.test.ts` 覆盖 |
| header 相关样式无新增硬编码色值 | 通过 | `theme.test.ts`「顶部栏背景与文字只能引用 --soxu-* token」：抽出 `.app-header` 声明块（先剥离注释）后断言必须含 `var(--soxu-*)` 的 background/color/border-bottom，且不得出现 `#hex`/`rgb(a)`/`hsl(a)`/`white|black` |
| `pnpm --filter @soxu/desktop check` 通过 | 通过 | `pnpm check`（= desktop check + desktop test 70 项 + scripts test 47 项）全绿 |
| 附浅色/深色两张截图 | 通过 | `header-light.png` / `header-dark.png` |

## computed style（`measure-theme.js` 输出，节选）

| 字段 | 浅色 | 深色 |
|---|---|---|
| `html[data-theme]` | `light` | `dark` |
| `.app-header` color-scheme | `light` | `dark` |
| `.app-header` background | `rgb(245, 245, 246)` = `#f5f5f6` | `rgb(34, 32, 32)` = `#222020` |
| `.app-header` color | `rgb(25, 25, 25)` = `#191919` | `rgb(244, 243, 243)` = `#f4f3f3` |
| `.app-header` border-bottom | `rgb(233, 233, 237)` = `#e9e9ed` | `rgb(54, 51, 51)` = `#363333` |
| `.location-scope` color | `rgb(87, 87, 87)` | `rgb(196, 190, 190)` |
| header `.icon-button` color | `rgb(87, 87, 87)` | `rgb(196, 190, 190)` |
| header `.badge` color | `rgb(192, 57, 43)`（danger 态） | `rgb(224, 114, 95)` |
| `--soxu-hover` | `#ececee` | `#2b2929` |
| `body` background | `rgb(252, 252, 252)` = `#fcfcfc` | `rgb(25, 23, 23)` = `#191717` |

`badge` 在浏览器预览里是 danger 态（`浏览器预览`），桌面端真实运行时是 `Rust 运行时`，两者共用同一组 token。

## 像素采样（1920×1080，PNG 直接取色）

| 截图 | 顶部栏 (600,26) | 正文 (600,400) |
|---|---|---|
| `header-light.png` | `R245 G245 B246` | `R252 G252 B252` |
| `header-dark.png` | `R34 G32 B32` | `R25 G23 B23` |

深色下顶部栏 `#222020` 与正文 `#191717` 只差 9 个色阶，靠 `border-bottom: #363333` 分隔，没有出现近白色大面积背景。

## 截图

| 文件 | 说明 |
|---|---|
| `header-light.png` | 浏览器预览，浅色主题：顶部栏 `#f5f5f6`、正文 `#fcfcfc` |
| `header-dark.png` | 浏览器预览，深色主题：顶部栏 `#222020`、正文 `#191717`（同一会话，点击主题按钮后 1400ms） |
| `titlebar-light.png` | 真实 Tauri 窗口，浅色：标题栏浅色，下方 header `#f5f5f6` |
| `titlebar-dark.png` | 真实 Tauri 窗口，深色：标题栏 `R33 G30 B39`，下方 header `#222020` |
| `measure-theme.js` | 采集脚本：读取浅/深两态的 computed style |
| `switch-to-dark.js` | 采集脚本：点击主题按钮并等待过渡结束 |

`titlebar-*.png` 只裁了窗口顶部 62px（标题栏 + header 上沿）：整窗截图会带上用户自己的会话标题，
不适合入库。

## 未覆盖 / 风险

- **Linux（GTK）不支持窗口级主题**：`set_theme` 会返回错误，`syncWindowTheme` 记 `failed` 后静默降级，
  应用内主题照常切换。
- **启动首帧仍是静态窗口背景**：主题偏好存在 WebView 的 `localStorage`，Rust 侧读不到，所以
  `tauri.conf.json` 的 `backgroundColor` 只能是一个固定值。深色偏好下冷启动可能有一两帧浅色底。
  彻底解决需要把主题偏好落到 Rust 状态，或改成 `visible: false` + 首帧后 `show()`；本轮没有改窗口可见性，
  避免前端异常时窗口永不出现的风险。
- **hover 态没有真实指针证据**：headless 下无法派发真实 hover。已确认 `.icon-button:hover` 只用
  `var(--soxu-hover)`（上表两态取值），没有硬编码色值。
- 只在 Windows 11 + WebView2 156（Chromium）验证；macOS `NSAppearance` 与 Linux WebKitGTK 未验证。
- 原生标题栏的深色是 DWM 绘制的标题栏（`R33 G30 B39`），与 header 的 `#222020` 不是同一个色值，
  这是系统主题的结果，不是 CSS 能控制的；两者视觉上一致即可。
