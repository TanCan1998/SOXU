//! 小文件读写：原子替换 + 容错读取。
//!
//! 快照与目录元数据都必须可被突然中断的写入打断而不破坏上一次的有效内容，
//! 因此统一走 write-temp + rename。

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// 进程内单调计数器：同一进程的多个线程写同一个目标文件时，
/// 临时文件名必须互不相同，否则会互相截断。
static TEMPORARY_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// Windows 覆盖式重命名的重试次数。
const RENAME_ATTEMPTS: usize = 4;

use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::error::{CatalogError, ErrorCode, Result};

fn io_error(path: &Path, error: &std::io::Error) -> CatalogError {
    CatalogError::io(
        ErrorCode::IoFailure,
        format!("文件系统操作失败：{}", path.display()),
        error,
    )
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            CatalogError::io(
                ErrorCode::IoFailure,
                format!("无法创建目录：{}", parent.display()),
                &error,
            )
        })?;
    }
    let temporary = temporary_path(path);
    {
        let mut file =
            fs::File::create(&temporary).map_err(|error| io_error(&temporary, &error))?;
        file.write_all(bytes)
            .map_err(|error| io_error(&temporary, &error))?;
        file.sync_all()
            .map_err(|error| io_error(&temporary, &error))?;
    }
    // Windows 上 rename 不能覆盖已存在的文件：先移除目标再重试。
    // 移除与重命名之间存在窗口，因此重试若干次而不是只试一次；
    // 临时文件名唯一，重试不会让两个写者的内容互相截断。
    let mut last = None;
    for _ in 0..RENAME_ATTEMPTS {
        match fs::rename(&temporary, path) {
            Ok(()) => return Ok(()),
            Err(error) => {
                last = Some(error);
                let _ = fs::remove_file(path);
            }
        }
    }
    let _ = fs::remove_file(&temporary);
    Err(io_error(
        path,
        &last.unwrap_or_else(|| std::io::Error::other("重命名重试次数用尽")),
    ))
}

fn temporary_path(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "snapshot".to_string());
    let sequence = TEMPORARY_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    path.with_file_name(format!(".{name}.{}.{sequence}.tmp", std::process::id()))
}

pub(crate) fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let bytes = serde_json::to_vec(value).map_err(|error| {
        CatalogError::new(
            ErrorCode::MetadataCorrupt,
            format!("序列化快照失败：{} ({error})", path.display()),
        )
    })?;
    write_atomic(path, &bytes)
}

/// 读取 JSON：不存在返回 None；存在但损坏返回错误，由调用方决定重建。
pub(crate) fn read_json<T: DeserializeOwned>(path: &Path) -> Result<Option<T>> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(io_error(path, &error)),
    };
    serde_json::from_slice(&bytes).map(Some).map_err(|error| {
        CatalogError::new(
            ErrorCode::MetadataCorrupt,
            format!("快照无法解析：{} ({error})", path.display()),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_overwrites() {
        let directory = std::env::temp_dir().join(format!("soxu-store-{}", std::process::id()));
        let path = directory.join("value.json");
        write_json(&path, &vec![1_u32, 2, 3]).unwrap_or_else(|error| panic!("{error}"));
        write_json(&path, &vec![9_u32]).unwrap_or_else(|error| panic!("{error}"));
        let loaded: Option<Vec<u32>> = read_json(&path).unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(loaded, Some(vec![9]));
        let _ = fs::remove_dir_all(&directory);
    }

    #[test]
    fn concurrent_writes_to_one_path_stay_parseable() {
        let directory =
            std::env::temp_dir().join(format!("soxu-store-race-{}", std::process::id()));
        let path = directory.join("value.json");
        let mut handles = Vec::new();
        for index in 0..8_u32 {
            let path = path.clone();
            handles.push(std::thread::spawn(move || {
                write_json(&path, &vec![index; index as usize + 1])
            }));
        }
        let mut succeeded = 0;
        for handle in handles {
            let result = handle.join().unwrap_or_else(|_| panic!("写线程不应崩溃"));
            if result.is_ok() {
                succeeded += 1;
            }
        }
        // 覆盖式重命名在极端竞争下允许个别写者放弃，但绝不能留下半截内容。
        assert!(succeeded >= 1, "并发写入至少要有一个写者成功");
        // 无论哪个线程最后落盘，文件都必须是完整可解析的某一版，绝不是半截内容。
        let loaded: Option<Vec<u32>> = read_json(&path).unwrap_or_else(|error| panic!("{error}"));
        let value = loaded.unwrap_or_else(|| panic!("并发写入后文件应存在且可解析"));
        assert_eq!(value.len(), value[0] as usize + 1);
        let leftovers = fs::read_dir(&directory)
            .map(|entries| {
                entries
                    .filter_map(|entry| entry.ok())
                    .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
                    .count()
            })
            .unwrap_or(0);
        assert_eq!(leftovers, 0, "临时文件不应残留");
        let _ = fs::remove_dir_all(&directory);
    }

    #[test]
    fn missing_file_is_not_an_error() {
        let path = std::env::temp_dir().join("soxu-store-missing-xyz.json");
        let loaded: Option<Vec<u32>> = read_json(&path).unwrap_or_else(|error| panic!("{error}"));
        assert!(loaded.is_none());
    }
}
