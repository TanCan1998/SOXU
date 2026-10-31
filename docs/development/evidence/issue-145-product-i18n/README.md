# Issue #145 · 产品净化第二刀 + i18n（设置页与命令面板）验证记录

本文件记录 TASK-035 的验收证据。**自动化的部分**给出可复现命令与结果；
**需要桌面窗口的部分**（托盘关闭、资源管理器、桌面通知）由 `verify-issue-145-desktop.mjs`
驱动构建产物 `soxu-desktop.exe` 实机走查，断言与原始观测都写在
`desktop-metrics.json` 里（见第 3 节）。仍有两项无法自动化，逐条列为「未验证」，
没有真实走查就不写成通过。

## 1. 改动范围

| 文件 | 改动 |
| --- | --- |
| `apps/desktop/src/settings/extensions.ts` | 每条加稳定 `id`（语言包 key 片段）；用途说明走语言包 |
| `apps/desktop/src/settings/catalog.ts` | 目录只存语言包 key（`labelKey` / `descriptionKey` / `keywordsKey`），新增 `settingsTabs` / `settingsEntries` / `settingsEntryView` / `settingsTabView` 解析函数；移除 `system.autoUpdate`、`system.updateCheck` 两项 |
| `apps/desktop/src/commands/registry.ts` | 命令声明只写 id + 动作，key 由 id 推导（`commandKeys`）；分组改成稳定 id；`buildCommands(t)` 按当前语言解析 |
| `apps/desktop/src/locales/{zh-CN,en-US}/settings.json` | 新增目录文案、选项档位、系统页说明、弹窗外壳文案 |
| `apps/desktop/src/locales/{zh-CN,en-US}/commands.json` | 新增模块：命令标题 / 说明 / 别名 / 不可用原因 / 面板自身文案 |
| `apps/desktop/src/components/SettingsDialog.vue` | 外壳文案走 `t()`，标签页来自 `settingsTabs(t)` |
| `apps/desktop/src/components/settings/SettingsSystem.vue` | 5 项（移除两个更新入口）；两个开关真接线；新增「打开数据目录」按钮；说明文案走 `t()` |
| `apps/desktop/src/components/settings/SettingsRow.vue` | 行标题 / 说明按当前语言解析 |
| `apps/desktop/src/components/settings/Settings{Appearance,Session}.vue` | 选项档位与说明文案走语言包（`settings/optionLabels.ts`） |
| `apps/desktop/src/components/CommandPalette.vue` | 面板文案（条数、空态、不可用原因、分组、底部提示、aria）走 `t()` |
| `apps/desktop/src/settings/optionLabels.ts` | 选项文案解析（语言包优先，缺 key 回退数据表） |
| `apps/desktop/src/settings/systemBridge.ts` | 两条后端通道的注入点：`set_close_behavior` / `open_data_directory` |
| `apps/desktop/src/notifications/settings.ts` + `stores/notifications.ts` + `composables/useNotifications.ts` | 「任务完成通知」作为总闸并入事件链：关闭后完成 / 出错不提醒，等待输入仍提醒 |
| `apps/desktop/src/App.vue` | 接线：通知总闸、关闭行为推送（含 `immediate`）、打开数据目录、清空会话禁用原因走 `t()`、命令清单 `computed` |
| `apps/desktop/src-tauri/src/tray.rs` | 新增受管 `ClosePreference`（默认 true）；`close_action(tray_present, minimize_to_tray)`；窗口事件读偏好 |
| `apps/desktop/src-tauri/src/commands/workspace.rs` | 新增 `open_data_directory`（只取 `app_data_dir()`，交给系统文件管理器）与 `set_close_behavior` |
| `apps/desktop/src-tauri/src/lib.rs` | 登记 `ClosePreference`；两条命令注册进 workspace 领域块 |
| `apps/desktop/tests/harness/verify-issue-145-desktop.mjs` | 桌面实机走查脚本：真实窗口下量关闭行为、完成通知与「打开数据目录」 |
| `.gitignore` | 忽略 `.soxu-tmp/`（走查期间的临时探针目录，不进仓库） |

## 2. 自动化证据（本次已执行）

环境：Windows / Node v26.10.0 / pnpm 12.15.0 / Rust（`rust-toolchain.toml`）。

| 命令 | 结果 |
| --- | --- |
| `pnpm --filter @soxu/desktop check`（vue-tsc --noEmit） | 通过，无诊断 |
| `pnpm --filter @soxu/desktop test` | 458 tests / 458 pass / 0 fail |
| `node scripts/check-locales.mjs` | 通过：2 种语言、5 个模块、748 条文案，key 完全对齐 |
| `node scripts/check-command-blocks.mjs` | 通过：13 个领域块、51 个 command |
| `cargo fmt --all -- --check` | 通过 |
| `cargo clippy -p soxu-desktop --all-targets --locked -- -D warnings` | 通过 |
| `cargo test -p soxu-desktop` | 通过（含 `tray_bridge.rs` 13 条、`workspace_bridge.rs` 2 条） |
| `pnpm test:scripts` | 66/71 通过；5 条失败全部来自 `secret-gate.test.mjs`，原因是本机 `SOXU_AGENT_SESSION=1`（见下）。清空该变量后 71/71 通过 |
| `node --test scripts/tests/secret-gate.test.mjs`（去掉该环境变量） | 5/5 通过 |

