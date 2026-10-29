# Issue #116 · V4-S2 设置页（外观 / 会话 / 扩展 / 系统）验证记录

本目录记录 **V4-S2 切片**的可复现验证：命令、环境、原始输出与截图。
每条证据都能对回 Issue 的 acceptance criteria；未验证或未实现的部分在文末单列，
不写成已完成。

- 验证时间：2026-10-30
- 环境：Windows（本机）· Node v26.10.0 · pnpm 12.15.0 · Edge 156.0.4314.50（headless）
- 复现脚本：`node apps/desktop/tests/harness/shoot-issue-116-settings.mjs`
- 原始指标：`metrics.json`（同目录）

---

## 1. 验收对照

| Acceptance criterion | 证据 |
|---|---|
| `pnpm check` 通过，桌面端测试全绿 | §2.1：231 个桌面端用例 + 47 个脚本用例，0 failed |
| 4 个 tab 切换正常，键盘可达（Tab / 方向键） | §3.2 的 `tabs`/`panels`/`keyboard` 指标 + 截图 07 |
| 主题与强调色切换实时生效且持久化（重启后保持） | §3.3 `accentViolet`/`dark`/`afterReload` 三组指标 + 截图 02/06/08；强调色在组件里的实际消费见 §3.7 |
| 新增测试覆盖设置的读写与默认值 | §2.2：`tests/settingsDialog.test.ts`（21 个用例）+ `tests/appearance.test.ts` 扩充 |
| 提交规范：`<gitmoji> type(scope): 描述`，目标分支 `dev` | 由 Runner 统一提交（Developer 不执行 `git commit`） |

## 2. 命令与原始结果

### 2.1 类型检查与测试

```
$ pnpm check
# icons:generate + vue-tsc --noEmit + node --test tests/*.test.ts + node --test scripts/tests/*.test.mjs
ℹ tests 231
ℹ pass 231
ℹ fail 0
ℹ tests 47
ℹ pass 47
ℹ fail 0
```

> 桌面端用例数 226 → 231 是本轮新增的 `tests/sendCaretContrast.test.ts`（5 个，见 §3.7）。

> 若在**开发 Agent 会话**里直接跑 `pnpm check`，`scripts/tests/secret-gate.test.mjs` 会因环境里存在
> `SOXU_AGENT_SESSION=1`（pre-commit 钩子按设计拒绝 Agent 直接提交）而失败。这是环境注入造成的既有现象，
> 与本次改动无关：清掉该变量后 47 个脚本用例全绿（上面的结果即如此）。

### 2.2 新增与调整的用例

| 文件 | 数量 | 覆盖 |
|---|---|---|
| `tests/settingsDialog.test.ts`（新增） | 23 | 会话页/系统页偏好读写与默认值、脏值逐项回退、存储不可用；扩展页 12 项静态占位且不写存储；强调色（含「深色块不得重复声明 --soxu-accent」的回归用例）/代码字体/衬线/正文宽度在 base.css 的档位与组件消费方式；四 tab 结构与 reka-ui 控件；App.vue 接线（思考强度透传、清空会话不删除、清空保留草稿、恢复布局、复制路径）；时间戳格式化；数据目录与应用标识符一致；设置组件不写死字体栈 |
| `tests/sendCaretContrast.test.ts`（新增） | 5 | 发送区前景的**组件级**约束：caret 的 `color` 必须等于 `var(--soxu-on-accent)` 且块内无白色字面量、分隔线由 on-accent 推导、主钮与 caret 前景同源、六个色板的 on-accent 对主色都 ≥ 3:1（复审阻塞点的回归用例） |
| `tests/appearance.test.ts`（扩充） | 15 | 五个外观字段的合法性、选项表、默认值、往返与逐字段容错、`applyDocumentAppearance` 写满五个 `data-*`、`useAppearance` 当帧落地与幂等写入；**色板前景色 WCAG 对比度校验** |
| `tests/theme.test.ts`（调整） | 9 | 深色 token 的双选择器与「大面积背景不是近白」检查：强调色派生色改由 color-mix 推导后，改为核对 `*-dark` 源值与默认色源值的亮度 |
| `tests/sendModes.test.ts`（调整） | 11 | 「忙碌时发送」从 SettingsDialog.vue 搬到 `components/settings/SettingsSession.vue` 后的断言迁移 |
| `tests/uiWording.test.ts`（调整） | 4 | 「关于」搬到系统页后的断言迁移 |

