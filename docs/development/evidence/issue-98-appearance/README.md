# Issue #98 · 界面字体与字号自定义：实机证据

- 采集日期：2026-10-29（复审整改后重新采集）
- 采集对象：本工作树 `apps/desktop` 的 Vite 预览，即 `App.vue` + `components/SettingsDialog.vue` +
  `components/MessageList.vue` + `styles/base.css` + `theme/appearance.ts` + `composables/useAppearance.ts`
  的真实运行结果
- 浏览器：Microsoft Edge 156.0.4314.50（Chromium，`--headless=new`，`--remote-debugging-port=9448`，
  独立 `--user-data-dir`），视口 1280×860，DPR 1
- 交互：CDP `Input.dispatchMouseEvent`（真实点击设置入口与单选项）与 `Page.captureScreenshot`
- 说明：浏览器预览没有 Tauri 桥，因此没有真实会话；会话正文取用仓库既有的 `MessageList` DOM 夹具
  （`tests/harness/long-session.html`，Issue #36）渲染真实组件与真实 CSS，见第 3 节。

## 复审整改（本轮的改动范围）

| 复审意见 | 处理 | 证据 |
|---|---|---|
| 「等宽」档实际让整个界面变等宽（代码块本就恒等宽），与设置面板文案「只影响代码块与工具输出」相反 | 改文案与证据表述（复审给出的两条路径之一）：「等宽」如实描述为**界面字体**档；代码块与工具输出始终等宽、会话正文不变 | 面板文案见截图 `07-family-mono.png`；实测见第 2、3 节；事实源头是 `base.css` 的 `:root[data-font-family="mono"]` 只覆盖 `--soxu-font-family-ui` |
| 同一说法散落在注释里，容易再次漂移 | 同步 `components/SettingsDialog.vue`（面板文案）、`theme/appearance.ts`、`styles/base.css` 的说法；`components/MessageList.vue` 的原注释本就是「界面变等宽、正文不变」，无需改动 | 见本轮 diff |
| 防止文案与 CSS 再次矛盾 | 新增回归测试「设置面板文案与真实作用域一致」：文案必须点到「界面」「正文」，不得出现「只影响代码块」，并断言等宽档只改 `--soxu-font-family-ui` | `apps/desktop/tests/appearance.test.ts` |

为什么选「改文案」而不是「把作用域收窄到代码块」：代码块与工具输出**本来就恒等宽**（改动前如此，
默认零回归要求它保持如此）。若等宽档连界面字体都不改，这一档就等于没有任何可见效果，
Issue 要求的「三选」会退化成「两选 + 一个空档」。Issue 技术路径里那句「只影响代码/工具输出块」
与它自己的验收项 3（「代码块变等宽、正文不变」）在本项目里无法同时成立，因此作用域如实定为
**界面字体**，并把「正文不变」作为硬约束守住（下面第 2、3 节有逐项实测）。

## 复现步骤

```powershell
# 1. 启动前端预览（1423 曾残留一个旧监听，本轮采集改用 1424）
pnpm --filter @soxu/desktop exec vite --port 1424 --strictPort --host 127.0.0.1

# 2. 启动独立 profile 的 headless Edge 并暴露 CDP
$args = @(
  '--headless=new',
  '--remote-debugging-port=9448',
  ('--user-data-dir=' + $env:TEMP + '\soxu-98-edge'),
  '--no-first-run', '--disable-extensions', '--hide-scrollbars', 'about:blank'
)
Start-Process -FilePath 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe' -ArgumentList $args

# 3. CDP 脚本（Node 26 自带 WebSocket）：
#    PUT /json/new?about:blank 建立页面 → Emulation.setDeviceMetricsOverride 1280x860 → Page.navigate →
#    等 .app-shell 出现 → 点击 button[aria-label="设置"] → 逐个点击 input[name="soxu-font-size"] /
#    input[name="soxu-font-family"] → 读 computed style 与 localStorage → Page.captureScreenshot
```

会话正文（10–16）走夹具页：`/tests/harness/long-session.html?count=40`。夹具页只挂 `MessageList`，
不含 `main.ts`，所以采集脚本按 `applyDocumentAppearance` 的同一写法直接写
`<html data-font-size data-font-family>`，再取 computed style 与截图——这与生产启动路径写的是同一组属性。