关于 `secret-gate` 的 5 条失败：该用例跑的是 `.githooks/pre-commit` 门禁本身，
而 `scripts/check-staged.mjs` 在 `SOXU_AGENT_SESSION=1` 时按设计拒绝任何 Agent 提交。
这与本切片改动无关，也不构成「跳过门禁」：同一批用例在无该变量的环境（Runner）下全绿。

### 2.0 真实 DOM 渲染（headless Edge + CDP，非 Tauri 窗口）

设置页与命令面板都在浏览器夹具里用**生产组件 + 生产语言包**渲染过一遍：

```powershell
node apps/desktop/tests/harness/shoot-issue-116-settings.mjs   # 设置页（含 en-US 一段）
node apps/desktop/tests/harness/shoot-issue-123-palette.mjs    # 命令面板
```

| 断言 | 结果 |
| --- | --- |
| 系统页 5 行、没有「检查更新」「自动更新」入口 | 通过（`rows: 5`，`hasUpdateEntry: false`） |
| 系统页有「打开数据目录」且按钮接到真实动作 | 通过（`count: 1`，按钮文案变成「已打开」） |
| 切到 en-US 后设置页没有任何中文（含 CJK 标点） | 通过 |
| 切到 en-US 后四个标签页是 Appearance / Session / Extensions / System | 通过 |
| 切到 en-US 后扩展页（12 个扩展 + 4 个技能 + 4 个 MCP）没有中文 | 通过（20 个条目） |
| 命令面板列出 34 条命令；`dk` 首条是「打开设置」；`sz` 命中「打开设置」 | 通过 |

产物（本次运行）：

- `settings-harness-metrics.json` / `palette-harness-metrics.json`：两次运行的完整断言与耗时
- `settings-en-us.png` / `extensions-en-us.png`：en-US 下外观页与扩展页的截图

注意：这两个脚本按设计会把自己的产物写回各自 Issue 的证据目录
（`issue-116-v4-s2` / `issue-123-command-palette`）。本次为避免覆盖历史证据，
运行后已把那两处文件恢复到原状，只把与 Issue #145 有关的新产物复制到本目录。

### 2.1 关键断言（`apps/desktop/tests/productI18n.test.ts`）

| 验收点 | 断言 |
| --- | --- |
| 目录与注册表无硬编码 CJK | 抹掉注释后扫 `settings/catalog.ts` 与 `commands/registry.ts` |
| 设置页切 en-US 全英文 | 18 项 + 4 页的 label / description / keywords 全部解析成非 key 文案且不含 CJK 与全角标点 |
| 命令面板切 en-US 全英文 | 34 条命令的 title / hint / keywords + 不可用原因同样断言；切回 zh-CN 后标题立刻变回中文 |
| key 对齐 | `commands` / `settings` 两个模块在两个语言里 key 集合完全一致 |
| 完成通知总闸 | 纯函数判定：完成 / 出错关闭，等待输入保留；store 级用例覆盖「不弹 toast、不记历史」 |
| 关闭行为通道 | `pushCloseBehavior` 成功 / 失败两条路径；命令名与 `lib.rs` 注册、`commands/workspace.rs` 实现逐一对照 |
| 打开数据目录 | 成功带回真实路径、失败带回原因 |
| App.vue 接线 | `completionEnabled` 注入、`pushCloseBehavior(..., immediate)`、`openDataDirectoryInFileManager`、`:commands="commands"` |
| 更新入口移除 | catalog 里没有 `system.autoUpdate` / `system.updateCheck`；系统页模板里没有任何更新入口 |

### 2.2 Rust 侧

- `tray_bridge.rs`：`close_action` 的四种组合（托盘有无 × 偏好真假）；`ClosePreference`
  默认值与前端 `DEFAULT_SYSTEM_SETTINGS.minimizeToTray` 一致且可翻转；
  窗口事件确实从受管状态读偏好并把它交给 `close_action`。
- 真实 `CloseRequested` 事件、`window.hide()` 与进程退出由第 3 节的实机走查覆盖。

## 3. 桌面实机证据（构建产物 `soxu-desktop.exe`，本次已执行）

复现命令（仓库根目录，先构建一次 Rust 侧）：

```powershell
cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml
node apps/desktop/tests/harness/verify-issue-145-desktop.mjs
```

脚本自己拉起 Vite（结束时回收），每个用例各启动一次真实 Tauri 窗口，把断言与原始观测写进
`desktop-metrics.json`。最近一次运行 **2026-10-31T07:47:04Z**，**10/10 断言通过**：

