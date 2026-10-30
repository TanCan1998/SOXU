//! 语言包存储（Issue #135）：社区翻译只落在应用数据目录的 locales/ 下。
//!
//! 单一 owner：语言包的列 / 读 / 写 / 删全部经过 LocaleStore，命令层只做参数映射。
//! 目录既不在仓库里也不在安装目录里：更新应用不会覆盖用户导入的语言包。
//!
//! 安全边界：语言标签会拼进文件名，因此校验是路径穿越的唯一防线——
//! 只允许 ASCII 字母数字与「-」，且必须以小写字母开头。

use std::fs;
use std::path::{Path, PathBuf};

/// 单个语言包的大小上限，与前端 locales/community.ts 的 MAX_LOCALE_PACK_BYTES 一致。
pub const MAX_PACK_BYTES: usize = 256 * 1024;
/// 标签长度上限：真实 BCP 47 标签远短于此，限制只为挡住异常输入。
pub const MAX_TAG_LEN: usize = 32;

pub struct LocaleStore {
    dir: PathBuf,
}

impl LocaleStore {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    /// 语言包目录的绝对路径，设置页展示给用户（用户要能自己备份与分享）。
    pub fn directory(&self) -> String {
        self.dir.to_string_lossy().to_string()
    }

    /// 列出已导入的语言标签；目录不存在时返回空表，不创建目录。
    pub fn list(&self) -> Result<Vec<String>, String> {
        if !self.dir.exists() {
            return Ok(Vec::new());
        }
        let entries = fs::read_dir(&self.dir)
            .map_err(|error| format!("无法读取语言包目录 {}：{error}", self.dir.display()))?;
        let mut tags = Vec::new();
        for entry in entries {
            let entry = entry
                .map_err(|error| format!("无法读取语言包目录 {}：{error}", self.dir.display()))?;
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            // 目录里可能有用户手放的其它文件：只列能通过标签校验的 .json。
            let Some(tag) = path
                .file_name()
                .and_then(|value| value.to_str())
                .and_then(|name| name.strip_suffix(".json"))
            else {
                continue;
            };
            if validate_tag(tag).is_ok() {
                tags.push(tag.to_owned());
            }
        }
        tags.sort();
        Ok(tags)
    }

    pub fn read(&self, tag: &str) -> Result<String, String> {
        let path = self.pack_path(tag)?;
        read_limited(&path, "语言包")
    }

    pub fn save(&self, tag: &str, json: &str) -> Result<(), String> {
        let path = self.pack_path(tag)?;
        if json.trim().is_empty() {
            return Err("语言包内容为空".to_owned());
        }
        if json.len() > MAX_PACK_BYTES {
            return Err(format!(
                "语言包过大：{} 字节，上限 {MAX_PACK_BYTES} 字节",
                json.len()
            ));
        }
        fs::create_dir_all(&self.dir)
            .map_err(|error| format!("无法创建语言包目录 {}：{error}", self.dir.display()))?;
        // 先写临时文件再改名：中途失败不会留下半个 JSON 覆盖掉还能用的语言包。
        let temp = self.dir.join(format!(".{tag}.json.tmp"));
        fs::write(&temp, json)
            .map_err(|error| format!("无法写入语言包 {}：{error}", temp.display()))?;
        // Windows 上 rename 不能覆盖已存在的文件：先删目标再改名。
        if path.exists()
            && let Err(error) = fs::remove_file(&path)
        {
            let _ = fs::remove_file(&temp);
            return Err(format!("无法替换语言包 {}：{error}", path.display()));
        }
        fs::rename(&temp, &path).map_err(|error| {
            let _ = fs::remove_file(&temp);
            format!("无法保存语言包 {}：{error}", path.display())
        })
    }

    pub fn delete(&self, tag: &str) -> Result<bool, String> {
        let path = self.pack_path(tag)?;
        if !path.exists() {
            return Ok(false);
        }
        fs::remove_file(&path)
            .map_err(|error| format!("无法删除语言包 {}：{error}", path.display()))?;
        Ok(true)
    }

    fn pack_path(&self, tag: &str) -> Result<PathBuf, String> {
        validate_tag(tag)?;
        Ok(self.dir.join(format!("{tag}.json")))
    }
}

/// 语言标签校验：小写字母开头，其余为 ASCII 字母数字或「-」。
pub fn validate_tag(tag: &str) -> Result<(), String> {
    let bytes = tag.as_bytes();
    if bytes.is_empty() || bytes.len() > MAX_TAG_LEN {
        return Err(format!("语言标签长度必须在 1..={MAX_TAG_LEN}：{tag}"));
    }
    if !bytes[0].is_ascii_lowercase() {
        return Err(format!("语言标签必须以小写字母开头：{tag}"));
    }
    for byte in bytes {
        if byte.is_ascii_alphanumeric() || *byte == b'-' {
            continue;
        }
        return Err(format!("语言标签只能包含字母、数字与「-」：{tag}"));
    }
    Ok(())
}

/// 读取用户通过系统对话框选中的源文件。
///
/// 路径由用户亲自选择，但命令对前端开放，因此这里仍然只放行 .json 与有界大小，
/// 免得一个被注入的渲染进程能借它读取任意文件。
pub fn read_source(path: &str) -> Result<String, String> {
    let path = Path::new(path);
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if !extension.eq_ignore_ascii_case("json") {
        return Err("只能导入 .json 语言包".to_owned());
    }
    read_limited(path, "语言包源文件")
}