## 实现要点

| 关注点 | 做法 |
|---|---|
| 持久化 | `localStorage["soxu.appearance"]` 存 JSON `{"fontSize":…,"fontFamily":…}`，与 `soxu.theme` 同域但独立成键（清字号偏好不该丢主题）；逐字段容错，脏值只回退坏的那一项 |
| 应用方式 | `<html data-font-size data-font-family>`，由 `theme/appearance.ts` 在 **挂载前** 写入（`main.ts`），组件内没有任何档位判断 |
| 字号缩放 | `html { font-size: calc(1rem * var(--soxu-font-scale)) }`；`:root` 的 `--soxu-font-scale` 默认 `1`，组件里原有的 px 字号全部按 16px 基准改写为 rem |
| 字体栈 | 三个 token 单一来源：`--soxu-font-family-ui`（界面字体）、`--soxu-font-family-body`（会话正文/输入框）、`--soxu-font-family-mono`（代码与工具输出）；组件只引用 token |
| 字体档作用域 | 三档（系统默认 / 无衬线 / 等宽）**只改 `--soxu-font-family-ui`**：界面（侧栏、按钮、标签、设置面板、消息行标签）跟随；代码块与工具输出始终是等宽栈；会话正文气泡与输入框用 `--soxu-font-family-body`，任何档位下都不变 |

字号档位与 Issue 的 13 / 14 / 15 / 16.5px 等比例对应（以标准档 14px 为基准），但 root 基准保留浏览器的 16px：

| 档位 | Issue 参考值 | `--soxu-font-scale` | root font-size 实测（本轮） |
|---|---|---|---|
| 小 | 13px | 0.93 | 14.88px |
| 标准（默认） | 14px | 1 | **16px**（= 改动前，浏览器默认） |
| 大 | 15px | 1.07 | 17.12px |
| 特大 | 16.5px | 1.18 | 18.88px |

为什么不把 root 直接写成 13/14/15/16.5px：标准档若写 14px，则所有继承默认字号的文本（body 未声明 font-size）
都会从 16px 变 14px，与「默认值 = 现状」冲突；保留 16px 基准后，原来的 px 全部按 `px / 16` 换 rem
（分母是 2 的幂，0.5px 的整数倍），标准档逐像素等于改动前。

## 1. 字号档位实测（真实点击设置面板单选项）

| 点击档位 | `html.dataset.fontSize` | `--soxu-font-scale` | root font-size | 设置面板标题 | 分组标题 | 选项标签 | 脚注 | `localStorage` |
|---|---|---|---|---|---|---|---|---|
| 小 | small | 0.93 | 14.88px | 13.95px | 10.23px | 11.625px | 9.765px | `{"fontSize":"small","fontFamily":"system"}` |
| 标准 | standard | 1 | 16px | 15px | 11px | 12.5px | 10.5px | `{"fontSize":"standard","fontFamily":"system"}` |
| 大 | large | 1.07 | 17.12px | 16.05px | 11.77px | 13.375px | 11.235px | `{"fontSize":"large","fontFamily":"system"}` |
| 特大 | xlarge | 1.18 | 18.88px | 17.7px | 12.98px | 14.75px | 12.39px | `{"fontSize":"xlarge","fontFamily":"system"}` |

持久化：`Page.navigate` 重新加载后 `html.dataset.fontSize = "xlarge"`、root font-size = 18.88px、
设置面板标题 17.7px、「字号」选中项 = `xlarge`（`06-after-reload-xlarge.png`）。

## 2. 字体族实测（同一台机器、同一视口，逐档真实点击）

| 档位 | `--soxu-font-family-ui` | `--soxu-font-family-body` | 设置面板标题 computed | `localStorage` |
|---|---|---|---|---|
| 系统默认（默认） | `Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif` | 与 ui 相同（= 改动前） | 同上（sans） | `{"fontSize":"xlarge","fontFamily":"system"}` |
| 无衬线 | `"Helvetica Neue", Arial, "Microsoft YaHei", "PingFang SC", sans-serif` | **不变** | 同 ui | `{…,"fontFamily":"sans"}` |
| 等宽 | `ui-monospace, SFMono-Regular, "Cascadia Mono", Consolas, monospace` | **不变** | 同 ui（等宽栈） | `{…,"fontFamily":"mono"}` |