| 断言 | 原始观测（`desktop-metrics.json`） | 结果 |
| --- | --- | --- |
| 托盘开关 = 开：点 × 后进程仍在、主窗口存在但不可见 | `afterClose.process: "alive"`、`window: "hidden"`；顶层窗口含 `Tauri Window\|hidden` 与 `tray_icon_app\|hidden` | 通过 |
| 隐藏到托盘后 WebView2 子进程仍在（恢复时不白屏） | 进程树关闭前后都是 6 个 `msedgewebview2.exe` | 通过 |
| 托盘开关 = 关：点 × 后 `soxu-desktop.exe` 退出、窗口消失 | `afterClose.process: "gone"`、`window: "missing"`、顶层窗口表为空 | 通过 |
| 进程退出后没有残留子进程 | 进程树 6 → 0 | 通过 |
| 两张托盘截图的开关区域确实不同（不是同一张图） | 裁剪 MD5 `8420cd64…`（`aria-checked=true`） vs `593fd0f8…`（`false`） | 通过 |
| 通知开：完成一轮后真的弹 `sessionCompleted` Toast | toast 标题「会话完成」、事件流里有一条 `settled` | 通过 |
| 通知关：同样一轮不再弹 Toast | 前后 toast 计数均为 0 | 通过 |
| 「打开数据目录」真的打开资源管理器 | `file:///C:/Users/tanca/AppData/Roaming/dev.soxu.desktop` | 通过 |
| 两个开关都真的把偏好推给 Rust | 控制台没有任何 `[system]` 同步失败诊断 | 通过 |

操作方式与真人一致：× 用 `CloseMainWindow()`（WM_CLOSE，与点标题栏 × 同一条路径进入
`WindowEvent::CloseRequested`），设置弹窗用 Esc 关闭，开关用 CDP 真实鼠标事件点击。
进程与窗口状态从宿主侧读取（`EnumWindows` + `IsWindowVisible`、`Get-CimInstance Win32_Process`），
不依赖页面自述；`hide()` 失败只写 stderr，所以 stderr 也一并记进证据（本次为空）。

截图（同一块屏幕、只有开关状态不同，裁剪 MD5 已进断言）：

- `desktop-tray-on-switch-on.png` + `desktop-tray-on-switch-crop.png`（开关开）
- `desktop-tray-off-switch-off.png` + `desktop-tray-off-switch-crop.png`（开关关）
- `desktop-notify-on-toast.png` / `desktop-notify-off.png` / `desktop-open-data-directory.png`

**仍然没有证据、不写成通过的两项**：

1. **托盘图标左键恢复窗口**：Windows 11 默认把新托盘图标收进「隐藏的图标」溢出区，
   脚本无法稳定点到它。`show_main_window` 的两条事件映射（左键抬起 / 双击）与四种
   `close_action` 组合由 `tray_bridge.rs` 单测覆盖，真实鼠标点击仍需人工确认。
2. **隐藏瞬间的 tooltip 文案**：同属托盘图标区域，未取得截图 / UIA 证据
   （与 Issue #101 的既有结论一致）。

## 4. 已知边界

- **未迁移的界面**：输入区与消息区、文件 / Git / 终端 / 搜索抽屉、通知正文
  （`notifications/events.ts`）仍是中文。切到 en-US 时这些位置中英混排，界面不会空白；
  它们属于 `docs/development/i18n.md` 阶段 3 的其余小任务。
- 扩展页清单已迁移（12 个扩展 + 4 个技能 + 4 个 MCP 服务）：条目名保持产品标识，
  用途说明走语言包，缺 key 时回退 `settings/extensions.ts` 里的中文。
- **`autoUpdate` 字段保留但不显示**：更新通道落地前不提供入口（移除而不是禁用），
  字段留着以免丢掉用户旧偏好；将来加回入口不需要做数据迁移。
- **通知正文不走语言包**：本次只把「是否提醒」接进事件链，Toast / 历史的措辞仍属通知切片。
- **`open_data_directory` 用平台启动器**（`explorer` / `open` / `xdg-open`）而不是
  `tauri-plugin-opener`：少一个依赖与权限面。子进程不阻塞命令返回，但仍 join 一次，
  避免在 Unix 上留下僵尸进程；macOS / Linux 未实机验证。
- **临时会话不 retain 运行时事件**（既有行为，不属本任务范围）：后端只在 fanout 计数 > 0 时
  emit，持久化会话由 `openSession` 调 `retainSession` 挂上计数，而临时会话在
  `sessionWorkspace.openSession` 里提前 return，从没调过它。走查要验证的是「完成通知总闸」，
  所以脚本在会话打开后补调一次 `retain_session_events`（前端本来会调的那条命令），
  不改产品代码、不碰用户会话文件。该缺口另开任务处理。
- **走查脚本的两处替身与副作用**：`pi` 用 `rustc` 编译的 shim 指向
  `crates/agent-runtime/tests/fixtures/fake-pi.mjs`（避免真的调用模型、真的写用户会话）；
  用例结束把两个系统开关写回默认值——`tray-off` 结束时进程已退出、CDP 不可用，脚本会
  **重新拉起一次应用写回并正常关闭**，否则开发机会一直停在 `minimizeToTray=false`。