## 3. 浏览器实测（`metrics.json`）

脚本内维护一组 `checks`（名称 + 期望 + 实测），任一条不成立就以非 0 退出并在 `metrics.json` 里留痕，
避免生成一份「看起来正常、其实已经回归」的证据。本轮 7 条全部通过。

### 3.1 起点

```json
"initial": {
  "theme": "light",
  "appearance": { "fontSize": "standard", "fontFamily": "system", "codeFont": "system",
                  "contentWidth": "fixed", "accent": "blue" },
  "dataset": { "fontSize": "standard", "fontFamily": "system", "codeFont": "system",
               "contentWidth": "fixed", "accent": "blue", "theme": "light" },
  "accent": "#3a83f7", "accentSoft": "#e8f0ff", "contentMax": "768px",
  "accentInShell": "#3a83f7", "accentSoftInShell": "#e8f0ff", "onAccentInShell": "#ffffff",
  "session": { "sendAfterScroll": true, "enterToSend": true, "showToolCalls": false,
               "showTimestamps": false, "thinkingLevel": "medium" },
  "storage": { "appearance": null, "session": null, "system": null, "theme": null }
}
```

> `accentInShell` / `accentSoftInShell` / `onAccentInShell` 是从 `.app-shell` 元素上
> 读出的计算值。复审教训：只量 `documentElement` 看不出「深色下 app-shell 子树仍是蓝色」，
> 因为深色 token 同时挂在 `:root` 与 `.app-shell` 两个选择器上，后者会覆盖前者的色板。

要点：**启动时不写存储**（`storage.* = null`），即没有改动设置的用户不会被写死一份默认偏好；
默认强调色 `#3a83f7`、默认宽度 `768px` 与 base.css / tokens.css 的默认值一致。

### 3.2 四个 tab 与键盘

```json
"keyboard": {
  "tabs": [ {"label":"外观","selected":"false"}, {"label":"会话","selected":"true","focused":true},
            {"label":"扩展","selected":"false"}, {"label":"系统","selected":"false"} ],
  "panels": [ {"hidden":true,"rows":0}, {"hidden":false,"rows":7},
              {"hidden":true,"rows":0}, {"hidden":true,"rows":0} ]
}
```

焦点停在「外观」时按一次 **→**：选中项与可见面板一起切到「会话」（7 行），其余三页 `hidden`。
`role=tab` / `aria-selected` / `role=tabpanel` 全部由 reka-ui Tabs 提供。

紧接着按一次 **Tab**（`keyboard.afterTab`）：焦点离开标签栏，落到 `role=tabpanel` 的面板容器上
（`insidePanel: true`），再按一次 Tab 即进入面板内的第一个控件（开关 / 单选组都自带键盘语义）。
标签栏内部是 roving focus：只有当前标签停在 Tab 序列里，方向键负责在四个标签间移动。

### 3.3 强调色与主题：实时生效 + 持久化

```json
"accentViolet": {
  "appearance": { "accent": "violet" },
  "dataset": { "accent": "violet" },
  "accent": "#8b5cf6", "accentInShell": "#8b5cf6", "onAccentInShell": "#ffffff",
  "accentSoftInShell": "color-mix(in srgb, #8b5cf6 14%, transparent)",
  "storage": { "appearance": "{\"fontSize\":\"standard\",\"fontFamily\":\"system\",\"codeFont\":\"system\",\"contentWidth\":\"fixed\",\"accent\":\"violet\"}" }
},
"accentAmber": {
  "appearance": { "accent": "amber" },
  "accentInShell": "#f59e0b", "onAccentInShell": "#191717",
  "accentSoftInShell": "color-mix(in srgb, #f59e0b 14%, transparent)"
},
"dark": {
  "theme": "dark",
  "dataset": { "theme": "dark" },
  "accent": "#8b5cf6", "accentInShell": "#8b5cf6", "onAccentInShell": "#ffffff",
  "accentSoftInShell": "color-mix(in srgb, #8b5cf6 26%, transparent)",
  "dialogBg": "rgb(33, 33, 33)",
  "storage": { "theme": "dark" }
},
"afterReload": {
  "theme": "dark",
  "dataset": { "codeFont": "jetbrains", "contentWidth": "fluid", "accent": "violet", "theme": "dark" },
  "accent": "#8b5cf6", "accentInShell": "#8b5cf6",
  "accentSoftInShell": "color-mix(in srgb, #8b5cf6 26%, transparent)",
  "contentMax": "100%",
  "fontMono": "\"JetBrains Mono\", ui-monospace, SFMono-Regular, \"Cascadia Mono\", Consolas, monospace",
  "storage": {
    "appearance": "{\"fontSize\":\"standard\",\"fontFamily\":\"system\",\"codeFont\":\"jetbrains\",\"contentWidth\":\"fluid\",\"accent\":\"violet\"}",
    "session": "{\"sendAfterScroll\":false,\"enterToSend\":true,\"showToolCalls\":false,\"showTimestamps\":false,\"thinkingLevel\":\"medium\"}",
    "system": "{\"autoUpdate\":false,\"notifyOnComplete\":true,\"minimizeToTray\":true}",
    "theme": "dark"
  }
}
```

