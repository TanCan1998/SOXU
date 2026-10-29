# 会话内搜索：文本缓存 + 线性扫描（Issue #109）

抽屉里的「搜索」面板只过滤**已加载的 40 条**时，真实会话（1,235 条）会让用户以为「没有这条」。
本文件记录补上数据层后的实现、预算与证据。

## 1. 范围与非目标

| 做 | 不做 |
| --- | --- |
| 在**整份会话**里做大小写不敏感子串匹配 | 倒排索引 / 分词 / 模糊匹配 / 正则 |
| 后端给命中片段与字符偏移，前端只负责高亮 | 跨会话全局搜索（范围语义另立 Issue） |
| 两级字节预算（单会话 8 MiB、全局 24 MiB） | 结果排序策略（当前固定按 ordinal，即时间序） |
| 追加即缓存；文件被外部改写时整份重建 | 订阅文件系统事件（Pi 是文件唯一写者） |

**为什么不做倒排索引**：会话 JSONL 持续追加，倒排需要增量重建与一致性校验，
10 MiB 文本的 trigram 索引本身就要 30–50 MB；而线性扫描在毫秒级，搜索又是低频操作。
PRD 第 5 节的非目标写着「不为炫技引入无边界内存缓存」，倒排索引在 5 万事件下正好撞这条。

## 2. 分层与所有权

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 正文提取 | `crates/session-index/src/text.rs` | 一行 JSONL → 类型 / 角色 / 正文；UI 与搜索共用同一份实现 |
| 匹配与片段 | `crates/session-index/src/search/matcher.rs` | 大小写不敏感匹配、字符对齐的片段截取 |
| 单会话缓存 | `crates/session-index/src/search/cache.rs` | 指纹同步、追加、单会话预算、线性扫描 |
| 多会话缓存 | `crates/session-index/src/search/mod.rs` | LRU、全局预算、慢查询诊断、查询长度校验 |
| IPC | `apps/desktop/src-tauri/src/{commands,workspace,dto}.rs` | `search_session`：解析会话文件 → `spawn_blocking` 查缓存 → DTO |
| 前端 | `apps/desktop/src/workspace/{sessionWorkspace,search,types,bridge}.ts` | 200 ms 防抖、请求序号守卫、片段切片高亮 |

单一 owner：

- `AppState.search`（`Arc<Mutex<SearchCache>>`）是全部搜索缓存的唯一持有者，缓存的字节预算由它自己执行，
  不需要额外的清理任务或后台线程。
- 防抖定时器按会话登记在 `WorkspaceSession.searchTimers` 里，关闭 Tab / `dispose()` 时显式清理。
- 缓存只读会话文件，**绝不写回** JSONL，也不写索引快照。

## 3. 数据结构与匹配规则

```rust
pub struct SessionSearchCache {
    session: SessionId,
    path: PathBuf,
    entries: Vec<CachedEntry>, // ordinal 升序，与分页索引同源
    bytes: usize,
    fingerprint: Option<Fingerprint>, // (mtime_ms, size)
    read_position: u64,
    evict_cursor: usize,
    dropped: usize,
}
```

- **序号对齐**：空行不产生条目、超长行产生「无正文条目」、损坏行产生「无正文条目」——
  与 `SessionLog` 的规则完全一致，因此 `ordinal` 可以直接用于翻页定位。
- **大小写不敏感**：查询含大小写字符时折叠后滑窗匹配，纯中文/数字查询走零分配的原样子串匹配。
- **片段**：命中位置前后各 40 个字符，边界对齐到字符（不是字节）；片段**不追加省略号**，
  否则 `match_start` / `match_end` 会与文本错位。
- **单条上限**：一条条目最多统计 20 次命中，避免一条超长工具输出刷屏。
- **结果顺序**：按 ordinal 升序；`after_ordinal` 用于分页，`total_hits` 与分页无关（翻页不改变「共 N 条」）。

## 4. 预算（硬约束）

