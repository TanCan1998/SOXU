# Issue #111 · V4-S1 会话主链路（markdown 渲染 + 发送三选 + 消息操作）验证记录

本目录记录 **V4-S1 切片**的可复现验证：命令、环境、原始输出与截图。
每条证据都能对回 Issue 的 acceptance criteria；未验证的部分在文末「已知限制」里单列，不写成已完成。

- 验证时间：2026-10-29
- 环境：Windows（本机）· Node v26.10.0 · pnpm 12.15.0 · Rust 1.99.1（`cargo fmt`/`cargo test`）
- 截图浏览器：headless Edge 156.0.4314.50，视口 1280×720
- 复现脚本：`node apps/desktop/tests/harness/shoot-v4-session.mjs`

---

## 1. 验收对照

| Acceptance criterion | 证据 |
|---|---|
| `pnpm check` 通过，桌面端现有测试全绿（134+ 用例） | §2.1：180 个用例全绿（原 138 + 新增 42），`pnpm check` 退出码 0 |
| 发送三选菜单交互与原型一致（忙碌置灰用 mock 状态验证） | §2.2 纯函数用例 + §3 截图 02/03 + `metrics.json` 的 `idleMenu`/`busyMenu` |
| shiki 语言包按需加载（bundle 不含全量语言） | §2.3 源码扫描用例 + §2.4 构建产物清单 |
| 提交规范：`<gitmoji> type(scope): 描述`，目标分支 dev | 由 Runner 统一提交（Developer 不执行 `git commit`） |

## 2. 命令与原始结果

### 2.1 类型检查与测试

```
$ pnpm check
# icons:generate + vue-tsc --noEmit + node --test tests/*.test.ts + node --test scripts/tests/*.test.mjs
ℹ tests 180
ℹ pass 180
ℹ fail 0
ℹ tests 47          # scripts（提交门禁/发布脚本）
ℹ pass 47
```

> 注意：若在**开发 Agent 会话**里直接跑 `pnpm check`，`scripts/tests/secret-gate.test.mjs` 会因为
> 环境里存在 `SOXU_AGENT_SESSION=1`（pre-commit 钩子按设计拒绝 Agent 直接提交）而失败。
> 这是环境注入造成的既有现象，与本次改动无关：清掉该变量后 47 个脚本用例全绿（上面的结果即如此）。

新增用例（42 个）：

| 文件 | 覆盖 |
|---|---|
| `tests/markdown.test.ts`（13） | 代码块/行内 code/表格/引用渲染、XSS 转义、`javascript:` 拦截、超长截断、语言归一、按需加载源码扫描、真实高亮（双主题 token） |
| `tests/sendModes.test.ts`（11） | 三选可用条件（含忙碌/空闲/空草稿/附件/无项目）、菜单结构与方向、模式横条、设置项、`mode`/`thinking` 参数管道 |
| `tests/messageActions.test.ts`（6） | 剪贴板三级行为、复制真实现、重试/回退置灰 + 「即将支持」、markdown 接入与工具折叠保留、流式期跳过高亮 |
| `tests/tooltipPlacement.test.ts`（7） | 位置 → 方向映射（右→左、左→右、底部→上、中部→上、零视口兜底） |
| `tests/busyDelivery.test.ts`（5） | 「忙碌时发送」默认值、脏值回退、存储不可用、只在用户改动时落盘 |

### 2.2 Rust

```
$ cargo fmt --all -- --check     # 退出码 0
$ cargo test --workspace
test dto::tests::prompt_mode_accepts_the_three_ui_values ... ok
test dto::tests::thinking_level_accepts_low_medium_high ... ok
test dto::tests::optional_prompt_parameters_default_to_none ... ok
# 其余既有用例全部通过（47 + 28 + 16 + …，0 failed）
```

### 2.3 按需加载（源码层）

`tests/markdown.test.ts` 直接扫 `src/markdown/*.ts`：

