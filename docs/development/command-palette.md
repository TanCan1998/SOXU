# 命令面板（Issue #123 · TASK-031）

本文件说明 `Ctrl/⌘+K` 命令面板的行为、匹配规则与边界，以及它与设置项元数据的关系。
实现位置：

| 文件 | 职责 |
| --- | --- |
| `apps/desktop/src/commands/match.ts` | 拼音索引、模糊匹配、打分与高亮区间（纯逻辑，无 DOM） |
| `apps/desktop/src/commands/registry.ts` | 命令清单、可用性判断、键盘语义（纯逻辑，无 DOM） |
| `apps/desktop/src/components/CommandPalette.vue` | 渲染结果与高亮、把按键翻译成动作 |
| `apps/desktop/src/settings/catalog.ts` | 设置页与设置类命令共用的元数据（唯一来源） |
| `apps/desktop/src/App.vue` | 打开/关闭面板、把命令动作接到真实副作用 |

## 1. 交互

- **打开/关闭**：`Ctrl+K`（macOS 为 `⌘K`）切换；`Esc` 或点击遮罩关闭。
- **输入**：打开即聚焦输入框，可以直接打字。
- **选择**：`↑` / `↓` 首尾相接；`Home` / `End` 跳到第一条 / 最后一条。
- **执行**：`↵` 执行当前高亮项；执行后先收起面板，再执行动作（设置弹窗不会被面板盖住）。
- **不可用命令**：结果行右侧直接写出原因（例如「当前没有打开的会话」），按 `↵` 只会读出这条原因，不会假装执行。
- **焦点圈**：`Tab` / `Shift+Tab` 被圈在面板内，走不到模态层背后的界面上。
- **焦点还原**：关闭（`Esc` / `↵` / 点遮罩）后焦点回到打开前的位置；
  如果那个元素已随命令一起换掉（例如打开了设置弹窗），由接手的界面自己聚焦，不会被抢回去。

无障碍：面板是 `role="dialog"` + `aria-modal`，输入框是 `role="combobox"` 并通过
`aria-controls` / `aria-activedescendant` 指向 `role="listbox"` 里的
`role="option"`；结果条数用 `role="status"` 播报，焦点始终留在输入框里。

`aria-modal` 只是语义声明，浏览器不会替你圈焦点、也不会替你还原焦点，所以这两件事在组件里
自己实现：`commands/focusTrap.ts` 只回答「下一个该聚焦第几个」（纯逻辑，可脱离 DOM 断言），
DOM 遍历与 `focus()` 留在 `CommandPalette.vue`。打开前的 `document.activeElement` 在
`onMounted` 里记录、`onBeforeUnmount` 里还原，且只在原元素 `isConnected` 时才还原。

## 2. 匹配规则

一条命令有三个可匹配来源（优先级从高到低）：

1. **标题原文** —— 直接输入中文（`设置`）；
2. **全拼** —— `dakaishezhi`（空格与大小写都不敏感）；
3. **首字母** —— `dksz`，因此 `dk` 命中所有「打开…」命令、`sz` 命中「打开设置」。

另有 `keywords` 别名（英文名与同义词，例如 `worktree`、`inspector`）。
别名只参与「能不能搜到」，不参与高亮——别名不在标题里，标不出位置，
所以别名命中的行整行不高亮，而不是标错位置。

打分顺序固定为：标题精确 > 标题前缀 > 标题包含 > 全拼前缀 > 全拼包含 >
首字母前缀 > 首字母包含 > 别名相等 > 别名包含 > 标题子序列 > 全拼子序列 > 首字母子序列。
同分按注册表顺序，因此同一输入的顺序在任何时候都确定。

子序列匹配有**跨度上限**（查询长度 × 4，且至少 8）：没有上限时，输入 `git` 会靠
`g…i…t` 命中「关闭时最小化到托盘」的全拼。超跨度的子序列直接丢弃。

高亮区间按码点下标给出，相邻区间会合并：全拼 `dakai` 的 5 个字符落在
「打」「开」两个码点上，合并成一个 `<mark>`，不会碎成 5 块。

### 已知边界

- **拼音 + 汉字混写不支持**：`dakai设置` 不会命中——全拼串里没有汉字、标题串里没有
  `dakai`，两个来源各缺一半。纯英文 + 汉字（`enter发送`）则走标题子序列命中。
- 多音字取 pinyin-pro 的默认读音（`重` 取 `chong`），因此「重新打开当前会话」的
  全拼是 `chongxin…`。它仍然能被 `dk` 命中，因为首字母串里含 `dk`。

