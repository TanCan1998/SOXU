//! 重试预算的磁盘持久化：进程重启后不能重置已用次数。
//!
//! 文件放在应用数据目录的 `retry/` 子目录，不写进用户仓库，也不碰 Pi 的会话文件。
//! 文件名由「可读前缀 + FNV-1a 摘要」组成：`sessionId` 来自 UI 与 Pi 目录，
//! 属于外部输入，绝不直接拼进路径（避免 `..` / 保留名等路径穿越）。
//!
//! 失败处理是**保守**的：文件损坏或版本不认识时不会当作「全新预算」放行自动重试，
//! 而是构造一个已耗尽的预算——手动启动仍然可以试一次，但不会再自动重试，
//! 直到某次运行真正成功（`record_success` 会清空预算）。

use std::path::{Path, PathBuf};

use soxu_agent_runtime::retry::{FailureKind, RetryLedger, RetryPolicy, RetryStatus};

/// 应用数据目录下的子目录名。
pub const RETRY_DIR: &str = "retry";
/// 文件名可读前缀的最大长度（字节）；其余部分由摘要保证唯一。
const PREFIX_MAX: usize = 40;

/// 每个会话的重试预算存储。
pub struct RetryStore {
    root: PathBuf,
}

impl RetryStore {
    pub fn new(state_dir: &Path) -> Self {
        Self {
            root: state_dir.join(RETRY_DIR),
        }
    }

    /// 读取该会话的预算。文件不存在视为「首次运行」，返回全新预算。
    ///
    /// 读到损坏/未来版本的文件时返回**已耗尽**的预算并留下诊断，
    /// 因为无法证明历史重试次数，只能按最坏情况处理。
    pub fn load(&self, session_id: &str, policy: RetryPolicy) -> RetryLedger {
        let path = self.path(session_id);
        let text = match std::fs::read_to_string(&path) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return RetryLedger::new(policy);
            }
            Err(error) => {
                eprintln!(
                    "SOXU: 会话 {session_id} 的重试预算读取失败（{}）：{error}",
                    path.display()
                );
                return Self::untrusted(policy);
            }
        };
        match RetryLedger::decode(policy, &text) {
            Ok(ledger) => ledger,
            Err(error) => {
                eprintln!("SOXU: 会话 {session_id} 的重试预算无法恢复：{error}");
                Self::untrusted(policy)
            }
        }
    }

    /// 写入预算快照。失败只记录诊断：重试预算丢失不值得中断用户会话。
    pub fn save(&self, session_id: &str, ledger: &RetryLedger) {
        if let Err(error) = std::fs::create_dir_all(&self.root) {
            eprintln!(
                "SOXU: 无法创建重试预算目录 {}：{error}",
                self.root.display()
            );
            return;
        }
        let path = self.path(session_id);
        if let Err(error) = std::fs::write(&path, ledger.encode()) {
            eprintln!("SOXU: 重试预算写入失败（{}）：{error}", path.display());
        }
    }

    /// 只读快照；文件不存在时返回 `None`（控制台显示「未发生重试」而不是伪造 0）。
    pub fn status(&self, session_id: &str, policy: RetryPolicy) -> Option<RetryStatus> {
        let path = self.path(session_id);
        if !path.exists() {
            return None;
        }
        Some(self.load(session_id, policy).status())
    }

    /// 删除该会话的预算记录（仅在确认结论后由上层调用）。
    pub fn clear(&self, session_id: &str) {
        let path = self.path(session_id);
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => eprintln!("SOXU: 重试预算删除失败（{}）：{error}", path.display()),
        }
    }

    /// 无法证明历史重试次数时的预算：已耗尽但没有消耗次数。
    fn untrusted(policy: RetryPolicy) -> RetryLedger {
        let mut ledger = RetryLedger::new(policy);
        ledger.record_terminal(FailureKind::Permanent);
        ledger
    }

    fn path(&self, session_id: &str) -> PathBuf {
        self.root.join(format!("{}.json", file_key(session_id)))
    }
}

