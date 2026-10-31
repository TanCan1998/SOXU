//! 扩展 / 技能 / Pi 包的发现规则（Issue #147）。
//!
//! 这里只回答「Pi 会加载哪些资源、哪些被 settings 关掉了」，不写任何配置：
//! 启停属于 Pi 的配置所有权，SOXU 只把状态显示出来。

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

use super::entry::{
    builtin_name, clip, display_path, file_name_of, is_excluded, is_exclusion, package_name,
    read_json, read_skill_meta, resolve_entry, resolve_inside,
};
use super::{BUILTIN_EXTENSIONS, EXTENSION_FILE_SUFFIXES, EXTENSION_INDEX_FILES, MAX_SKILL_DEPTH};
use crate::dto::{ExtensionItem, ExtensionSource, SkillItem};

// ── 扩展 ────────────────────────────────────────────────────────

pub(super) fn scan_builtin_extensions(entries: &[String]) -> BTreeMap<String, ExtensionItem> {
    let mut names: BTreeSet<String> = BUILTIN_EXTENSIONS
        .iter()
        .map(|name| (*name).to_owned())
        .collect();
    for entry in entries {
        if let Some(name) = builtin_name(entry) {
            names.insert(name.to_owned());
        }
    }
    names
        .into_iter()
        .map(|name| {
            let id = format!("builtin:{name}");
            let enabled = !entries
                .iter()
                .any(|entry| is_exclusion(entry) && builtin_name(entry) == Some(name.as_str()));
            (
                id.clone(),
                ExtensionItem {
                    id,
                    name,
                    source: ExtensionSource::Builtin,
                    enabled,
                    description: None,
                    path: None,
                },
            )
        })
        .collect()
}

pub(super) fn scan_user_extensions(
    agent_dir: &Path,
    entries: &[String],
) -> BTreeMap<String, ExtensionItem> {
    let mut items = BTreeMap::new();
    for path in extension_candidates(&agent_dir.join("extensions")) {
        insert_extension(&mut items, &path, entries, agent_dir);
    }
    // settings 里额外声明的扩展（+path 或裸路径）：不在 extensions/ 目录里也照样列出。
    for entry in entries.iter().filter(|entry| !is_exclusion(entry)) {
        if builtin_name(entry).is_some() {
            continue;
        }
        let Some(path) = resolve_entry(entry, agent_dir) else {
            continue;
        };
        if extension_entry_name(&path).is_some() {
            insert_extension(&mut items, &path, entries, agent_dir);
        }
    }
    items
}

fn insert_extension(
    items: &mut BTreeMap<String, ExtensionItem>,
    path: &Path,
    entries: &[String],
    agent_dir: &Path,
) {
    let Some(name) = extension_entry_name(path) else {
        return;
    };
    let id = format!("extension:{name}");
    let enabled = !is_excluded(entries, Some(path), &[&name], agent_dir);
    items.entry(id.clone()).or_insert_with(|| ExtensionItem {
        id,
        name,
        source: ExtensionSource::User,
        enabled,
        description: None,
        path: Some(display_path(path)),
    });
}

/// extensions/ 下的候选入口：单文件扩展与带 index.* 的目录扩展。
fn extension_candidates(root: &Path) -> Vec<PathBuf> {
    let Ok(read_dir) = fs::read_dir(root) else {
        return Vec::new();
    };
    let mut paths: Vec<PathBuf> = read_dir
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| extension_entry_name(path).is_some())
        .collect();
    paths.sort();
    paths
}

/// 一个路径是否是 Pi 认的扩展入口；是则返回展示用的名字。
fn extension_entry_name(path: &Path) -> Option<String> {
    let metadata = fs::metadata(path).ok()?;
    if metadata.is_file() {
        let suffix = path.extension().and_then(|value| value.to_str())?;
        if !EXTENSION_FILE_SUFFIXES
            .iter()
            .any(|known| suffix.eq_ignore_ascii_case(known))
        {
            return None;
        }
        return path
            .file_stem()
            .and_then(|value| value.to_str())
            .map(str::to_owned);
    }
    if metadata.is_dir()
        && EXTENSION_INDEX_FILES
            .iter()
            .any(|index| path.join(index).is_file())
    {
        return file_name_of(path);
    }
    None
}