| 项 | 上限 | 超出行为 |
| --- | --- | --- |
| 单会话缓存 | 8 MiB | 丢**最旧**条目的正文（条目保留，序号不错位），结果标 `degraded` |
| 全局缓存 | 24 MiB | 淘汰最久未使用的会话 |
| 单条正文 | 20,000 字符 | 只留前 200 字符 + `truncated: true` |
| 单次查询 | 50 ms | 记一条诊断事件（`eprintln!` + `SearchCache::take_diagnostics`），不静默变慢 |
| 查询长度 | 200 字符 | 返回 `E_SEARCH_QUERY_TOO_LONG` |
| 单次返回 | 50（默认）/ 200（硬上限） | `truncated: true` 表示还有下一页 |

为什么单会话超预算时丢的是**最旧**正文：会话是追加写的，用户搜的几乎总是最近的内容；
丢最旧的能让「刚发生的事情」始终可搜，同时用 `degraded` 如实告诉界面结果可能不完整。
（另一种做法是停止缓存新条目，但那会让最新的内容永远搜不到，比缺结果更糟。）

## 5. 一致性：追加不重建

`sync()` 只看 `(mtime_ms, size)` 两个事实，按顺序判定：

| 现象 | 判定 | 处理 |
| --- | --- | --- |
| 没有指纹 | 首次 | 整份建立缓存 |
| `size` 变小 / `mtime` 倒退 | 截断、替换、时钟回拨 | 整份重建 |
| `size` 相同但 `mtime` 变了 | 外部等长改写 | 整份重建（内容已不可信） |
| `size` 变大 | 追加 | 只解析新增字节，**不重建** |
| 完全一致 | 无变化 | 什么都不做 |

未以 `\n` 结束的尾部留在缓冲区，等 Pi 写完再解析——**半个 JSONL 行永远不会成为条目**。
单行超过 8 MiB 只记行起点（不缓冲正文），保证序号仍与索引对齐。

`mtime` 精度不足（例如某些网络文件系统只到秒）时，「等长改写」可能漏判；
这种情况仍会被后续的 `size` 变化或截断检测纠正，属于已知限制而非静默错误。

## 6. IPC 契约

| 命令 | 参数 | 返回 |
| --- | --- | --- |
| `search_session` | `sessionId, query, limit?, afterOrdinal?` | `SessionSearchResult` |

```ts
interface SessionSearchResult {
  sessionId: string;
  hits: { ordinal: number; kind: EntryKind; role: EntryRole | null;
          snippet: string; matchStart: number; matchEnd: number;
          totalMatches: number; truncated: boolean }[];
  totalHits: number;      // 会话内命中条目总数（与 limit / 分页无关）
  scannedEntries: number;
  truncated: boolean;     // 命中数超过 limit
  degraded: boolean;      // 缓存因预算丢了正文，结果可能不完整
  tookMs: number;
  rebuilt: boolean;       // 本次是否重建了缓存（验收用）
}
```

边界行为：空查询（含全空白）返回空结果**而不是错误**；超过 200 字符返回
`E_SEARCH_QUERY_TOO_LONG`；未登记的会话返回「会话未登记」；未绑定文件的临时会话返回
「还没有绑定 Pi 会话文件」。

## 7. 前端

- `WorkspaceSession.search(sessionId, query, options?)`：一次调用一次 IPC，结果写进 `tab.search`。
- `WorkspaceSession.scheduleSearch(...)`：200 ms 防抖，只保留最后一次查询；定时器在
  `closeTab` / `dispose` 时清理。
- 请求序号 `search.seq`：迟到响应（用户已经改了查询）整条丢弃，不覆盖新结果。
- 超长查询在前端先拦（与后端同一上限），不发注定失败的请求。
- `splitSnippet(snippet, matchStart, matchEnd)`：按**码点**切片高亮，前端不重新计算匹配位置；
  偏移越界时夹到边界，不让一颗坏数据把面板打崩。
