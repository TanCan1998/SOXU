//! 大小写不敏感子串匹配 + 字符对齐的命中片段。
//!
//! 三条约束决定了这里的实现方式：
//! 1. 中文不需要分词，英文统一小写比较；因此只有「含大小写字符」的查询才需要折叠，
//!    纯中文查询走零分配的原样子串匹配（见 `needs_fold`）。
//! 2. 片段偏移必须按**字符**（不是字节）给出，前端才能安全地切片高亮；
//!    折叠后字节长度会变（如 `İ`），所以匹配位置先落到原文字节偏移，再换算成字符。
//! 3. 单条命中有上限，避免一条超长工具输出刷屏。

/// 单条文本内最多统计的命中次数。
pub const MAX_MATCHES_PER_ENTRY: usize = 20;
/// 命中片段前后各保留的字符数。
pub const SNIPPET_CONTEXT_CHARS: usize = 40;

/// 一次命中的位置（原文字节偏移，左闭右开）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MatchSpan {
    pub start: usize,
    pub end: usize,
}

/// 命中片段：`text` 是原文切片，`match_start`/`match_end` 是片段内的**字符**偏移。
///
/// 片段不追加省略号：偏移必须与文本严格对齐，界面用 CSS 省略即可。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Snippet {
    pub text: String,
    pub match_start: usize,
    pub match_end: usize,
}

/// 查询是否含大小写字符。不含时大小写不敏感等价于原样子串匹配。
///
/// 中文、标点、数字都返回 false；ASCII 字母与带大小写的拉丁/希腊/西里尔字母返回 true。
fn needs_fold(needle: &str) -> bool {
    needle
        .chars()
        .any(|character| character.is_lowercase() || character.is_uppercase())
}

/// 找出全部命中位置，最多 `cap` 个；允许重叠命中（如 "aa" 在 "aaa" 里算 2 次）。
pub fn find_all(text: &str, needle: &str, cap: usize) -> Vec<MatchSpan> {
    if needle.is_empty() || text.is_empty() || cap == 0 {
        return Vec::new();
    }
    if !needs_fold(needle) {
        return find_exact(text, needle, cap);
    }
    find_folded(text, needle, cap)
}

fn find_exact(text: &str, needle: &str, cap: usize) -> Vec<MatchSpan> {
    let mut spans = Vec::new();
    let mut from = 0_usize;
    while from <= text.len() {
        let Some(relative) = text[from..].find(needle) else {
            break;
        };
        let start = from + relative;
        spans.push(MatchSpan {
            start,
            end: start + needle.len(),
        });
        if spans.len() >= cap {
            break;
        }
        // 前进一个**原文字符**，保证重叠命中也能被统计。
        from = start + text[start..].chars().next().map_or(1, char::len_utf8);
    }
    spans
}

/// 折叠后逐字符滑窗。`offsets[i]` 是第 i 个折叠字符对应的原文字节偏移。
fn find_folded(text: &str, needle: &str, cap: usize) -> Vec<MatchSpan> {
    let (folded, offsets) = fold(text);
    let needle: Vec<char> = needle.to_lowercase().chars().collect();
    if needle.len() > folded.len() {
        return Vec::new();
    }
    let mut spans = Vec::new();
    let mut index = 0_usize;
    while index + needle.len() <= folded.len() {
        if folded[index..index + needle.len()] == needle[..] {
            let start = offsets[index];
            let end = offsets
                .get(index + needle.len())
                .copied()
                .unwrap_or(text.len());
            spans.push(MatchSpan { start, end });
            if spans.len() >= cap {
                break;
            }
            index = next_original_char(&offsets, index);
        } else {
            index += 1;
        }
    }
    spans
}

fn fold(text: &str) -> (Vec<char>, Vec<usize>) {
    let mut folded = Vec::with_capacity(text.len());
    let mut offsets = Vec::with_capacity(text.len());
    for (byte, character) in text.char_indices() {
        for lower in character.to_lowercase() {
            folded.push(lower);
            offsets.push(byte);
        }
    }
    (folded, offsets)
}

