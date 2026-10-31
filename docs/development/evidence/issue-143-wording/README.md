# Issue #143 · TASK-033 产品净化（移除假交互与开发术语）验证记录

本目录记录 TASK-033 的可复现验证：命令、环境、原始指标与截图。
每条证据都能对回 Issue 的 acceptance criteria；未验证或未做的部分在文末单列，不写成已完成。

- 验证时间：2026-10-31
- 环境：Windows（本机）· Node v26.10.0 · pnpm 12.15.0 · Edge 156.0.4314.50（headless）
- 复现脚本：`node apps/desktop/tests/harness/shoot-issue-143-wording.mjs`
- 原始指标：`metrics.json`（同目录）

---

## 1. 验收对照

| Acceptance criterion | 证据 |
|---|---|
| 新增文案扫描（或扩展 `tests/uiWording.test.ts`），命中禁用词即失败 | §2.2：`tests/support/uiWordingScan.ts` + `tests/uiWording.test.ts` 的 4 个新用例（含扫描器自检与反假绿阈值） |
| `settings/extensions.ts` 不再有 `enabled` 与假的 `fileCount`/`toolCount`/`connected` | §2.3：`settingsDialog.test.ts` 断言每条只剩 `name`/`description`，模块里不出现这些字段名 |
| 扩展页无任何可点击开关；浅色 + 深色截图走查无开发术语 | §3：截图 01/02 + 7 条浏览器内断言（开关数 0、徽章数 0、渲染文字无禁用词） |
| `ProjectSidebar` 的 kbd 标注与 `App.vue` keydown 一致 | §2.3：`interactionPolish.test.ts` 断言按钮不再标 `Ctrl K`，且 `App.vue` 的 `Ctrl/⌘+K` 绑定的是命令面板 |
| `pnpm check` 全绿 | §2.1 |

## 2. 命令与原始结果

### 2.1 类型检查与测试

```
$ pnpm check
✅ 领域块检查通过：13 个领域块、49 个 command，落位与顺序正确
✅ 语言包检查通过：2 种语言、2 个模块、106 条文案，key 完全对齐
ℹ tests 435
ℹ pass 435
ℹ fail 0
ℹ tests 71
ℹ pass 71
ℹ fail 0
```

> 若在**开发 Agent 会话**里直接跑 `pnpm check`，`scripts/tests/secret-gate.test.mjs` 会因环境里存在
> `SOXU_AGENT_SESSION=1`（pre-commit 钩子按设计拒绝 Agent 直接提交）而失败。这是环境注入造成的既有现象，
> 与本次改动无关：清掉该变量后 71 个脚本用例全绿（上面的结果即如此）。

### 2.2 文案扫描器（新增）

| 文件 | 内容 |
|---|---|
| `apps/desktop/tests/support/uiWordingScan.ts` | 纯函数：`.vue` 只取模板文本节点与属性值（含 `:bound="'字面量'"`）、`.ts` 先抹注释再取字符串字面量、`.json` 取语言包 value；`scanText` 供浏览器证据脚本复核渲染后的文字 |
| `apps/desktop/tests/uiWording.test.ts` | 4 个新用例：禁用词表与验收一致、`.vue` 自检（注释与 `<script>` 不算文案）、`.ts` 自检（`https://` 里的 `//` 不截断）、全量扫描 `apps/desktop/src` |

关键设计：**扫描的是用户可见字符串，不是文件全文**。注释里写 Issue 编号是可追溯性，不该被门禁逼着删；
模板里漏一句同样的字样就变成用户读到的产品文案。全量用例另外钉了「提取到的片段 > 300 段且必须包含侧栏
『临时会话』」的反假绿阈值——提取逻辑一坏，门禁不会静默通过。

禁用词表：`切片` / `Issue #` / `占位` / `演示` / `V4-S` / `后续切片` / `TODO(`。

### 2.3 行为与结构用例（调整）