结论：

1. **实时生效**：点「紫罗兰」后 `<html data-accent="violet">` 与计算值 `--soxu-accent: #8b5cf6` 同一帧更新，
   **并且 `.app-shell` 子树内的计算值同步是 `#8b5cf6`**（`accentInShell`），截图 02 里选中描边、开关轨道、
   tab 下划线一起变紫；
   组件级证据：选中 tab 的下划线 `activeTabBorder` = `rgb(139, 92, 246)`，说明组件确实引用了同一套 token；
2. **深色下不会退回蓝色**：切到深色后 `accentInShell` 仍是 `#8b5cf6`、`activeTabBorder` 仍是
   `rgb(139, 92, 246)`，派生色从 14% 切到 26%（`accentSoftInShell`）。截图 06 的像素统计：紫罗兰色像素 412 个、索序蓝 0 个
   （`System.Drawing` 逐像素比对，命令见 §9）；
3. **重启后保持**：刷新页面（= 重启）后从 localStorage 读回 `theme=dark / accent=violet / codeFont=jetbrains /
   contentWidth=fluid / sendAfterScroll=false / autoUpdate=false`，`--soxu-content-max` 变成 `100%`、
   等宽栈变成 JetBrains Mono（截图 08）；
4. **深色面板**取 `--bg-panel` = `#212121`（V4 token），不是 V3 的 `#191717`：设置弹窗是本切片迁移到 S0 token 的第一个组件。

### 3.4 色板前景色对比度（复审要求：新色板白字未验证）

发送主钮是纯图标、色板勾选是 12px 描边图形，适用 WCAG 1.4.11 的**非文本对比度 3:1**。
每个色板取「白 / 墨（#191717）中对比度更高的一侧」，实测值（`tests/appearance.test.ts` 逐条断言）：

| 色板 | 主色 | 白字 | 深墨字 | 采用 | 采用值对比度 |
|---|---|---|---|---|---|
| 索序蓝（默认） | `#3a83f7` | 3.64 | 4.90 | 白（沿用既有基线） | 3.64:1 |
| 青绿 | `#10a37f` | 3.20 | 5.58 | 深墨 | 5.58:1 |
| 蓝绿 | `#14b8a6` | 2.49 | 7.17 | 深墨 | 7.17:1 |
| 紫罗兰 | `#8b5cf6` | 4.23 | 4.22 | 白 | 4.23:1 |
| 玫红 | `#f43f5e` | 3.67 | 4.86 | 深墨 | 4.86:1 |
| 琥珀 | `#f59e0b` | 2.15 | 8.31 | 深墨 | 8.31:1 |

浏览器实测（`accentAmber.onAccentInShell = "#191717"`）与上表一致：琥珀色板上的白字确实被换成深墨色。
默认色保留白字是为了不改既有观感，3.64:1 仍高于非文本 3:1；如果以后要在强调色底上放**正文**，
只有青绿/蓝绿/玫红/琥珀这四档达到 4.5:1，蓝与紫罗兰需要再调主色。

> **这张表只验证 token，不验证组件有没有消费它。** 上一轮就是拿着这张表写成「已改深墨色」，
> 而发送区 caret 实际仍写死 `#fff`（见 §3.7 的复审修复记录）。结论必须以组件级实测为准。

