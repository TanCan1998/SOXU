# 长会话虚拟列表与 5 万事件回归（Issue #36 / P-04）

本文件记录**已实现**的有界分页、窗口化缓存、虚拟列表与长输出处理，以及 50,000 条事件离线夹具
的实测数字。它区分「离线夹具结果」「Chromium 开发服务器结果」和「实机验收」——后两者不是同一件事，
未做的部分单列在「未验证」。

依赖：[会话目录与 JSONL 索引契约](../architecture/session-catalog.md)、
[多会话工作区](multi-session-workspace.md)。

## 1. 范围与非目标

范围内：

- 三道内存边界：服务端分页预算、前端 Tab 窗口上限、单条正文上限；
- 虚拟列表（`@tanstack/vue-virtual`）只渲染视口内的行；
- 长工具输出的折叠与截断标记；
- 50,000 条事件的离线夹具、可重复的内存采样与 DOM 规模采样。

非目标：

- 不做尾部分页（`offset` 仍从最早一条开始，见第 6 节）；
- 不做消息搜索、跨会话跳转定位；
- 不引入新的运行时依赖，不改动 `agents/policies/` 与版本基线。

## 2. 三道边界

| 层 | 上限 | 位置 | 作用 |
| --- | --- | --- | --- |
| 索引分页 | 每页 ≤ 200 条、≤ 1 MiB、单条 > 256 KiB 只给占位 | `crates/session-index/src/index/page.rs` | 一次 IPC 不会拖出巨型输出 |
| 分页预览 | 每条 ≤ 240 字符 + `…` | `crates/session-index/src/entry.rs` | 列表元数据保持有界 |
| 正文补齐 | 每次 ≤ 40 条、单条 ≤ 256 KiB 读取、≤ 20,000 字符 | `apps/desktop/src-tauri/src/entry_text.rs` | 完整正文按需读取且可截断 |
| Tab 窗口 | ≤ 240 条历史、≤ 120 条实时、≤ 2,000,000 历史字符 | `apps/desktop/src/workspace/types.ts` | 「加载更多」与多轮实时对话都不会把会话读进内存 |
| 单条正文 | ≤ 20,000 字符（按码点，UTF-8/代理对安全） | `workspace/mapping.ts` `capText` | 一条超长工具输出或流式输出不会撑爆状态 |

前端分页大小仍是 `HISTORY_PAGE_SIZE = 40`：首屏只请求一页、只补齐这一页的正文。

### 窗口如何释放

`enforceMessageWindow` 有**两个调用点**，覆盖缓存的两条增长路径：

| 调用点 | 触发时机 | 说明 |
| --- | --- | --- |
| `mergeHistory` | 合并一页历史后 | 「加载更多」不会把整份会话读进内存 |
| `sendPrompt` / `applyStream` | 每次**新增**一条实时消息后 | 多轮对话不会绕过上限；流式增量合并同一行，不重复扫描 |

释放顺序固定：

1. 先释放**最旧**的历史消息，直到条数与字符预算都满足；
2. 再释放最旧的实时消息，但**永不释放**正在流式的最后一条；
3. `history.loaded` 只统计**仍在内存里**的历史条数，历史释放累加到 `history.evicted`，
   实时释放累加到 `history.evictedLive`（两者分开，避免把实时释放误当成历史释放）。

界面上会显示「更早的 N 条已从内存释放，Pi 的会话文件未受影响」——释放的是内存窗口，
不是用户数据；`open_session_history` 随时可以重新读取同一批条目。实时释放同样如此：
Pi 已经把对话写进 JSONL，重新加载历史就能看到。

> **回归背景**：这一版之前，实时追加路径没有调用 `enforceMessageWindow`，300 轮对话后
> 实测保留 600 条实时消息（`evictedLive` 恒为 0），与本节声明的有界窗口矛盾。现在两条路径
> 都会收敛，用例 `实时追加路径同样有界` 与内存检查点 `live-300-rounds` 一起守住这个不变量。

## 3. 虚拟列表