- 面板组件由 Issue #118 交付：`components/SearchDrawer.vue`（抽屉 + 搜索框 + 结果数 + 三态）
  与 `components/searchPanel.ts`（状态判定、倒序、按 ordinal 定位、计数口径）。
  抽屉只渲染状态，**不自带定时器**：防抖仍只有 `WorkspaceSession.scheduleSearch` 一份，
  点击结果的定位规则（含最多 3 页的有界翻页）是 `resolveJumpTarget`，可脱离 DOM 测试。
  证据见 [issue-118-search-drawer](evidence/issue-118-search-drawer/README.md)。
- 命中超过 `limit` 时后端只返回**最早**的一批（`afterOrdinal` 只能向前翻页），
  面板因此对这一批做倒序并用 `truncated` 如实说明；倒序分页需要后端支持，属后续切片。

## 8. 验收证据

命令与环境（Windows 11 / Rust 1.99.1 / Node 26.10.0 / pnpm 12.15.0）：

| 验收点 | 证据 | 结果 |
| --- | --- | --- |
| 1,235 条会话搜「扩散」返回全部命中 | `cargo test -p soxu-session-index --test search_cache finds_every_hit_not_only_the_first_page`；`cargo test -p soxu-desktop --test search_bridge` | `total_hits = 206`（每 6 条命中一次），首屏 200 条 + 翻页 6 条 |
| 50,000 条 / ≈10 MiB：建缓存 < 400 ms，查询 < 50 ms | `cargo test --release -p soxu-session-index --test search_perf -- --ignored --nocapture` | 文件 11,866,390 B、50,001 条：**建缓存 96–135 ms**、**查询 5–9 ms**（5 次采样），缓存 6,191,338 B |
| 常驻内存 ≤ 24 MiB | 同上 + `budget_evicts_oldest_text_and_reports_degraded`、`global_budget_evicts_least_recently_used_session` | 单会话 6.19 MiB；多会话超全局预算时淘汰最久未使用的会话 |
| 追加 100 条后命中新条目且不重建 | `appends_new_entries_without_rebuilding` | `rebuilds() == 1`、`appends() == 1`，10 条新命中 |
| 文件被外部改写后不返回已删除内容 | `rewritten_file_drops_removed_content`、`equal_size_rewrite_is_detected_by_mtime` | 旧关键词 0 命中，新关键词 1 命中 |
| 超大条目只返回截断片段并标记 | `oversized_entry_is_truncated_and_flagged` | `truncated = true`，片段来自前 200 字符 |
| 空查询 / 无命中 / 超长查询有明确行为 | `empty_and_overlong_queries_have_explicit_behaviour`、`search_limits_and_boundary_inputs_are_explicit` | 空查询空结果；超长返回 `E_SEARCH_QUERY_TOO_LONG` |
| `cargo test --workspace` + `pnpm --filter @soxu/desktop check` | 见第 9 节 | 通过 |
| 前端防抖：快速输入只发 1 次请求 | `node --test apps/desktop/tests/sessionSearch.test.ts` | 3 次输入 → 1 次 `searchSession` |

复现命令：

```powershell
cargo test -p soxu-session-index --test search_cache
cargo test -p soxu-desktop --test search_bridge
cargo test --release -p soxu-session-index --test search_perf -- --ignored --nocapture
cd apps/desktop; node --test tests/sessionSearch.test.ts
```

## 9. 未验证

- **Tauri WebView2 / WKWebView / WebKitGTK 实机**：本 Issue 只有单元/集成测试与离线夹具；
  面板组件已在 Issue #118 接线，但仍没有在打包应用里点过（见
  [issue-118-search-drawer](evidence/issue-118-search-drawer/README.md) 第 5 节）。
- **macOS / Linux**：只在本机 Windows 11 跑过；`mtime` 精度与文件系统行为未跨平台验证。
- **真实 10 MiB 会话**：性能基线用的是合成会话（每行结构真实、正文为占位文本）。
- **慢查询诊断的上报路径**：目前写 `eprintln!` 与内存诊断环形缓冲，还没有接入监控面板。

## 相关文档

- [会话目录与 JSONL 索引契约](../architecture/session-catalog.md)
- [多会话工作区](multi-session-workspace.md)
- [长会话虚拟列表与 5 万事件回归](long-session-virtual-list.md)
- [产品需求文档 P-04](../product/prd.md)
