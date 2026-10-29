# 会话目录与 JSONL 索引契约

本文件是 `crates/session-index`（crate `soxu-session-index`）的对外契约：**身份关系**、**错误码**、
**持久化布局**与**恢复路径**。实现如与本文件冲突，以本文件为准并同步修改实现或先更新本文件。

## 边界

- Pi 拥有会话文件、格式与写入权；本 crate **只读** JSONL，从不写回、从不移动或删除用户的会话文件。
- 运行中的 Pi 进程不与会话文件强绑定：文件可能被重命名、迁移、截断；进程可能早于或晚于文件存在。
- 索引是可丢弃的缓存。任何不一致都选择重建，而不是把错误历史展示给 UI。
- **隐式扫描有路径边界**：只有解析（`canonicalize`）后仍位于会话根目录内的 `.jsonl` 才进入索引。
  指向根目录之外的符号链接 / 目录联接会被拒绝并列入 `SyncReport::rejected_paths`，
  文件原样留在磁盘上。非默认布局用 `attach_session_file` 显式登记——那是用户主动选择，
  不受隐式扫描边界限制（见[越权与敏感信息回归](../development/security-regression.md)）。

## 身份关系

```
ProjectId (项目根目录)
  └── WorktreeId (工作树路径, 1..N)
        └── SessionId (Pi 会话, 1..N, 跨重启稳定)
              └── RuntimeLink (runtimeId + generation, 0..1, 临时)
```

| 身份 | 前缀 | 派生方式 | 稳定性 |
| --- | --- | --- | --- |
| `ProjectId` | `prj_` | 规范化根路径的 FNV-1a 指纹 | 跨重启稳定；仅当项目目录换路径才变化 |
| `WorktreeId` | `wkt_` | `projectId` + 规范化工作树路径 | 跨重启稳定；**切换分支不改变** |
| `SessionId` | `ses_` / `ses_l_` | Pi 会话头部 `id`；无 id 的旧会话用头部行字节指纹 | 跨重启、**重命名与迁移后仍稳定** |
| `SessionId`（临时） | `ses_tmp_` | 目录分配的内存序号（见「临时会话与转正」） | **仅本进程**；不持久化，重启即消失 |
| `RuntimeId` | `rt_` | 由 Supervisor 分配 | **不持久化**，重启后不复用 |
| `generation` | — | 每次挂载递增的水位 | 单调递增，用于丢弃迟到事件 |

### 路径规范化

