//! Rust ⇄ Vue 的数据契约。
//!
//! 所有结构使用 camelCase 序列化，字段与 `apps/desktop/src/workspace/types.ts`
//! 中的 TypeScript 类型一一对应；改动必须同步两侧与文档。
//!
//! 按领域拆分为子模块（Issue #112），本文件只做再导出，
//! 因此 `crate::dto::<Type>` 的引用路径保持不变；新增结构请落到对应领域文件。

mod extension;
mod git;
mod session;
mod stats;
mod workspace;
mod worktree;

pub use extension::*;
pub use git::*;
pub use session::*;
pub use stats::*;
pub use workspace::*;
pub use worktree::*;
