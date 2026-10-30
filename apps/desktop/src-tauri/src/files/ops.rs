//! 文件系统操作（Issue #120 / TASK-028）：目录枚举、只读预览、受约束的写与文件内搜索。
//!
//! 全部是同步实现，由 `files/mod.rs` 放进 `spawn_blocking` 执行：
//! 大目录枚举与网络盘上的读写可能持续上百毫秒，不能占用 async 执行器。
//!
//! 有界原则：预览按字节截断、写入有大小上限、目录枚举只读一层且有条目上限、
//! 文件内搜索对深度/文件数/命中数三重设限——任何入口都不会「一次性读全盘」。

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Instant, UNIX_EPOCH};

use crate::dto::{
    DirListing, FileContent, FileEntry, FileMutation, FileSearchHit, FileSearchResult,
};

use super::guard::{
    CONFIRM_MISMATCH, CONTENT_TOO_LARGE, DIR_NOT_EMPTY, FileError, FileRoot, IO_FAILURE, NOT_A_DIR,
    NOT_A_FILE, PATH_EXISTS, PATH_IS_ROOT, PATH_MISSING, QUERY_EMPTY, SYMLINK_UNSUPPORTED,
};

/// 单层目录枚举的条目上限：懒加载一次只读一层，但单层仍可能有数万条目。
pub const MAX_DIR_ENTRIES: usize = 2_000;
/// 只读预览的字节上限：超出只返回前一段并标记 `truncated`，绝不整份读进内存。
pub const MAX_PREVIEW_BYTES: u64 = 256 * 1024;
/// 单次写入的字节上限：防止误选的巨型内容被写进项目。
pub const MAX_WRITE_BYTES: usize = 4 * 1024 * 1024;
/// 文件内搜索的单文件扫描上限。
pub const MAX_SEARCH_FILE_BYTES: u64 = 1024 * 1024;
/// 文件内搜索的默认命中上限。
pub const DEFAULT_FILE_HITS: usize = 200;
/// 文件内搜索的扫描文件数上限（防止一次搜索走遍整盘）。
pub const MAX_SEARCH_FILES: usize = 20_000;
/// 文件内搜索的目录深度上限。
pub const MAX_SEARCH_DEPTH: usize = 12;
/// 命中预览的最大字符数（与 UI 一行的宽度对齐）。
const MAX_HIT_PREVIEW_CHARS: usize = 160;

/// 文件内搜索跳过的目录：依赖与构建产物，命中它们既慢又没有意义。
const SKIPPED_DIRS: [&str; 11] = [
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    "target",
    "dist",
    "build",
    ".venv",
    "__pycache__",
    ".next",
    "vendor",
];

fn modified_at_ms(metadata: &fs::Metadata) -> Option<u64> {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
}

pub fn list_dir(root: &FileRoot, relative: &str) -> Result<DirListing, FileError> {
    let target = root.existing_dir(relative)?;
    let reader = fs::read_dir(&target)
        .map_err(|error| FileError::io(NOT_A_DIR, format!("目录不可读取：{relative}"), &error))?;
    let mut entries = Vec::new();
    let mut total = 0usize;
    for entry in reader {
        // 单个条目读失败（权限/竞态）不中断整层枚举，也不伪造它存在。
        let Ok(entry) = entry else { continue };
        total += 1;
        if entries.len() >= MAX_DIR_ENTRIES {
            continue;
        }
        entries.push(file_entry(root, &entry));
    }
    // 后端只保证确定性顺序（名称升序）；名称/时间/大小的排序偏好属于 UI。
    // 排序键缓存一次而不是每次比较都分配：单层两万条目时差别很明显。
    entries.sort_by_cached_key(|entry| entry.name.to_lowercase());
    Ok(DirListing {
        project_id: String::new(),
        path: root.relative_display(&target),
        entries,
        total,
        truncated: total > MAX_DIR_ENTRIES,
    })
}

