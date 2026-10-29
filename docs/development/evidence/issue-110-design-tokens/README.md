# Issue #110 · V4-S0 设计 token 落地（证据）

> 目标：把原型 `F:\workplace\pi\soxu-prototype\style.css` 的设计变量搬进桌面端，
> 用 Tailwind 4 的 CSS-first `@theme` 注册，并建立深浅色双主题基础设施。
> 本切片**不改**任何既有组件（App.vue 等 10 个），只新增 token 层与验证面。

## 1. 交付物

| 文件 | 作用 |
|---|---|
| `apps/desktop/src/styles/tokens.css` | 唯一真源：静态 token + 浅/深两套主题 token + `@theme` 注册 |
| `apps/desktop/vite.config.ts` | 接入 `@tailwindcss/vite`（CSS-first 配置没有插件就不会编译） |
| `apps/desktop/src/main.ts` | 先加载 tokens.css 再加载 base.css（+2 行 import，不改任何组件） |
| `apps/desktop/tokens.html` + `src/styles/tokensPreview.ts` + `src/styles/TokensPreview.vue` | 开发专用色板验证面（`pnpm dev` 后访问 `/tokens.html`） |
| `apps/desktop/src/styles/tokenCatalog.ts` | 色板样本清单（纯数据）：色板与测试共用一份，避免各写一份各漏一半 |
| `apps/desktop/tests/designTokens.test.ts` | Node 侧回归：token 齐全、与原型一字不差、@theme 注册、无自引用、无 Preflight |
| `apps/desktop/tests/harness/shoot-issue-110-tokens.mjs` | 浏览器侧证据：计算值、@theme 工具类、圆形扩散、零布局位移、截图 |

## 2. 关键决策

### 2.1 不引入 Preflight

`@import "tailwindcss"` 整包会带上 Preflight，那套 reset 会抹掉 h1/button/列表的
浏览器默认样式——等于顺手改了 10 个既有组件的样式，与本切片「不改组件」冲突。
因此按 Tailwind 官方「Disabling Preflight」配方只取两层：

```css
@layer theme, base, components, utilities;
@import "tailwindcss/theme.css" layer(theme);
@import "tailwindcss/utilities.css" layer(utilities);
```

`apps/desktop/tests/designTokens.test.ts` 里有一条断言专门守住这一点（禁止
`tailwindcss/preflight` 与整包 `@import "tailwindcss"`）。

### 2.2 token 名与原型一字不差，@theme 只做别名

原型名多数不在 Tailwind 命名空间里（`--surface` 不是 `--color-surface`），
所以 `@theme inline` 里做一层 `--color-surface: var(--surface)` 的别名。
`inline` 让工具类内联成 `var(--surface)`，深浅色切换时在元素上重算，
不需要重新生成 CSS。

两个特例（`--shadow-pop`、`--ease-spring`）本身就在 `--shadow-*` /
`--ease-*` 命名空间里，直接写 `--shadow-pop: var(--shadow-pop)` 会自引用（计算值失效）。
做法是把真值放进 `--shadow-pop-value` / `--ease-spring-value`，由原型名转发一次：
工具类名仍是 `shadow-pop` / `ease-spring`，raw token 名仍是原型名，也没有自引用。
`designTokens.test.ts` 用 `/(--[a-z0-9-]+)s*:s*var()/` 扫全文件，出现即失败。

裸 `--ease` 没有后缀，进不了 `--ease-*` 命名空间，因此工具类名是 `ease-standard`。

### 2.3 语义色不随主题变

原型与 `docs/design/UIUX/V4/DESIGN.md` 都把 `--accent` / `--ok` / `--warn` /
`--danger` 当作固定值（只由 `data-accent` 切色板）。本切片照搬，没有自造深色变体；
测试里把它们归入「与主题无关」并断言深浅色取值一致。

### 2.4 验证面独立成页，不动 App.vue

