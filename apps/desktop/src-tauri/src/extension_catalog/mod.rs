//! Pi 扩展目录的只读扫描（Issue #147）：设置页「扩展」展示本机真实配置。
//!
//! 边界（AGENTS.md：Pi 拥有扩展 / 技能 / MCP 配置的所有权，SOXU 不重新实现内核）：
//! - 只读：本模块只有 metadata / read_dir / read_to_string，没有任何写调用；
//!   启停由 Pi 的配置决定，SOXU 只把读到的状态显示出来。
//! - 白名单目录：只读 agent 目录下的 settings.json、mcp.json、extensions/、
//!   skills/ 与 settings 声明的 npm 包目录；命令层不接受前端传路径。
//! - 不读凭据：mcp.json 里只取 name / type / description，
//!   headers 与 env（常有 token）一律不读不传。
//! - 不猜状态：MCP 连接状态只读拿不到，固定返回 unknown，界面显示「未知」。
//! - 不猜开关：enabled 全部由 settings 里的 -path / !pattern / -builtin:x
//!   与包声明里的空数组推导；没有依据就按 Pi 的默认行为（加载）处理。

mod entry;
mod mcp;
mod resources;
#[cfg(test)]
mod tests;

use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::dto::{ExtensionCatalog, ExtensionDetail, ExtensionItem, ExtensionSource};

use entry::{count_files, display_path, read_json, string_list};
use mcp::scan_mcp_servers;
use resources::{scan_builtin_extensions, scan_packages, scan_user_extensions, scan_user_skills};

/// Pi 文档列出的内置扩展名（docs/settings.md → Resources）。
/// settings 里出现的其它 builtin: 名字也会一并列出，避免 Pi 升级后这里过期。
const BUILTIN_EXTENSIONS: [&str; 4] = ["codemode", "llama.cpp", "mcp", "tool-search"];
/// 扩展入口文件的后缀：Pi 直接加载 TypeScript / JavaScript 文件。
const EXTENSION_FILE_SUFFIXES: [&str; 4] = ["ts", "js", "mjs", "cjs"];
/// 目录形式的扩展入口（Pi 只认这些文件名）。
const EXTENSION_INDEX_FILES: [&str; 4] = ["index.ts", "index.js", "index.mjs", "index.cjs"];
/// 单个 JSON 配置的读取上限：settings.json / mcp.json / package.json 都是小文件。
const MAX_JSON_BYTES: u64 = 1024 * 1024;
/// SKILL.md 只读前 64 KiB 就够解析 frontmatter。
const MAX_SKILL_MD_BYTES: u64 = 64 * 1024;
/// 描述长度上限：npm 包描述可能上千字，界面按两行截断，这里再兜一层。
const MAX_DESCRIPTION_CHARS: usize = 400;
/// 详情统计文件数的上限：技能目录里可能有 node_modules，必须有界。
const MAX_COUNTED_FILES: u32 = 2000;
/// 递归发现技能目录的深度上限。
const MAX_SKILL_DEPTH: usize = 3;

/// Pi 的配置目录：PI_CODING_AGENT_DIR（Pi 官方变量）→ SOXU_PI_AGENT_DIR（测试与自定义布局）
/// → 默认 ~/.pi/agent。
///
/// 优先跟随 Pi 自己的变量，是为了「Pi 改了目录，SOXU 读的还是同一份配置」。
pub fn agent_dir() -> Result<PathBuf, String> {
    for key in ["PI_CODING_AGENT_DIR", "SOXU_PI_AGENT_DIR"] {
        if let Some(value) = env::var_os(key)
            && !value.is_empty()
        {
            return Ok(PathBuf::from(value));
        }
    }
    let home = env::var_os("HOME").or_else(|| env::var_os("USERPROFILE"));
    let Some(home) = home.filter(|value| !value.is_empty()) else {
        return Err(
            "无法确定用户主目录（HOME / USERPROFILE 都未设置），因此读不到 Pi 的配置目录"
                .to_owned(),
        );
    };
    Ok(PathBuf::from(home).join(".pi").join("agent"))
}

/// 扫描默认配置目录（命令层入口）。
pub fn list() -> Result<ExtensionCatalog, String> {
    scan(&agent_dir()?)
}