身份比较前统一走 `normalize_path`：反斜杠转正斜杠、去掉尾部斜杠、空路径视为 `/`；
Windows 下再折叠为小写。注册项目与工作树时先 `canonicalize`，再用 `strip_verbatim` 去掉
Windows 的 `\\?\` 前缀，保证 ID 与 Pi 会话目录命名使用同一份可读路径。

### SessionId 的具体规则

1. 会话文件已有登记记录（按路径命中）→ 沿用原 `SessionId`。
2. 否则取头部行 `id`，满足「非空、≤64 字节、仅 `[A-Za-z0-9._-]`」→ `ses_<id>`。
   不满足（含路径穿越字符、超长、非 ASCII）→ 退化为头部哈希，绝不内联到文件名或日志。
3. 头部没有 `id` 的旧会话 → `ses_l_<头部行指纹>`。
4. 以上都不成立 → `ses_l_<指纹>`，并在扫描报告里记 `HeaderMissing` 告警。

因此「文件重命名」只更新 `SessionRecord.file`，不产生新身份；若同一 `SessionId` 同时以两个
**都存在**的文件出现，不做静默合并，而是记 `E_SESSION_PATH_CONFLICT` / 报告 `duplicates`。

### 运行时归属

- 同一会话最多一个可写运行时：`claim_writable` 在已有其他 `RuntimeId` 持有时返回
  `E_SESSION_ALREADY_OWNED`，用错误而不是静默接管来防止双写 JSONL。
- 进程退出：`release` 校验持有者一致，然后清空 `runtime` 并把 `generation_watermark` 抬到
  `generation + 1`；崩溃遗留的挂载在**打开目录时**统一清理（`ProjectCatalog::open_with`，
  见 `recovered_stale_runtimes()`），水位同样递增；`release_stale_runtime` 保留为单个会话的显式入口。
  不在打开时清理就会留下「幽灵运行时」：上一进程的 Pi 已经不存在，UI 却仍显示运行中，
  旧 generation 的事件也还有机会被放行。
- 迟到事件：`event_allowed` / `guard_event` 按 `(session, runtime, generation)` 三元组过滤，
  不匹配即 `E_STALE_RUNTIME_GENERATION`。**重启后旧 generation 永不复用**，所以 UI 不会把
  上一代进程的工具结果画到新会话上。
- 归属与水印在 `sync` 时随既有记录保留，不因一次扫描丢失。

## 临时会话与转正

临时会话是「默认不进入持久化历史」的会话视图，用于一次性对话。它的登记**只存在于内存**
（`TemporaryRegistry`），`save()` 不写它，因此崩溃、断电或正常退出后都不会出现幽灵历史。

| 动作 | API | 行为 | 失败时 |
| --- | --- | --- | --- |
| 创建 | `open_temporary_session(project, worktree?)` | 分配 `ses_tmp_*` 身份，只进内存表 | 项目/工作树未登记、超出上限（`MAX_TEMPORARY_SESSIONS = 32`） |
| 绑定 | `bind_temporary_file(session, file)` | 绑定一个合法 Pi 会话文件；绑定期间 `sync` 跳过它 | 非 `.jsonl`、首行不是 Pi 会话头部、版本为 0、文件已是普通会话落点或已被别的临时会话绑定 |
| 归属 | `claim_temporary_writable(session, runtime)` / `release_temporary_writable(...)` | 声明/释放该临时会话的可写运行时（只存内存，不落盘） | 已有其他 runtime 持有时 `E_TEMPORARY_SESSION_RUNTIME_ACTIVE`；释放者与持有者不符时 `E_SESSION_RUNTIME_UNKNOWN` |
| 转正 | `promote_temporary_session(session)` | 走 `upsert_session` 写入历史，身份改为 Pi 头部 id | 未绑定文件、身份冲突、**仍有运行时持有**；不写入任何东西，临时会话保留 |
| 结束 | `discard_temporary_session(session)` | 清内存登记与该文件的索引快照 | 未登记时 `E_TEMPORARY_SESSION_UNKNOWN`；**仍有运行时持有**时 `E_TEMPORARY_SESSION_RUNTIME_ACTIVE` |

规则：

1. **默认不进入历史**：临时会话不出现在 `sessions(project)`、`list_projects` 或侧栏里；
   打开它的历史返回空页，而不是「会话未登记」错误。
2. **绑定即隔离**：绑定到临时会话的文件在扫描时被跳过（`SyncReport::temporary_skipped`），
   所以「临时对话」不会在重启后变成普通历史。转正后绑定解除，文件才作为普通会话出现。
3. **显式转正**：只有用户显式请求且文件已绑定才写历史；失败保留临时会话与内容，
   错误文本带稳定错误码供 UI 显示原因。UI 不得在后端未确认前显示「已保存」。
4. **不碰 Pi 的文件**：转正、结束都不移动、不删除、不改写 JSONL；结束只清可丢弃的索引快照。
5. **有界**：内存表上限 32，超出返回 `E_TEMPORARY_SESSION_LIMIT`，不会无限增长。
6. **可写归属先于转正**：临时会话启动运行时同样登记可写归属（与持久化会话的 `claim_writable` 同语义，
   只是存在内存里）。只要有 Pi 持有它，转正与结束都必须被拒绝——否则旧进程会失去 owner
   （「停止」变成 no-op 假成功，进程直到自己退出才被回收），转正后再启动还会对同一 JSONL 双写；
   结束则会解除绑定，文件可能被下一次扫描当成普通会话（幽灵历史）。
   正确顺序：停止运行时（释放归属）→ 再转正或结束。

## 持久化布局

```
<state_dir>/
  catalog.json                 目录元数据（CatalogSnapshot, schema = 1）
  indexes/<file_key>.json      每个会话文件的索引快照（IndexSnapshot）
