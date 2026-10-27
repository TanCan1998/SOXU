//! 无外部依赖的稳定哈希：ID 派生与文件头部指纹。
//!
//! 用 FNV-1a 64 而不是 SipHash，因为 std 的 DefaultHasher 不保证跨进程、跨版本稳定，
//! 而 ProjectId 必须在重启后保持一致。这里只需要低碰撞、可复现，不需要抗碰撞。

pub(crate) const FNV_OFFSET_BASIS: u64 = 0xcbf2_9ce4_8422_2325;
pub(crate) const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

pub(crate) fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut hash = FNV_OFFSET_BASIS;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    hash
}

/// 分段哈希：插入 0x1f 分隔符，避免 ("ab","c") 与 ("a","bc") 得到相同 ID。
pub(crate) fn fnv1a64_parts(parts: &[&str]) -> u64 {
    let mut hash = FNV_OFFSET_BASIS;
    for part in parts {
        for byte in part.as_bytes() {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(FNV_PRIME);
        }
        hash ^= 0x1f;
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    hash
}

pub(crate) fn hex16(value: u64) -> String {
    format!("{value:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashing_is_stable_across_calls() {
        assert_eq!(fnv1a64(b"session"), fnv1a64(b"session"));
        assert_ne!(fnv1a64(b"session"), fnv1a64(b"session "));
    }

    #[test]
    fn part_boundaries_are_hashed() {
        assert_ne!(fnv1a64_parts(&["ab", "c"]), fnv1a64_parts(&["a", "bc"]));
    }

    #[test]
    fn hex_is_fixed_width() {
        assert_eq!(hex16(0).len(), 16);
        assert_eq!(hex16(u64::MAX).len(), 16);
    }
}