### 3.5 其余三页

```json
"extensions": { "items": 20, "switches": 12, "tags": ["已启用","已启用","已启用"] },
"system": { "rows": 7, "checkUpdateDisabled": true,
            "about": "关于SOXU 0.1.0 · Tauri 2.12.5 · Pi RPC已连接 连接状态：已连接本机运行时 · 平台：windows · …" },
"copy": { "copyState": "copied" }
```

- 扩展页 12 个扩展开关 + 4 个技能 + 4 个 MCP 服务（共 20 行），开关只在本地切换、不写存储；
- 系统页 7 行；「检查更新」在后端能力缺失时是 `disabled`（点击不会假成功）；
- 「复制路径」在 headless Edge 里真的写进了剪贴板（`copyState: "copied"`）。

### 3.6 截图

| 文件 | 内容 |
|---|---|
| `01-appearance-light.png` | 外观页（浅色）：主题 / 强调色六色板 / 界面字号 / 界面字体 / 代码字体 / 正文宽度 |
| `02-appearance-violet.png` | 选「紫罗兰」后：选中描边、tab 下划线随强调色变化 |
| `03-session-light.png` | 会话页：四个开关 + 思考强度 Select + 忙碌时发送 + 清空会话 |
| `04-extensions-light.png` | 扩展页：12 个扩展开关 + 技能列表 + MCP 服务列表（静态占位横幅） |
| `05-system-light.png` | 系统页：7 项，含禁用的「检查更新」与「复制路径」 |
| `06-appearance-dark.png` | 深色主题下的外观页（面板 `#212121`） |
| `07-keyboard-tabs.png` | 焦点在标签栏时按 → 切到「会话」页 |
| `08-after-reload-dark-violet.png` | 刷新后：深色 + 紫罗兰 + JetBrains Mono + 自适应宽度全部保持 |
| `09-send-caret-amber.png` | 琥珀色板下的发送区（主钮 + caret），6 倍放大：caret 是深墨色（§3.7） |
| `10-send-caret-teal.png` | 蓝绿色板下的发送区，6 倍放大：同上，上一轮这里是白字压浅底 |

### 3.7 发送区前景（复审阻塞点：caret 写死 `#fff`）

上一轮只把**色板 token** 改对了（`--soxu-on-accent`），但 `ComposerSendMenu.vue` 的 caret 仍然写死
`color: #fff`：琥珀 2.15:1、蓝绿 2.49:1，低于 WCAG 1.4.11 的非文本 3:1，而且当时没有组件级测试，
文档却写成「琥珀色板上的白字确实被换成深墨色」——**这句是错的**，本轮修正。

修复：caret 的前景改为 `var(--soxu-on-accent)`，分隔线改为
`color-mix(in srgb, var(--soxu-on-accent) 28%, transparent)`，组件里不再有白色字面量。

复现脚本（把真正的 `ChatPanel` 挂进 headless Edge，逐色板 × 深浅主题读**计算后**的前景色与底色）：

```powershell
node apps/desktop/tests/harness/shoot-send-caret-contrast.mjs   # 36 条断言，任一失败即非 0 退出
```

原始数据：`send-caret-contrast.json`（`samples` 12 条 = 6 色板 × 2 主题，`checks` 36 条全 `ok`，
`pageErrors: []`）。实测值（caret 计算色 / 底色 / 对比度）：

| 色板 | on-accent | caret 计算值 | 底色（`.send-split`） | 对比度 | 上一轮写死 #fff 时 |
|---|---|---|---|---|---|
| 索序蓝（默认） | `#ffffff` | `rgb(255, 255, 255)` | `rgb(58, 131, 247)` | 3.64:1 | 3.64:1 |
| 青绿 | `#191717` | `rgb(25, 23, 23)` | `rgb(16, 163, 127)` | 5.58:1 | 3.20:1 |
| 蓝绿 | `#191717` | `rgb(25, 23, 23)` | `rgb(20, 184, 166)` | 7.17:1 | **2.49:1 ❌** |
| 紫罗兰 | `#ffffff` | `rgb(255, 255, 255)` | `rgb(139, 92, 246)` | 4.23:1 | 4.23:1 |
| 玫红 | `#191717` | `rgb(25, 23, 23)` | `rgb(244, 63, 94)` | 4.86:1 | 3.67:1 |
| 琥珀 | `#191717` | `rgb(25, 23, 23)` | `rgb(245, 158, 11)` | 8.31:1 | **2.15:1 ❌** |

