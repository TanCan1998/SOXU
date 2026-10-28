//! 有副作用的操作台账：防止「结果未知」时被盲目重放。
//!
//! 典型场景：创建 PR 的请求超时了——PR 可能已经建好。此时只允许先查证，
//! 绝不直接再建一个。台账有界，且拒绝丢弃未落定的条目。

use super::MAX_SIDE_EFFECT_ENTRIES;

/// 重放判定：决定「这条有副作用的操作能不能再来一次」。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReplayDecision {
    /// 没有登记过，也没有在途记录：可以安全执行。
    SafeToReplay,
    /// 已发出但结果未知：必须先查证（例如查询是否已存在 PR），不得重放。
    VerifyFirst,
    /// 已确认执行成功：禁止重放，避免重复创建。
    NeverReplay,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum SideEffectState {
    /// 已发出、结果未知。
    Unknown,
    Applied,
    NotApplied,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SideEffect {
    op: String,
    state: SideEffectState,
}

/// 有界副作用台账：登记「可能已经产生副作用」的操作，防止盲目重放。
///
/// 典型场景：创建 PR 的请求超时——PR 可能已经建好了。此时只允许
/// `ReplayDecision::VerifyFirst`，绝不直接再建一个。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SideEffectLedger {
    entries: Vec<SideEffect>,
}

impl SideEffectLedger {
    pub fn new() -> Self {
        Self::default()
    }

    /// 发起有副作用的操作前登记，默认按「可能已执行」处理。
    ///
    /// 返回 `false` 表示台账已满且仍有未落定项：调用方必须暂停，不允许继续发请求。
    pub fn mark_sent(&mut self, op: impl Into<String>) -> bool {
        let op = op.into();
        if let Some(existing) = self.entries.iter_mut().find(|entry| entry.op == op) {
            existing.state = SideEffectState::Unknown;
            return true;
        }
        if self.entries.len() >= MAX_SIDE_EFFECT_ENTRIES {
            // 先回收已落定的最旧条目；回收未落定条目会静默放行重放，必须拒绝。
            match self
                .entries
                .iter()
                .position(|entry| entry.state != SideEffectState::Unknown)
            {
                Some(index) => {
                    self.entries.remove(index);
                }
                None => return false,
            }
        }
        self.entries.push(SideEffect {
            op,
            state: SideEffectState::Unknown,
        });
        true
    }

    /// 查证后落定结果；返回是否找到对应条目。
    pub fn resolve(&mut self, op: &str, applied: bool) -> bool {
        match self.entries.iter_mut().find(|entry| entry.op == op) {
            Some(entry) => {
                entry.state = if applied {
                    SideEffectState::Applied
                } else {
                    SideEffectState::NotApplied
                };
                true
            }
            None => false,
        }
    }

    /// 该操作能否重放。未登记视为安全，已登记未落定必须先查证。
    pub fn decision(&self, op: &str) -> ReplayDecision {
        match self.entries.iter().find(|entry| entry.op == op) {
            None => ReplayDecision::SafeToReplay,
            Some(entry) => match entry.state {
                SideEffectState::Unknown => ReplayDecision::VerifyFirst,
                SideEffectState::Applied => ReplayDecision::NeverReplay,
                SideEffectState::NotApplied => ReplayDecision::SafeToReplay,
            },
        }
    }

    /// 仍有未落定的操作：此时不允许在对账前继续任何写操作。
    pub fn has_unresolved(&self) -> bool {
        self.entries
            .iter()
            .any(|entry| entry.state == SideEffectState::Unknown)
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}
