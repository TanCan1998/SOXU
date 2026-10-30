# Issue #123 命令面板：真实渲染与全键盘执行证据

采集脚本：`apps/desktop/tests/harness/shoot-issue-123-palette.mjs`
夹具页面：`apps/desktop/tests/harness/command-palette.html`
原始指标：`metrics.json`（同目录）

## 环境

| 项 | 值 |
| --- | --- |
| 日期 | 2026-10-30 |
| 浏览器 | Edg/156.0.4314.50（headless=new，CDP 驱动） |
| 视口 | 1280 × 720，deviceScaleFactor 1 |
| 平台 | Windows，Node 26.10.0 |
| 被测对象 | 生产代码里的 `CommandPalette.vue` + `COMMANDS` + `match.ts` |

夹具只替换「动作落地」：命令执行写到内存里的 `actionLog`，不写存储。
匹配、排序、高亮、键盘语义、设置弹窗（`SettingsDialog.vue` 真组件）全部是生产代码，
夹具没有重写被测逻辑。设置弹窗的 `open` / `initialTab` / `request` 接线与 `App.vue` 一致，
因此「设置已经开着时再请求一次」这条路径是真实渲染验证，不是单元测试的复述。

## 复现

```bash
node apps/desktop/tests/harness/shoot-issue-123-palette.mjs
```

脚本自己拉起 Vite（1427 端口）与独立 profile 的 headless Edge（CDP 9459），
结束后回收两个子进程；失败时退出码为 1。

## 键盘序列（本次采集实际按下的键）

| 步骤 | 操作 | 结果 |
| --- | --- | --- |
| 1 | 打开面板 | 输入框自动聚焦（`focused = cp-input`），拼音字典异步 chunk 已就绪（`data-pinyin=ready`），列表给出全部 36 条命令 |
| 2 | 输入 `dk` | 命中 11 条，前 10 条都是「打开…」，首条是「打开设置」；「打开」两字高亮 |
| 3 | `↓` `↓` | 高亮落到第 3 条（`soxu-command-option-2`），`aria-activedescendant` 同步 |
| 4 | `↑` | 高亮回到第 2 条「打开会话搜索」 |
| 5 | `↵` | 执行 `panel.search` → `openSearch` 真的被调用，面板随即关闭 |
| 6 | `Esc` | 关闭面板，不执行任何命令 |
| 7 | 输入 `sz` | 首条是「打开设置」，「设置」两字高亮 |
| 8 | 输入 `消息时间戳` + `↵` | 命中设置项命令，执行 `openSettings:session`（跳到设置 → 会话） |
| 9 | 输入 `xxt` | 无结果态：`没有匹配的命令` |
| 10 | 从触发按钮打开后按 `Tab` / `Shift+Tab` | 焦点仍在面板内（`cp-input`），没有跑到背后的界面上 |
| 11 | `Esc` 关闭 | 焦点回到触发按钮（`harness-trigger`），不是掉到 `<body>` |
| 12 | 输入 `系统` + `↵` | 执行「打开设置 · 系统」，**真实设置弹窗**打开并停在系统页（请求序号 +1） |
| 13 | 再开面板、输入 `外观` + `↵` | 设置**没有关**，标签页从系统切到外观（请求序号再 +1）——复审阻塞点 A 的真实渲染证据 |

第 3–5 步是「全键盘完成一次命令执行」的直接证据：整个过程没有一次鼠标事件，
按键走的是 CDP `Input.dispatchKeyEvent`（浏览器级真实按键），不是页面里合成的
`KeyboardEvent`。

## 31 项检查全部通过

`metrics.json` 的 `checks` 覆盖：打开即聚焦、拼音字典按需加载完成、命令总数、底部快捷键提示、
`dk` 命中全部「打开…」命令、首条是「打开设置」、命中高亮是「打开」、
输入到渲染耗时（`dkLatencyMs`，预算 250 ms；本 README 不复述该数值）、↓ 移动高亮、`aria-activedescendant` 同步、
↵ 执行选中项、动作真的被调用、执行后面板关闭、Esc 不执行、`sz` 命中与高亮、
设置项命令命中并跳到对应页、无结果态、深色主题面板背景 `rgb(33, 33, 33)`、无障碍语义
（dialog / aria-modal / combobox / listbox / option / aria-selected / status）、
`Tab` 与 `Shift+Tab` 焦点圈（`tab-trap-stays-inside` / `shift-tab-trap-stays-inside`）、
关闭后焦点还原到触发元素（`focus-restored-to-trigger`）、
设置项命令真的打开设置并落到对应页（`setting-entry-really-opened-settings`）、
设置已开着时命令面板换页（`settings-tab-command-found` / `settings-opened-on-target-tab` /
`settings-stays-open-on-retarget` / `settings-retargeted-to-new-tab` / `settings-request-incremented`）、
页面无 JS 异常。

「输入 → 渲染」的耗时含一次 CDP 往返，历次采集在 17–23 ms 之间波动；
以 `metrics.json` 的 `dkLatencyMs` 为准，不要引用某一次的具体数字。

## 截图

| 文件 | 内容 |
| --- | --- |
| `01-light-open.png` | 打开态：输入框聚焦 + 全部命令 + 底部快捷键提示 |
| `02-light-dk.png` | 输入 `dk`：11 条结果，「打开」高亮 |
| `03-light-keyboard.png` | `↓↓` 之后：高亮在第 3 条「打开 Git 面板」 |
| `04-after-execute.png` | `↵` 执行后：面板关闭 |
| `05-light-sz.png` | 输入 `sz`：「设置」高亮 |
| `06-light-setting-entry.png` | 输入「消息时间戳」：设置项命令 + 「设置 · 会话」提示 |
| `07-light-no-results.png` | 无结果态 |
| `08-dark-dk.png` | 深色主题下的同一份结果 |
| `09-settings-retarget.png` | 设置已开着时从命令面板切页：标签停在「外观」，弹窗没有关 |

## 未覆盖

- 真实 Tauri 窗口里的 `⌘K`（macOS）未验证：本机只有 Windows，按键映射用的是
  `event.ctrlKey || event.metaKey`，macOS 需要在真机上补一次走查。
- 屏幕阅读器（NVDA / VoiceOver）只做了语义结构断言，没有实机朗读记录。
- 焦点圈与焦点还原在夹具页面里验证（单 webview）；真实 Tauri 窗口里的多 webview 切换未走查。
- 设置弹窗内的二次交互（改值后再用命令面板换页）未走查：夹具只验证换页与请求序号，
  改值链路由 `tests/settingsDialog.test.ts` 的单元测试覆盖。
- 「打开终端」「打开文件」不在注册表里（对应面板尚未实现），因此 `dk` 不会命中它们。
- 拼音字典在真实 Tauri 窗口里的首次加载耗时未测量：本机只测了 dev server 下的动态 chunk
  （打开面板到 `data-pinyin=ready` 在同一帧序列内完成，未单独计时）。

## 上轮复审阻塞点的逐条确认

三个阻塞点（设置已打开时切页、文档耗时与 `metrics.json` 一致、`aria-modal` 焦点圈与焦点还原）
逐条对应到修复位置与可复现验证，见
[命令面板文档 §7](../../command-palette.md#7-上轮复审阻塞点逐条确认)。
本目录的 `metrics.json` 是其中两条（耗时、焦点）的唯一数字来源。
