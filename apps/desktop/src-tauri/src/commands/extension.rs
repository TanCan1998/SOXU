//! 扩展领域命令：语言包（Issue #135）与扩展页真数据（Issue #147）。
//!
//! 语言包命令只做参数映射：标签校验、大小上限与文件读写都在 crate::locale_store 里。
//! 扩展命令同理：目录白名单、排除项匹配与文件数统计都在 crate::extension_catalog 里，
//! 命令层不拼接路径，也不接受前端传来的路径。
//!
//! **只读**：这里没有任何写 Pi 配置的命令（无 set_ / save_ 类 Pi 写回入口）。
//! 扩展与技能的启停属于 Pi 的配置所有权，SOXU 只显示读到的状态。

use tauri::State;

use crate::dto::{ExtensionCatalog, ExtensionDetail, LocalePackList};
use crate::extension_catalog;
use crate::locale_store::{self, LocaleStore};

/// 列出本机 Pi 的扩展 / 技能 / MCP 服务（只读）。
///
/// 扫描固定白名单目录（PI_CODING_AGENT_DIR 或默认 ~/.pi/agent），不接受前端传路径；
/// 目录不存在或配置无法解析时返回明确错误，不返回空列表冒充成功。
///
/// 扫描本身是同步文件 IO，但只读几个目录 + 小 JSON，量级与列语言包目录相同；
/// 详情里的大目录统计有 2000 个文件的上限，不会把 UI 线程拖住。
#[tauri::command]
pub async fn list_extensions() -> Result<ExtensionCatalog, String> {
    extension_catalog::list()
}

/// 展开一条扩展 / 技能的详情（按需调用，目前只有技能目录的真实文件数）。
///
/// id 必须来自 list_extensions 的返回值：命令层不解析路径，越权访问无从发生。
#[tauri::command]
pub async fn read_extension_detail(id: String) -> Result<ExtensionDetail, String> {
    extension_catalog::detail(&id)
}

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