/// 折叠序列里跳过同一个原文字符产生的其余折叠字符。
fn next_original_char(offsets: &[usize], index: usize) -> usize {
    let current = offsets.get(index).copied().unwrap_or_default();
    let mut next = index + 1;
    while next < offsets.len() && offsets[next] == current {
        next += 1;
    }
    next
}

/// 以命中位置为中心截取片段，边界对齐到字符。
///
/// 单次 O(n) 扫描只发生在**真正命中**的条目上，未命中条目不会付出这个代价。
pub fn snippet(text: &str, span: MatchSpan) -> Snippet {
    let start_char = text
        .get(..span.start)
        .map_or(0, |prefix| prefix.chars().count());
    let end_char = start_char
        + text
            .get(span.start..span.end)
            .map_or(0, |matched| matched.chars().count());
    let total = text.chars().count();
    let from = start_char.saturating_sub(SNIPPET_CONTEXT_CHARS);
    let to = end_char.saturating_add(SNIPPET_CONTEXT_CHARS).min(total);
    let clipped: String = text.chars().skip(from).take(to - from).collect();
    Snippet {
        text: clipped,
        match_start: start_char - from,
        match_end: end_char - from,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_ascii_case_insensitively() {
        let spans = find_all("Hello World, hello", "hello", 10);
        assert_eq!(
            spans,
            vec![
                MatchSpan { start: 0, end: 5 },
                MatchSpan { start: 13, end: 18 }
            ]
        );
    }

    #[test]
    fn matches_chinese_without_folding() {
        let spans = find_all("扩散测试：扩散", "扩散", 10);
        assert_eq!(spans.len(), 2);
        assert_eq!(&"扩散测试：扩散"[spans[0].start..spans[0].end], "扩散");
    }

    #[test]
    fn counts_overlapping_matches_up_to_cap() {
        assert_eq!(find_all("aaaa", "aa", 10).len(), 3);
        assert_eq!(find_all("aaaa", "aa", 2).len(), 2);
    }

    #[test]
    fn snippet_offsets_are_char_based() {
        let text = format!("{}命中{}", "汉".repeat(100), "尾".repeat(100));
        let span = MatchSpan {
            start: 300,
            end: 306,
        };
        let snippet = snippet(text.as_str(), span);
        // 片段内字符切片必须能精确还原命中词，说明偏移不是字节偏移。
        let chars: Vec<char> = snippet.text.chars().collect();
        let matched: String = chars[snippet.match_start..snippet.match_end]
            .iter()
            .collect();
        assert_eq!(matched, "命中");
        assert_eq!(snippet.match_start, SNIPPET_CONTEXT_CHARS);
        assert_eq!(chars.len(), SNIPPET_CONTEXT_CHARS * 2 + 2);
    }

    #[test]
    fn snippet_is_clamped_at_both_ends() {
        let snippet = snippet("扩散", MatchSpan { start: 0, end: 6 });
        assert_eq!(snippet.text, "扩散");
        assert_eq!((snippet.match_start, snippet.match_end), (0, 2));
    }

    #[test]
    fn empty_needle_never_matches() {
        assert!(find_all("任意内容", "", 10).is_empty());
        assert!(find_all("", "内容", 10).is_empty());
        assert!(find_all("任意内容", "内容", 0).is_empty());
    }

    #[test]
    fn folding_keeps_original_byte_offsets() {
        // İ 折叠成两个字符：折叠序列的下标与原文下标不再一一对应，
        // 命中范围必须仍指向原文（否则切片会落在字符中间）。
        let text = "İstanbul 扩散";
        let spans = find_all(text, "nbul 扩散", 4);
        assert_eq!(spans.len(), 1);
        assert_eq!(&text[spans[0].start..spans[0].end], "nbul 扩散");
    }
}