/// 文件名：可读前缀 + 全量 sessionId 的 64 位摘要。
fn file_key(session_id: &str) -> String {
    let mut prefix = String::new();
    for character in session_id.chars() {
        if prefix.len() >= PREFIX_MAX {
            break;
        }
        // 只放行字母数字与 -/_：点号会引入 ".." 与隐藏文件名，必须一起替换掉。
        let safe = character.is_ascii_alphanumeric() || matches!(character, '-' | '_');
        prefix.push(if safe { character } else { '_' });
    }
    if prefix.is_empty() {
        prefix.push_str("session");
    }
    format!("{prefix}-{:016x}", digest(session_id))
}

/// FNV-1a：确定性、无依赖，跨版本稳定，适合做文件名摘要。
fn digest(text: &str) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for byte in text.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn policy() -> RetryPolicy {
        RetryPolicy::new(2, Duration::from_millis(1), Duration::from_millis(2))
    }

    fn sandbox(name: &str) -> PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or_default();
        let dir = std::env::temp_dir().join(format!("soxu-retry-{name}-{stamp}"));
        std::fs::create_dir_all(&dir).expect("创建临时目录");
        dir
    }

    #[test]
    fn missing_file_starts_with_a_full_budget() {
        let dir = sandbox("missing");
        let store = RetryStore::new(&dir);
        let ledger = store.load("ses_a", policy());
        assert_eq!(ledger.attempts(), 0);
        assert!(ledger.may_attempt());
        assert!(store.status("ses_a", policy()).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn saved_budget_survives_a_restart() {
        let dir = sandbox("restart");
        let store = RetryStore::new(&dir);
        let mut ledger = store.load("ses_a", policy());
        ledger.record_failure(FailureKind::Timeout);
        ledger.record_failure(FailureKind::Timeout);
        assert_eq!(ledger.record_failure(FailureKind::Timeout), None);
        store.save("ses_a", &ledger);

        // 新进程：重新打开同一目录。
        let reopened = RetryStore::new(&dir);
        let restored = reopened.load("ses_a", policy());
        assert!(restored.is_exhausted());
        assert_eq!(restored.attempts(), 2);
        assert_eq!(restored.last_failure(), Some(FailureKind::Timeout));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_budget_fails_closed_but_still_permits_one_manual_attempt() {
        let dir = sandbox("corrupt");
        let store = RetryStore::new(&dir);
        std::fs::create_dir_all(dir.join(RETRY_DIR)).expect("创建预算目录");
        std::fs::write(store.path("ses_a"), "{not json").expect("写入坏文件");

        let mut ledger = store.load("ses_a", policy());
        // 不能证明历史次数：不允许自动重试，但预算没有被算成「已用次数」。
        assert!(ledger.is_exhausted());
        assert_eq!(ledger.attempts(), 0);
        assert!(!ledger.may_attempt());
        // Review 回归：exhausted=true、attempts=0 也不能换回一次自动重试。
        assert_eq!(
            ledger.record_failure(FailureKind::Timeout),
            None,
            "损坏快照必须失败关闭，不能因为 attempts < max 就放行重试"
        );
        assert_eq!(ledger.attempts(), 0, "失败关闭不得虚构已用次数");
        assert!(ledger.is_exhausted());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn session_ids_never_leak_into_paths() {
        let dir = sandbox("paths");
        let store = RetryStore::new(&dir);
        let evil = "../../etc/passwd";
        let path = store.path(evil);
        assert_eq!(path.parent(), Some(dir.join(RETRY_DIR).as_path()));
        let name = path.file_name().unwrap().to_string_lossy();
        assert!(!name.contains('/') && !name.contains('\\'), "{name}");
        assert!(!name.contains(".."), "{name}");
        // 不同 sessionId 映射到不同文件，不串预算。
        assert_ne!(store.path("ses_a"), store.path("ses_b"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn status_reports_the_persisted_counts() {
        let dir = sandbox("status");
        let store = RetryStore::new(&dir);
        let mut ledger = store.load("ses_a", policy());
        ledger.record_failure(FailureKind::Timeout);
        store.save("ses_a", &ledger);

        let status = store.status("ses_a", policy()).expect("应能读到预算");
        assert_eq!(status.attempts, 1);
        assert_eq!(status.max_attempts, 2);
        assert!(!status.exhausted);
        assert!(status.cost_notice.contains("费用"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
