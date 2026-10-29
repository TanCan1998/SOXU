# SOXU 持久化方案调研

> 调研时间：2026-10-29 · 基线 dev `6cc0f51`
> 结论先说：**配置与目录元数据继续用 JSON；SQLite 只在"跨会话检索"真正开工时，作为可丢弃的派生索引引入，绝不作为事实源。**

## 1. 现状

### 1.1 SOXU 自己写的东西

| 位置 | 文件 | 内容 | 量级 |
|---|---|---|---|
| `app_data_dir()` | `catalog.json` | `CatalogSnapshot`：项目 / 工作树 / 会话引用 | 34 项目 × ~7 会话 → 估 100–300 KB |
| 仓库内 `.soxu/` | `policy.json`、`agent-models.json`、`model-settings.json`、`checkpoints/*.json`、`intake/*.json`、`runner/*.log` | Agent Loop 的配置与检查点 | 实测 66 文件 / **120.8 KB** |

写入方式：`crates/session-index/src/store.rs` 的 `write_atomic`
—— temp 文件 + `sync_all` + rename（Windows 上带 4 次重试，因为 rename 不能覆盖已存在文件）。
读取容错：`read_json` 失败或 schema 不匹配时**退回默认值并重建**。

### 1.2 设计前提：快照是可丢弃的缓存

`snapshot.rs` 开头写着：

> 快照是可丢弃的缓存：任何不一致都应重建索引，而不是让 UI 看到错误历史。

配套的 `RebuildReason` 枚举：`Truncated` / `Replaced` / `SnapshotSchemaMismatch` / `SnapshotCorrupt` / `Manual`。
也就是说**现在的持久化不承担"数据正确性"责任**——错了就重扫。这是很重要的简化。

### 1.3 不属于 SOXU 的数据

会话正文是 Pi 的 JSONL，SOXU 只读索引、从不写回（`catalog.rs` 注释明确写了）。
临时会话只在内存里，**永不序列化**（`catalog.rs:94`）。

### 1.4 真实数据规模（本机实测）

```
~/.pi/agent/sessions
  jsonl 文件数   235
  总大小         305.6 MB
  最大单文件     26.1 MB
  中位数         359 KB
  项目目录数     34
```

**关键判断**：大的是 Pi 的 JSONL（305 MB），不是 SOXU 的状态（< 1 MB）。

## 2. SQLite 能买到什么

| 需求 | JSON 现状 | SQLite 收益 |
|---|---|---|
| 目录元数据（项目/会话/工作树） | 全量读入，几百 KB | 几乎为零——数据太小，索引开销大于收益 |
| **单会话内搜索**（Issue #109） | 内存缓存 + 线性扫描 | 无——最大 26 MB，扫描 10–30 ms |
| **跨会话搜索**（305 MB） | 不可能（要么全读要么不做） | **FTS5 是正解** |
| 用量/费用按时间聚合 | 只能遍历 JSON | SQL 聚合很自然 |
| 会话按项目/日期/角色筛选 | 前端过滤 | 索引查询 |
| 崩溃安全 | temp+rename 已足够 | WAL 更稳，但当前也不丢数据 |
| Schema 演进 | 版本号不匹配就重建 | **需要写迁移** |

## 3. SQLite 的代价

1. **事实源化风险**：一旦 SQLite 存了"只有它知道"的数据，就不能再"错了就重建"。现在的 5 个 `RebuildReason` 全部失效，得改成迁移体系。
2. **迁移负担**：每加一列/改一类型都要迁移脚本 + 兼容旧库 + 回滚方案。JSON 只要 bump `CATALOG_SCHEMA_VERSION`。
3. **跨进程写冲突**：Agent Loop 写仓库内 `.soxu/`，桌面端写 `app_data_dir`。若共用一个库，会撞 `database is locked`（WAL 也只能缓解）。
4. **体积**：`rusqlite` bundled 约 +1.2 MB 二进制；305 MB JSONL 的 FTS5 索引约为原文 1.5–3 倍 → **450–900 MB**，直接违反"资源占用优先"。
5. **可检修性**：JSON 出问题用记事本就能看；SQLite 出问题要工具。

## 4. 横向参考：PiDeck 怎么做的

PiDeck 依赖里有 `sql.js`（SQLite WASM），但**只用在检索通道**：

```
XueIndexService.ts   → 优先 native sidecar（Go），失败回退 sql.js
XuePromptManager.ts  → "sql.js WASM（逐次全库加载，语义完全相同，作为 sidecar 缺失/失败时的兜底）"
```

**它的应用状态持久化仍是 `durableJsonStore`**（atomic write + backup + CAS + file lock），不是 SQLite。

即：**PiDeck 把 SQLite 当"索引"，不当事务存储**。这和 SOXU 应有的取舍一致。

## 5. 建议方案

### 5.1 保持不动（JSON + 原子写）

- `catalog.json`、`policy.json`、`agent-models.json`、`model-settings.json`
- `checkpoints/*.json`、`intake/*.json`

理由：总量 < 1 MB，可丢弃、可重建、可人肉检修。SQLite 在这个量级是纯负担。

### 5.2 单会话搜索（Issue #109）：维持内存缓存 + 线性扫描

最大 26 MB / 典型 359 KB，线性扫描 10–30 ms。**不需要 SQLite。**

### 5.3 跨会话搜索（未来，未开工）：SQLite FTS5 作为派生索引

真要做时，按这几条硬约束：

| 约束 | 值 |
|---|---|
| 库文件 | `app_data_dir()/index.sqlite`，与 `catalog.json` 并列 |
| 地位 | **派生索引**，删掉整个文件不丢任何数据（下次重建） |
| 范围 | 按项目分库或按项目建表，不默认全量索引 305 MB |
| 预算 | 索引体积上限 = 被索引文本的 2 倍；超出停止索引并记诊断 |
| 写入者 | 只有桌面端主进程；Agent Loop 不碰这个库 |
| 触发 | 用户显式开启跨会话搜索时才建；不后台偷跑 |
| 依赖 | `rusqlite` + `bundled` + WAL，单连接专用线程（或 `tokio-rusqlite`） |
| 可删 | 提供"重建索引"按钮 = 删库 + 重扫 |

### 5.4 明确不做

- 用 SQLite 存会话正文（Pi 的 JSONL 是唯一事实源）
- 用 SQLite 存配置/策略（需要人肉可读 + git diff）
- 用 SQLite 存检查点（Loop 要能在无 DB 环境下跑）

## 6. 判定规则

以后遇到"要不要上 SQLite"，用这三条筛：

1. **数据量**：< 10 MB 且读全量能接受 → 不用 SQLite
2. **可重建性**：如果删掉它会导致信息永久丢失 → 不能是 SQLite（要么是事实源，要么别用）
3. **写入者**：有多个进程/多个写入者 → 先解决所有权，再谈 SQLite

## 7. 结论

- **现在不上 SQLite。** 状态 < 1 MB、搜索最大 26 MB，JSON + 内存扫描都够。
- **跨会话搜索开工时上 SQLite FTS5**，但定位是"可删除的派生索引"，与 `catalog.json` 并列、由桌面端独占写。
- 现有"快照可丢弃"的设计要保住——它是 SOXU 简单性的来源，SQLite 化会把它换成迁移体系。