深色主题下数值完全相同：色板主色与 on-accent 不随主题变化，深色只切派生色比例（见 §3.3）。

补充证据：

1. `checks` 里同时断言 `caret 前景 === 主钮前景` 与 `caret 前景 === 色板的 --soxu-on-accent`，
   避免「只有 caret 改了、主钮没改」这类半边修复；
2. 分隔线的计算值跟着前景走（琥珀下是 `color(srgb 0.098 0.090 0.090 / 0.28)`，不再是 `1 1 1 / 0.28`）；
3. 截图 09/10 是 6 倍放大的发送区，逐像素统计（`System.Drawing`）：
   `09-send-caret-amber.png` 近墨色像素 2394、琥珀色像素 58143、蓝绿 0；
   `10-send-caret-teal.png` 近墨色像素 2425、蓝绿色像素 58163、琥珀 0。
   图里的近白像素（约 4.6 万）是按钮外围的浅色背景，不是图标；
4. 单元回归：`tests/sendCaretContrast.test.ts`（5 个用例）把「caret 必须引用 token、块内不得出现
   `#fff`/`rgb(255 255 255 …)`/`white`、分隔线由 on-accent 推导、六色板 ≥ 3:1」锁死，
   改回旧写法会直接失败（§2.2）。

## 4. 与 Issue 原文的差异（都是有意的，逐条说明）

| Issue 原文 | 实际实现 | 理由 |
|---|---|---|
| 界面字号：小 / 标准 / 大 | 小 / 标准 / 大 / **特大** | 「特大」是 Issue #98 已上线的档位，删掉等于回退既有功能；本切片保留四档 |
| 界面字体：Inter / 系统栈 / 衬线 | Inter / 系统栈 / 衬线 / **等宽** | 同上，等宽档是 #98 的既有能力；默认档 = Inter 优先栈，观感零变化 |
| 代码字体：JetBrains Mono / Fira Code / 系统等宽 | 顺序为 **系统等宽（默认）/ JetBrains Mono / Fira Code** | 不打包字体文件；默认档必须沿用系统等宽栈，否则没装这两款字体的机器会「什么都没变却显示已切换」 |
| 正文宽度：固定 768 / 自适应 | 默认「固定 768」，实现为 `min(100% - 48px, var(--soxu-content-max))` | 原组件写死 780px；改用 V4 token `--content-max`（768px），首屏正文窄 12px，这是本切片唯一的默认观感变化 |
| 系统页：检查更新 / 数据目录 | 「检查更新」禁用并说明原因；「数据目录」改为**复制真实路径** | 后端没有 updater 与 opener 命令，而本切片明确不许改 `commands.rs`/`dto.rs`/`lib.rs`。宁可禁用+说明，也不做点了没反应的按钮或假成功 |
| 系统页：关闭时最小化到托盘 | 只持久化开关 | 托盘行为由 `lib.rs`/`tray.rs` 决定（#90 目前是「总是最小化」），改它需要后端改动 |
| 任务完成通知 | 只做开关 UI 与持久化 | Issue 明确要求（通知实现见 #117） |
| 扩展页 | 静态列表 + 本地开关，标注 `TODO(V4-S7)` | Issue 明确要求 |

### 未实现清单（需要后端或后续切片）

1. **自动更新 / 检查更新**：没有 `tauri-plugin-updater`，也没有对应命令；当前只显示版本号。
2. **打开数据目录**：没有 opener 插件或命令，改为「复制路径」（路径按 `app_data_dir` 的
   `%APPDATA%\dev.soxu.desktop` 给出，与 tauri.conf.json 的 identifier 一致，有测试核对）。
3. **托盘开关生效**：需要 `lib.rs` 读设置后决定 `CloseRequested` 行为。
4. **扩展页真实数据**：需要 `list_extensions` 命令（`TODO(V4-S7)`）。
5. **恢复默认布局**：侧栏/抽屉宽度目前是固定 token（无拖拽改宽），因此重置的是「面板显隐 + 正文宽度」，
   设置页文案如实写了这一点。

## 5. 依赖变更