- 参数集中在 `apps/desktop/src/components/messageVirtualizer.ts`（估算行高 96px、overscan 6 行、
  贴底阈值 120px），组件与回归测试共用同一份数值。
- 行高由 `measureElement` 实测，流式追加导致的高度变化不会让滚动位置漂移。
- **本轮修复的真实缺陷**：Vue 在元素进入布局**之前**就调用 `ref` 回调，此时 `offsetHeight` 为 0；
  tanstack 的默认 `measureElement` 会把 0 写进尺寸缓存，并在后续无 `ResizeObserverEntry` 的调用中
  **直接返回缓存值**，于是 0 永远不会自愈：所有行叠在 `translateY(0)`、画布高度远小于真实内容、
  滚动条长度错误。
  修复：测量推迟到 `nextTick`，并且只测量高度大于 0 的元素；若这一帧还没布局，下一帧再试一次，
  仍为 0 就保留估算行高（列表照常可用，只是不够精确）。
- 底部跟随只在「距底部 < 120px」时触发，用户向上翻历史时不会被新消息强行拉回底部。

## 4. 长输出处理

| 情况 | 行为 |
| --- | --- |
| 工具输出 > 360 字符 | 折叠为 `<details>`，展开才看全文 |
| 单条正文 > 20,000 字符 | 后端截断并返回 `clipped`，前端再兜底 `capText`，界面标记「正文超过单条上限，已截断」 |
| 单条条目 > 256 KiB | 索引只返回占位视图（`oversized`），不读取正文，不伪造内容 |
| 流式增量累计超过 20,000 字符 | 到顶后丢弃后续增量并标记 `truncated`，避免每个 token 重新切片 20k 字符 |

## 5. 复现命令与实测结果

### 5.1 离线回归（无需 Pi、无需外网）

```powershell
pnpm --filter @soxu/desktop test   # 含 tests/longSession.test.ts 的 6 个用例
```

夹具在 `apps/desktop/tests/support/longSession.ts`：50,000 条条目、每 10 条一条 20,000 字符的
工具输出、预览 240 字符、条目字节数贴近 Rust 索引口径，全部确定性生成，不含任何真实会话内容。

用例覆盖的不变量：

| 用例 | 断言 |
| --- | --- |
| `首屏只加载一页` | 只发 1 次 `fetchHistory(0, 40)`、1 次 `fetchTexts`（≤ 40 条）；首屏正文远小于整份会话 |
| `虚拟列表：渲染行数只随视口高度变化` | 用组件同一份参数驱动 `Virtualizer`：1080px 视口行数 ≤ 估算上界，12 条消息时不超额渲染 |
| `持续加载更多：历史缓存被窗口截住` | 加载 12 页后历史条数 ≤ 240、字符 ≤ 2,000,000，`loaded + evicted = 累计加载` |
| `字符预算` | 10 条 20,000 字符消息在 100,000 字符预算下被释放到预算内 |
| `长输出与超长流式增量都被单条上限截断` | 流式累计 80,000 字符后正文停在 20,000 + `truncated` |
| `实时追加路径同样有界` | 300 轮真实 `sendPrompt`+`stream`+`settled` 后实时消息停在 120 条、`evictedLive` = 480、最新一轮仍在窗口内 |
| `窗口释放永不丢弃正在流式的最后一条消息` | 200 条实时消息压到 20 条时，最后一条流式消息保留 |

### 5.2 内存采样

```powershell
cd apps/desktop
pnpm perf:long-session                                  # 只看数字
pnpm perf:long-session --full-control --out ../../docs/development/evidence/m2-long-session/long-session-memory-windows.json
```

本机实测（Windows 11 / 10.0.26300 / Node v26.10.0 / V8 堆，2026-10-29）：

