//! 语言包 DTO（Issue #135）。
//!
//! 字段与 apps/desktop/src/services/localePacks.ts 的 LocalePackList 一一对应。

use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalePackList {
    /// 语言包目录的绝对路径（设置页展示，用户据此备份或分享）。
    pub directory: String,
    /// 已导入的语言标签，后端已按字母序排好。
    pub tags: Vec<String>,
}