三档的 `--soxu-font-family-mono` 恒为 `ui-monospace, SFMono-Regular, "Cascadia Mono", Consolas, monospace`，
即**代码块与工具输出不受字体档影响**（选系统默认时它们也是等宽）。

面板内的说明文案（本轮整改后，实测 `textContent`）：

> 「等宽」切换的是界面字体（侧栏、按钮、设置等）；代码块与工具输出始终等宽，会话正文不随这一项变化。

## 3. 会话正文与工具输出（`MessageList` DOM 夹具，真实组件 + 真实 CSS）

```json
{
  "small/system":    { "assistantBubble": { "fontSize": "13.02px", "fontFamily": "Inter, ui-sans-serif, …" },
                       "toolBubble": { "fontSize": "11.16px", "fontFamily": "ui-monospace, …" },
                       "messageLabel": { "fontSize": "9.765px", "fontFamily": "Inter, ui-sans-serif, …" } },
  "standard/system": { "assistantBubble": { "fontSize": "14px", "fontFamily": "Inter, ui-sans-serif, …" },
                       "toolBubble": { "fontSize": "12px", "fontFamily": "ui-monospace, …" },
                       "messageLabel": { "fontSize": "10.5px", "fontFamily": "Inter, ui-sans-serif, …" } },
  "large/system":    { "assistantBubble": { "fontSize": "14.98px", "fontFamily": "Inter, ui-sans-serif, …" },
                       "toolBubble": { "fontSize": "12.84px", "fontFamily": "ui-monospace, …" },
                       "messageLabel": { "fontSize": "11.235px", "fontFamily": "Inter, ui-sans-serif, …" } },
  "xlarge/system":   { "assistantBubble": { "fontSize": "16.52px", "fontFamily": "Inter, ui-sans-serif, …" },
                       "toolBubble": { "fontSize": "14.16px", "fontFamily": "ui-monospace, …" },
                       "messageLabel": { "fontSize": "12.39px", "fontFamily": "Inter, ui-sans-serif, …" } },
  "standard/mono":   { "assistantBubble": { "fontSize": "14px", "fontFamily": "Inter, ui-sans-serif, …" },
                       "toolBubble": { "fontSize": "12px", "fontFamily": "ui-monospace, …" },
                       "messageLabel": { "fontSize": "10.5px", "fontFamily": "ui-monospace, …" } },
  "standard/sans":   { "assistantBubble": { "fontSize": "14px", "fontFamily": "Inter, ui-sans-serif, …" },
                       "toolBubble": { "fontSize": "12px", "fontFamily": "ui-monospace, …" },
                       "messageLabel": { "fontSize": "10.5px", "fontFamily": ""Helvetica Neue", Arial, …" } }
}
```

读法：等宽档下 `assistantBubble`（正文气泡）与标准档完全一致——**正文不变**；`toolBubble` 一直是等宽；
`messageLabel`（「用户 / 助手」这类行标签）属于界面文案，跟随 `--soxu-font-family-ui`，因此等宽档下变等宽。
输入框（`.composer textarea`）与气泡同用正文 token，等宽档下不变（有对应源码断言）。

## 结论（对应 Issue 验收项）

