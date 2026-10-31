//! 扩展页扫描用到的路径与文本工具（Issue #147）。
//!
//! 单独成文件的原因：路径守卫、排除项匹配、frontmatter 解析都是纯逻辑，
//! 与「怎么扫描目录」分开后各自可以被单测直接覆盖，模块也不会膨胀成一个千行文件。

use std::fs;
use std::path::{Component, Path, PathBuf};

use serde_json::Value;

use super::{MAX_COUNTED_FILES, MAX_DESCRIPTION_CHARS, MAX_JSON_BYTES, MAX_SKILL_MD_BYTES};

// ── 共用工具 ────────────────────────────────────────────────────

pub(super) fn read_json(path: &Path, label: &str) -> Result<Option<Value>, String> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("无法读取{label} {}：{error}", path.display())),
    };
    if !metadata.is_file() {
        return Err(format!("{label}不是普通文件：{}", path.display()));
    }
    if metadata.len() > MAX_JSON_BYTES {
        return Err(format!(
            "{label}过大：{} 字节，上限 {MAX_JSON_BYTES} 字节（{}）",
            metadata.len(),
            path.display()
        ));
    }
    let text = fs::read_to_string(path)
        .map_err(|error| format!("无法读取{label} {}：{error}", path.display()))?;
    let value: Value = serde_json::from_str(&text)
        .map_err(|error| format!("无法解析{label} {}：{error}", path.display()))?;
    Ok(Some(value))
}

pub(super) fn string_list(value: &Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

/// -path / !pattern 是排除项；+path 与裸路径是包含项。
pub(super) fn is_exclusion(entry: &str) -> bool {
    entry.starts_with('-') || entry.starts_with('!')
}

pub(super) fn builtin_name(entry: &str) -> Option<&str> {
    entry
        .trim_start_matches(['+', '-', '!'])
        .strip_prefix("builtin:")
}

/// 一条排除项是否命中某个扩展 / 技能。
///
/// 路径比较做双向前缀：settings 里的排除项可能写到 SKILL.md 这一层，
/// 而条目记的是技能目录，两种写法都必须命中。
pub(super) fn is_excluded(
    entries: &[String],
    path: Option<&Path>,
    names: &[&str],
    agent_dir: &Path,
) -> bool {
    entries
        .iter()
        .filter(|entry| is_exclusion(entry))
        .any(|entry| {
            let value = entry.trim_start_matches(['-', '!']).trim();
            if names.iter().any(|name| value.eq_ignore_ascii_case(name)) {
                return true;
            }
            let (Some(path), Some(candidate)) = (path, resolve_entry(value, agent_dir)) else {
                return false;
            };
            let item = normalize_key(&display_path(path));
            let target = normalize_key(&display_path(&candidate));
            item == target
                || item.starts_with(&format!("{target}/"))
                || target.starts_with(&format!("{item}/"))
        })
}

/// 把配置里的一条资源路径解析成绝对路径。相对路径按 Pi 的规则从配置目录解析。
pub(super) fn resolve_entry(value: &str, agent_dir: &Path) -> Option<PathBuf> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    // 通配符由 Pi 自己展开：SOXU 不实现 glob，宁可少判一个排除项，也不假装支持。
    if value.contains(['*', '?', '[', '{']) {
        return None;
    }
    let path = Path::new(value);
    let resolved = if path.is_absolute() {
        path.to_path_buf()
    } else {
        agent_dir.join(path)
    };
    if resolved
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return None;
    }
    Some(resolved)
}

/// 相对路径解析成 base 下的路径；越界（.. / 绝对路径）一律拒绝。
/// 相对路径解析成 base 下的路径；越界（.. / 绝对路径）一律拒绝。
pub(super) fn resolve_inside(base: &Path, relative: &str) -> Option<PathBuf> {
    let path = Path::new(relative);
    if path.is_absolute() {
        return None;
    }
    let mut resolved = base.to_path_buf();
    for component in path.components() {
        match component {
            Component::Normal(part) => resolved.push(part),
            // ./ 这种写法在包的 manifest 里很常见，展开成干净路径。
            Component::CurDir => {}
            _ => return None,
        }
    }
    Some(resolved)
}