/// 扫描指定配置目录。目录不存在 / 不是目录 / 配置无法解析都返回明确错误，
/// 绝不返回空列表冒充「本机没有装扩展」。
pub fn scan(agent_dir: &Path) -> Result<ExtensionCatalog, String> {
    let metadata = fs::metadata(agent_dir).map_err(|error| {
        format!(
            "读不到 Pi 的配置目录 {}（{error}）：请先在本机运行一次 Pi，或用 PI_CODING_AGENT_DIR 指定目录",
            agent_dir.display()
        )
    })?;
    if !metadata.is_dir() {
        return Err(format!("Pi 的配置目录不是文件夹：{}", agent_dir.display()));
    }

    // 顶层不是对象说明这份配置被写坏了：报错，而不是当成「什么都没配」。
    let settings = read_json(&agent_dir.join("settings.json"), "Pi 设置文件")?;
    let settings = require_object(settings, "Pi 设置文件", &agent_dir.join("settings.json"))?;
    let mcp = read_json(&agent_dir.join("mcp.json"), "MCP 配置")?;
    let mcp = require_object(mcp, "MCP 配置", &agent_dir.join("mcp.json"))?;

    let extension_entries = string_list(&settings, "extensions");
    let skill_entries = string_list(&settings, "skills");

    let mut extensions = scan_builtin_extensions(&extension_entries);
    extensions.extend(scan_user_extensions(agent_dir, &extension_entries));
    let mut skills = scan_user_skills(agent_dir, &skill_entries);
    let packages = scan_packages(agent_dir, &settings, &extension_entries, &skill_entries);
    extensions.extend(packages.extensions);
    skills.extend(packages.skills);

    let mut extensions: Vec<ExtensionItem> = extensions.into_values().collect();
    sort_extensions(&mut extensions);

    Ok(ExtensionCatalog {
        agent_dir: display_path(agent_dir),
        extensions,
        skills: skills.into_values().collect(),
        mcp_servers: scan_mcp_servers(&mcp),
    })
}

/// 展开一条技能 / 扩展的详情（按需调用）：目前只有真实文件数需要额外一次遍历。
pub fn detail(id: &str) -> Result<ExtensionDetail, String> {
    detail_in(&agent_dir()?, id)
}

/// 展开详情的可测版本。
pub fn detail_in(agent_dir: &Path, id: &str) -> Result<ExtensionDetail, String> {
    let catalog = scan(agent_dir)?;

    let (name, path, description) =
        if let Some(item) = catalog.extensions.iter().find(|item| item.id == id) {
            (
                item.name.clone(),
                item.path.clone(),
                item.description.clone(),
            )
        } else if let Some(item) = catalog.skills.iter().find(|item| item.id == id) {
            (
                item.name.clone(),
                Some(item.path.clone()),
                item.description.clone(),
            )
        } else {
            return Err(format!(
                "找不到 id 为「{id}」的扩展或技能：本机配置可能已经变化，请刷新后重试"
            ));
        };

    let Some(path) = path else {
        return Err(format!(
            "「{name}」只有 settings.json 里的声明，本机没有可统计的目录（来源：远程包）"
        ));
    };
    let (file_count, file_count_truncated) = count_files(Path::new(&path))?;
    Ok(ExtensionDetail {
        id: id.to_owned(),
        name,
        path,
        file_count,
        file_count_truncated,
        description,
    })
}

/// 配置文件的顶层必须是对象；文件不存在时返回 Null（等同于「没有这一项配置」）。
fn require_object(value: Option<Value>, label: &str, path: &Path) -> Result<Value, String> {
    match value {
        None => Ok(Value::Null),
        Some(value @ Value::Object(_)) => Ok(value),
        Some(_) => Err(format!(
            "{label}的顶层必须是 {{ \"key\": ... }} 对象：{}",
            path.display()
        )),
    }
}

fn sort_extensions(items: &mut [ExtensionItem]) {
    items.sort_by(|a, b| {
        let rank = |source: ExtensionSource| match source {
            ExtensionSource::Builtin => 0,
            ExtensionSource::User => 1,
        };
        rank(a.source)
            .cmp(&rank(b.source))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
}
