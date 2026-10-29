# Issue #118 · TASK-026 搜索抽屉（会话内全文搜索 UI）验证记录

本目录记录**搜索抽屉 UI 切片**的可复现验证：命令、环境、原始指标与截图。
每条证据都能对回 Issue 的 acceptance criteria；未验证或已知限制在文末单列，不写成已完成。

- 验证时间：2026-10-29
- 环境：Windows 11（本机）· Node v26.10.0 · pnpm 12.15.0 · Rust 1.99.1 · Edge 156.0.4314.50（headless）
- 复现脚本：node apps/desktop/tests/harness/shoot-issue-118-search.mjs
- 原始指标：metrics.json（同目录，15 条 check 全绿）
- 数据层（search_session、防抖、片段高亮助手）已在 Issue #109 交付，本切片**不改 Rust**

---

## 1. 验收对照

| Acceptance criterion | 证据 |
| --- | --- |
| pnpm check 通过，桌面端测试全绿 | §2.1：258 个桌面端用例 + 58 个脚本用例，0 failed |
| 输入后 250 ms 内出结果 | §3.2 latency-within-250ms：多次运行实测 **226–234 ms**（防抖 200 ms + 一帧渲染，metrics.json 记录最近一次 231.3 ms）；防抖预算由 tests/searchDrawer.test.ts 断言 ≤ 250 ms |
| 点击结果定位到对应消息 | §3.3 jump-highlight：点击 #54 后第 54 条消息出现 data-highlight="true" 并被滚到视口中央（截图 03） |
| 新增测试覆盖防抖与结果渲染 | §2.2：tests/searchDrawer.test.ts（27 个用例）覆盖状态判定、倒序、定位、计数口径、防抖预算、组件与外壳接线；渲染由 §3 的浏览器实测覆盖 |
| 提交规范 <gitmoji> type(scope): 描述，目标分支 dev | 由 Runner 统一提交（Developer 不执行 git commit） |

## 2. 命令与原始结果

### 2.1 类型检查与测试

    $ pnpm check
    ℹ tests 258      # apps/desktop：vue-tsc --noEmit + node --test tests/*.test.ts
    ℹ pass 258
    ℹ fail 0
    ℹ tests 58       # scripts/tests/*.test.mjs
    ℹ pass 58
    ℹ fail 0

> 若在**开发 Agent 会话**里直接跑 pnpm check，scripts/tests/secret-gate.test.mjs 会因环境里存在
> SOXU_AGENT_SESSION=1（pre-commit 钩子按设计拒绝 Agent 直接提交）而失败。这是环境注入造成的既有现象，
> 与本次改动无关：清掉该变量后 58 个脚本用例全绿（上面的结果即如此）。

    $ cargo fmt --all -- --check     # 未改动任何 Rust 文件
    exit=0
    $ cargo test --workspace         # 冷启动全量编译后跑完，0 failed
    test result: ok. ... 0 failed（全部测试二进制）
    $ git diff --check
    exit=0

### 2.2 新增与调整的用例

| 文件 | 数量 | 覆盖 |
| --- | --- | --- |
| tests/searchDrawer.test.ts（新增） | 27 | 三态/错误态判定边界（含「输入变了不能继续显示旧结果」）；命中按时间倒序且不原地改写状态；命中 id 与 mapping.ts 同源；按 ordinal 定位（实时消息不可被历史命中选中）；有界翻页（已在窗口 / 需翻页 / 翻到上限 / 历史到底 / 翻页途中切走会话）；计数与截断/降级文案口径；千分位不依赖 locale；防抖 ≤ 250 ms 且组件不自带第二份定时器；抽屉结构（aria、type=search、mark 高亮、live region）与 reka-ui/S0 token 使用；App.vue 的 Ctrl+F / 关闭 / 输入 / 跳转接线；消息列表的 scrollToIndex 与高亮定时器清理；store 暴露搜索三件套 |
| tests/sessionSearch.test.ts（沿用，未改） | 10 | 数据层：一次 IPC、200 ms 防抖只发一次、迟到响应丢弃、空/超长查询、失败与 degraded、片段切片 |

### 2.3 无新增依赖

抽屉只用已有依赖：reka-ui（ScrollArea 原语与 AppTooltip 封装的 Tooltip）、@lucide/vue（Search / X）、
V4-S0 token（tokens.css）。

## 3. 浏览器实测（metrics.json）

脚本自拉起 Vite（1426）与独立 profile 的 headless Edge，用 CDP 真实输入与点击，
任一条 check 不成立就以非 0 退出并留痕。本轮 15 条全部通过。

夹具：tests/harness/search-drawer.html + search-drawer.ts，挂载**生产组件**
（SearchDrawer + ChatPanel + MessageList），会话是 60 条内存消息（每 9 条一条含「扩散」），
跳转复用生产代码里的 resolveJumpTarget——夹具不重写被测逻辑。

### 3.1 空态

    "empty": { "status": "empty", "count": "", "hits": 0, "marks": 0, "notice": null }

空态说明「输入关键词，搜索这个会话的整份内容（不只是已加载的消息）」——这正是本切片
相对「只过滤已加载 40 条」的差别（见 docs/development/session-search.md 开头的动机）。

