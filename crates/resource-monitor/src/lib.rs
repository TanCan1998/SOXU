//! SOXU 进程级内存预算与空闲释放策略。
//!
//! 只做三件事，其余（停进程、展示 UI、记录会话）都属于其它模块：
//! 1. **采样**：受管 Pi 进程树 + SOXU 自身的工作集/私有提交，带平台解释与降级说明；
//! 2. **判定**：按预算阈值产生预警，并对明确空闲的 runtime 产出「优雅释放请求」；
//! 3. **解释**：把不可用的指标、采样失败、释放失败都变成可展示的诊断，而不是静默忽略。
//!
//! 硬约束：本 crate 不会、也无法强制终止活跃 Agent——`Directive` 里没有 kill 语义，
//! 唯一涉及进程的写操作是可选的 `trim_working_set`（仅对自有进程，数据不丢）。
//!
//! 指标口径、采样间隔、阈值取值、平台限制与基准方法见
//! `docs/development/memory-budget.md`。
//!
//! ```no_run
//! use std::time::Instant;
//! use soxu_resource_monitor::{
//!     Activity, Governor, MemoryBudget, Monitor, MonitorConfig, Target,
//!     platform::{Sampler, SystemSampler},
//! };
//!
//! let budget = MemoryBudget::for_16gb();
//! let sampler = SystemSampler::new();
//! let mut monitor = Monitor::new(&sampler, MonitorConfig::from_budget(&budget));
//! let mut governor = Governor::new(budget.clone());
//!
//! let now = Instant::now();
//! // 上层每次 tick 用 supervisor 的真实状态构造 target：runtimeId + pid + 活动状态。
//! let targets = [Target::new("session-01#1", std::process::id(), Activity::Active)];
//! if monitor.due(now) {
//!     let sample = monitor.sample(&sampler, now, &targets);
//!     for directive in governor.evaluate(&sample) {
//!         // ReleaseIdleRuntime：映射为 PiSupervisor::stop（优雅停止，会话不丢）。
//!         println!("{directive:?}");
//!     }
//! }
//! ```

mod budget;
mod error;
mod governor;
mod metrics;
mod monitor;
mod sample;

pub mod platform;

pub use budget::MemoryBudget;
pub use error::{ErrorCode, MonitorError, Result};
pub use governor::{Directive, Governor, GovernorStats, PressureLevel, ReclaimOutcome};
pub use metrics::{Capabilities, Degradation, MetricSupport, Platform, ProcessUsage, TreeUsage};
pub use monitor::{Monitor, MonitorConfig, collect_tree};
pub use platform::{FakeSampler, Sampler, SystemSampler};
pub use sample::{Activity, RuntimeSample, Sample, Target};