- 断言**不存在** `from "shiki"`、`shiki/bundle/full`、`shiki/bundle/web`、`from "@shikijs/langs"`；
- 断言白名单里每个语言都有**一条独立的** `import("shiki/langs/<id>.mjs")`（数量 == 白名单长度）；
- 断言只动态加载 2 个主题（`github-light` / `github-dark`）；
- 白名单有界：26 个语言，`text`/`plain`/`console` 不在其中。

### 2.4 构建产物（`npx vite build`）

```
dist/assets/index-*.js                 445.87 kB │ gzip: 157.23 kB   # 主 chunk
dist/assets/core-*.js                  112.44 kB │ gzip:  35.95 kB   # shiki 核心（懒加载）
dist/assets/engine-javascript-*.js      57.98 kB │ gzip:  20.32 kB   # 正则引擎（懒加载）
dist/assets/github-light-*.js           11.18 kB │ gzip:   2.49 kB
dist/assets/github-dark-*.js            11.40 kB │ gzip:   2.53 kB
dist/assets/ts-*.js                      0.05 kB │ …                # 语言包逐个按需
dist/assets/typescript-*.js            181.06 kB │ gzip:  16.23 kB
dist/assets/python-*.js                 69.94 kB │ gzip:   9.09 kB
dist/assets/cpp-*.js                   796.96 kB │ gzip:  60.65 kB
…
```

结论：

1. **没有全量语言包**：产物里只有白名单中的 26 个语言（外加 shiki 内部的别名模块），
   不存在 `shiki/langs` 的聚合入口；不出现代码块时这些 chunk 一个都不会下载。
2. 主 chunk 从 608.52 kB（gzip 210.17 kB）降到 445.87 kB（gzip 157.23 kB）：
   把 shiki 核心与引擎也改成动态 import 后，**没有代码块的首屏完全不加载高亮器**。
   （这两个数字是同一轮迭代内的前后对比，不是相对 dev 基线的对比。）
3. 已知代价：`cpp` 语言包未压缩 797 kB（gzip 60 kB），只有真的出现 ```cpp 代码块时才会下载。

### 2.5 运行时指标（`metrics.json`）

```json
{
  "render": { "codeBlocks": 1, "highlighted": 1, "pending": 0, "codeLang": "ts",
              "shikiSpans": 17, "tables": 1, "quotes": 1, "inlineCode": 3,
              "foldedTools": 1, "messageActions": 1, "modeBar": null },
  "idleMenu":  [ {"mode":"steer","disabled":true}, {"mode":"followUp","disabled":false}, {"mode":"parallel","disabled":false} ],
  "busyMenu":  [ {"mode":"steer","disabled":false}, {"mode":"followUp","disabled":false}, {"mode":"parallel","disabled":false} ],
  "modeBar": "下一条消息将 并行发送",
  "dark": { "theme": "dark", "codeColor": "rgb(249, 117, 131)", "modeBarBg": "rgb(35, 50, 75)" },
  "actions": { "visible": 1, "buttons": [
      {"label":"复制消息","disabled":false},
      {"label":"重试（即将支持）","disabled":true},
      {"label":"回退到这里（即将支持）","disabled":true}]},
  "pageErrors": []
}
```

要点：

- `codeColor` 在深色主题下等于 `#F97583`，正是 `github-dark` 的 token 值 → `--shiki-dark` 覆盖规则生效
  （切换主题不需要重新着色）；
- `modeBarBg` = `#23324b`，即深色 token `--soxu-accent-soft`，横条跟随主题；
- 空闲时「加入当前」置灰、忙碌时三选全开，与决策文档一致；
- `pageErrors` 为空：夹具页面没有运行时异常。

### 2.6 截图

| 文件 | 内容 |
|---|---|
| `01-light-messages.png` | 浅色：markdown 段落、列表、引用、ts 代码块（已高亮）、表格、工具输出折叠、输入区 |
| `02-light-send-menu-idle.png` | 空闲态三选菜单：「加入当前」置灰并显示原因 |
| `03-light-send-menu-busy.png` | 忙碌态三选菜单：三项全开（含「并行发送」描述） |
| `04-light-mode-bar.png` | 选中「并行发送」后 composer 上方的「下一条消息将 并行发送」横条 + 取消按钮 |
| `05-dark-mode-bar.png` | 深色主题下的同一界面（代码配色走 `--shiki-dark`） |
| `06-light-message-actions.png` | 悬停 agent 消息露出的三个操作（复制可用、重试/回退置灰） |