**无。** reka-ui 2.11.0 早已在 `dependencies` 里（Tabs / Switch / RadioGroup / Select 都来自它），
本切片没有新增任何依赖，也没有打包字体文件（JetBrains Mono / Fira Code 只在字体栈里，未安装时回退）。

包体影响（`npx vite build`，与 Issue #111 记录的同一条命令对比）：

| 产物 | S1 记录 | 本切片 | 差 |
|---|---|---|---|
| `dist/assets/index-*.js` | 445.87 kB（gzip 157.23 kB） | 509.42 kB（gzip 174.29 kB） | +63.55 kB（gzip +17.06 kB） |

增量来自 reka-ui 的 Tabs / RadioGroup / Select 三个组件首次被引入（此前只用到 Tooltip 与 DropdownMenu）。
这三者正是 Issue 指定的控件，且自带 role/aria 与键盘行为；手写实现省下的体积不足以抵消可访问性回归的风险。

## 6. 文件规模（超过 600 行提示线的两个文件）

| 文件 | 行数 | 说明 |
|---|---|---|
| `apps/desktop/src/App.vue` | 732（改动前 628） | 只做装配：状态与副作用都已按域拆到 composable（useAppearance / useBusyDelivery / useSessionSettings / useSystemSettings / useProjectDirectoryPick），四个设置面板、工作树面板、会话面板都是独立组件。剩余部分是全应用唯一的两个入口（主题切换 setTheme、历史记录 history）与模板接线；再拆只能拆模板片段，会让「谁持有哪个状态」变难追踪、提高生命周期泄漏风险。文件顶部已写明这条理由。 |
| `apps/desktop/src/styles/base.css` | 684（改动前 539） | 样式表，不是逻辑文件。新增内容是外观档位声明（`data-accent` 五色、`data-code-font` 两档、`data-content-width` 一档、衬线档与 `--soxu-content-max` 默认值），全部紧邻既有的字号/字体档位块，属于同一件事；拆到第二个 CSS 文件会让「强调色默认值在 tokens.css、档位在 base.css、组件消费在组件里」变成三个文件的查找路径。 |

其余新增文件都在 400 行以内（最大的组件 `SettingsSession.vue` 229 行）。

## 7. 已知限制

1. `pnpm check` 在本 Agent 会话里会因 `SOXU_AGENT_SESSION=1` 触发 secret-gate 用例失败（见 §2.1 的说明），
   该用例与本次改动无关。
2. 本轮没有改动 Rust 代码，因此没有新增 Rust 侧验证；`cargo fmt --all -- --check` 与
   `cargo test --workspace` 仅作为「没有被前端改动破坏」的回归门禁执行（见 §8）。
3. 浏览器实测只覆盖 Windows + Edge 156（本机唯一可用组合）；macOS / Linux 的字体回退与托盘行为未实测。
4. 截图是 headless 截图，不含真实系统的标题栏与托盘区域。
5. `src/styles/TokensPreview.vue`（Issue #110 的开发用 token 色板页，`tokens.html` 独立入口、
   `vite build` 不打包）里还有一处 `background: var(--accent)` + `color: #fff` 的组合，
   属于同一类「强调色底上的前景」问题。它是开发验证面、不进产品构建，也不在本切片范围（改动需回到
   #110 的页面），因此本轮只记录不改；产品组件（`src/components/`）已由
   `tests/sendCaretContrast.test.ts` 覆盖。
6. 本轮只改了 Vue / TS / 夹具与文档，未触碰 Rust，因此没有新增 Rust 侧证据（§8 的回归结论沿用）。

## 8. Rust 回归（未改动 Rust，仅确认门禁仍绿）

```
$ cargo fmt --all -- --check     # 退出码 0
$ cargo test --workspace         # 全部既有用例通过，0 failed
```

## 9. 复现步骤