fn file_entry(root: &FileRoot, entry: &fs::DirEntry) -> FileEntry {
    // `DirEntry::file_type` / `metadata` 都不跟随符号链接：链接本身就是一个条目。
    let file_type = entry.file_type().ok();
    let symlink = file_type.map(|kind| kind.is_symlink()).unwrap_or(false);
    let kind = match file_type {
        Some(kind) if kind.is_dir() => "dir",
        Some(kind) if kind.is_file() => "file",
        Some(kind) if kind.is_symlink() => "symlink",
        _ => "other",
    };
    let metadata = entry.metadata().ok();
    let name = entry.file_name().to_string_lossy().into_owned();
    FileEntry {
        path: root.relative_display(&entry.path()),
        hidden: name.starts_with('.'),
        name,
        kind: kind.to_owned(),
        size: metadata.as_ref().map(fs::Metadata::len).unwrap_or(0),
        modified_at_ms: metadata.as_ref().and_then(modified_at_ms),
        symlink,
    }
}

pub fn read_file(root: &FileRoot, relative: &str) -> Result<FileContent, FileError> {
    let target = root.existing(relative)?;
    let metadata = fs::metadata(&target).map_err(|error| {
        FileError::io(PATH_MISSING, format!("文件不可访问：{relative}"), &error)
    })?;
    if !metadata.is_file() {
        return Err(FileError::new(
            NOT_A_FILE,
            format!("目标不是文件：{relative}"),
        ));
    }
    let file = File::open(&target)
        .map_err(|error| FileError::io(NOT_A_FILE, format!("文件不可读取：{relative}"), &error))?;
    let mut buffer = Vec::new();
    // 只读到上限 + 1 字节：多出来的那 1 字节就是「还有更多」的证据。
    file.take(MAX_PREVIEW_BYTES + 1)
        .read_to_end(&mut buffer)
        .map_err(|error| FileError::io(NOT_A_FILE, format!("文件读取中断：{relative}"), &error))?;
    let truncated = buffer.len() as u64 > MAX_PREVIEW_BYTES;
    if truncated {
        buffer.truncate(MAX_PREVIEW_BYTES as usize);
    }
    // 二进制判定只看前 8 KiB 的 NUL：真正的二进制文件不值得在只读预览里解码。
    let binary = buffer.iter().take(8 * 1024).any(|byte| *byte == 0);
    // 截断可能切在 UTF-8 字符中间：用 lossy 解码，末尾最多一个替换符，不影响其余内容。
    let text = if binary {
        String::new()
    } else {
        String::from_utf8_lossy(&buffer).into_owned()
    };
    Ok(FileContent {
        path: root.relative_display(&target),
        text,
        size: metadata.len(),
        bytes_read: buffer.len() as u64,
        truncated,
        binary,
        modified_at_ms: modified_at_ms(&metadata),
    })
}

pub fn write_file(
    root: &FileRoot,
    relative: &str,
    content: &str,
) -> Result<FileMutation, FileError> {
    ensure_content_fits(content)?;
    let target = root.existing(relative)?;
    let metadata = fs::metadata(&target).map_err(|error| {
        FileError::io(PATH_MISSING, format!("文件不可访问：{relative}"), &error)
    })?;
    if !metadata.is_file() {
        return Err(FileError::new(
            NOT_A_FILE,
            format!("目标不是文件：{relative}"),
        ));
    }
    fs::write(&target, content.as_bytes())
        .map_err(|error| FileError::io(IO_FAILURE, format!("写入失败：{relative}"), &error))?;
    Ok(FileMutation {
        path: root.relative_display(&target),
        kind: "file".to_owned(),
        size: content.len() as u64,
    })
}

pub fn create_file(
    root: &FileRoot,
    relative: &str,
    content: Option<&str>,
) -> Result<FileMutation, FileError> {
    let content = content.unwrap_or("");
    ensure_content_fits(content)?;
    let target = root.creatable(relative)?;
    // `create_new` 是原子的：目标在这一刻已存在（含符号链接）就失败，
    // 不给「校验通过后被换成链接」留出 TOCTOU 窗口。
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target)
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                FileError::new(PATH_EXISTS, format!("目标已存在，拒绝覆盖：{relative}"))
            } else {
                FileError::io(IO_FAILURE, format!("创建失败：{relative}"), &error)
            }
        })?;
    if !content.is_empty() {
        file.write_all(content.as_bytes())
            .map_err(|error| FileError::io(IO_FAILURE, format!("写入失败：{relative}"), &error))?;
    }
    Ok(FileMutation {
        path: root.relative_display(&target),
        kind: "file".to_owned(),
        size: content.len() as u64,
    })
}