// ── 技能 ────────────────────────────────────────────────────────

pub(super) fn scan_user_skills(
    agent_dir: &Path,
    entries: &[String],
) -> BTreeMap<String, SkillItem> {
    let mut items = BTreeMap::new();
    let mut roots = vec![agent_dir.join("skills")];
    for entry in entries.iter().filter(|entry| !is_exclusion(entry)) {
        if let Some(path) = resolve_entry(entry, agent_dir) {
            roots.push(path);
        }
    }
    for root in roots {
        for dir in skill_dirs(&root) {
            insert_skill(&mut items, &dir, None, entries, agent_dir);
        }
    }
    items
}

/// 找出一个根目录下的技能目录（Pi 的发现规则：目录里有 SKILL.md）。
fn skill_dirs(root: &Path) -> Vec<PathBuf> {
    if root.is_file() {
        // settings 里可能直接指向某个 SKILL.md。
        if file_name_of(root).as_deref() == Some("SKILL.md") {
            return root.parent().map(Path::to_path_buf).into_iter().collect();
        }
        return Vec::new();
    }
    if !root.is_dir() {
        return Vec::new();
    }
    if root.join("SKILL.md").is_file() {
        return vec![root.to_path_buf()];
    }
    let mut found = Vec::new();
    collect_nested_skill_dirs(root, 1, &mut found);
    found
}

fn collect_nested_skill_dirs(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth > MAX_SKILL_DEPTH {
        return;
    }
    let Ok(read_dir) = fs::read_dir(dir) else {
        return;
    };
    let mut children: Vec<PathBuf> = read_dir
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            fs::metadata(path)
                .map(|meta| meta.is_dir())
                .unwrap_or(false)
        })
        .collect();
    children.sort();
    for child in children {
        if child.join("SKILL.md").is_file() {
            // 技能目录里不再往下找嵌套技能：Pi 也把一个技能当一个整体。
            out.push(child);
        } else {
            collect_nested_skill_dirs(&child, depth + 1, out);
        }
    }
}

fn insert_skill(
    items: &mut BTreeMap<String, SkillItem>,
    dir: &Path,
    package: Option<&str>,
    entries: &[String],
    agent_dir: &Path,
) {
    let folder = file_name_of(dir).unwrap_or_default();
    let (declared, description) = read_skill_meta(&dir.join("SKILL.md"));
    let name = declared.filter(|value| !value.is_empty()).unwrap_or(folder);
    if name.is_empty() {
        return;
    }
    let id = match package {
        Some(package) => format!("skill:{package}/{name}"),
        None => format!("skill:{name}"),
    };
    let enabled = !is_excluded(entries, Some(dir), &[&name], agent_dir);
    items.entry(id.clone()).or_insert_with(|| SkillItem {
        id,
        name,
        description,
        enabled,
        path: display_path(dir),
    });
}

// ── Pi 包（settings.packages）───────────────────────────────────

pub(super) struct PackageScan {
    pub(super) extensions: BTreeMap<String, ExtensionItem>,
    pub(super) skills: BTreeMap<String, SkillItem>,
}

/// 包声明里的资源筛选：None = 未声明（加载包允许的全部），
/// Some(false) = 空数组（这一类资源全不加载），Some(true) = 有筛选但非空。
#[derive(Default)]
struct PackageFilters {
    extensions: Option<bool>,
    skills: Option<bool>,
}

impl PackageFilters {
    fn from_object(object: &Map<String, Value>) -> Self {
        let flag = |key: &str| {
            object
                .get(key)
                .and_then(Value::as_array)
                .map(|items| !items.is_empty())
        };
        Self {
            extensions: flag("extensions"),
            skills: flag("skills"),
        }
    }

    fn allows_extensions(&self) -> bool {
        self.extensions != Some(false)
    }

    fn allows_skills(&self) -> bool {
        self.skills != Some(false)
    }
}

