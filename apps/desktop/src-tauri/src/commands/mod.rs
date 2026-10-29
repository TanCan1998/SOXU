//! Tauri 命令层：只做参数映射与错误转字符串，业务在 workspace / session_runtime。
//!
//! 前端调用名与 `apps/desktop/src/workspace/bridge.ts` 中的 invoke 一一对应；
//! 多词参数由 Tauri 自动从 camelCase 映射到 snake_case。
//!
//! 按领域拆分为子模块（Issue #112）：本文件只做再导出，因此 `commands::<name>`
//! 的调用路径保持不变。新增 command 的落位规则见 `docs/development/command-blocks.md`，
//! 并由 `scripts/check-command-blocks.mjs` 机器校验（`pnpm check` 会跑）。

mod history;
mod session;
mod workspace;
mod worktree;

pub use history::*;
pub use session::*;
pub use workspace::*;
pub use worktree::*;
