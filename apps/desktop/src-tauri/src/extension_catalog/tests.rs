//! 扩展目录扫描的单测（Issue #147）：纯逻辑用临时目录验证，不读真实 ~/.pi/agent。

use super::MAX_DESCRIPTION_CHARS;
use super::entry::*;

use super::*;

#[test]
fn frontmatter_keeps_single_line_metadata() {
    let text =
        "\u{feff}---\nname: pdf-tools\ndescription: \"Extract text: tables too\"\n---\n\n# 正文";
    assert_eq!(
        parse_frontmatter(text),
        (
            Some("pdf-tools".to_owned()),
            Some("Extract text: tables too".to_owned())
        )
    );
}

#[test]
fn frontmatter_reads_block_scalars_instead_of_their_indicator() {
    // 技能库里常见写法：description 用块标量换行写。把 "|-" 当描述显示就是在编数据。
    let text = "---
name: ms-hub
description: |-
  列出并安装技能。\n  仅用于技能中心。
tags:
  - a
---
";
    let (name, description) = parse_frontmatter(text);
    assert_eq!(name.as_deref(), Some("ms-hub"));
    assert_eq!(
        description.as_deref(),
        Some("列出并安装技能。 仅用于技能中心。")
    );
}

#[test]
fn resolve_inside_normalizes_dot_segments() {
    let base = Path::new("/pkg");
    assert_eq!(
        resolve_inside(base, "./skills/council-mode"),
        Some(base.join("skills").join("council-mode"))
    );
    assert_eq!(resolve_inside(base, "skills"), Some(base.join("skills")));
    assert_eq!(resolve_inside(base, "../escape"), None);
    assert_eq!(resolve_inside(base, "/abs"), None);
}

#[test]
fn frontmatter_without_complete_rule_yields_nothing() {
    assert_eq!(parse_frontmatter("# 没有 frontmatter"), (None, None));
    assert_eq!(
        parse_frontmatter("---\nname: x\n"),
        (None, None),
        "缺少闭合的 --- 时整体忽略"
    );
    assert_eq!(
        parse_frontmatter("---\nname:\ndescription:   \n---"),
        (None, None),
        "空值不产生假字段"
    );
}

#[test]
fn package_names_drop_versions_but_keep_scopes() {
    assert_eq!(package_name("npm:pi-web-access"), "pi-web-access");
    assert_eq!(package_name("npm:pi-web-access@1.2.3"), "pi-web-access");
    assert_eq!(
        package_name("npm:@madgagarin/pi-agentrouter"),
        "@madgagarin/pi-agentrouter"
    );
    assert_eq!(
        package_name("npm:@madgagarin/pi-agentrouter@0.4.0"),
        "@madgagarin/pi-agentrouter"
    );
    assert_eq!(
        package_name("git:github.com/example/pi-tools@v1"),
        "github.com/example/pi-tools@v1"
    );
}

#[test]
fn entry_resolution_rejects_traversal_and_globs() {
    let agent = Path::new("/home/user/.pi/agent");
    assert_eq!(
        resolve_entry("skills/extra", agent),
        Some(agent.join("skills").join("extra"))
    );
    assert_eq!(
        resolve_entry("/abs/skill", agent),
        Some(PathBuf::from("/abs/skill"))
    );
    assert_eq!(resolve_entry("../escape", agent), None, "不得越出配置目录");
    assert_eq!(resolve_entry("skills/*.ts", agent), None, "不解析通配符");
    assert_eq!(resolve_entry("   ", agent), None);
}

#[test]
fn builtin_entries_are_parsed_with_sign() {
    assert_eq!(builtin_name("+builtin:mcp"), Some("mcp"));
    assert_eq!(builtin_name("-builtin:codemode"), Some("codemode"));
    assert_eq!(builtin_name("builtin:tool-search"), Some("tool-search"));
    assert_eq!(builtin_name("npm:pi-web-access"), None);
    assert!(is_exclusion("-builtin:mcp"));
    assert!(is_exclusion("!extensions/legacy.ts"));
    assert!(!is_exclusion("+builtin:mcp"));
}

#[test]
fn exclusions_match_paths_in_both_directions() {
    let agent = Path::new("/home/user/.pi/agent");
    let skill = agent.join("skills").join("image-gen");
    let entries = vec![
        format!("-{}/SKILL.md", display_path(&skill)),
        "-pideck-doctor".to_owned(),
    ];
    assert!(is_excluded(&entries, Some(&skill), &["image-gen"], agent));
    assert!(is_excluded(
        &entries,
        Some(&agent.join("skills").join("pideck-doctor")),
        &["pideck-doctor"],
        agent
    ));
    assert!(!is_excluded(
        &entries,
        Some(&agent.join("skills").join("rust-skills")),
        &["rust-skills"],
        agent
    ));
    // 没有排除项时一律按 Pi 的默认（加载）处理。
    assert!(!is_excluded(&[], Some(&skill), &["image-gen"], agent));
}

#[test]
fn descriptions_are_clipped() {
    let long = "字".repeat(MAX_DESCRIPTION_CHARS + 10);
    let clipped = clip(&long);
    assert_eq!(clipped.chars().count(), MAX_DESCRIPTION_CHARS + 1);
    assert!(clipped.ends_with('…'));
    assert_eq!(clip(" 短描述 "), "短描述");
}