| 检查点 | heapUsed | rss | 内存里保留的消息 |
| --- | --- | --- | --- |
| 基线 | 8.6 MiB | 79.1 MiB | 0 |
| 首屏（1 页） | 8.9 MiB | 77.7 MiB | 40 条 / 84,320 字符 |
| 翻 25 页后 | 9.8 MiB | 89.7 MiB | 240 条 / 505,920 字符（已释放 760 条） |
| 关闭 Tab 后 | 8.8 MiB | 89.3 MiB | 0 |
| 300 轮实时对话 | 9.1 MiB | 89.9 MiB | 160 条（历史 40 + 实时 120，已释放 480 条实时） |
| 对照：保留全部 50,000 条预览 | 218.9 MiB | 349.7 MiB | 50,000 条 / 6,605,000 字符 |
| 对照：保留全部 50,000 条完整正文 | 218.7 MiB | 563.5 MiB | 50,000 条 / 105,400,000 字符 |

后端读取量：25 次分页、1,000 条条目、2,108,000 字符——从未读取整份 5 万条。

### 5.3 DOM 规模（Chromium 开发服务器）

```powershell
pnpm --filter @soxu/desktop dev   # 另开一个终端
moli fetch --layout --wait-selector ".virtual-row" --eval-file tests/harness/measure-dom.js "http://127.0.0.1:1420/tests/harness/long-session.html?count=50000"
moli fetch --layout --wait-selector ".virtual-row" --eval-file tests/harness/measure-dom.js "http://127.0.0.1:1420/tests/harness/long-session.html?count=50000&scroll=end"
```

1920×1080 视口实测（2026-10-29）：

| 场景 | 渲染行数 | 整页 DOM 节点 | 行索引范围 | 画布高度 |
| --- | --- | --- | --- | --- |
| 240 条（应用真实窗口），顶部 | 15 | 89 | 0..14 | 23,695px |
| 50,000 条，顶部 | 15 | 89 | 0..14 | 4,800,660px |
| 50,000 条，滚到底部 | 17 | 99 | 49,983..49,999 | 4,800,000px |

结论：**DOM 规模与消息总数无关**，只取决于视口高度与行高；滚到底部时渲染的是尾部条目。

原始数据见 `docs/development/evidence/m2-long-session/`。

## 6. 已知限制

1. **分页方向是「从头往后」**：`open_session_history` 的 `offset` 是条目序号，首屏拿到的是最早的
   40 条，按钮因此写作「加载更多历史」而不是「加载更早」。打开 5 万条会话时看到的不是最新一屏，
   这是下一步要改的行为（需要后端提供 `prev`/尾部分页），本轮没有实现。
2. **窗口释放后不能往回滚**：被释放的更早消息只能通过关闭并重新打开 Tab（重新从第 0 页加载）
   或后续实现尾部分页来找回；释放数量会在界面与检查器里如实显示（历史记 `evicted`，
   实时记 `evictedLive`）。实时消息被释放后，重新加载历史仍可读到——Pi 已把它写进 JSONL。
3. 窗口上限（240 条 / 2,000,000 字符）是工程取值，不是实测标定出来的最优值；后续应按 P-07
   的同条件采样再校准。
4. 夹具行高分布比真实会话窄：真实会话里长工具输出、混排文本的行高差异更大，实测行数会略有出入。

## 7. 未验证（不得据此宣称实机通过）

- **Tauri WebView2 / WKWebView / WebKitGTK 的实测**：上面的 DOM 数字来自 Chromium 开发服务器
  夹具页，内核与桌面端不同；WebView 进程 RSS、滚动帧率、合成层内存都未测。
- **macOS / Linux**：完全未验证。
- **真实 Pi 会话**：夹具是确定性生成的，没有跑过真实的 5 万事件 JSONL（也没有这样的真实会话）。
- **滚动性能**：没有采样 FPS / 长任务，只验证了 DOM 规模与索引范围。
- **无障碍**：`role="log"`、`aria-live="polite"` 保留，但屏幕阅读器在长列表下的表现未验证。

## 相关文档

- [多会话工作区](multi-session-workspace.md)（分页与正文补齐的原始契约）
- [会话目录与 JSONL 索引契约](../architecture/session-catalog.md)
- [首版能力和已知限制](limitations.md)
- [性能与资源采样说明](../../tests/performance/README.md)