## 3. 设置项元数据只有一份

`settings/catalog.ts` 是设置项的唯一来源，同时被三处消费：

| 消费方 | 用法 |
| --- | --- |
| `SettingsDialog.vue` | `v-for` 渲染四个标签页（`SETTINGS_TABS`） |
| `SettingsRow.vue` | 按 `setting="appearance.theme"` 取行标题与默认说明 |
| `commands/registry.ts` | 为每个标签页与每个设置项各生成一条命令 |

因此设置面板模板里**没有中文标题字面量**，新增一项设置只需要改 `catalog.ts` 一次，
命令面板自动多一条可搜索项。这条性质由测试守着：

- `tests/commandPalette.test.ts` 扫描三个面板的 `setting="…"`，逐个用
  `settingsEntry()` 解析（拼错的 id 会当场失败），并断言面板里不再出现
  `<SettingsRow label="…">`；
- `tests/settingsDialog.test.ts` 断言四页与各项的文案来自 `catalog.ts`。

设置类的命令执行的是「打开设置并落到对应页」，**不会**替你改任何开关：
命令面板只负责导航，改值仍然在设置页里做（避免一个快捷键静默改掉用户偏好）。

**设置已经开着时**（`Ctrl+,` 之后再按 `Ctrl+K`）执行设置类命令同样会切到目标页：
`App.vue` 每次调用 `openSettings` 都递增一个请求序号（`settingsRequest`），弹窗据此把
「同一页被再请求一次」也当成新请求，判定在 `settings/openRequest.ts`（`opened` /
`retargeted` / `none`，纯逻辑，有单元测试）。只看 `open` 的 `false → true` 变化会丢掉
这次请求：界面停在原页，而命令看起来像没生效——这是复审时实际发现的缺陷。

## 4. 注册表只登记真实存在的动作

当前 36 条命令：面板开关（7）、会话动作（4）、设置（4 页 + 20 项）、系统（1）。

**未覆盖**：终端面板与文件打开在本切片都还没有实现，因此注册表里**没有**
「打开终端」「打开文件」——宁可少一条，也不放一条点了没反应的命令。
Issue 正文里 `dk` 的示例包含这两个动作，它们要等对应切片交付后再加；
注册表是数据表，加两条不需要改组件结构。

`Ctrl+K` 原本用于「新建临时会话」，现在让给命令面板（V4 interaction-inventory
规定 `⌘K` 是命令面板触发）。新建临时会话仍在：命令面板里的一条命令 + 侧栏与 Tab 栏的按钮。

## 5. 资源与性能

- 组件不持有任何资源：没有定时器、没有 `window` 级监听，关闭即卸载。
- 结果条数上界 `MAX_RESULTS = 50`（当前命令总量 36，实际不会截断），DOM 节点数有界。
- 拼音索引按标题缓存（上限 256 条，超出清空），同一标题只算一次。
- 实测「输入 → 结果渲染」端到端耗时**只写在证据目录 `metrics.json` 的 `dkLatencyMs` 里**
  （含一次 CDP 往返；预算 250 ms，历次采集在 17–23 ms 之间波动）。本文件不复述具体数值：
  两份数字各写一套正是上一轮复审的阻塞点之一，重跑采集会覆盖证据，正文跟着漂移就必然对不上。

### 拼音字典按需加载（重要）

Issue 正文估的「约 3 KB gzip」不成立。实测 `pinyin-pro@3.29.5` 的 ESM 产物：

| 口径 | 原始 | gzip |
| --- | --- | --- |
| 包内全部 `.mjs`（含未用到的分词/多音字模块） | 576 KB | 173 KB |
| 静态 import 后进入首屏 `index` chunk 的增量 | +287 KB | +142 KB |
| 改成动态 import 后的独立 chunk（`esm-*.js`） | 287 KB | 141 KB |

所以 **不静态 import**：`commands/match.ts` 只接受注入的 `PinyinProvider`，
`CommandPalette.vue` 在**第一次打开面板时**才 `await import("pinyin-pro")`。
构建结果对比（`pnpm --filter @soxu/desktop build`）：

| 方案 | index chunk | gzip |
| --- | --- | --- |
| 静态 import（历史对照，已验证） | 891.46 kB | 344.51 kB |
| 动态 import（当前实现，最近一次构建） | 605.16 kB | 202.51 kB |
| 拼音字典独立 chunk | 287.42 kB | 141.95 kB（打开面板时才加载） |

