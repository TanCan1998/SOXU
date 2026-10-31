# Issue #147 · 扩展页真数据（list_extensions 只读接入）验证记录

本文件记录 TASK-037 的验收证据。所有数字都能用下面给出的命令重跑；
没有实机证据的部分逐条写成「未验证」，不写成通过。

## 1. 改动范围

| 文件 | 改动 |
| --- | --- |
| `apps/desktop/src-tauri/src/extension_catalog/mod.rs` | 新增只读扫描入口：`agent_dir()`（PI_CODING_AGENT_DIR → SOXU_PI_AGENT_DIR → ~/.pi/agent）、`scan()`、`detail_in()`；配置文件顶层不是对象时直接报错 |
| `.../extension_catalog/entry.rs` | 路径守卫（拒绝 `..` / 通配符 / 越界）、排除项匹配、frontmatter 解析（含块标量）、文件数统计 |
| `.../extension_catalog/resources.rs` | 扩展 / 技能 / Pi 包的发现规则与 `enabled` 推导 |
| `.../extension_catalog/mcp.rs` | mcp.json 只取 name / type / description，连接状态固定 `unknown` |
| `apps/desktop/src-tauri/src/dto/extension.rs` | 新增 `ExtensionCatalog` / `ExtensionItem` / `SkillItem` / `McpServerItem` / `ExtensionDetail` |
| `apps/desktop/src-tauri/src/commands/extension.rs` | 新增 `list_extensions`、`read_extension_detail`（只做参数映射，无写入口） |
| `apps/desktop/src-tauri/src/lib.rs` | 两条命令注册进 extension 领域块；`pub mod extension_catalog` |
| `apps/desktop/src/services/extensions.ts` | 前端唯一调用扩展命令的桥接；浏览器预览走显式失败 |
| `apps/desktop/src/composables/useExtensionCatalog.ts` | 三态（loading / ready / error）与技能详情按需展开 + 缓存 |
| `apps/desktop/src/components/settings/SettingsExtensions.vue` | 改调真数据：三态、空态、来源徽章、启停状态、技能详情展开；仍无开关 |
| `apps/desktop/src/settings/extensions.ts` | **删除**：静态常量表（12 个扩展 / 4 个技能 / 4 个 MCP）不再作为数据来源 |
| `apps/desktop/src/locales/{zh-CN,en-US}/settings.json` | 扩展页文案重写：三态、空态、来源、启停、详情、只读说明；移除 20 条静态描述 key |
| `apps/desktop/src-tauri/tests/extensions_bridge.rs` | 集成测试：真实布局夹具、凭据不外泄、纯读、错误态、详情统计 |
| `apps/desktop/src-tauri/src/extension_catalog/tests.rs` | 单测：frontmatter（含块标量）、包名解析、路径守卫、排除项、描述截断 |
| `apps/desktop/tests/extensionsPage.test.ts` | 前端：三态、空态、详情缓存与重试、后端无写调用 |
| `apps/desktop/tests/settingsDialog.test.ts` | 重写扩展页回归：只读、无开关、三态文案、静态表已删除 |
| `apps/desktop/src-tauri/examples/scan-agent-dir.rs` | 手动证据工具：把本机扫描结果打成 JSON（只读） |
| `apps/desktop/tests/harness/extensions.{html,ts}` | DOM 夹具：真实组件 + 注入的真实扫描结果 |
| `apps/desktop/tests/harness/shoot-issue-147-extensions.mjs` | 走查脚本：17 条断言 + 6 张截图 |
| `README.md` / `README.en.md` | 同步「扩展页已接入真实数据」 |

## 2. 验收标准对照

| 验收项 | 证据 |
| --- | --- |
| `list_extensions` 注册进 lib.rs extension 领域块（check-command-blocks 通过） | `node scripts/check-command-blocks.mjs` → 13 个领域块、53 个 command 通过（见 §3） |
| 桌面端扩展页内容与本机 `~/.pi/agent` 实际内容一致 | §4：真实扫描 JSON → 注入夹具 → 生产组件渲染，脚本逐条比对**条目顺序 / 区块计数 / 徽章数 / 停用条数 / 文件数**，截图见 `01`～`03` |
| 无任何写入 Pi 配置的调用 | `extensionsPage.test.ts` 扫描 `extension_catalog/*.rs` 里不得出现 `fs::write` / `fs::remove` / `fs::create_dir` / `OpenOptions` / `File::create` / `fs::rename`；命令层不得出现 `set_/save_/toggle_/enable_/disable_` 类非语言包命令；集成测试比对扫描前后目录逐字节一致 |
| 失败态：目录不存在 / 不可读显示明确错误 | §4 截图 `05-error-zh-CN.png`；`extensions_bridge.rs` 覆盖：目录不存在、路径是文件、settings.json 写坏、settings.json 是目录、mcp.json 顶层是数组 |
| `pnpm check` 全绿 | §3 |

## 3. 自动化证据（本次已执行）

环境：Windows 10（x64）/ Node v26.10.0 / pnpm 12.15.0 / Rust（`rust-toolchain.toml`）。

| 命令 | 结果 |
| --- | --- |
| `pnpm check` | 通过（icons + 领域块 + 语言包 + `vue-tsc --noEmit` + 462 条前端测试）。`pnpm test:scripts` 66/71：5 条失败全部来自 `secret-gate.test.mjs`，原因是本机 `SOXU_AGENT_SESSION=1`（该门禁按设计拒绝 Agent 提交），与本切片无关；清空该变量后 71/71 通过 |
| `node scripts/check-command-blocks.mjs` | ✅ 13 个领域块、53 个 command |
| `node scripts/check-locales.mjs` | ✅ 2 种语言、5 个模块、744 条文案，key 完全对齐 |
| `pnpm --filter @soxu/desktop test` | 462 tests / 462 pass / 0 fail |
| `cargo fmt --all -- --check` | 通过 |
| `cargo clippy --workspace --all-targets --locked -- -D warnings` | 通过 |
| `cargo test --workspace` | 通过（含 `extensions_bridge.rs` 4 条、`extension_catalog::tests` 9 条） |
| `pnpm test:scripts`（清空 `SOXU_AGENT_SESSION`） | 71 tests / 71 pass / 0 fail |
| `git diff --check` | 通过 |