Issue 正文一边要求「现有组件（App.vue 等 10 个）不改」，一边要求「App.vue 临时挂一个色板」。
两者冲突时取前者：色板做成 `tokens.html` 独立入口（`vite build` 只打包 `index.html`，
色板不进生产产物），但它调用的是**生产同一套** `theme.ts` + `themeTransition.ts`，
主题切换走的就是 `startViewTransition` 圆形扩散。

色板页同时 `import` 了 base.css：只为了拿到 `::view-transition-*` 那段扩散 CSS。
因此 `screens.json` 里 `bodyBg` 是 V3 的 `--soxu-bg`（`rgb(252,252,252)` /
`rgb(25,23,23)`），**色板本体的表面色来自 V4 `--surface`**（`#ffffff` / `#212121`）。
两套 token 并存是刻意的：V3 组件未迁移前观感必须不变。

## 3. 验证

### 3.1 Node 侧

```powershell
pnpm --filter @soxu/desktop test
```

`tests/designTokens.test.ts` 11 条全绿，覆盖：

- 静态 token 与原型 `style.css` 一字不差（字号 / 圆角 / 缓动 / 时长 / 强调色 / 语义色 / 阴影 / 布局）；
- 浅色块把裸 `:root` 一起列进选择器（没有 data-theme 的首帧也是浅色）；
- 深色 16 个 token 与原型一字不差，`--surface` / `--bg-*` 亮度 < 0.1（不是近白）；
- 16 个主题 token 深浅两套值互不相同；21 个静态 token 只定义一次；
- 34 条 `@theme` 注册全部指向正确的 raw token；`--text-chat--line-height` 跟 `--lh-chat`；
- 色板样本覆盖所有看得见的 token，且不引用 tokens.css 里不存在的变量；
- 没有 `tailwind.config.*`；没有自引用变量；没有 Preflight；
- vite 配置真的用了 `@tailwindcss/vite`，main.ts 里 tokens.css 先于 base.css；
- 没有新增依赖（tailwindcss 与 @tailwindcss/vite 都在既有 devDependencies，版本一致）。

### 3.2 浏览器侧（可复现）

```powershell
node apps/desktop/tests/harness/shoot-issue-110-tokens.mjs
```

脚本自己拉起 Vite（1434）与独立 profile 的 headless Edge，用 CDP 派发真实鼠标事件。
本次结果：**113 项断言全部通过**，环境 `Edg/156.0.4314.50`，视口 1280×900（整页 2145px）。

| 断言 | 结果 |
|---|---|
| 浅色 `--surface` / `--fg` / `--bg-raised` … 计算值 | `#ffffff` / `#1a1a1a` / `#f2f2f3`（与原型一致） |
| 深色 `--surface` / `--fg` / `--bg-raised` | `#212121` / `#ececec` / `#2f2f2f` |
| 16 个主题 token 深浅不同、21 个静态 token 深浅相同 | 通过 |
| `bg-bg-raised` 工具类 | 浅 `rgb(242,242,243)` → 深 `rgb(47,47,47)` |
| `rounded-lg` / `text-chat` / `font-mono` | `13px` / `16px` + 行高 `26.88px` / `"JetBrains Mono", …` |
| `shadow-pop` 工具类 | 浅 `rgba(0,0,0,.12)` → 深 `rgba(0,0,0,.46)`（跟着主题换） |
| `ease-spring` / `ease-standard` | `cubic-bezier(0.34,1.42,0.64,1)` / `cubic-bezier(0.2,0,0,1)` |
| 切换方式 | `startViewTransition` 支持；过渡期间 `<html>` 挂 `soxu-theme-transition` |
| 圆心 / 半径 / 时长 | 圆心 = 点击点 `(1198, 45)`，半径 `1472px`，`420ms` |
| 布局跳动 | `maxShift = 0`，文档滚动高度/宽度变化 `0`（切深、切回浅各测一次） |
| 运行期异常 | 0 |

### 3.3 截图（人眼复核用）

