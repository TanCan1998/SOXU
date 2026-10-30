---
name: rust-conventions
description: SOXU 的 Rust 写法与库 API 规范（微软 Rust Guidelines 14 条库 UX + P.NAM/G.FMT，加本项目 fmt/clippy 门禁与跨平台测试夹具要求）。新增或修改 crates/、apps/desktop/src-tauri/ 下的 .rs 文件、设计 pub API、写错误类型/构建器/集合 trait，或审查 Rust 改动时使用。
---

# SOXU Rust 规范

来源：Microsoft Rust Guidelines（`libs/ux` 14 条）与通用指南（命名 P.NAM、格式 G.FMT），按本项目口径收窄。

## 硬门禁（CI 会红）

1. `cargo fmt --all -- --check`
2. `cargo clippy --workspace --all-targets --locked -- -D warnings`
3. `cargo test --workspace --locked`

本地提交前至少跑前两条；平台缺失时必须写 **未验证**，不得声称通过。

## 公开 API（库 UX 14 条摘要）

- **不暴露实现包装器**（M-AVOID-WRAPPERS）：签名用 `&T`/`&mut T`/`T`，`Arc<Mutex<..>>`、`Rc<RefCell<..>>` 不进公开签名。
- **具体类型 > 泛型 > `dyn Trait`**（M-DI-HIERARCHY）：只为测试替换时用 enum；需要多实现才引入窄 trait；出现 `Foo<Bar<Baz>>` 时改 `dyn` + 自定义包装器。
- **inherent 方法优先**（M-ESSENTIAL-FN-INHERENT）：核心能力写 `impl T { pub fn ... }`，trait 只做转发，用户不必额外 `use` 才能用。
- **错误是规范 struct**（M-ERRORS-CANONICAL-STRUCTS / M-FROM-ERROR）：每类失败一个错误类型，`Display` + `std::error::Error`；内部 `ErrorKind` 私有并暴露 `is_xxx()`；跨层转换用 `From` 让 `?` 完成，不散落 `map_err`。
- **初始化**（M-INIT-BUILDER / M-INIT-CASCADED）：可选参数 ≥4 或参数成组时用 builder / 语义分组的小类型（setter 不加 `set_`，末位 `.build()`）。
- **service 的 `Clone` 只复制句柄**（M-SERVICES-CLONE）：`struct S { inner: Arc<Inner> }`。
- **参数顺序一致**（M-PARAMETER-CONSISTENCY）：调用者关心的具体参数在前、普适参数在后；闭包最后且一个函数至多一个。
- **集合实现完整迭代族**（M-COLLECTION-TRAITS）：`iter/iter_mut/into_iter`、三种 `IntoIterator`、`FromIterator`、`Extend`，`size_hint` 如实。
- **不定义 prelude**（M-NO-PRELUDE），模块按语义分组（M-BALANCED-MODULES）。
- **能用 `async fn` 就不手写 `impl Future`**（M-ASYNC-FN）。
- **抽象不显式嵌套**（M-SIMPLE-ABSTRACTIONS）：不要 `Service<Backend<Store>>`。

## 命名与格式（P.NAM / G.FMT）

- 类型 `UpperCamelCase`、函数/变量 `snake_case`、常量 `SCREAMING_SNAKE_CASE`；布尔谓词用 `is_`/`has_`，返回迭代器的方法用复数名（`candidate_paths`）。
- 有副作用的方法用动词短语（`remember_alias`、`resolve_session_directory`），不用 `set_xxx`/`do_xxx`。
- 格式交给 `cargo fmt`，不手调对齐；注释解释**为什么**与边界，不复述代码。

## 本项目额外约定

- 单元源码文件尽量 ≤400 行，超 600 行必须在提交信息里给出拆分理由（`crates/session-index/src/catalog.rs` 是已知超标项，拆分需单独任务）。
- 错误用 `Result<T, E>` 贯穿；不 `unwrap()` 业务路径，不用 `panic!` 表达可恢复失败。
- 不在主线程做长 IO；阻塞工作交给 `git_blocking`/`spawn_blocking` 或既有异步路径。
- **跨平台测试夹具**：临时目录创建后一律规范化（真实大小写 + 长文件名 + 去掉 Windows verbatim 前缀）。macOS 的 `/var` 是 `/private/var` 的符号链接、Windows runner 的 `RUNNER~1` 是 8.3 短名；不规范化会让「测试给的路径」与「git/目录里存的 canonical 路径」永远不相等。参考 `crates/git-worktree/tests/support/mod.rs`、`crates/session-index/tests/common/mod.rs`。
- **不要把绝对路径拼进 shell 命令**：路径可能含空格（用户名、`Program Files`），要执行就用 cwd 内的相对路径或 argv 数组。