fn read_limited(path: &Path, label: &str) -> Result<String, String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("无法读取{label} {}：{error}", path.display()))?;
    if !metadata.is_file() {
        return Err(format!("{label}不是普通文件：{}", path.display()));
    }
    if metadata.len() > MAX_PACK_BYTES as u64 {
        return Err(format!(
            "{label}过大：{} 字节，上限 {MAX_PACK_BYTES} 字节",
            metadata.len()
        ));
    }
    fs::read_to_string(path).map_err(|error| format!("无法读取{label} {}：{error}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sandbox(name: &str) -> PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or_default();
        let dir = std::env::temp_dir().join(format!("soxu-locales-{name}-{stamp}"));
        fs::create_dir_all(&dir).expect("创建临时目录");
        dir
    }

    #[test]
    fn tag_validation_blocks_path_traversal() {
        for good in ["zh-CN", "en-US", "pt-BR", "ja"] {
            assert!(validate_tag(good).is_ok(), "{good} 应当合法");
        }
        for bad in [
            "",
            "../../etc/passwd",
            "zh-CN/../x",
            "zh CN",
            "zh_CN",
            "ZH-cn",
            ".hidden",
            r"ja-JP\evil",
        ] {
            assert!(validate_tag(bad).is_err(), "{bad} 必须被拒绝");
        }
        assert!(
            validate_tag(&"a".repeat(MAX_TAG_LEN + 1)).is_err(),
            "超长标签必须被拒绝"
        );
    }

    #[test]
    fn save_read_list_delete_roundtrip() {
        let dir = sandbox("roundtrip");
        let store = LocaleStore::new(dir.join("locales"));
        // 目录还不存在时列表为空，不报错也不创建目录。
        assert!(store.list().expect("列目录").is_empty());
        assert!(!dir.join("locales").exists(), "只列不建目录");

        store
            .save("ja-JP", r#"{"common.action.copy":"コピー"}"#)
            .expect("保存");
        store
            .save("pt-BR", r#"{"common.action.copy":"Copiar"}"#)
            .expect("保存");
        assert_eq!(
            store.list().expect("列目录"),
            vec!["ja-JP".to_owned(), "pt-BR".to_owned()],
            "按字母序返回"
        );
        assert_eq!(
            store.read("ja-JP").expect("读取"),
            r#"{"common.action.copy":"コピー"}"#
        );

        // 覆盖写入：不会留下临时文件。
        store
            .save("ja-JP", r#"{"common.action.copy":"コピー2"}"#)
            .expect("覆盖");
        assert!(store.read("ja-JP").expect("读取").contains("コピー2"));
        let leftovers: Vec<_> = fs::read_dir(dir.join("locales"))
            .expect("读目录")
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .filter(|name| name.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "不能留下临时文件：{leftovers:?}");

        assert!(store.delete("ja-JP").expect("删除"));
        assert!(!store.delete("ja-JP").expect("重复删除返回 false"));
        assert_eq!(store.list().expect("列目录"), vec!["pt-BR".to_owned()]);

        // 目录里的非语言包文件不会被列出来。
        fs::write(dir.join("locales").join("notes.txt"), "hi").expect("写普通文件");
        assert_eq!(store.list().expect("列目录"), vec!["pt-BR".to_owned()]);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_rejects_empty_and_oversized_payloads() {
        let dir = sandbox("limits");
        let store = LocaleStore::new(dir.join("locales"));
        assert!(store.save("ja-JP", "   ").is_err(), "空内容必须被拒绝");
        let huge = "x".repeat(MAX_PACK_BYTES + 1);
        assert!(store.save("ja-JP", &huge).is_err(), "超大内容必须被拒绝");
        assert!(store.save("../evil", "{}").is_err(), "非法标签必须被拒绝");
        assert!(!dir.join("locales").join("..").join("evil.json").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_source_only_accepts_small_json_files() {
        let dir = sandbox("source");
        let json = dir.join("ja-JP.json");
        fs::write(&json, r#"{"common.action.copy":"コピー"}"#).expect("写 json");
        assert!(
            read_source(json.to_str().expect("路径"))
                .expect("读取")
                .contains("コピー")
        );

        let text = dir.join("ja-JP.txt");
        fs::write(&text, "{}").expect("写 txt");
        assert!(
            read_source(text.to_str().expect("路径")).is_err(),
            "非 json 必须被拒绝"
        );

        let folder = dir.join("dir.json");
        fs::create_dir_all(&folder).expect("建目录");
        assert!(
            read_source(folder.to_str().expect("路径")).is_err(),
            "目录即使叫 .json 也必须被拒绝"
        );
        assert!(read_source("").is_err(), "空路径必须被拒绝");

        let big = dir.join("big.json");
        fs::write(&big, "x".repeat(MAX_PACK_BYTES + 1)).expect("写大文件");
        assert!(
            read_source(big.to_str().expect("路径")).is_err(),
            "超大文件必须被拒绝"
        );

        let _ = fs::remove_dir_all(&dir);
    }
}