| 文件 | 内容 |
|---|---|
| `01-light-tokens.png` | 浅色色板首屏（视口 1280×900） |
| `02-light-to-dark-reveal-early.png` | 圆形扩散早期（~110ms） |
| `03-light-to-dark-reveal-late.png` | 圆形扩散后期（~290ms），与早期帧字节不同 → 扩散是逐帧推进的 |
| `04-dark-tokens.png` | 深色色板首屏，与浅色截图字节不同 → 主题真的换了 |
| `05-light-tokens-full.png` | 浅色整页（2145px，覆盖全部 7 组样本） |
| `06-dark-tokens-full.png` | 深色整页 |
| `screens.json` | 全部计算值、几何量、截图哈希与 113 项断言明细 |

抽样像素（`screens.json` 同级 PNG 的中心网格）复核：浅色帧表面 `#ffffff`、
分割线 `#e5e5e7`、raised `#f2f2f3`、主按钮 `#3a83f7`；
深色帧 `#212121` / `#383838` / `#2f2f2f` / `#2f70d8`；
过渡帧同一行里同时出现浅色与深色区块，边界随半径推进。

### 3.4 完整门禁

```powershell
pnpm check
```

- `icons:generate`、`vue-tsc --noEmit`（`@soxu/desktop check`）通过；
- `@soxu/desktop test`：**149 条通过 / 0 失败**；
- `test:scripts`：**47 条通过 / 0 失败**；
- `git diff --check`：无输出（退出码 0）。

⚠️ 一个环境前提：本机 Agent 会话带着 `SOXU_AGENT_SESSION=1`，
`scripts/tests/secret-gate.test.mjs` 的「暂存普通文本时门禁放行」用例会因此失败
（`scripts/check-staged.mjs` 明确拒绝 Agent 自己提交）。这与本切片无关，
在同一条命令前清掉该标记即可复现全绿；本切片没有、也不应该修改该门禁或其测试。

未执行：`cargo fmt` / `cargo test`——本切片没有任何 Rust 改动。

## 4. 已知风险与后续

1. **两套 token 并存**：`base.css` 的 `--soxu-*`（V3）仍在服务 10 个组件，V4 token 只被色板与测试消费。
   S1 起逐组件迁移，迁移完成的组件才允许删 `--soxu-*`。同名不同值（深色 `--soxu-fg` `#f4f3f3` vs `--fg` `#ececec`）
   是刻意的，不要"顺手对齐"，那会改掉未迁移组件的观感。
2. **工具类层低于既有样式**：base.css 的规则全部未分层，未分层样式优先于任何 `@layer`，
   所以 Tailwind 工具类**不会**覆盖组件里已经生效的规则。这是本切片要的安全属性；
   但后续组件改用工具类时，必须先把对应组件样式也放进 `@layer` 或直接删掉手写规则，否则工具类会被压住。
3. **扫描范围包含 docs/**：`@tailwindcss/vite` 会扫描项目里的设计稿 HTML，可能生成少量用不到的工具类
   （本次产物 43.5 kB，gzip 8.6 kB）。不影响正确性（都在 utilities 层），需要时再加 `@source not` 收窄。
4. **`--danger` 深色对比度**：原型在深色下沿用 `#dc2626`（与 `#212121` 对比约 4.0:1）。
   本切片按「原型即视觉基准」照搬，没有自造深色变体；若后续做无障碍审计需要提亮，应在设计侧定值后再改 token。
5. **色板不进生产构建**：`tokens.html` 只被 `vite dev` 提供；`vite build` 产物只有
   `dist/index.html` + `assets/`，已实测确认。删除色板不影响 `pnpm build`。
6. **文件行数**：`TokensPreview.vue` 505 行、`shoot-issue-110-tokens.mjs` 593 行，
   都在 600 行以内；样本清单已单独抽到 `tokenCatalog.ts`（117 行）避免 SFC 继续膨胀。
   两个文件都是开发期验证面，不参与运行时。