注入前只做标题字面匹配与别名匹配（面板仍然可用，只是拼音搜不到）；注入完成后清空
索引缓存并触发一次重排，用户已经打了一半的输入会立刻出现拼音结果。
加载失败（离线、chunk 被拦）同样只降级、不报错。

## 5.1 新依赖记录

| 项 | 值 |
| --- | --- |
| 包 | `pinyin-pro` `3.29.5`（精确版本，与仓库其他依赖一致） |
| License | MIT |
| 必要性 | 汉字→拼音/首字母需要完整字表；手写覆盖不全，Issue 已批准该依赖 |
| 包体 | 见上表；不进入首屏，打开面板时才加载 141 KB gzip |
| 运行时资源 | 纯计算，无后台进程、无定时器、无网络；索引缓存在内存里且有 256 条上限 |
| 供应链 | 安装时通过 pnpm 的 supply-chain 策略检查（`✓ Lockfile passes supply-chain policies`） |

## 6. 验证

```bash
pnpm --filter @soxu/desktop check        # vue-tsc
pnpm --filter @soxu/desktop test         # 含 tests/commandPalette.test.ts（31 条）
node apps/desktop/tests/harness/shoot-issue-123-palette.mjs   # 真实键盘 + 截图 + metrics.json
```

`pnpm check` 在**本机 Agent 会话**里会因 `SOXU_AGENT_SESSION=1` 让 `test:scripts` 里的
`scripts/tests/secret-gate.test.mjs` 失败（该测试跑的是 pre-commit 门禁本身，而门禁
按规定拒绝 Agent 提交）。这与本切片无关，Runner 在没有该环境变量的环境下运行即可通过。

真实渲染证据见 [证据目录](evidence/issue-123-command-palette/README.md)。

### 6.1 本次门禁实测（Issue #123 交付时，Windows / Node 26.10.0 / pnpm 12.15.0）

| 命令 | 结果 |
| --- | --- |
| `pnpm --filter @soxu/desktop check`（vue-tsc --noEmit） | 通过，无诊断 |
| `pnpm --filter @soxu/desktop test` | 369 tests / 369 pass / 0 fail（含 `commandPalette.test.ts` 31 条） |
| `pnpm test:scripts`（`SOXU_AGENT_SESSION` 未设置，即 Runner 环境） | 58 tests / 58 pass / 0 fail |
| `cargo fmt --all -- --check` | 通过 |
| `cargo test --workspace` | 通过 |
| `git diff --check`（工作区与暂存区） | 通过 |
| `pnpm --filter @soxu/desktop build` | 通过；`index` 605.16 kB / gzip 202.51 kB，拼音 chunk `esm-*.js` 287.42 kB / gzip 141.95 kB |

说明：`pnpm check` 与上面两条命令等价，但在**本机 Agent 会话**（`SOXU_AGENT_SESSION=1`）里
`test:scripts` 会按设计失败——它测的是 pre-commit 门禁，而门禁拒绝 Agent 直接提交。
这不是本切片的问题，也不构成「跳过门禁」：同一批用例在无该环境变量时全绿（上表第 3 行）。

## 7. 上轮复审阻塞点：逐条确认

复审要求「逐条确认上轮问题」。下表把每个阻塞点对应到**修复位置 → 可复现的验证**，
不留「已修复」这种无法核对的说法。

### 7.1 阻塞点 A：设置已打开时，命令面板的设置命令不换页

| 项 | 内容 |
| --- | --- |
| 修复前现象 | `SettingsDialog` 只在 `open` 由 `false` 变 `true` 时应用 `initialTab`。设置已经开着（先 `Ctrl+,` 再 `Ctrl+K` 执行「设置 · 系统」）时 `open` 一直是 `true`，请求被静默丢弃：界面停在原页，命令看起来没生效。 |
| 修复方式 | `App.vue` 的 `openSettings()` 每次调用都递增单调请求序号 `settingsRequest`；`SettingsDialog` 把 `(open, request)` 的前后变化交给纯函数 `settingsOpenTransition()`，得到 `opened`（从关到开，应用目标页并把焦点移进弹窗）/ `retargeted`（已经开着，只切页、不抢焦点）/ `none`。 |
| 代码 | `apps/desktop/src/settings/openRequest.ts`、`App.vue`（`settingsRequest`）、`components/SettingsDialog.vue` |
| 单元测试 | `tests/settingsDialog.test.ts` › `设置已打开时再请求必须切页（Issue #123 复审阻塞点）`、`请求序号接到纯函数上，App.vue 每次打开都递增` |
| 真实 DOM 证据 | 夹具挂载**真正的 `SettingsDialog.vue`**（与 App.vue 同样的 `open` / `initialTab` / `request` 三件套）：键盘执行「打开设置 · 系统」→ 弹窗落到系统页；再开面板执行「打开设置 · 外观」→ 弹窗**不关**且切到外观页，请求序号 1→2→3。对应 `metrics.json` 检查项 `settings-tab-command-found`、`settings-opened-on-target-tab`、`settings-stays-open-on-retarget`、`settings-retargeted-to-new-tab`、`settings-request-incremented`，截图 `09-settings-retarget.png` |
| 复现 | `node --test apps/desktop/tests/settingsDialog.test.ts`（纯逻辑）与 `node apps/desktop/tests/harness/shoot-issue-123-palette.mjs`（真实渲染） |
| 当前结果 | 2 条用例通过；三态（`opened` / `retargeted` / `none`）与「同一页被再请求一次也算新请求」均有断言；真实渲染里 `activeTab` 由 `系统` 变为 `外观` 且 `open` 始终为 `true` |

