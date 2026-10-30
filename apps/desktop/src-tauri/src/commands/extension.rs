//! 语言包命令（Issue #135）：列出 / 读取 / 保存 / 删除 / 读取用户选中的源文件。
//!
//! 只做参数映射：标签校验、大小上限与文件读写都在 crate::locale_store 里，
//! 命令层不重复实现规则，也不在这里拼接路径。

use tauri::State;

use crate::dto::LocalePackList;
use crate::locale_store::{self, LocaleStore};

#[tauri::command]
pub async fn list_locale_packs(store: State<'_, LocaleStore>) -> Result<LocalePackList, String> {
    Ok(LocalePackList {
        directory: store.directory(),
        tags: store.list()?,
    })
}

#[tauri::command]
pub async fn read_locale_pack(
    store: State<'_, LocaleStore>,
    tag: String,
) -> Result<String, String> {
    store.read(&tag)
}

#[tauri::command]
pub async fn save_locale_pack(
    store: State<'_, LocaleStore>,
    tag: String,
    json: String,
) -> Result<(), String> {
    store.save(&tag, &json)
}

#[tauri::command]
pub async fn delete_locale_pack(
    store: State<'_, LocaleStore>,
    tag: String,
) -> Result<bool, String> {
    store.delete(&tag)
}

#[tauri::command]
pub async fn read_locale_source(path: String) -> Result<String, String> {
    locale_store::read_source(&path)
}