```powershell
# 1. 类型检查 + 单元测试（脚本用例需先清掉 Agent 会话标记）
Remove-Item Env:SOXU_AGENT_SESSION -ErrorAction SilentlyContinue
pnpm check

# 2. 浏览器实测（自己拉起 Vite + headless Edge，结束时回收子进程）
#    脚本内的 checks 全部通过才以 0 退出；任一不成立会打印「断言未通过」并返回 1
node apps/desktop/tests/harness/shoot-issue-116-settings.mjs

# 2b. 发送区前景对比度（§3.7）：六个色板 × 深浅主题的计算值
node apps/desktop/tests/harness/shoot-send-caret-contrast.mjs

# 3. 深色截图里的强调色像素统计（§3.3 第 2 条的证据来源）
Add-Type -AssemblyName System.Drawing
$bmp = [System.Drawing.Bitmap]::FromFile((Resolve-Path 'docs/development/evidence/issue-116-v4-s2/06-appearance-dark.png'))
$violet = 0; $blue = 0
for ($y = 0; $y -lt $bmp.Height; $y++) { for ($x = 0; $x -lt $bmp.Width; $x++) {
  $c = $bmp.GetPixel($x, $y)
  if ([Math]::Abs($c.R-139) -lt 24 -and [Math]::Abs($c.G-92) -lt 24 -and [Math]::Abs($c.B-246) -lt 24) { $violet++ }
  if ([Math]::Abs($c.R-58) -lt 12 -and [Math]::Abs($c.G-131) -lt 12 -and [Math]::Abs($c.B-247) -lt 12) { $blue++ }
} }
"violet=$violet blue=$blue"   # 期望：violet=412 blue=0
$bmp.Dispose()

# 4. 人工看设置页
pnpm dev
# 浏览器打开 http://localhost:1420/tests/harness/settings.html
```

## 10. 复审修复记录（本轮）

历次复审的问题逐条修复，每条都指向可复跑的验证（最后一行是本轮新增）：

| 复审意见 | 修复 | 验证 |
|---|---|---|
| 深色下 `.app-shell[data-theme=dark]` 覆盖了 `--soxu-accent`，强调色只改了 V4 `--accent`，app-shell 子树仍是 `#3a83f7`（两套色） | 深色块不再声明 `--soxu-accent`；派生色改成「主色 + 主题比例」两级源值（`*-light` / `*-dark` 源值 + 组件只认的别名），深色只切比例。V4 的 `--accent-soft` 在深色下也切到 26% | `tests/settingsDialog.test.ts`「深色主题不得重复声明强调色」；浏览器实测 `dark.accentInShell = "#8b5cf6"`、`dark.activeTabBorder = "rgb(139, 92, 246)"`、`accentSoftInShell = 26%`、截图 06 像素统计 violet=412 / blue=0 |
| `showToolCalls` 默认值被改却写成「现状」 | 默认值改回 `false`（= 改动前工具输出块默认折叠），注释与设置页文案如实说明「打开后默认展开」 | `tests/settingsDialog.test.ts` 的默认值断言；`metrics.json` 的 `session.showToolCalls = false` |
| 新色板白字对比度未验证 | 每个色板新增 `onAccent`（CSS 的 `--soxu-on-accent` 与 `ACCENT_OPTIONS` 同源），按「白/墨取高者」选定：蓝绿 2.49→7.17、琥珀 2.15→8.31 等 | `tests/appearance.test.ts` 的 WCAG 对比度用例（逐色板断言 ≥3:1，且非默认色必须取更高的一侧）；浏览器实测 `accentAmber.onAccentInShell = "#191717"` |
| 发送区 caret 写死 `#fff`（琥珀 2.15:1 / 蓝绿 2.49:1，低于 3:1），无组件级测试，文档却声称已改深墨色 | caret 的 `color` 与 `border-left` 改为一律引用 `--soxu-on-accent`（分隔线用 28% 的 color-mix 推导）；`ChatPanel`/`MessageList` 新增必填 `settings` 后没跟上的两个夹具（`v4-session.ts`、`long-session.ts`）一并补上 | `tests/sendCaretContrast.test.ts` 5 个用例；`shoot-send-caret-contrast.mjs` 36 条断言全过（`send-caret-contrast.json`），琥珀 2.15→8.31、蓝绿 2.49→7.17；截图 09/10 的像素统计；§3.4 已加上「只验证 token，不验证组件」的更正 |
| 清空会话会丢草稿 | `clearSessionCache` 先取出 `tab.draft`，在 `finally` 里写回（历史加载失败也不丢）；同时把重开的 Tab 搬回原位置，tab 栏顺序不跳动。草稿不进存储 | `tests/settingsDialog.test.ts`「清空当前会话保留草稿」断言取草稿在 `closeTab` 之前、写回在 `openSession` 之后的 `finally` 里、并还原 tab 顺序 |