| 验收项 | 结论 | 证据 |
|---|---|---|
| 设置里改字号即时生效，重启后保持 | 通过 | 点击单选项后 `<html data-font-size>`、root font-size 与面板字号同帧变化（第 1 节）；`localStorage` 立即写入；`Page.navigate` 重新加载后仍是 `xlarge` / 18.88px，选中态为「特大」（`06-after-reload-xlarge.png`） |
| 四档字号（或滑杆范围）全部可用的截图 | 通过 | `02-size-small.png`、`03-size-standard.png`、`04-size-large.png`、`05-size-xlarge.png`（都含设置面板选中态）；会话正文四档见 `10`–`13` |
| 等宽档下代码块变等宽、正文不变 | 通过 | 等宽档：`toolBubble` = `ui-monospace…`（12px），`assistantBubble` = 正文栈（14px，与标准档逐值相同），面板文案与本表口径一致；截图 `14-message-family-mono.png`、`07-family-mono.png`。补充：代码块与工具输出在**任何**字体档下都是等宽栈，字体档改的是界面字体（复审整改说明见文首） |
| 默认值与现状像素一致（回归零） | 通过 | 默认档 root = 16px、`--soxu-font-scale: 1`；设置面板标题 15px、分组标题 11px、选项 12.5px、脚注 10.5px、消息正文 14px、工具输出 12px，全部等于改动前的 px 值；`--soxu-font-family-ui` 与 `--soxu-font-family-body` 都等于改动前 body 的字体栈 |
| `pnpm --filter @soxu/desktop check` 通过 | 通过 | `vue-tsc --noEmit` 退出码 0；`pnpm --filter @soxu/desktop test` 110 项全绿（其中 `tests/appearance.test.ts` 14 项） |

## 截图

| 文件 | 说明 |
|---|---|
| `01-default-standard-system.png` | 默认外观（标准 / 系统默认），设置面板未打开，与改动前像素一致 |
| `02-size-small.png` | 小档，设置面板中「小」选中 |
| `03-size-standard.png` | 标准档，「标准」选中 |
| `04-size-large.png` | 大档，「大」选中 |
| `05-size-xlarge.png` | 特大档，「特大」选中 |
| `06-after-reload-xlarge.png` | 重新加载页面后仍是特大档，选中态恢复 |
| `07-family-mono.png` | 等宽档：界面字体（含设置面板与说明文案）变等宽，正文 token 不变 |
| `08-family-sans.png` | 无衬线档：界面切到 Helvetica/Arial 栈 |
| `09-family-system.png` | 回到系统默认档 |
| `10-message-small.png` | 夹具：小档的会话正文（13.02px） |
| `11-message-standard.png` | 夹具：标准档的会话正文（14px，= 改动前） |
| `12-message-large.png` | 夹具：大档的会话正文（14.98px） |
| `13-message-xlarge.png` | 夹具：特大档的会话正文（16.52px） |
| `14-message-family-mono.png` | 夹具：等宽档，正文气泡仍是正文栈、工具输出仍是等宽、行标签随界面变等宽 |
| `15-message-family-sans.png` | 夹具：无衬线档，正文气泡与工具输出均不变，行标签切 Helvetica/Arial |
| `16-message-tool-xlarge.png` | 夹具：特大档 + 工具输出（正文 16.52px / 工具 14.16px 同时放大） |

## 未覆盖 / 风险

- 只在 Windows + Chromium（Edge 156）验证；Tauri 实际 WebView、macOS（WKWebView）与 Linux（WebKitGTK）未验证。
  三者的差异主要在等宽栈的解析结果（`ui-monospace`、`Cascadia Mono`、`Consolas` 是否命中），不影响字号缩放。
- 会话正文未能用真实 Pi 会话截图（浏览器预览没有 Tauri 桥）；夹具用的是 `MessageList` 本身与 `base.css`，
  取值与真实会话同源，但未在 Tauri 窗口内逐档对比过真实长会话。
- 字号只缩放 **文字**：图标尺寸、行高像素、内边距、侧栏宽度等仍是固定 px。
  特大档（1.18）下按钮与标签盒会略微变紧，实测未见溢出（设置面板选项已允许换行）。若后续把布局尺寸也改成 rem，需要重新截图核对。
- 「等宽」是界面字体档：会话列表、设置面板、行标签都会变等宽，长段界面文案的可读性会下降——这是该档的预期行为，
  不是缺陷；正文气泡与输入框被刻意排除在外（正文 token 独立）。
- 第三方注入内容（例如未来渲染的 Markdown 内联样式、Pi 扩展自绘界面）不在缩放范围内：
  它们若写死 px 字号，不会跟随 `--soxu-font-scale`。
- `tests/appearance.test.ts` 里有三条结构性约束（源码里禁止 `font-size: …px`、禁止在组件里写死 `font-family`、
  设置面板文案必须与等宽档的实际作用域一致），新增组件或改文案若确有必要绕过，需要连同测试一起改并说明原因。