### 7.2 阻塞点 B：文档里的耗时与 metrics.json 不一致

| 项 | 内容 |
| --- | --- |
| 修复前现象 | 文档正文写了一个与 `metrics.json` 的 `dkLatencyMs` 不同的数字，读者无法判断以哪个为准。 |
| 修复方式 | 正文**不再写具体毫秒数**，只指向 `metrics.json` 的 `dkLatencyMs`（见 §5）；证据目录 README 同样只引用该字段，不复述第二份数字。重跑采集只会改证据，不会让文档与证据对不上。 |
| 代码/文档 | `docs/development/command-palette.md` §5、`docs/development/evidence/issue-123-command-palette/README.md` |
| 复现 | `node -e "console.log(require('./docs/development/evidence/issue-123-command-palette/metrics.json').dkLatencyMs)"` |
| 当前结果 | 输出一个毫秒数（最近一次采集为 `20`），预算 250 ms，检查项 `dk-latency-budget` 为 `ok: true`；文档正文不含第二个数字，因此不存在「两份对不上」的可能 |

### 7.3 阻塞点 C：`aria-modal` 只有语义，没有焦点圈与焦点还原

| 项 | 内容 |
| --- | --- |
| 修复前现象 | 面板声明了 `role="dialog"` + `aria-modal="true"`，但 `Tab` 仍会把焦点带到面板背后的界面上；关闭后焦点掉到 `<body>`，键盘用户要从头 `Tab`。 |
| 修复方式 | `commands/focusTrap.ts` 只回答「下一个该聚焦第几个」（纯函数，首尾相接，空列表返回 -1）；`CommandPalette.vue` 负责 DOM 遍历与 `focus()`，并在 `onMounted` 记录打开前的 `document.activeElement`、`onBeforeUnmount` 时**仅当原元素 `isConnected`** 才还原。 |
| 单元测试 | `tests/commandPalette.test.ts` › `模态焦点圈：Tab / Shift+Tab 首尾相接，焦点出不去` |
| 真实 DOM 证据 | `metrics.json`：`focus.afterTab` / `focus.afterShiftTab` 均为 `cp-input` 且 `insidePalette: true`；`focusRestored` 为触发按钮 `harness-trigger`（`insidePalette: false`）；检查项 `tab-trap-stays-inside`、`shift-tab-trap-stays-inside`、`focus-restored-to-trigger` 全为 `ok: true`（按键经 CDP `Input.dispatchKeyEvent` 真实下发，不是页面内合成事件） |
| 复现 | `node apps/desktop/tests/harness/shoot-issue-123-palette.mjs`（自拉 Vite + headless Edge，结束回收子进程） |
| 当前结果 | 31 项检查全部 `ok: true`，汇总位 `ok` 亦为 `true` |

### 7.4 仍未覆盖（如实列出，不当作已通过）

- 真实 Tauri 窗口里的焦点圈与焦点还原：只在单 webview 夹具页面验证。
- macOS 的 `⌘K` / `⌘,`：按键判定用 `ctrlKey || metaKey`，但本机只有 Windows，未在真机走查。
- 屏幕阅读器实机朗读（NVDA / VoiceOver）：只做了语义结构断言。
- 设置弹窗内的二次交互（在设置里改值后再用命令面板换页）：夹具里的设置弹窗只验证换页与请求序号，
  改值链路仍由 `settingsDialog.test.ts` 的单元测试覆盖。