```

- 两者都走 `write-temp + fsync + rename` 原子替换；Windows 上 rename 不能覆盖时会先移除再重试。
- `file_key` 由**文件路径**派生（不是 SessionId），因此重命名后旧快照自然不命中；
  命中的快照还要通过自校验（`schema`、`head_len ≤ 4096`、偏移单调且不超过 `indexed_bytes`）。
- `catalog.json` 损坏或 schema 不匹配 → 目录从空开始重建并置 `load_warning()`，磁盘会话文件不受影响。

Pi 会话目录命名规则（默认布局，`SOXU_PI_SESSIONS_DIR` 可覆盖根目录）：

```
<root>/--<去掉前导分隔符、把 / \ : 换成 - 的绝对路径>--/<name>.jsonl
```

例如 `/home/user/project` → `--home-user-project--`，`F:\workplace\pi` → `--F--workplace-pi--`。
布局变化时用 `attach_session_file` 显式登记，不猜测。

## 索引与分页契约

扫描（`SessionLog::refresh`）：

- 以 64 KiB 分块推进，只保存每行的 `offset` / `len` / `kind` / `role` / `flags`，不保留正文。
- 未以 `\n` 结束的尾部进入 `pending`，等 Pi 写完再索引——**半个 JSONL 行永远不会成为条目**。
- 单行超过 8 MiB 进入跳过模式：只记录长度与 `OversizedLine` 告警，不缓冲正文。
- 读到 EOF 后若写者仍在追加，最多再追 8 轮，不会无限自旋。
- 非法 JSON 或非 UTF-8 行标记 `FLAG_CORRUPT` 并继续扫描，不中断整个文件。
- 告警有界（`MAX_WARNINGS = 64`），超出只累计计数。

分页（`SessionPage` → `EntryPage`）：

| 参数/字段 | 契约 |
| --- | --- |
| `offset` | **条目序号**（0 起），不是字节偏移 |
| `limit` | 钳制到 `1..=200`（`MAX_PAGE_ENTRIES`） |
| `max_bytes` | 钳制到 `1..=1 MiB`（`MAX_PAGE_BYTES`） |
| `next` | 下一页起始序号；`None` 表示到底 |
| `bytes_read` | 本页实际从磁盘读取的字节数，用于验证有界性 |
| `clipped` | 因字节预算提前截断 |

两条保证分页一定前进：**页的第一条条目不受字节预算限制**（否则调用方按 `next` 重试会原地打转）；
超过 `INLINE_ENTRY_BYTES`（256 KiB）的条目只返回占位视图，不读正文。`offset > total` 返回
`E_PAGE_OUT_OF_RANGE`；`offset == total` 返回空页而不是错误。

目录级入口 `ProjectCatalog::page_session` 把三者串起来：`SessionId` → 读快照 → 增量刷新 →
按页读取 → 仅在「有新条目或发生重建」时才回写快照，纯翻页不重复落盘。

所有权：`page_session` 接收 `&mut self`，与 `sync` / `save` 保持同一模型——目录是索引缓存目录的
唯一 owner，因此同一时刻只有一个写者，本层不需要额外加锁。需要并发只读分页时用
`open_session_log` + `SessionLog::page`（`&self`，可在多个线程各自持有独立 `SessionLog`）。

## 错误码

错误码是机器可读契约：**字符串值一旦发布不可更改，只能追加**。说明文字允许本地化，不属于契约。
`is_recoverable()` 表示调用方能否在不修改磁盘数据的前提下重试或回退。

| 错误码 | 触发场景 | 可恢复 |
| --- | --- | --- |
| `E_PROJECT_ROOT_MISSING` | 注册时项目根目录不存在或不可访问 | 否 |
| `E_PROJECT_ROOT_NOT_DIRECTORY` | 项目根存在但不是目录 | 否 |
| `E_PROJECT_UNKNOWN` | 项目未注册 | 否 |
| `E_WORKTREE_UNKNOWN` | 工作树不属于该项目 | 否 |
| `E_WORKTREE_PATH_MISSING` | 添加的工作树目录不存在 | 否 |

工作树记录只被**引用**更新（分支、`missing` 标记），不会因目录消失而删除会话记录；
Git 侧的枚举、创建与受确认删除见 [Git 工作树服务](worktree-service.md)。
| `E_SESSION_UNKNOWN` | 会话未登记 | 否 |
| `E_SESSION_FILE_MISSING` | 会话文件不存在（含翻页时被删除） | 是 |
| `E_SESSION_PATH_CONFLICT` | 同一 SessionId 出现在两个都存活的文件 | 否 |
| `E_SESSION_ALREADY_OWNED` | 其他运行时仍持有可写权 | 否 |
| `E_SESSION_RUNTIME_UNKNOWN` | 释放的运行时与当前持有者不符 | 否 |
| `E_STALE_RUNTIME_GENERATION` | 事件 generation 已过期 | 是 |
| `E_PAGE_OUT_OF_RANGE` | 分页 offset 超出条目总数 | 是 |
| `E_SESSIONS_ROOT_UNAVAILABLE` | 未配置 Pi 会话根目录 | 是 |
| `E_METADATA_CORRUPT` | 目录或索引快照 JSON 无法解析 | 是 |
| `E_IO_FAILURE` | 其他文件系统错误 | 否 |
| `E_TEMPORARY_SESSION_UNKNOWN` | 临时会话不在内存登记表里（已转正、已结束或从未分配） | 否 |
| `E_TEMPORARY_SESSION_LIMIT` | 临时会话数量达到上限 | 是 |
| `E_TEMPORARY_SESSION_UNPROMOTABLE` | 还没有绑定 Pi 会话文件，暂无可持久化内容 | 是 |
| `E_TEMPORARY_SESSION_FILE_INVALID` | 绑定目标不是合法 Pi 会话（扩展名/头部/版本） | 是 |
| `E_TEMPORARY_SESSION_FILE_CONFLICT` | 文件已是普通会话落点，或已被另一个临时会话绑定 | 否 |
| `E_TEMPORARY_SESSION_RUNTIME_ACTIVE` | 仍有运行时持有该临时会话（转正/结束/被别的 runtime 抢占归属） | 是 |

`CatalogError` = 稳定错误码 + 人类可读上下文 + 可选底层原因（`kind: message`），
三者都可在日志中出现，但只有错误码进入契约比较。

## 恢复路径

| 现象 | 判定 | 处理 | 证据 |
| --- | --- | --- | --- |
| 文件变短 | `file_len < 已读位置` → `Truncated` | 整体重建索引 | `truncation_rebuilds_the_index` |
| 文件被替换 | 头部 ≤4096 字节指纹变化 → `Replaced` | 整体重建索引 | `replacement_rebuilds_the_index` |
| 快照 schema 变化 | `schema != CATALOG_SCHEMA_VERSION` | 丢弃快照重建 | `snapshot_restore_avoids_rescan_and_detects_schema_mismatch` |
| 快照自相矛盾 | 偏移倒退 / 越界 | 丢弃快照重建（`SnapshotCorrupt`） | 同上 |
| 快照 JSON 损坏 | `E_METADATA_CORRUPT` | 视为无快照，重建 | `corrupt_metadata_is_rebuilt_not_fatal` |
| 目录元数据损坏 | `E_METADATA_CORRUPT` | 空目录重启 + `load_warning()` | `corrupt_metadata_is_rebuilt_not_fatal` |
| 文件被重命名 | 头/ID 命中既有身份 | 更新 `file`，保留 ID，报告 `relocated` | `renamed_session_keeps_its_id` |
| 文件被删除 | 路径不存在 | 保留记录并标 `SessionState::Missing` | `missing_session_is_retained_but_flagged` |
| 两个文件同 ID | 两处都存在 | 不合并，报重复 | `duplicate_session_header_is_reported_not_merged` |
| 会话头部 cwd 与工作树不符 | 路径比较 | 不阻断索引，报告 `cwd_mismatch` | `cwd_mismatch_is_surfaced` |
| 写入半个 JSONL 行 | 尾部无 `\n` | 留在 `pending`，不进入索引 | `partial_line_writes_are_never_indexed_twice` |
| 并发追加 | — | 分块顺序扫描，不丢不重 | `concurrent_appends_never_lose_or_duplicate_entries` |
| 快照写入被中断 | — | write-temp + fsync + rename，临时文件名唯一 | `concurrent_writes_to_one_path_stay_parseable` |
| 崩溃遗留运行时挂载 | 打开目录时 `runtime` 非空 | 清空并把水位抬到 `generation + 1` | `crash_leaves_no_ghost_runtime_and_no_temporary_history`、`restarted_app_reports_no_ghost_runtime` |
| 临时会话未绑定文件就转正 | 无绑定文件 | 返回 `E_TEMPORARY_SESSION_UNPROMOTABLE`，保留临时会话，不写历史 | `promotion_without_a_bound_file_keeps_the_temporary_session` |
| 临时会话的文件被扫描到 | 已绑定 | 跳过登记，记入 `temporary_skipped` | `bound_file_is_hidden_from_sync_until_promoted` |
| 结束临时会话 | — | 清内存登记与索引快照，Pi 文件原样保留 | `temporary_registry_is_bounded_and_discard_keeps_pi_files` |

## 验收证据

**重启后 ID 稳定**：`ids_and_index_survive_restart`、`restart_paging_reuses_persisted_snapshot`。
**并发写入**：`concurrent_appends_never_lose_or_duplicate_entries`、`pages_can_be_read_in_parallel`、
`catalog_claims_one_runtime_per_session`。
**部分 JSONL 行**：`indexes_complete_lines_and_defers_partial_tail`、
`partial_line_writes_are_never_indexed_twice`、`paging_after_append_returns_only_complete_entries`。
**索引失效重建**：`truncation_rebuilds_the_index`、`replacement_rebuilds_the_index`、
`snapshot_restore_avoids_rescan_and_detects_schema_mismatch`、`corrupt_metadata_is_rebuilt_not_fatal`。
**长会话按页查询不整文件入内存**：`catalog_pages_a_long_session_with_bounded_reads`、
`long_session_never_loads_whole_file_per_page`、`pages_are_bounded_and_report_overflow`、
`oversized_line_is_skipped_with_bounded_memory`。
**身份关系与错误码**：`error_codes_are_stable_and_specific`、`runtime_ownership_filters_stale_generations`、
`worktrees_do_not_share_sessions`、`ids_and_index_survive_restart`，加上本文件。
**临时会话生命周期**：`temporary_session_never_enters_persisted_history`、
`bound_file_is_hidden_from_sync_until_promoted`、`promotion_without_a_bound_file_keeps_the_temporary_session`、
`binding_rejects_invalid_and_already_registered_files`、`crash_leaves_no_ghost_runtime_and_no_temporary_history`、
`temporary_sessions_are_isolated_between_projects_and_worktrees`、
`temporary_registry_is_bounded_and_discard_keeps_pi_files`（`cargo test -p soxu-session-index`）。
**越权路径**：`linked_session_file_outside_root_is_not_indexed`、
`linked_session_directory_outside_root_is_not_indexed`、`attach_of_unregistered_worktree_is_rejected`、
`project_registered_through_link_keeps_a_single_identity`。

复现命令：

```powershell
cargo test -p soxu-session-index
cargo clippy -p soxu-session-index --all-targets -- -D warnings
cargo fmt --all -- --check
```

## 已知限制

- 索引是「按文件路径缓存」。同一会话文件被移动到**另一个** Pi 会话目录时，需重新扫描一次，
  但 `SessionId` 不变。
- 分页返回的是**条目视图**（元数据 + 有界预览），不是完整正文；完整正文以 `offset + len` 作为
  按需资源接口的定位依据，由上层决定是否读取大块内容。
- 本 crate 不订阅文件系统事件；实时性由调用方按需 `refresh` 的频率决定，没有后台线程。
- 会话格式以 Pi session v3 为准；更高版本只记 `UnsupportedVersion` 告警并继续按已知字段解析。
- 临时会话**不跨进程存活**：重启后内存登记表为空，Tab 需要重新创建；这是「无幽灵历史」的代价。
- 转正需要显式绑定 Pi 会话文件。Pi 目前不会向 SOXU 回报它自己的会话文件路径，因此 UI 若拿不到
  路径就只会得到 `E_TEMPORARY_SESSION_UNPROMOTABLE`（明确失败，而不是假装成功）。

## 相关文档

- [架构总览](overview.md)
- [产品目标与验收](../product/prd.md)
- [测试规范](../../agents/policies/testing.md)