### 3.2 输入 → 结果（延迟与倒序）

    "timing": { "debounceMs": 200, "latencyMs": 231.3 },
    "results": {
      "status": "results",
      "count": "6 条匹配 · 扫描 60 条",
      "hits": 6,
      "ordinals": [54, 45, 36, 27, 18, 9],
      "marks": 6,
      "markText": "扩散"
    }

- latencyMs 是**页面内**测的：从最后一次 input 事件到「结果写进状态后的下一帧」，
  因此包含防抖窗口 + 状态写回 + 一帧渲染；夹具的后端是 1 ms 的 fakeSearch。
- 这个值逐次运行会有几毫秒抖动（226–234 ms），不是固定值；上表区间来自三次独立运行，
  metrics.json 只保留最近一次。
- 后端按 ordinal 升序返回（docs/development/session-search.md 第 3 节），面板要求倒序，
  所以 ordinals 是 [54 … 9]，最新命中排在最上面。
- 高亮位置来自后端的 matchStart / matchEnd（按码点），前端只切片，不重新算匹配位置。

### 3.3 点击结果 → 定位并高亮

    "jump": { "present": true, "text": "Agent 第 54 条：讨论扩散模型的采样步数与显存占用" }

点击第一条（#54）后，虚拟列表用 scrollToIndex 把第 54 条滚到视口中央，
并给它加上 data-highlight="true"（2.4 s 后自动撤销，定时器由 MessageList 在卸载时清理）。

### 3.4 三种状态与错误态

| 状态 | 触发 | 实测 |
| --- | --- | --- |
| 搜索中 | 输入已变、结果未回（防抖待触发或请求在途） | status=searching、count=搜索中… |
| 无结果 | 查询完成、命中为 0 | status=no-results、count=0 条匹配 · 扫描 60 条 |
| 空态 | 输入为空/全空白 | status=empty、不显示计数 |
| 错误 | 后端返回错误（如会话文件缺失） | status=error、count=搜索失败，正文给出后端原因 |

### 3.5 命中被 limit 截断时如实说明

    "truncated": {
      "count": "206 条匹配（已返回最早的 6 条） · 扫描 60 条",
      "notice": "命中 206 条，这里只拿到最早的 6 条；加长关键词可以把范围缩小。"
    }

### 3.6 深色主题与无障碍

    "dark": { "background": "rgb(33, 33, 33)" },
    "a11y": { "inputLabel": "搜索本会话", "metaRole": "status",
              "closeLabel": "关闭搜索", "drawerLabel": "会话搜索" }

结果数走 role="status" + aria-live="polite"：数量变化会播报，焦点不必离开输入框。
Escape 关闭抽屉（stopPropagation，不会连带关掉别的浮层）。

## 4. 已知限制

1. **命中超过 limit 时只能显示最早的一批。** search_session 只支持 afterOrdinal 向**前**翻页，
   没有「取最新一批」的能力；本切片不改 Rust，所以面板对返回的这一批做倒序，
   并用 truncated 提示说明「只拿到最早的 N 条」。彻底解决需要后端支持倒序分页。
2. **防抖取 200 ms 而不是 Issue 文本里的 250 ms。** 验收写的是「输入后 250 ms 内出结果」，
   防抖窗口本身就是「最后一次输入 → 发请求」的延迟，取 250 ms 会把这 250 ms 全部用光；
   实测 200 ms 窗口下端到端 226–234 ms（余量 16–24 ms），加上后端实测 5–9 ms 的查询耗时约 240 ms。
   数据层文档 docs/development/session-search.md 第 7 节记录的也是 200 ms，两者一致。
   若维护者希望更大余量，把 SEARCH_DEBOUNCE_MS 调小即可（一处常量）。
3. **右侧抽屉与「会话状态」面板互斥**（一次只显示一个）。顶栏两个按钮各自「点自己开自己」，
   互斥由 App.vue 的 watch(inspectorOpen) 收口；两个 320px 抽屉并排会把正文挤到不可读。

## 5. 未验证

- **Tauri WebView2 / WKWebView / WebKitGTK 实机**：本次只有 Node 测试与浏览器夹具，
  没有在打包应用里点过搜索面板（pnpm tauri:dev 未运行）。
- **macOS / Linux**：只在本机 Windows 11 + Edge（Chromium）跑过；⌘F 走的是同一段
  ctrlKey || metaKey 判断，但没有实机验证。
- **真实 5 万条会话的端到端延迟**：夹具是 60 条内存消息，后端的 5–9 ms 查询耗时引自
  Issue #109 的 release 基准，没有在本切片重新测量。
- **读屏软件实测**：只核对了 ARIA 属性与 live region，没有用 NVDA/讲述人实际朗读。

## 6. 截图清单

| 文件 | 内容 |
| --- | --- |
| 01-light-empty.png | 空态（浅色） |
| 02-light-results.png | 输入「扩散」后的结果列表，命中词蓝色高亮，按时间倒序 |
| 03-light-jumped.png | 点击 #54 后消息被定位并高亮 |
| 04-light-searching.png | 搜索中 |
| 05-light-no-results.png | 无结果 |
| 06-light-error.png | 后端错误 |
| 07-light-truncated.png | 命中被 limit 截断时的如实说明 |
| 08-dark-results.png | 深色主题下的结果列表 |

## 相关文档

- [会话内搜索：文本缓存 + 线性扫描（数据层）](../../session-search.md)
- [多会话工作区](../../multi-session-workspace.md)
- [V4 设计 token](../../../design/UIUX/V4/DESIGN.md)
