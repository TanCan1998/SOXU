# Issue #144 · 会话区与输入区 i18n 存量迁移 · 证据

TASK-034 的验收证据：会话区（ChatPanel / MessageList / MessageActions / SessionTabs /
SessionStatsRow / SessionStatsRing / sendMode.ts / sessionStats.ts）与输入区
（ChatComposer / ComposerSendMenu）的用户可见文案全部走语言包。

## 1. 变更概览

| 项目 | 内容 |
| --- | --- |
| 新增语言包 | `locales/zh-CN/session.json`（100 条）、`locales/zh-CN/composer.json`（15 条）+ `en-US` 同名文件 |
| loader 登记 | `locales/index.ts` 的 `BUILTIN_MODULES` 增加 `session` / `composer` 两个模块（两种语言各一次） |
| 数据源文案 | `sendMode.ts` 改为保存 key（`SEND_MODE_TEXT[*].labelKey`）并提供 `sendModeLabel` / `sendModeDescription` / `sendModePendingReason`；`sessionStats.ts` 的统计行、浮窗分组、读屏标签与降级说明全部走 `t()` |
| 时间戳 | `messageTime.ts` 改为把合法时间交给语言运行时的 `formatDateTime`（Intl），不再手拼 `HH:mm` |
| 组件 | 会话区 8 个 + 输入区 2 个文件的模板/脚本里不再有硬编码中文；aria-label、tooltip、placeholder、错误提示同源 |
| 新增测试 | `apps/desktop/tests/i18nSessionComposer.test.ts`（10 条） |
| 走查脚本 | `apps/desktop/tests/harness/shoot-issue-144-i18n.mjs` + 夹具 `session-i18n.html` / `session-i18n.ts` |

## 2. 门禁命令与结果（2026 年本机 Windows / Node 26.10.0）

```powershell
node scripts/check-locales.mjs
# ✅ 语言包检查通过：2 种语言、4 个模块、336 条文案，key 完全对齐

pnpm --filter @soxu/desktop check          # vue-tsc --noEmit
# 无输出（0 error）

node --test apps/desktop/tests/*.test.ts
# ℹ tests 445   ℹ pass 445   ℹ fail 0
```

## 3. 走查脚本：`shoot-issue-144-i18n.mjs`

```powershell
node apps/desktop/tests/harness/shoot-issue-144-i18n.mjs
```

脚本自己拉起 Vite（1427）与独立 profile 的 headless Edge（CDP 9459），
打开 `/tests/harness/session-i18n.html?locale=<tag>`，对 zh-CN 与 en-US 各走一遍：
整屏截图 → 打开发送选项菜单截图 → 打开统计浮窗截图，共 6 张。
浏览器：`Edg/156.0.4314.50`，视口 1180×900，页面异常 0 条。

断言 40 条全部通过（明细见 `metrics.json` 的 `checks`），关键几条：

| 断言 | 结果 |
| --- | --- |
| en-US：会话区 + 输入区渲染文本**没有任何中文** | 通过（`hasCjk: false`） |
| zh-CN：同一区域渲染文本包含中文 | 通过 |
| en-US：出现 Temporary session / Running / Load more history / Turns / You / Tool output | 通过 |
| zh-CN：出现 临时会话 / 运行中 / 加载更多历史 / 轮次 / 你 / 工具输出 | 通过 |
| 消息时间戳按语言格式化 | zh-CN `09:05`、en-US `09:05 AM` |
| 输入框 placeholder 已本地化 | `向 Pi Agent 发送消息…` / `Send a message to Pi Agent…` |
| 发送菜单三项齐全且全部置灰（投递语义未接入） | 3 / 3 |
| 置灰原因随语言变化 | `即将支持` / `Coming soon` |
| 统计浮窗标题与内容随语言变化，en-US 无中文 | 通过 |
| 两种语言下渲染文本都没有禁用词（切片 / Issue # / 占位 / 演示 / V4-S / TODO( ） | 通过 |

截图：

| 文件 | 内容 |
| --- | --- |
| `01-session-zh-CN.png` / `02-session-en-US.png` | Tab 栏 + 会话面板 + 消息列表 + 输入区 + 统计行 |
| `01-send-menu-zh-CN.png` / `02-send-menu-en-US.png` | 发送选项菜单（三项可见但置灰） |
| `01-stats-zh-CN.png` / `02-stats-en-US.png` | 上下文与统计浮窗 |

## 4. 单元测试覆盖（`tests/i18nSessionComposer.test.ts`）

1. 会话区与输入区 12 个文件的模板文本、属性值与脚本字符串里**没有中文**（注释不算）；
2. 这些文件里 `t()` 的每个 key 都能在基准包里找到（防写错 key）；
3. `session` / `composer` 两个模块在 zh-CN 与 en-US 里 key 完全一致，英文包里没有中文、也没有照抄中文的值；
4. `checkLocales(REPO_ROOT)` 无违规（与 CI 同一份实现）；
5. 切到 en-US 后**每一个** key 都解析成英文（不是静默回退成中文），并抽查各组件的代表性文案；
6. 社区包只翻译一部分时，缺的 key 回退 zh-CN（`session.list.role.user` → `你`）；
7. `sendMode.ts` 的名称/说明、`sessionStats.ts` 的统计行/浮窗/读屏标签/降级说明随语言切换；
8. `formatMessageTime` 由 `formatDateTime` 决定 12/24 小时制，非法值返回 null；MessageList 不再出现 `getHours()`。

## 5. 未验证项（不冒充通过）

- **Tauri 桌面窗口**：截图来自 Vite 开发服务器 + headless Edge，与 `pnpm tauri:dev` 的
  WebView 是同一份前端代码，但**没有**在真实桌面窗口里再走一遍；WebView2 的 Intl 数据
  与 Edge 同源，风险低但未实测。
- **真实 Pi 会话**：夹具用内存假数据（Tab、消息、统计快照），没有连接 Pi 运行时；
  因此「真实会话下切换语言」仍需人工确认。
- **语言偏好持久化**：切换后重启仍生效由 Issue #135 的测试与文档覆盖，本切片未重复验证。
- **其他界面**：设置页、侧栏、抽屉、通知、loop 控制台仍为中文，属后续三个 i18n 任务。