## 3. 依赖变更

| 依赖 | 版本 | License | 必要性 | 运行时/包体影响 |
|---|---|---|---|---|
| `shiki` | 4.5.0 | MIT | Issue 明确要求「markdown-it + shiki 做代码高亮」；仓库此前只有 markdown-it，没有高亮能力 | 安装体积约 5.9 MB（含全部语言包，仅磁盘）；**运行时**只加载被请求的语言 + 2 个主题 + 核心/引擎（见 §2.4），均为懒加载 |

- 引擎选 **JavaScript 正则引擎**（`createJavaScriptRegexEngine({ forgiving: true })`）而不是 oniguruma wasm：
  省掉约 1 MB 的 wasm chunk，也避免 CSP/wasm 相关配置；`forgiving` 让个别语法退化为「不染色」而不是抛错。
- 版本锁定在 4.5.0（与 `@shikijs/*` 同版本），未改动任何既有依赖版本。

## 4. 实现要点（与代码对应）

| 能力 | 位置 |
|---|---|
| markdown 渲染（`html: false`） | `apps/desktop/src/markdown/markdownRenderer.ts` |
| 语言白名单 + 按需加载表 | `apps/desktop/src/markdown/languages.ts` |
| shiki 单例、双主题 token、转义 | `apps/desktop/src/markdown/highlighter.ts` |
| 渲染后异步升级代码块 | `apps/desktop/src/markdown/highlightDom.ts`、`components/MarkdownContent.vue` |
| 消息操作（复制/重试/回退） | `components/MessageActions.vue`、`services/clipboard.ts` |
| 发送三选（可用条件纯函数） | `components/sendMode.ts`、`components/ComposerSendMenu.vue` |
| 模式横条 + 按会话记录待发模式 | `components/ChatComposer.vue` |
| 「忙碌时发送」设置 | `settings/busyDelivery.ts`、`composables/useBusyDelivery.ts`、`components/SettingsDialog.vue` |
| 位置感知 tooltip | `components/tooltipPlacement.ts`、`components/AppTooltip.vue`（`auto`） |
| `send_prompt` 参数管道 | `workspace/bridge.ts`、`workspace/types.ts`、`src-tauri/src/commands.rs`、`src-tauri/src/dto.rs` |

## 5. 已知限制（本切片刻意不做，不能当成已完成）

1. **发送三选没有运行时语义**：`mode`/`thinking` 只走到命令层并被显式忽略
   （`let _ = (mode, thinking);`）。因此 agent 忙碌时主发送钮仍然禁用，
   选择「加入当前」后不能真的插进当前回合——注入/排队/并行会话属于后续切片。
2. **并行发送不建匿名会话**：`send_parallel` / `bring_back_to_main` 未实现，本切片只做选择与参数管道。
3. **消息重试 / 回退到这里**：后端命令（`retry_message` / `rewind_to`）不存在，按钮按决策文档置灰并提示「即将支持」。
4. **markdown 里的链接**：没有接 `tauri-plugin-opener`，点击会先复制链接并提示（直接跟随 href 会把整个应用导航走）。
5. **动效 token**：S0 的 `--ease-spring` 尚未落在本分支，组件统一写成
   `var(--ease-spring, <同一曲线>)`——S0 合并后自动生效，未合并时退回既有曲线，不会出现无过渡。
6. **`cpp` 语言包较大**（797 kB 未压缩 / 60 kB gzip），且仅在出现 ```cpp 时下载；如后续在意，可再收窄白名单。
7. **未做跨平台实机验证**：以上结果只覆盖 Windows 本机（macOS/Linux 未验证，不宣称通过）。