补充：`cargo test --workspace` 连跑两次，第二次出现过 1 次
`soxu-agent-runtime` 的 `retry_budget::a_successful_start_unblocks_the_next_run` 失败
（时间相关的既有用例，`crates/agent-runtime` 在本切片零改动）；单独重跑该测试 10/10 通过。
这属于既有用例的偶发不稳定，不是本切片引入，也不被算作「通过」。

## 4. 真实数据走查（本机 ~/.pi/agent）

### 4.1 生成真实扫描快照

```powershell
cargo run -q -p soxu-desktop --example scan-agent-dir > docs/development/evidence/issue-147-extensions-page/agent-scan-windows.json
```

本次结果（`agent-scan-windows.json`，agent 目录 `C:\Users\tanca\.pi\agent`）：

| 区块 | 数量 | 说明 |
| --- | --- | --- |
| 扩展 | 9 | 4 个内置（codemode / llama.cpp / mcp / tool-search）+ 4 个 npm 包（context-mode、pi-subagents、pi-tracker、pi-web-access）+ 用户扩展 `rtk.ts` |
| 技能 | 63 | `skills/` 下的用户技能（含 `rust-skills/skills/*` 这类嵌套目录）+ 包内技能（pi-subagents、context-mode）；其中 2 条被 `settings.json` 的 `-…SKILL.md` 排除，显示为「已停用」 |
| MCP 服务 | 5 | context7、fluxdown、github、pideck（http）、rea（stdio）；连接状态全部为 unknown |

两条如实体现真实配置的细节：

1. `@madgagarin/pi-agentrouter` 在 `settings.packages` 里以 `extensions: []` 声明 —— 即「这个包不加载任何扩展」，
   因此扩展列表里没有它（不是漏读）；`pi-cache-optimizer` 装在 `npm/node_modules` 但**没有**在 settings 里声明，
   因此也不列出（Pi 同样不会加载它）。
2. `skills/image-gen` 与 `skills/pideck-doctor` 被 `settings.skills` 以 `-…\SKILL.md` 排除，
   页面上显示「已停用」，与 Pi 的解析结果一致。

### 4.2 渲染走查

```powershell
node apps/desktop/tests/harness/shoot-issue-147-extensions.mjs
```

脚本自己拉起 Vite（1429）与 headless Edge，把上一步的真实扫描 JSON 注入
`tests/harness/extensions.html`（生产组件 + 生产 composable + 生产桥接，
只把 `window.__TAURI_INTERNALS__.invoke` 换成夹具替身），逐条断言并把结果写进
`desktop-report.json`。本次 17 条全部通过：

- 渲染顺序与扫描 JSON 完全一致（扩展 9 + 技能 63 + MCP 5 = 77 条）；
- 区块计数、来源徽章数、停用条数、MCP「连接状态未知」条数都与 JSON 一致；
- 技能详情展示真实文件数（脚本按 Rust 同一规则再数一遍目录）；
- en-US 下状态词是英文（Enabled / Connection unknown）；
- 读取中显示进度文案；失败态显示后端原因 + 重试且**没有**空态文案；空清单三段各有空态；
- 两种语言与失败态的渲染文本都不含禁用词（切片 / Issue # / 占位 / 演示 / V4-S / TODO( ）。

截图（`docs/development/evidence/issue-147-extensions-page/`）：

| 文件 | 内容 |
| --- | --- |
| `01-ready-zh-CN.png` | 真数据整页（zh-CN） |
| `02-ready-skill-detail-zh-CN.png` | 展开一条技能，显示真实文件数与目录 |
| `03-ready-en-US.png` | 同一份数据（en-US），界面状态词随语言切换 |
| `04-loading-zh-CN.png` | 读取中 |
| `05-error-zh-CN.png` | 配置目录不可读：原因 + 重试，没有空列表 |
| `06-empty-zh-CN.png` | 目录存在但没有任何资源：三条空态文案 |

## 5. 边界与已知限制

1. **不做 glob**：`settings.extensions` / `settings.skills` / 包 manifest 里的通配符（`*`、`!pattern`）不由 SOXU 展开，
   只解析字面路径。带通配符的排除项可能让某条显示为「已启用」而 Pi 实际没加载它——
   这是已知偏差，宁可少判也不假装支持。
2. **不做 MCP 探测**：连接状态恒为 unknown；工具数没有只读来源，因此 DTO 里根本不带 `toolCount` 字段。
3. **只扫用户级配置**：项目级 `<repo>/.pi/` 与 `~/.agents/skills/` 不在本 Issue 范围，
   页面只反映 `~/.pi/agent`。
4. **内置扩展名表**：取自 Pi 文档的四个内置扩展，外加 settings 里出现过的 `builtin:` 名字；
   Pi 未来新增内置扩展时，只要用户配置里出现就能列出，未出现则不会显示。
5. **未验证**：macOS / Linux 实机（路径大小写与符号链接语义不同，代码按 `cfg!(windows)` 分支处理，
   但没有实机跑过）；真实 Tauri 窗口内的滚动与长列表手感（走查用的是同一份 DOM，非 Tauri WebView）。
