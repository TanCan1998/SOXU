//! JSONL 只读索引入口，下一阶段实现增量 offset/分页。
#[derive(Debug, Clone, Copy)]
pub struct SessionPage {
    pub offset: u64,
    pub limit: usize,
}
impl SessionPage {
    pub fn new(offset: u64, limit: usize) -> Self {
        Self {
            offset,
            limit: limit.clamp(1, 200),
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn limits_page() {
        assert_eq!(SessionPage::new(0, 100000).limit, 200);
    }
}
