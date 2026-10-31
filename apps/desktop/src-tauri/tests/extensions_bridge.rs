//! 扩展页只读接入的集成测试（Issue #147）。
//!
//! 用临时 agent 目录复刻 Pi 的真实布局：settings.json / mcp.json / extensions/ /
//! skills/ / npm/node_modules/。断言三件事：
//! 1. 列出来的内容与磁盘一致（名字、来源、启停、MCP 传输方式）；
//! 2. 凭据字段（mcp.json 的 headers / env）绝不进 DTO；
//! 3. 扫描是纯读：跑完之后目录里一个字节都没变。

use std::fs;
use std::path::{Path, PathBuf};

use soxu_desktop_lib::extension_catalog;

fn temp_dir(name: &str) -> PathBuf {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or_default();
    let dir = std::env::temp_dir().join(format!("soxu-extensions-{name}-{stamp}"));
    fs::create_dir_all(&dir).expect("创建临时目录");
    dir
}

/// 假凭据在运行时拼接：仓库里不写形似密钥的字面量。
fn fake_secret() -> String {
    format!("{}{}{}", "gh", "p_test_", "0f1e2d3c4b5a6978")
}

fn write_skill(root: &Path, folder: &str, name: &str, description: &str) {
    let dir = root.join(folder);
    fs::create_dir_all(&dir).expect("创建技能目录");
    fs::write(
        dir.join("SKILL.md"),
        format!("---\nname: {name}\ndescription: {description}\n---\n\n# 正文\n"),
    )
    .expect("写 SKILL.md");
    fs::create_dir_all(dir.join("references")).expect("创建技能子目录");
    fs::write(dir.join("references").join("notes.md"), "参考\n").expect("写参考文件");
}

/// 复刻一份本机真实布局的 agent 目录。
fn build_agent_dir(root: &Path) {
    fs::create_dir_all(root.join("extensions")).expect("创建 extensions");
    fs::write(
        root.join("extensions").join("rtk.ts"),
        "export default function () {}\n",
    )
    .expect("写扩展文件");
    fs::create_dir_all(root.join("extensions").join("legacy")).expect("创建无入口的目录");

    fs::create_dir_all(root.join("skills")).expect("创建 skills");
    write_skill(
        &root.join("skills"),
        "pdf-craft",
        "pdf-craft",
        "PDF 合并与拆分",
    );
    write_skill(&root.join("skills"), "image-gen", "image-gen", "图片生成");

    // 一个只声明了 pi.extensions 的 npm 包。
    let package = root.join("npm").join("node_modules").join("pi-subagents");
    fs::create_dir_all(&package).expect("创建包目录");
    fs::write(
        package.join("package.json"),
        serde_json::json!({
            "name": "pi-subagents",
            "description": "子代理与并行工作流",
            "pi": { "extensions": ["./dist/index.js"], "skills": ["./skills"] },
        })
        .to_string(),
    )
    .expect("写 package.json");
    write_skill(
        &package.join("skills"),
        "council-mode",
        "council-mode",
        "顾问团模式",
    );

    fs::write(
        root.join("settings.json"),
        serde_json::json!({
            "extensions": ["+builtin:mcp", "-builtin:codemode"],
            "skills": [format!("-{}", root.join("skills").join("image-gen").join("SKILL.md").display())],
            "packages": ["npm:pi-subagents", { "source": "npm:pi-web-access@1.0.0", "extensions": [] }],
        })
        .to_string(),
    )
    .expect("写 settings.json");

    fs::write(
        root.join("mcp.json"),
        serde_json::json!({
            "mcpServers": {
                "github": {
                    "url": "https://api.example.invalid/mcp",
                    "description": "仓库 / PR / issue",
                    "headers": { "Authorization": format!("Bearer {}", fake_secret()) },
                },
                "rea": {
                    "type": "stdio",
                    "command": "rea",
                    "args": ["--token", fake_secret()],
                    "env": { "REA_TOKEN": fake_secret() },
                },
            }
        })
        .to_string(),
    )
    .expect("写 mcp.json");
}

