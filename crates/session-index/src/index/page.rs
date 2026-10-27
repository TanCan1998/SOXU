//! 有界分页：按条目序号读取，单页字节数由预算约束。
//!
//! 读取预算保证一次请求不会把超长工具输出整体拉进内存；超出预算时提前截断，
//! 用 next 告诉调用方从哪里继续。首条条目不受预算限制（见 page 的注释），
//! 保证任何预算下分页都能前进。

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};

use serde::{Deserialize, Serialize};

use super::SessionLog;
use crate::entry::{self, EntryPage};
use crate::error::{CatalogError, ErrorCode, Result};

/// 单页最多条目数，防止一次请求拖出过多对象。
pub const MAX_PAGE_ENTRIES: usize = 200;
/// 单页最多读取字节数，防止一页里塞满巨型工具输出。
pub const MAX_PAGE_BYTES: usize = 1024 * 1024;
/// 超过该长度的条目只返回占位视图，不读正文。
pub const INLINE_ENTRY_BYTES: u32 = 256 * 1024;

/// 分页请求。offset 是条目序号（0 起），不是字节偏移。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionPage {
    pub offset: u64,
    pub limit: usize,
    pub max_bytes: usize,
}

impl SessionPage {
    pub fn new(offset: u64, limit: usize) -> Self {
        Self {
            offset,
            limit: limit.clamp(1, MAX_PAGE_ENTRIES),
            max_bytes: MAX_PAGE_BYTES,
        }
    }

    /// 缩小本页读取预算（测试与低内存场景使用）。
    pub fn with_budget(mut self, max_bytes: usize) -> Self {
        self.max_bytes = max_bytes.clamp(1, MAX_PAGE_BYTES);
        self
    }
}

impl Default for SessionPage {
    fn default() -> Self {
        Self::new(0, 50)
    }
}

impl SessionLog {
    /// 按条目序号分页读取。
    ///
    /// 字节预算从第一条开始扣减；条目本身超过预算时提前截断并标记 clipped。
    /// 例外是页的第一条：即使超过预算也会返回，否则调用方按 next 重试会原地打转。
    /// 超过 INLINE_ENTRY_BYTES 的条目一律只返回占位视图，不读取正文。
    pub fn page(&self, page: SessionPage) -> Result<EntryPage> {
        let total = self.entries.len();
        let offset = usize::try_from(page.offset).unwrap_or(usize::MAX);
        if offset > total {
            return Err(CatalogError::new(
                ErrorCode::PageOutOfRange,
                format!("分页 offset {offset} 超出条目总数 {total}"),
            ));
        }
        let limit = page.limit.clamp(1, MAX_PAGE_ENTRIES);
        let end = total.min(offset.saturating_add(limit));
        if offset == end {
            return Ok(EntryPage {
                entries: Vec::new(),
                offset: page.offset,
                total,
                next: None,
                bytes_read: 0,
                clipped: false,
            });
        }
        let mut file = File::open(&self.path).map_err(|error| {
            CatalogError::io(
                ErrorCode::SessionFileMissing,
                format!("会话文件不存在：{}", self.path.display()),
                &error,
            )
        })?;
        let mut views = Vec::with_capacity(end - offset);
        let mut budget = page.max_bytes;
        let mut bytes_read = 0_u64;
        let mut cursor = offset;
        while cursor < end {
            let meta = self.entries[cursor];
            if meta.is_oversized() || meta.len > INLINE_ENTRY_BYTES {
                views.push(entry::placeholder_from(cursor as u64, meta));
                cursor += 1;
                continue;
            }
            if meta.len as usize > budget && !views.is_empty() {
                break;
            }
            let mut buffer = vec![0_u8; meta.len as usize];
            file.seek(SeekFrom::Start(meta.offset)).map_err(|error| {
                CatalogError::io(ErrorCode::IoFailure, "定位会话文件失败", &error)
            })?;
            file.read_exact(&mut buffer).map_err(|error| {
                CatalogError::io(
                    ErrorCode::SessionFileMissing,
                    format!("会话文件在分页时被截断：{}", self.path.display()),
                    &error,
                )
            })?;
            budget = budget.saturating_sub(meta.len as usize);
            bytes_read += u64::from(meta.len);
            views.push(entry::view_from(cursor as u64, meta, &buffer));
            cursor += 1;
        }
        Ok(EntryPage {
            entries: views,
            offset: page.offset,
            total,
            next: if cursor < total {
                Some(cursor as u64)
            } else {
                None
            },
            bytes_read,
            clipped: cursor < end,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limits_page() {
        assert_eq!(SessionPage::new(0, 100000).limit, MAX_PAGE_ENTRIES);
        assert_eq!(SessionPage::new(0, 0).limit, 1);
    }

    #[test]
    fn budget_cannot_exceed_max() {
        assert_eq!(
            SessionPage::new(0, 10).with_budget(usize::MAX).max_bytes,
            MAX_PAGE_BYTES
        );
    }

    #[test]
    fn budget_is_never_zero() {
        assert_eq!(SessionPage::new(0, 10).with_budget(0).max_bytes, 1);
    }
}
