//! 文件抽屉后端的集成测试（Issue #120 / TASK-028）：真实临时目录 + 真实会话目录。
//!
//! 验收对应的四件事：
//! 1. **路径穿越全部被拒**：`..`、绝对路径、符号链接/目录联接跳出根目录；
//! 2. **目录树懒加载**：一次只读一层，不递归读子目录；
//! 3. **写操作有界**：新建/写入/重命名/删除都限制在项目根目录内，删除要名称确认；
//! 4. **只读预览有界**：超大文件与二进制文件都不会整份进入界面状态。
//!
//! 平台差异（Windows 普通用户只能建目录联接）见 `docs/development/security-regression.md`。

mod support;

use std::fs;
use std::path::{Path, PathBuf};

use soxu_desktop_lib::files;
use soxu_desktop_lib::state::AppState;
use soxu_desktop_lib::workspace;
use soxu_session_index::CatalogConfig;
use support::{Sandbox, try_dir_link, try_file_link};

/// 登记一个真实项目目录，返回 (状态, 项目根, 项目 ID)。
async fn setup(sandbox: &Sandbox) -> (AppState, PathBuf, String) {
    let project_root = sandbox.path("project");
    fs::create_dir_all(&project_root).expect("创建项目目录");
    let sessions_root = sandbox.path("sessions");
    let state = AppState::open(
        sandbox.path("state"),
        CatalogConfig::with_sessions_root(&sessions_root),
    )
    .expect("初始化状态");
    let project = workspace::register_project(&state, project_root.to_string_lossy().as_ref())
        .await
        .expect("登记项目");
    (state, project_root, project.id)
}

fn write(root: &Path, relative: &str, content: &str) {
    let path = root.join(relative);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("创建父目录");
    }
    fs::write(path, content).expect("写入文件");
}

#[tokio::test]
async fn listing_reads_only_one_level_and_marks_entries() {
    let sandbox = Sandbox::new("list");
    let (state, root, project_id) = setup(&sandbox).await;
    write(&root, "README.md", "# repo\n");
    write(&root, "src/main.rs", "fn main() {}\n");
    write(
        &root,
        "src/deep/nested/ignored.txt",
        "不应该出现在根层列表里\n",
    );
    write(&root, ".env.example", "SOXU=1\n");
    fs::create_dir_all(root.join("empty-dir")).expect("创建空目录");

    let listing = files::list_dir(&state, &project_id, "")
        .await
        .expect("列出一层目录");
    assert_eq!(listing.project_id, project_id);
    assert_eq!(listing.path, "", "根目录的相对路径是空字符串");
    assert!(!listing.truncated);
    let names: Vec<&str> = listing
        .entries
        .iter()
        .map(|entry| entry.name.as_str())
        .collect();
    assert_eq!(
        names,
        vec![".env.example", "empty-dir", "README.md", "src"],
        "只读一层并按名称升序（隐藏文件也返回，由 UI 决定是否显示）"
    );

    let readme = listing
        .entries
        .iter()
        .find(|entry| entry.name == "README.md")
        .expect("README 在列表里");
    assert_eq!(readme.kind, "file");
    assert_eq!(readme.size, "# repo\n".len() as u64);
    assert!(
        readme.modified_at_ms.is_some(),
        "文件时间用于「按时间排序」"
    );
    assert!(!readme.hidden);
    let env = listing
        .entries
        .iter()
        .find(|entry| entry.name == ".env.example")
        .expect(".env.example 在列表里");
    assert!(env.hidden, "点开头的条目标记为隐藏");
    let src = listing
        .entries
        .iter()
        .find(|entry| entry.name == "src")
        .expect("src 在列表里");
    assert_eq!(src.kind, "dir");

    // 懒加载：子目录的内容只有显式展开时才读。
    let nested = files::list_dir(&state, &project_id, "src")
        .await
        .expect("展开子目录");
    let nested_names: Vec<&str> = nested
        .entries
        .iter()
        .map(|entry| entry.name.as_str())
        .collect();
    assert_eq!(nested_names, vec!["deep", "main.rs"]);
    assert!(
        nested
            .entries
            .iter()
            .all(|entry| entry.name != "ignored.txt"),
        "孙目录内容不得在父层出现"
    );

    // DTO 契约是 camelCase：前端直接按这个名字读。
    let json = serde_json::to_value(&listing).expect("序列化目录列表");
    assert!(json.get("projectId").is_some());
    assert!(json["entries"][0].get("modifiedAtMs").is_some());
}