/// 目录快照：相对路径 + 内容，用来证明扫描没有写入。
fn snapshot(root: &Path) -> Vec<(String, Vec<u8>)> {
    let mut files = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(&dir).expect("读目录").flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else {
                let relative = path
                    .strip_prefix(root)
                    .expect("相对路径")
                    .to_string_lossy()
                    .to_string();
                files.push((relative, fs::read(&path).expect("读文件")));
            }
        }
    }
    files.sort();
    files
}

#[test]
fn catalog_matches_the_agent_directory_and_stays_read_only() {
    let root = temp_dir("catalog");
    build_agent_dir(&root);
    let before = snapshot(&root);

    let catalog = extension_catalog::scan(&root).expect("扫描配置目录");

    assert_eq!(
        Path::new(&catalog.agent_dir),
        root.as_path(),
        "返回值要能告诉用户读的是哪个目录"
    );

    // 扩展：内置（含 settings 里的 -builtin 关闭状态）+ 用户文件 + 声明过的 npm 包。
    let names: Vec<&str> = catalog
        .extensions
        .iter()
        .map(|item| item.name.as_str())
        .collect();
    for expected in ["codemode", "mcp", "rtk", "pi-subagents"] {
        assert!(names.contains(&expected), "缺少扩展 {expected}：{names:?}");
    }
    assert!(
        !names.contains(&"pi-web-access"),
        "包声明里 extensions: [] 表示不加载扩展，不能列出来"
    );
    assert!(
        !names.contains(&"legacy"),
        "没有 index.* 入口的目录不是扩展"
    );

    let codemode = catalog
        .extensions
        .iter()
        .find(|item| item.name == "codemode")
        .expect("内置扩展");
    assert!(!codemode.enabled, "-builtin:codemode 必须显示为停用");
    assert!(codemode.path.is_none(), "内置扩展没有本地入口路径");

    let rtk = catalog
        .extensions
        .iter()
        .find(|item| item.name == "rtk")
        .expect("用户扩展");
    assert!(rtk.enabled, "没有排除项的扩展按 Pi 的默认行为加载");
    assert_eq!(
        rtk.path.as_deref().map(Path::new),
        Some(root.join("extensions").join("rtk.ts").as_path())
    );

    let package = catalog
        .extensions
        .iter()
        .find(|item| item.name == "pi-subagents")
        .expect("npm 包扩展");
    assert_eq!(
        package.description.as_deref(),
        Some("子代理与并行工作流"),
        "描述来自 package.json，不编"
    );

    // 技能：目录里的两个 + 包里的一个；settings 里 -SKILL.md 的那条被标记为停用。
    let skills: Vec<&str> = catalog
        .skills
        .iter()
        .map(|item| item.name.as_str())
        .collect();
    assert!(skills.contains(&"pdf-craft"), "{skills:?}");
    assert!(
        skills.contains(&"council-mode"),
        "包里的技能也要列出：{skills:?}"
    );
    let image = catalog
        .skills
        .iter()
        .find(|item| item.name == "image-gen")
        .expect("技能");
    assert!(!image.enabled, "settings 里的排除项必须反映到 enabled");
    let pdf = catalog
        .skills
        .iter()
        .find(|item| item.name == "pdf-craft")
        .expect("技能");
    assert!(pdf.enabled);
    assert_eq!(pdf.description.as_deref(), Some("PDF 合并与拆分"));

    // MCP：只给名字 / 传输方式 / 描述，状态一律未知。
    let github = catalog
        .mcp_servers
        .iter()
        .find(|item| item.name == "github")
        .expect("MCP 服务");
    assert_eq!(github.transport.as_deref(), Some("http"));
    assert_eq!(github.description.as_deref(), Some("仓库 / PR / issue"));
    let rea = catalog
        .mcp_servers
        .iter()
        .find(|item| item.name == "rea")
        .expect("MCP 服务");
    assert_eq!(rea.transport.as_deref(), Some("stdio"));

    // 凭据绝不进 DTO。
    let json =
        serde_json::to_string(&serde_json::to_value(&catalog).expect("序列化")).expect("序列化");
    assert!(
        !json.contains(&fake_secret()),
        "mcp.json 的 headers / env 不能出现在返回给界面的数据里"
    );
    assert!(!json.contains("Authorization"), "连头部名字都不需要暴露");
    assert!(
        json.contains("\"status\":\"unknown\""),
        "连接状态必须如实是 unknown"
    );

    // 只读：跑完扫描后目录内容逐字节不变，也没有多出文件。
    assert_eq!(before, snapshot(&root), "扫描不得写入 Pi 的配置目录");

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn detail_counts_real_files_and_rejects_unknown_ids() {
    let root = temp_dir("detail");
    build_agent_dir(&root);

    let catalog = extension_catalog::scan(&root).expect("扫描配置目录");
    let skill = catalog
        .skills
        .iter()
        .find(|item| item.name == "pdf-craft")
        .expect("技能");

    let detail = extension_catalog::detail_in(&root, &skill.id).expect("展开详情");
    assert_eq!(detail.name, "pdf-craft");
    assert_eq!(detail.file_count, 2, "SKILL.md 与 references/notes.md");
    assert!(!detail.file_count_truncated);

    let extension = catalog
        .extensions
        .iter()
        .find(|item| item.name == "rtk")
        .expect("扩展");
    let detail = extension_catalog::detail_in(&root, &extension.id).expect("展开扩展详情");
    assert_eq!(detail.file_count, 1, "单文件扩展就是一个文件");

    assert!(
        extension_catalog::detail_in(&root, "skill:不存在").is_err(),
        "未知 id 必须报错，不能返回空详情"
    );
    assert!(
        extension_catalog::detail_in(&root, "package:pi-web-access").is_err(),
        "远程包没有本地路径，不能编一个文件数"
    );

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn missing_or_broken_configuration_reports_a_reason() {
    let root = temp_dir("broken");
    let missing = root.join("no-such-agent-dir");
    let error = extension_catalog::scan(&missing).expect_err("目录不存在必须报错");
    assert!(
        error.contains("PI_CODING_AGENT_DIR"),
        "错误要说清怎么指定目录：{error}"
    );

    // 配置目录本身是文件。
    let file = root.join("agent-file");
    fs::write(&file, "not a directory").expect("写文件");
    assert!(extension_catalog::scan(&file).is_err());

    // settings.json 不是合法 JSON：宁可报错，也不返回半份列表。
    let broken = root.join("broken-settings");
    fs::create_dir_all(&broken).expect("创建目录");
    fs::write(broken.join("settings.json"), "{ not json").expect("写坏 JSON");
    let error = extension_catalog::scan(&broken).expect_err("坏配置必须报错");
    assert!(
        error.contains("settings.json"),
        "错误要指出是哪个文件：{error}"
    );

    // settings.json 是目录：同样报错而不是静默跳过。
    let directory_settings = root.join("dir-settings");
    fs::create_dir_all(directory_settings.join("settings.json")).expect("创建目录");
    assert!(extension_catalog::scan(&directory_settings).is_err());

    // 只有 mcp.json 坏掉时也要报错：MCP 列表不能假装「本机没有 MCP 服务」。
    let broken_mcp = root.join("broken-mcp");
    fs::create_dir_all(&broken_mcp).expect("创建目录");
    fs::write(broken_mcp.join("mcp.json"), "[]").expect("写数组");
    assert!(
        extension_catalog::scan(&broken_mcp).is_err(),
        "mcp.json 结构不对（数组而不是对象）必须报错"
    );

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn empty_agent_directory_is_a_real_empty_list_not_an_error() {
    let root = temp_dir("empty");
    let catalog = extension_catalog::scan(&root).expect("空目录仍然能扫描");
    // 只有内置扩展：它们是 Pi 自带的，与本机是否装过东西无关。
    assert!(
        catalog.extensions.iter().all(|item| item.path.is_none()),
        "空目录里不该出现用户扩展"
    );
    assert!(catalog.skills.is_empty());
    assert!(catalog.mcp_servers.is_empty());
    let _ = fs::remove_dir_all(&root);
}