| 文件 | 变化 |
|---|---|
| `tests/settingsDialog.test.ts` | 原「扩展页 12 个开关 + TODO(V4-S7)」用例改为「只读展示」：每条只有 `name`/`description`；面板不出现 `SettingsSwitch`、`.item-tag`、`localStorage`/`invoke(`；语言包区仍在 |
| `tests/sendModes.test.ts` | 新增「协议接入前三项一律置灰、原因写『即将支持』」；原有条件判定用例改为通过 `{ ready: true }` 驱动，并补一条「默认状态下同一组输入全部置灰」 |
| `tests/interactionPolish.test.ts` | 「临时会话」按钮不再自带 `Ctrl K`；提示语说明 `Ctrl K` 属于命令面板，且 `App.vue` 的绑定仍是命令面板 |
| `tests/i18n.test.ts` | 扩展页用例从「仍是静态占位」改为「只读、不写存储」 |

## 3. 浏览器实测（`metrics.json`）

脚本内维护一组 `checks`（名称 + 期望 + 实测），任一条不成立就以非 0 退出并在 `metrics.json` 里留痕，
避免生成一份「看起来正常、其实已经回归」的证据。本轮 9 条全部通过：

| 检查 | 实测 |
|---|---|
| 扩展页没有任何开关（`[role=switch]`） | 0 |
| 扩展页没有状态徽章（`.item-tag`） | 0 |
| 扩展页仍然列出 12 个扩展（只读展示不缩水） | 20 条（12 扩展 + 4 技能 + 4 MCP） |
| 扩展页浅色文案没有开发术语 | 0 命中 |
| 深色下扩展页同样没有开关 | 0 |
| 深色主题确实生效（`<html data-theme>`） | `dark` |
| 扩展页深色文案没有开发术语 | 0 命中 |
| 侧栏「临时会话」按钮不再自带 `kbd` 标注 | `kbd` 数 0 |
| 侧栏按钮文案保持不变 | 「临时会话」 |

截图：

- `01-extensions-light.png`：浅色下的扩展页——每行只有名称与一句用途，右侧没有开关、没有「已启用/未连接」，顶部说明为「仅供查阅」。
- `02-extensions-dark.png`：深色下同一页，布局与文案一致。
- `03-sidebar-light.png`：侧栏「临时会话」按钮（不再标 `Ctrl K`）；右侧检查器副标题为「状态来自运行时事件」。

## 4. 改动摘要（用户可感知）

1. **扩展页**：删掉只改内存的假开关、「已启用 / 未启用」徽章、技能文件数与 MCP 工具数/连接状态；
   列表改为纯只读展示，顶部一句话说明「实际加载哪些由 Pi 的配置决定」。
2. **发送三选**：三项仍可见，但全部置灰，描述后面统一接「即将支持」；
   条件判定保留在 `sendMode.ts`（`SEND_MODES_READY` 开关 + `ready` 选项），协议落地后打开即可。
3. **快捷键标注**：侧栏「临时会话」按钮不再标 `Ctrl K`（那个组合键打开的是命令面板），
   提示语说明按钮行为与命令面板入口。
4. **开发术语**：设置 → 系统 / 会话、会话状态面板、输入区提示中的「切片 / Issue # / 后续接入 / 等 #NNN 的命令层」
   改为面向用户的功能说明；「该目录可安全删除重建」改为说明删除会连同已导入的社区语言包一起丢失。

## 5. 未验证与已知问题

- **发送菜单没有截图证据**：`tests/harness/v4-session.ts` 的夹具 `tab` 缺少 `stats` 字段（#119 起 `SessionTab`
  要求它），挂载即抛错，因此该夹具当前不可用（`shoot-v4-session.mjs` 同样受影响）。这是既有问题，本次未修
  （不属于 TASK-033 范围，且 TASK-036 会重做这一块）。发送三选的「可见但全部置灰」由
  `tests/sendModes.test.ts` 的纯函数用例与 `ComposerSendMenu.vue` 的 `:disabled="!item.enabled"` 断言覆盖。
- **真数据未接入**：扩展、技能与 MCP 的真实状态仍无数据来源（TASK-037），本次只保证「不编造」，
  不代表这些列表已与用户本机一致。
- **界面语言**：设置页文案仍是组件内中文字面量（该模块尚未接入 `t()`），本轮只改文案内容，未做 i18n 迁移。