#[tokio::test]
async fn traversal_and_absolute_paths_are_rejected() {
    let sandbox = Sandbox::new("traversal");
    let (state, root, project_id) = setup(&sandbox).await;
    let outside = sandbox.path("outside");
    fs::create_dir_all(&outside).expect("创建外部目录");
    fs::write(outside.join("secret.txt"), "top secret").expect("写入外部文件");

    for path in [
        "../outside/secret.txt",
        "src/../../outside/secret.txt",
        "..",
        "./../outside",
    ] {
        let error = files::read_file(&state, &project_id, path)
            .await
            .expect_err("`..` 穿越必须被拒绝");
        assert!(
            error.starts_with(files::PATH_TRAVERSAL),
            "{path} 应返回 E_FILES_PATH_TRAVERSAL，实际 {error}"
        );
    }

    // 绝对路径：即使它真实存在且可读，也不能经命令层读到。
    let absolute = outside.join("secret.txt");
    let error = files::read_file(&state, &project_id, &absolute.to_string_lossy())
        .await
        .expect_err("绝对路径必须被拒绝");
    assert!(
        error.starts_with(files::PATH_ABSOLUTE),
        "绝对路径应返回 E_FILES_PATH_ABSOLUTE，实际 {error}"
    );
    // 错误文本不回显文件内容。
    assert!(!error.contains("top secret"));

    let listing = files::list_dir(&state, &project_id, "..")
        .await
        .expect_err("父目录枚举必须被拒绝");
    assert!(listing.starts_with(files::PATH_TRAVERSAL));

    // 写操作同样走同一条守卫。
    let error = files::create_file(&state, &project_id, "../escaped.md", None)
        .await
        .expect_err("越界创建必须被拒绝");
    assert!(error.starts_with(files::PATH_TRAVERSAL));
    assert!(!sandbox.path("escaped.md").exists(), "拒绝后不得留下文件");

    // 重命名的**目标**同样走守卫：源存在时才走到目标校验这一步。
    write(&root, "note.md", "note\n");
    let error = files::rename_path(&state, &project_id, "note.md", "../moved.md")
        .await
        .expect_err("越界重命名必须被拒绝");
    assert!(error.starts_with(files::PATH_TRAVERSAL));
    assert!(root.join("note.md").exists(), "拒绝后源文件必须还在");
    assert!(!sandbox.path("moved.md").exists());

    // 源不存在时先报「不存在」，不会因为目标越界而误报成别的错误。
    let error = files::rename_path(&state, &project_id, "missing.md", "ok.md")
        .await
        .expect_err("源不存在必须被拒绝");
    assert!(error.starts_with(files::PATH_MISSING), "{error}");

    assert!(root.is_dir(), "拒绝不影响项目目录本身");
}

#[tokio::test]
async fn symlinks_escaping_the_root_are_rejected() {
    let sandbox = Sandbox::new("symlink");
    let (state, root, project_id) = setup(&sandbox).await;
    let outside = sandbox.path("outside");
    fs::create_dir_all(&outside).expect("创建外部目录");
    fs::write(outside.join("secret.txt"), "top secret").expect("写入外部文件");

    let link = root.join("escape");
    if let Err(reason) = try_dir_link(&outside, &link) {
        eprintln!("平台限制：{reason}；目录链接子用例跳过");
        return;
    }

    // 链接出现在列表里，但标记为 symlink（UI 据此不给「打开」）。
    let listing = files::list_dir(&state, &project_id, "")
        .await
        .expect("列出根目录");
    let entry = listing
        .entries
        .iter()
        .find(|entry| entry.name == "escape")
        .expect("链接条目在列表里");
    assert!(entry.symlink, "链接条目必须标记 symlink");
    assert_eq!(entry.kind, "symlink");

    // 经链接读子目录 / 读文件都必须被落点检查拦下。
    let error = files::list_dir(&state, &project_id, "escape")
        .await
        .expect_err("经链接展开目录必须被拒绝");
    assert_eq!(
        error.split(':').next(),
        Some(files::PATH_OUTSIDE_ROOT),
        "{error}"
    );
    let error = files::read_file(&state, &project_id, "escape/secret.txt")
        .await
        .expect_err("经链接读文件必须被拒绝");
    assert_eq!(
        error.split(':').next(),
        Some(files::PATH_OUTSIDE_ROOT),
        "{error}"
    );

    // 文件符号链接（Windows 需要开发者模式）：越界读同样被拒绝。
    let file_link = root.join("secret-link.txt");
    match try_file_link(&outside.join("secret.txt"), &file_link) {
        Ok(()) => {
            let error = files::read_file(&state, &project_id, "secret-link.txt")
                .await
                .expect_err("经文件链接读越界内容必须被拒绝");
            assert_eq!(
                error.split(':').next(),
                Some(files::PATH_OUTSIDE_ROOT),
                "{error}"
            );
            // 写链接同样被拒：不能把内容写到根目录之外。
            let error = files::write_file(&state, &project_id, "secret-link.txt", "overwritten")
                .await
                .expect_err("经文件链接写越界内容必须被拒绝");
            assert_eq!(
                error.split(':').next(),
                Some(files::PATH_OUTSIDE_ROOT),
                "{error}"
            );
        }
        Err(reason) => eprintln!("平台限制：{reason}；文件符号链接子用例跳过"),
    }

    // 外部文件保持原样。
    assert_eq!(
        fs::read_to_string(outside.join("secret.txt")).expect("读取外部文件"),
        "top secret"
    );
}

