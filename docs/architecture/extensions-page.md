# 扩展页：本机 Pi 配置的只读视图（TASK-037 · Issue #147）

本文件记录扩展页的**已实现行为**：扫描层（apps/desktop/src-tauri/src/extension_catalog/）、
命令层（apps/desktop/src-tauri/src/commands/extension.rs）、前端桥接
（apps/desktop/src/services/extensions.ts）、状态（apps/desktop/src/composables/useExtensionCatalog.ts）
与面板（apps/desktop/src/components/settings/SettingsExtensions.vue）。
未验证的部分单列在「验证状态」，不写成已完成。

对应任务：`tasks/backlog/TASK-037.md`。证据见
`issue-147 验证记录`（docs/development/evidence/issue-147-extensions-page/README.md）。

## 1. 范围与非目标

范围内：

- 只读列出本机 Pi 的扩展、技能与 MCP 服务，每条带来源（内置 / 用户安装）与启停状态；
- 技能按需展开，显示真实文件数（最多统计 2000 个，触顶显示「≥ N」）；
- 读取中 / 读取失败（含后端原因与重试）/ 空清单三态。

非目标（**产品约束，不是待办**）：

- 不做扩展或技能的启停开关：Pi 拥有这些配置的所有权，SOXU 写回就等于重新实现内核；
- 不做 MCP 服务管理 UI，也不探测连接状态（只读拿不到，固定 unknown）；
- 不扫描项目级 `<repo>/.pi/`，也不做 glob 展开。

## 2. 命令契约

两条命令都在 `lib.rs` 的「extension」领域块内（块内字母序），且**没有任何写入口**。

| 命令 | 参数 | 返回 | 读写 |
| --- | --- | --- | --- |
| `list_extensions` | — | `ExtensionCatalog` | 只读 |
| `read_extension_detail` | id（来自列表） | `ExtensionDetail` | 只读 |

`read_extension_detail` 的 id 是不透明标识（`builtin:mcp` / `extension:rtk` /
`package:pi-subagents` / `skill:<name>`），后端重新扫描后按 id 匹配，
因此前端永远传不了路径，越权读取无从发生。

## 3. 目录白名单与数据来源

配置目录解析顺序：`PI_CODING_AGENT_DIR`（Pi 官方变量）→ `SOXU_PI_AGENT_DIR`
（测试与自定义布局）→ `~/.pi/agent`。**只读**下列位置：

| 位置 | 用途 |
| --- | --- |
| `settings.json` | `extensions` / `skills` 的包含与排除项、`packages` 声明 |
| `mcp.json` | `mcpServers` 的名字、`type` / `url` / `command`、`description` |
| `extensions/` | 单文件扩展（`.ts` / `.js` / `.mjs` / `.cjs`）与带 `index.*` 的目录扩展 |
| `skills/` | 含 `SKILL.md` 的目录（递归，最多 3 层） |
| `npm/node_modules/<包名>` | `settings.packages` 里声明过的 npm 包的 `package.json` 与技能目录 |

不读的东西：`auth.json`、`mcp-auth.json`、`mcp.json` 里的
`headers` / `env` / `args`（里面常有 token）、`models.json`、`trust.json`。

## 4. 状态推导规则（不猜）

- 扩展与技能的默认状态是「已启用」（Pi 的默认行为就是加载）；
- `settings.extensions` / `settings.skills` 里的 `-path` / `!pattern`
  命中条目时置为「已停用」，匹配做双向前缀比较（排除项常写到 `SKILL.md` 这一层，
  条目记的是技能目录）；
- `builtin:` 前缀的条目按符号决定内置扩展的启停；
- 包声明为对象时，`extensions: []` 表示「这个包不加载扩展」——该包不会出现在扩展列表里，
  而不是列出来再标成停用；
- 带通配符的条目 SOXU 不展开（不实现 glob），可能少判一个排除项，这是已知偏差；
- 配置文件顶层不是对象、目录不存在、目录不是文件夹都直接返回错误，
  不返回空列表冒充「本机什么都没装」。

## 5. 生命周期与内存

- 扫描是同步只读 IO（几个目录 + 小 JSON），与列语言包目录同量级；大目录统计有上限；
- 前端用 `shallowRef` 持有清单：上百条带长描述的数据不需要深响应式代理；
- 详情按 id 缓存，收起再展开不重复扫描；刷新会清空缓存（技能可能已被删除或改名）；
- 没有定时器、没有监听器、没有子进程：组件卸载即结束，不需要额外释放路径。

## 6. 验证状态

| 项 | 状态 |
| --- | --- |
| 扫描结果与本机 `~/.pi/agent` 一致 | 已验证（真实扫描 JSON → 生产组件渲染，17 条断言 + 6 张截图） |
| 只读（无写 Pi 配置的调用） | 已验证（源码扫描 + 扫描前后目录逐字节比对） |
| 失败态与空态 | 已验证（集成测试 + 渲染走查） |
| macOS / Linux 实机 | **未验证**（路径大小写与符号链接语义按 `cfg!(windows)` 分支处理，但没有实机跑过） |
| 真实 Tauri 窗口内的滚动与长列表手感 | **未验证**（走查用的是同一份 DOM，非 Tauri WebView） |