pub fn rename(root: &FileRoot, from: &str, to: &str) -> Result<FileMutation, FileError> {
    let source = root.existing(from)?;
    if source == root.root() {
        return Err(FileError::new(
            PATH_IS_ROOT,
            "项目根目录不能重命名".to_owned(),
        ));
    }
    // 重命名链接本身还是链接目标，语义模糊且容易越界：直接拒绝。
    let metadata = fs::symlink_metadata(&source)
        .map_err(|error| FileError::io(PATH_MISSING, format!("路径不可访问：{from}"), &error))?;
    if metadata.file_type().is_symlink() {
        return Err(FileError::new(
            SYMLINK_UNSUPPORTED,
            format!("不支持重命名符号链接：{from}"),
        ));
    }
    let destination = root.creatable(to)?;
    if destination == source {
        return Err(FileError::new(PATH_EXISTS, format!("源与目标相同：{from}")));
    }
    fs::rename(&source, &destination)
        .map_err(|error| FileError::io(IO_FAILURE, format!("重命名失败：{from} → {to}"), &error))?;
    let kind = if metadata.is_dir() { "dir" } else { "file" };
    Ok(FileMutation {
        path: root.relative_display(&destination),
        kind: kind.to_owned(),
        size: metadata.len(),
    })
}

pub fn delete(
    root: &FileRoot,
    relative: &str,
    recursive: bool,
    confirm_name: &str,
) -> Result<FileMutation, FileError> {
    let target = root.existing(relative)?;
    if target == root.root() {
        return Err(FileError::new(
            PATH_IS_ROOT,
            "项目根目录不能删除".to_owned(),
        ));
    }
    let metadata = fs::symlink_metadata(&target).map_err(|error| {
        FileError::io(PATH_MISSING, format!("路径不可访问：{relative}"), &error)
    })?;
    if metadata.file_type().is_symlink() {
        return Err(FileError::new(
            SYMLINK_UNSUPPORTED,
            format!("不支持删除符号链接：{relative}"),
        ));
    }
    // 二次确认由后端校验：UI 必须把目标名称原样传回来，只有「看见并确认了这个名字」才能删。
    let name = target
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_default();
    if confirm_name != name {
        return Err(FileError::new(
            CONFIRM_MISMATCH,
            format!("删除确认名称不匹配：需要「{name}」"),
        ));
    }
    if metadata.is_dir() {
        if !recursive {
            // 非递归删除前自己检查空目录：跨平台的错误类型不一致，先判断再删更可靠。
            let mut reader = fs::read_dir(&target).map_err(|error| {
                FileError::io(IO_FAILURE, format!("目录不可读取：{relative}"), &error)
            })?;
            if reader.next().is_some() {
                return Err(FileError::new(
                    DIR_NOT_EMPTY,
                    format!("目录非空，需要确认递归删除：{relative}"),
                ));
            }
            fs::remove_dir(&target).map_err(|error| {
                FileError::io(IO_FAILURE, format!("删除失败：{relative}"), &error)
            })?;
        } else {
            // `remove_dir_all` 不跟随符号链接（删链接本身），不会删到根目录之外。
            fs::remove_dir_all(&target).map_err(|error| {
                FileError::io(IO_FAILURE, format!("删除失败：{relative}"), &error)
            })?;
        }
        return Ok(FileMutation {
            path: root.relative_display(&target),
            kind: "dir".to_owned(),
            size: 0,
        });
    }
    fs::remove_file(&target)
        .map_err(|error| FileError::io(IO_FAILURE, format!("删除失败：{relative}"), &error))?;
    Ok(FileMutation {
        path: root.relative_display(&target),
        kind: "file".to_owned(),
        size: metadata.len(),
    })
}

fn ensure_content_fits(content: &str) -> Result<(), FileError> {
    if content.len() > MAX_WRITE_BYTES {
        return Err(FileError::new(
            CONTENT_TOO_LARGE,
            format!("内容超过 {} MiB 上限", MAX_WRITE_BYTES / (1024 * 1024)),
        ));
    }
    Ok(())
}