#[tokio::test]
async fn create_write_rename_delete_stay_inside_the_root() {
    let sandbox = Sandbox::new("mutate");
    let (state, root, project_id) = setup(&sandbox).await;

    // 新建：目标不存在才创建，已存在一律拒绝（不覆盖用户内容）。
    let created = files::create_file(&state, &project_id, "notes/draft.md", Some("# 草稿\n"))
        .await
        .expect_err("父目录不存在时不能凭空造目录");
    assert!(created.starts_with(files::PATH_MISSING), "{created}");
    fs::create_dir_all(root.join("notes")).expect("创建父目录");
    let created = files::create_file(&state, &project_id, "notes/draft.md", Some("# 草稿\n"))
        .await
        .expect("新建文件");
    assert_eq!(created.path, "notes/draft.md");
    assert_eq!(created.kind, "file");
    assert_eq!(created.size, "# 草稿\n".len() as u64);

    let error = files::create_file(&state, &project_id, "notes/draft.md", None)
        .await
        .expect_err("已存在的文件不能被 create_file 覆盖");
    assert!(error.starts_with(files::PATH_EXISTS), "{error}");
    assert_eq!(
        fs::read_to_string(root.join("notes/draft.md")).expect("读文件"),
        "# 草稿\n",
        "拒绝覆盖后内容保持原样"
    );

    // 写入：只覆盖已存在的文件；目标不存在时报错而不是顺手创建。
    let error = files::write_file(&state, &project_id, "notes/missing.md", "x")
        .await
        .expect_err("写入不存在的文件必须被拒绝");
    assert!(error.starts_with(files::PATH_MISSING), "{error}");
    files::write_file(&state, &project_id, "notes/draft.md", "# 改过的草稿\n")
        .await
        .expect("覆盖写入");
    assert_eq!(
        fs::read_to_string(root.join("notes/draft.md")).expect("读文件"),
        "# 改过的草稿\n"
    );

    // 重命名：目标已存在时拒绝，不覆盖。
    write(&root, "notes/other.md", "other\n");
    let error = files::rename_path(&state, &project_id, "notes/draft.md", "notes/other.md")
        .await
        .expect_err("重命名不得覆盖已存在的目标");
    assert!(error.starts_with(files::PATH_EXISTS), "{error}");
    let renamed = files::rename_path(&state, &project_id, "notes/draft.md", "notes/final.md")
        .await
        .expect("重命名");
    assert_eq!(renamed.path, "notes/final.md");
    assert!(!root.join("notes/draft.md").exists());
    assert!(root.join("notes/final.md").exists());

    // 删除：确认名称不匹配一律拒绝，磁盘保持原样。
    let error = files::delete_path(&state, &project_id, "notes/final.md", false, "")
        .await
        .expect_err("缺少确认名称必须被拒绝");
    assert!(error.starts_with(files::CONFIRM_MISMATCH), "{error}");
    let error = files::delete_path(&state, &project_id, "notes/final.md", false, "other.md")
        .await
        .expect_err("确认名称不匹配必须被拒绝");
    assert!(error.starts_with(files::CONFIRM_MISMATCH), "{error}");
    assert!(root.join("notes/final.md").exists(), "拒绝时文件必须还在");

    let deleted = files::delete_path(&state, &project_id, "notes/final.md", false, "final.md")
        .await
        .expect("确认名称匹配后删除");
    assert_eq!(deleted.path, "notes/final.md");
    assert!(!root.join("notes/final.md").exists());

    // 非空目录：必须显式递归确认，否则拒绝。
    let error = files::delete_path(&state, &project_id, "notes", false, "notes")
        .await
        .expect_err("非空目录不能静默删除");
    assert!(error.starts_with(files::DIR_NOT_EMPTY), "{error}");
    assert!(root.join("notes/other.md").exists());
    files::delete_path(&state, &project_id, "notes", true, "notes")
        .await
        .expect("确认递归删除");
    assert!(!root.join("notes").exists());

    // 项目根目录本身永远不可删除/重命名。
    let error = files::delete_path(&state, &project_id, "", true, "project")
        .await
        .expect_err("根目录不能删除");
    assert!(error.starts_with(files::PATH_IS_ROOT), "{error}");
    let error = files::rename_path(&state, &project_id, "", "renamed")
        .await
        .expect_err("根目录不能重命名");
    assert!(error.starts_with(files::PATH_IS_ROOT), "{error}");
    assert!(root.is_dir(), "根目录必须原样保留");
}

