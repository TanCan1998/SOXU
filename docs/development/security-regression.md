# 越权与敏感信息回归（PRD P-08）

Issue #40 的最小离线测试集：验证**未授权路径读取**、**写越界**与**敏感信息注入**会被拒绝，
并验证凭据不出现在日志、界面 DTO 与提交里。全部用例不联网、不调用模型、不依赖用户真实数据。

## 覆盖矩阵

| P-08 要求 | 验证点 | 用例（文件 · 名称） |
| --- | --- | --- |
| 未授权路径读取 | 未登记路径不被当作工作树读取/规划 | `crates/git-worktree/tests/path_guard.rs` · `unmanaged_path_is_not_read_as_a_worktree` |
| 未授权路径读取 | 非仓库目录不能被打开 | `crates/git-worktree/tests/path_guard.rs` · `non_repository_directories_are_rejected` |
| 未授权路径读取 | 会话根目录之外的 JSONL 不被索引（含链接） | `crates/session-index/tests/path_guard.rs` · `linked_session_file_outside_root_is_not_indexed`、`linked_session_directory_outside_root_is_not_indexed` |
| 未授权路径读取 | 未登记工作树不能 attach 会话文件 | `crates/session-index/tests/path_guard.rs` · `attach_of_unregistered_worktree_is_rejected` |
| 未授权路径读取 | 前端不能按 ID 读未登记会话 | `apps/desktop/src-tauri/tests/security_regression.rs` · `unauthorized_session_reads_are_refused_without_echoing_content` |
| 写越界 | 相对路径、`..` 穿越、经链接逃出允许根目录 | `crates/git-worktree/tests/path_guard.rs` · `relative_destination_is_rejected_by_path_resolution`、`traversal_outside_allowed_root_is_rejected`、`linked_parent_escaping_allowed_root_is_rejected` |
| 写越界 | 不建在仓库内部、不覆盖已有目录 | `destination_inside_the_repository_is_rejected`、`existing_destination_is_never_overwritten` |
| 路径解析 | 链接登记不产生重复项目身份 | `crates/session-index/tests/path_guard.rs` · `project_registered_through_link_keeps_a_single_identity` |
| 路径解析 | 会话目录名不残留分隔符/盘符 | `session_directory_name_stays_inside_the_sessions_root` |
| 路径比较 | 前缀相同不算子目录；verbatim 前缀被剥离 | `crates/session-index/src/identity.rs` 单测、`crates/git-worktree/src/repo.rs` 单测 |
| 敏感信息注入 | 凭据类文件不进入索引，也不出现在任何界面 DTO | `apps/desktop/src-tauri/tests/security_regression.rs` · `credential_files_are_never_indexed_or_exposed_to_the_ui` |
| 敏感信息注入 | 子进程 stderr 中的密钥形态被脱敏 | `crates/agent-runtime/tests/rpc_lifecycle.rs` · `stderr_diagnostics_are_bounded_and_redacted`、`crates/agent-runtime/src/redact.rs` 单测 |
| 敏感信息注入 | 提交门禁拦住令牌、私钥、`.env`、`id_rsa` | `scripts/tests/secret-gate.test.mjs`（直接运行 `scripts/check-staged.mjs`） |
| 敏感信息注入 | 子进程不继承 GitHub/AtomGit 凭据环境变量 | `crates/agent-runtime/src/config.rs` · `pi_rpc_uses_structured_args` |

失败即回归：任何一条由「拒绝」变成「通过」，都说明越权边界被打开。

## 运行方式

```powershell
cargo test -p soxu-git-worktree --test path_guard
cargo test -p soxu-session-index --test path_guard
cargo test -p soxu-desktop --test security_regression
node --test scripts/tests/secret-gate.test.mjs
```

桌面端 Rust 测试需要先生成不入库的图标：`pnpm icons:generate`（CI 使用同样顺序）。

## 拒绝行为是可见的，不是静默的

- `git-worktree`：返回稳定错误码（`E_GIT_PATH_OUTSIDE_ROOT` / `E_GIT_PATH_INSIDE_REPO` /
  `E_GIT_PATH_EXISTS` / `E_GIT_WORKTREE_UNKNOWN` / `E_GIT_REPO_MISSING`），磁盘保持原样，
  测试同时断言「拒绝后没有留下半成品目录」。
- `session-index`：越界文件不读取、不登记，列入 `SyncReport::rejected_paths`；用户文件原样保留。
- 提交门禁：`scripts/check-staged.mjs` 退出码 1，并指出命中的文件名。

## 平台差异（实测记录）

| 项 | Windows | macOS / Linux |
| --- | --- | --- |
| 文件符号链接 | 普通用户建不了（`os error 1314`，需要开发者模式或管理员）。文件链接子用例打印「平台限制…跳过」后返回，不伪装成通过。 | 可直接创建，子用例真实执行。 |
| 目录链接 | 符号链接同样受限，但**目录联接（junction）**普通用户可建；测试自动退化为 `cmd /C mklink /J`，因此目录级越权用例在 Windows 也真实执行。 | 使用符号链接。 |
| 路径大小写 | 身份比较折叠为小写（NTFS 默认大小写不敏感）。 | 大小写敏感，不折叠。 |
| 临时目录 | `%TEMP%` 没有额外符号链接层。 | macOS 的 `/var/folders/...` 是指向 `/private/var/...` 的符号链接；守卫两侧都先 `canonicalize` 再比较，不会误判为越界。 |
| 拒绝文案 | 中文，仅供人读；**错误码才是契约**。 | 同左。 |

Windows 本机实测（2026-10-29，Node 26.10 / Rust 1.99.1）：文件符号链接用例跳过并打印原因；
目录联接、`..` 穿越、仓库内路径、已存在目录、未登记路径等用例全部真实执行并通过。
macOS 与 Linux 未在本仓库的实机上运行过这些用例，不做「已通过」声明。

## 已知边界（不要误认为已沙箱化）

- 路径守卫**不能替代 OS 沙箱**：它只保证 SOXU 自己不越界读写，不限制 Pi 子进程按自身权限访问文件；
  生产使用建议独立低权限账户（见[已知限制](limitations.md)与[安全策略](../../agents/policies/security.md)）。
- `attach_session_file` 是显式入口：用户主动选择的非默认布局文件不受隐式扫描边界限制。
- 脱敏是「尽力而为」的形态匹配（密钥前缀 + 长度/字符分布），不是密码学保证。
- 本测试集不覆盖真实 Pi 进程、真实网络与模型调用，也不覆盖 GPU/UI 渲染层。

## 相关文档

- [会话目录与 JSONL 索引契约](../architecture/session-catalog.md)
- [Git 工作树服务](../architecture/worktree-service.md)
- [测试规范](../../agents/policies/testing.md)
- [产品目标与验收](../product/prd.md)