pub(super) fn count_files(root: &Path) -> Result<(u32, bool), String> {
    let metadata =
        fs::metadata(root).map_err(|error| format!("无法读取 {}：{error}", root.display()))?;
    if metadata.is_file() {
        return Ok((1, false));
    }
    let mut count = 0u32;
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(read_dir) = fs::read_dir(&dir) else {
            // 子目录不可读不影响已统计的部分：数出来的仍然是真实文件数。
            continue;
        };
        for entry in read_dir.flatten() {
            if count >= MAX_COUNTED_FILES {
                return Ok((count, true));
            }
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_dir() {
                stack.push(entry.path());
            } else if file_type.is_file() {
                count += 1;
            }
        }
    }
    Ok((count, false))
}

pub(super) fn file_name_of(path: &Path) -> Option<String> {
    path.file_name()
        .and_then(|value| value.to_str())
        .map(str::to_owned)
}

pub(super) fn display_path(path: &Path) -> String {
    let text = path.to_string_lossy();
    // Windows 的 \\?\ 前缀对用户没有意义，展示时去掉。
    match text.strip_prefix(r"\\?\") {
        Some(rest) => rest.to_owned(),
        None => text.into_owned(),
    }
}

pub(super) fn normalize_key(path: &str) -> String {
    let unified = path.replace('\\', "/");
    if cfg!(windows) {
        unified.to_lowercase()
    } else {
        unified
    }
}

pub(super) fn clip(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= MAX_DESCRIPTION_CHARS {
        return trimmed.to_owned();
    }
    let mut out: String = trimmed.chars().take(MAX_DESCRIPTION_CHARS).collect();
    out.push('…');
    out
}

/// 读取 SKILL.md 的 frontmatter（只用展示需要的 name / description）。
/// 解析失败不是错误：Pi 会给出自己的告警，SOXU 只是少一行描述。
pub(super) fn read_skill_meta(path: &Path) -> (Option<String>, Option<String>) {
    let Ok(metadata) = fs::metadata(path) else {
        return (None, None);
    };
    if !metadata.is_file() || metadata.len() > MAX_SKILL_MD_BYTES {
        return (None, None);
    }
    let Ok(text) = fs::read_to_string(path) else {
        return (None, None);
    };
    parse_frontmatter(&text)
}

/// 解析 SKILL.md 的 YAML frontmatter（只取展示需要的 name / description）。
///
/// 支持两种真实写法：单行值，以及块标量（description: |- 换行缩进），
/// 后者在技能库里很常见，把 "|-" 当描述显示出去就是在编数据。
pub(super) fn parse_frontmatter(text: &str) -> (Option<String>, Option<String>) {
    let text = text.trim_start_matches('\u{feff}');
    let lines: Vec<&str> = text.lines().collect();
    if lines.first().map(|line| line.trim()) != Some("---") {
        return (None, None);
    }
    let mut name = None;
    let mut description = None;
    let mut closed = false;
    let mut index = 1;
    while index < lines.len() {
        let trimmed = lines[index].trim();
        index += 1;
        if trimmed == "---" {
            closed = true;
            break;
        }
        let Some((key, value)) = trimmed.split_once(':') else {
            continue;
        };
        let value = frontmatter_value(value.trim(), &lines, &mut index);
        if value.is_empty() {
            continue;
        }
        match key.trim() {
            "name" if name.is_none() => name = Some(clip(&value)),
            "description" if description.is_none() => description = Some(clip(&value)),
            _ => {}
        }
    }
    // 没有闭合的 --- 说明这不是一份完整 frontmatter：宁可没有描述，也不猜。
    if !closed {
        return (None, None);
    }
    (name, description)
}

/// 取一个 frontmatter 值：块标量吃掉后续缩进行，单行值去掉引号。
fn frontmatter_value(raw: &str, lines: &[&str], index: &mut usize) -> String {
    if !matches!(raw, "|" | "|-" | "|+" | ">" | ">-" | ">+") {
        return raw.trim_matches(['"', '\'']).to_owned();
    }
    let mut parts: Vec<&str> = Vec::new();
    while *index < lines.len() {
        let line = lines[*index];
        let content = line.trim();
        if !content.is_empty() && !line.starts_with([' ', '\t']) {
            break;
        }
        *index += 1;
        if !content.is_empty() {
            parts.push(content);
        }
    }
    parts.join(" ")
}

pub(super) fn package_name(source: &str) -> String {
    let body = source.trim();
    if let Some(spec) = body.strip_prefix("npm:") {
        // 版本用最后一个 @ 分隔；作用域包以 @ 开头，不能把开头那个当成版本。
        return match spec.rfind('@') {
            Some(index) if index > 0 => spec[..index].to_owned(),
            _ => spec.to_owned(),
        };
    }
    body.strip_prefix("git:").unwrap_or(body).to_owned()
}