#[tokio::test]
async fn preview_is_bounded_and_binary_content_is_marked() {
    let sandbox = Sandbox::new("preview");
    let (state, root, project_id) = setup(&sandbox).await;
    let big = "a".repeat((files::MAX_PREVIEW_BYTES + 4096) as usize);
    write(&root, "big.txt", &big);
    fs::write(root.join("blob.bin"), [0u8, 1, 2, 3, 0, 4]).expect("写入二进制文件");

    let preview = files::read_file(&state, &project_id, "big.txt")
        .await
        .expect("读取大文件预览");
    assert!(preview.truncated, "超过上限必须标记 truncated");
    assert_eq!(preview.size, big.len() as u64);
    assert_eq!(preview.bytes_read, files::MAX_PREVIEW_BYTES);
    assert_eq!(preview.text.len() as u64, files::MAX_PREVIEW_BYTES);
    assert!(!preview.binary);

    let blob = files::read_file(&state, &project_id, "blob.bin")
        .await
        .expect("读取二进制文件");
    assert!(blob.binary, "含 NUL 的内容按二进制处理");
    assert!(blob.text.is_empty(), "二进制不回正文（避免乱码进界面状态）");

    // 目录不能当文件读。
    let error = files::read_file(&state, &project_id, "")
        .await
        .expect_err("目录不是文件");
    assert!(error.starts_with(files::NOT_A_FILE), "{error}");
}

#[tokio::test]
async fn search_is_bounded_and_skips_dependency_directories() {
    let sandbox = Sandbox::new("search");
    let (state, root, project_id) = setup(&sandbox).await;
    write(
        &root,
        "src/main.rs",
        "fn main() {\n    println!(\"needle\");\n}\n",
    );
    write(&root, "src/lib.rs", "pub fn needle() {}\n");
    write(
        &root,
        "docs/guide.md",
        "这里也提到 NEEDLE（大小写不敏感）\n",
    );
    // 依赖目录里的命中不该出现：它们既慢又没有意义。
    write(&root, "node_modules/pkg/index.js", "needle\n");
    write(&root, ".git/config", "needle\n");

    let result = files::search_files(&state, &project_id, "needle", None)
        .await
        .expect("搜索");
    let paths: Vec<&str> = result.hits.iter().map(|hit| hit.path.as_str()).collect();
    assert_eq!(paths, vec!["docs/guide.md", "src/lib.rs", "src/main.rs"]);
    assert!(result.scanned_files >= 3);
    assert!(result.skipped_files >= 2, "依赖目录被计入跳过数");
    assert!(!result.truncated);

    let main_hit = result
        .hits
        .iter()
        .find(|hit| hit.path == "src/main.rs")
        .expect("main.rs 命中");
    assert_eq!(main_hit.line, 2);
    assert!(main_hit.preview.contains("needle"));
    assert_eq!(
        &main_hit.preview[main_hit.match_start as usize..main_hit.match_end as usize],
        "needle"
    );

    // 命中上限生效并如实标记。
    let limited = files::search_files(&state, &project_id, "needle", Some(1))
        .await
        .expect("限量搜索");
    assert_eq!(limited.hits.len(), 1);
    assert!(limited.truncated, "触到上限必须标记 truncated");

    let empty = files::search_files(&state, &project_id, "   ", None)
        .await
        .expect_err("空关键词必须被拒绝");
    assert!(empty.starts_with(files::QUERY_EMPTY), "{empty}");
}

#[tokio::test]
async fn unregistered_projects_are_refused() {
    let sandbox = Sandbox::new("unknown");
    let (state, _root, _project_id) = setup(&sandbox).await;

    let error = files::list_dir(&state, "prj_not_registered", "")
        .await
        .expect_err("未登记的项目必须被拒绝");
    assert!(error.starts_with(files::ROOT_UNKNOWN), "{error}");
}