pub(super) fn scan_packages(
    agent_dir: &Path,
    settings: &Value,
    extension_entries: &[String],
    skill_entries: &[String],
) -> PackageScan {
    let mut extensions = BTreeMap::new();
    let mut skills = BTreeMap::new();
    let Some(declared) = settings.get("packages").and_then(Value::as_array) else {
        return PackageScan { extensions, skills };
    };

    for entry in declared {
        let (source, filters) = match entry {
            Value::String(source) => (source.clone(), PackageFilters::default()),
            Value::Object(object) => {
                let Some(source) = object.get("source").and_then(Value::as_str) else {
                    continue;
                };
                (source.to_owned(), PackageFilters::from_object(object))
            }
            _ => continue,
        };
        let name = package_name(&source);
        if name.is_empty() {
            continue;
        }
        let dir = npm_package_dir(agent_dir, &source);

        // 包目录不存在时（未安装 / git 来源）仍然列出来：声明本身是真实配置，
        // 只是没有本地路径可读，因此描述为空、path 为 null。
        let manifest = dir
            .as_deref()
            .map(read_package_manifest)
            .unwrap_or_default();

        if filters.allows_extensions() && (dir.is_none() || manifest.declares_extensions) {
            let id = format!("package:{name}");
            let enabled = !is_excluded(extension_entries, dir.as_deref(), &[&name], agent_dir);
            extensions
                .entry(id.clone())
                .or_insert_with(|| ExtensionItem {
                    id,
                    name: name.clone(),
                    source: ExtensionSource::User,
                    enabled,
                    description: manifest.description.clone(),
                    path: dir.as_deref().map(display_path),
                });
        }

        if filters.allows_skills()
            && let Some(dir) = dir.as_deref()
        {
            for root in manifest.skill_roots(dir) {
                for skill in skill_dirs(&root) {
                    insert_skill(&mut skills, &skill, Some(&name), skill_entries, agent_dir);
                }
            }
        }
    }

    PackageScan { extensions, skills }
}

#[derive(Default)]
struct PackageManifest {
    description: Option<String>,
    /// 这个包是否带扩展：manifest 里的 pi.extensions 非空，或存在约定的 extensions/ 目录。
    declares_extensions: bool,
    /// 包内技能根目录（manifest 里写死的路径 + 约定目录 skills/）。
    skills: Vec<String>,
    conventional_extensions: bool,
    conventional_skills: bool,
}

impl PackageManifest {
    fn skill_roots(&self, dir: &Path) -> Vec<PathBuf> {
        let mut roots: Vec<PathBuf> = self
            .skills
            .iter()
            .filter_map(|relative| resolve_inside(dir, relative))
            .collect();
        if self.conventional_skills {
            roots.push(dir.join("skills"));
        }
        roots
    }
}

fn read_package_manifest(dir: &Path) -> PackageManifest {
    let mut manifest = PackageManifest {
        conventional_extensions: dir.join("extensions").is_dir(),
        conventional_skills: dir.join("skills").is_dir(),
        ..PackageManifest::default()
    };
    let value = read_json(&dir.join("package.json"), "包的 package.json")
        .ok()
        .flatten();
    let Some(value) = value else {
        manifest.declares_extensions = manifest.conventional_extensions;
        return manifest;
    };
    manifest.description = value.get("description").and_then(Value::as_str).map(clip);
    let pi = value.get("pi");
    let declared = |key: &str| {
        pi.and_then(|pi| pi.get(key))
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    };
    manifest.skills = declared("skills");
    manifest.declares_extensions =
        !declared("extensions").is_empty() || manifest.conventional_extensions;
    manifest
}

/// npm 包在 Pi 的 npm 目录里的位置：agent 目录/npm/node_modules/包名。
fn npm_package_dir(agent_dir: &Path, source: &str) -> Option<PathBuf> {
    let spec = source.strip_prefix("npm:")?;
    let name = package_name(source);
    if name.is_empty() || spec.is_empty() {
        return None;
    }
    let dir = resolve_inside(&agent_dir.join("npm").join("node_modules"), &name)?;
    dir.is_dir().then_some(dir)
}