pub fn search(root: &FileRoot, query: &str, limit: usize) -> Result<FileSearchResult, FileError> {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return Err(FileError::new(QUERY_EMPTY, "搜索关键词不能为空".to_owned()));
    }
    let started = Instant::now();
    let mut hits: Vec<FileSearchHit> = Vec::new();
    let mut scanned_files = 0u64;
    let mut skipped_files = 0u64;
    let mut truncated = false;
    // 显式栈的深度优先遍历：深度、文件数、命中数三重上限，绝不走遍整盘。
    let mut stack: Vec<(PathBuf, usize)> = vec![(root.root().to_path_buf(), 0)];
    'walk: while let Some((directory, depth)) = stack.pop() {
        if depth > MAX_SEARCH_DEPTH {
            skipped_files += 1;
            continue;
        }
        let Ok(reader) = fs::read_dir(&directory) else {
            skipped_files += 1;
            continue;
        };
        for entry in reader.flatten() {
            let Ok(file_type) = entry.file_type() else {
                skipped_files += 1;
                continue;
            };
            if file_type.is_symlink() {
                skipped_files += 1;
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if file_type.is_dir() {
                if SKIPPED_DIRS.contains(&name.to_lowercase().as_str()) {
                    skipped_files += 1;
                    continue;
                }
                stack.push((entry.path(), depth + 1));
                continue;
            }
            if !file_type.is_file() {
                continue;
            }
            if scanned_files as usize >= MAX_SEARCH_FILES {
                truncated = true;
                break 'walk;
            }
            scanned_files += 1;
            let remaining = limit.saturating_sub(hits.len());
            if remaining == 0 {
                truncated = true;
                break 'walk;
            }
            match scan_file(root, &entry.path(), &needle, remaining) {
                // None 表示二进制或不可读：计入跳过数，不算扫描失败。
                Some(mut found) => hits.append(&mut found),
                None => skipped_files += 1,
            }
            if hits.len() >= limit {
                truncated = true;
                break 'walk;
            }
        }
    }
    // 遍历顺序由 readdir 决定：排序后返回，UI 与测试都能得到稳定结果。
    hits.sort_by(|left, right| {
        left.path
            .cmp(&right.path)
            .then_with(|| left.line.cmp(&right.line))
    });
    Ok(FileSearchResult {
        query: query.trim().to_owned(),
        hits,
        scanned_files,
        skipped_files,
        truncated,
        took_ms: started.elapsed().as_millis() as u64,
    })
}

/// 扫描单个文件；None 表示按二进制/不可读跳过（不计入命中）。
///
/// 只读一次：二进制判定用同一段已读入的字节，不为「计数」二次打开文件。
fn scan_file(
    root: &FileRoot,
    path: &Path,
    needle: &str,
    limit: usize,
) -> Option<Vec<FileSearchHit>> {
    let file = File::open(path).ok()?;
    let mut buffer = Vec::new();
    file.take(MAX_SEARCH_FILE_BYTES)
        .read_to_end(&mut buffer)
        .ok()?;
    if buffer.iter().take(8 * 1024).any(|byte| *byte == 0) {
        return None;
    }
    let relative = root.relative_display(path);
    let text = String::from_utf8_lossy(&buffer);
    let mut hits = Vec::new();
    for (index, line) in text.lines().enumerate() {
        if hits.len() >= limit {
            break;
        }
        if !line.to_lowercase().contains(needle) {
            continue;
        }
        // 预览去掉行首缩进后再高亮：偏移必须在**预览**里重新定位，否则高亮会错位。
        let preview: String = line.trim().chars().take(MAX_HIT_PREVIEW_CHARS).collect();
        let preview_lower = preview.to_lowercase();
        let (match_start, match_end) = match preview_lower.find(needle) {
            Some(found) => {
                let start = preview_lower[..found].chars().count();
                (start, start + needle.chars().count())
            }
            // 命中的部分被 160 字符上限切掉：退化成「不额外高亮」，仍返回该行。
            None => (0, 0),
        };
        hits.push(FileSearchHit {
            path: relative.clone(),
            line: index as u64 + 1,
            preview,
            match_start: match_start as u32,
            match_end: match_end as u32,
        });
    }
    Some(hits)
}
