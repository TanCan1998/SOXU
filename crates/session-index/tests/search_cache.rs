//! Issue #109 · 会话内搜索的数据层契约。
//!
//! 覆盖：全量命中（不是只有已加载的一页）、追加不重建、外部改写失效、
//! 超长条目截断、预算淘汰、分页与边界输入。全部离线，零外网、零模型调用。

mod common;

use std::fs;

use common::{TempDir, append_text, header_line, message_line, write_text};
use soxu_session_index::{
    MAX_QUERY_CHARS, MAX_SEARCH_HITS, SearchBudget, SearchCache, SessionId,
    project_sessions_dir_name,
};

const CWD: &str = "/repo";

fn session_path(dir: &TempDir, id: &str) -> std::path::PathBuf {
    let root = dir.mkdir("sessions");
    let path = root
        .join(project_sessions_dir_name(std::path::Path::new(CWD)))
        .join(format!("2026-01-01T00-00-00-000Z_{id}.jsonl"));
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("创建会话目录");
    }
    path
}

/// 1,235 条会话，其中每第 6 条含「扩散」。
fn large_session(id: &str, messages: usize, keyword_every: usize) -> String {
    let mut text = header_line(id, CWD);
    text.push('\n');
    let mut previous: Option<String> = None;
    for index in 0..messages {
        let message_id = format!("m{index:06}");
        let body = if index % keyword_every == 0 {
            format!("第 {index} 条讨论扩散模型的采样步数")
        } else {
            format!("第 {index} 条普通记录")
        };
        let role = if index % 2 == 0 { "user" } else { "assistant" };
        text.push_str(&message_line(&message_id, previous.as_deref(), role, &body));
        text.push('\n');
        previous = Some(message_id);
    }
    text
}

fn cache_with_session(path: &std::path::Path, id: &str) -> (SearchCache, SessionId) {
    let mut cache = SearchCache::new();
    let session = SessionId::new(id);
    let result = cache
        .search(&session, path, "", 50, None)
        .expect("空查询也要能建立缓存");
    assert_eq!(result.hits.len(), 0);
    (cache, session)
}

#[test]
fn finds_every_hit_not_only_the_first_page() {
    let dir = TempDir::new("search-all");
    let path = session_path(&dir, "01a101f1-all");
    write_text(&path, &large_session("01a101f1-all", 1_235, 6));

    let (mut cache, session) = cache_with_session(&path, "ses_01a101f1-all");
    let result = cache
        .search(&session, &path, "扩散", MAX_SEARCH_HITS, None)
        .expect("搜索成功");

    // 1,235 条里每 6 条命中一次 = 206 条（index 0,6,...,1230）。
    assert_eq!(
        result.total_hits, 206,
        "必须搜全整份会话，而不是已加载的一页"
    );
    assert_eq!(result.hits.len(), MAX_SEARCH_HITS, "单次返回受上限约束");
    assert!(result.truncated, "还有下一页时必须标记 truncated");
    assert_eq!(result.scanned_entries, 1_236, "含会话头部行");
    assert!(!result.degraded);
    let ordinals: Vec<u64> = result.hits.iter().map(|hit| hit.ordinal).collect();
    let mut sorted = ordinals.clone();
    sorted.sort_unstable();
    assert_eq!(ordinals, sorted, "结果必须按 ordinal 升序");
    for hit in &result.hits {
        let chars: Vec<char> = hit.snippet.chars().collect();
        let matched: String = chars[hit.match_start..hit.match_end].iter().collect();
        assert_eq!(matched, "扩散", "片段偏移必须精确指向命中词");
    }

    // 剩下 6 条用 after_ordinal 翻页取到，命中总数不因翻页变化。
    let last = result
        .hits
        .last()
        .map(|hit| hit.ordinal)
        .unwrap_or_default();
    let rest = cache
        .search(&session, &path, "扩散", MAX_SEARCH_HITS, Some(last))
        .expect("搜索成功");
    assert_eq!(rest.hits.len(), 6);
    assert_eq!(rest.total_hits, 206);
    assert!(!rest.truncated, "最后一页不应再报告还有下一页");
}

#[test]
fn appends_new_entries_without_rebuilding() {
    let dir = TempDir::new("search-append");
    let path = session_path(&dir, "01a101f1-append");
    write_text(&path, &large_session("01a101f1-append", 20, 1000));

    let mut cache = SearchCache::new();
    let session = SessionId::new("ses_01a101f1-append");
    let before = cache
        .search(&session, &path, "新增线索", 50, None)
        .expect("搜索成功");
    assert_eq!(before.total_hits, 0);
    assert!(before.rebuilt, "首次查询建立缓存");

    // 追加 100 条，其中 10 条含新关键词。
    let mut extra = String::new();
    for index in 0..100 {
        let body = if index % 10 == 0 {
            format!("追加的第 {index} 条：新增线索出现")
        } else {
            format!("追加的第 {index} 条")
        };
        extra.push_str(&message_line(&format!("x{index:04}"), None, "user", &body));
        extra.push('\n');
    }
    append_text(&path, &extra);

    let after = cache
        .search(&session, &path, "新增线索", 50, None)
        .expect("搜索成功");
    assert_eq!(after.total_hits, 10, "追加内容必须能命中");
    assert!(!after.rebuilt, "追加不应重建整份缓存");
    let cached = cache
        .cached_session(&session)
        .unwrap_or_else(|| panic!("缓存应存在"));
    assert_eq!(cached.rebuilds(), 1, "只重建过一次");
    assert_eq!(cached.appends(), 1, "第二次同步走的是追加路径");
}

#[test]
fn rewritten_file_drops_removed_content() {
    let dir = TempDir::new("search-rewrite");
    let path = session_path(&dir, "01a101f1-rewrite");
    let original = format!(
        "{}\n{}\n",
        header_line("01a101f1-rewrite", CWD),
        message_line("m1", None, "user", "旧内容里有扩散")
    );
    write_text(&path, &original);

    let (mut cache, session) = cache_with_session(&path, "ses_01a101f1-rewrite");
    assert_eq!(
        cache
            .search(&session, &path, "扩散", 50, None)
            .expect("搜索成功")
            .total_hits,
        1
    );

    // 外部改写：内容变短（模拟 Pi 重写或人工编辑），旧内容必须消失。
    let rewritten = format!(
        "{}\n{}\n",
        header_line("01a101f1-rewrite", CWD),
        message_line("m1", None, "user", "只剩新内容")
    );
    write_text(&path, &rewritten);
    let result = cache
        .search(&session, &path, "扩散", 50, None)
        .expect("搜索成功");
    assert_eq!(result.total_hits, 0, "不能返回已删除的内容");
    assert!(result.rebuilt, "体积变小必须重建");

    let fresh = cache
        .search(&session, &path, "新内容", 50, None)
        .expect("搜索成功");
    assert_eq!(fresh.total_hits, 1);
}

#[test]
fn equal_size_rewrite_is_detected_by_mtime() {
    let dir = TempDir::new("search-equal-size");
    let path = session_path(&dir, "01a101f1-equal");
    let build = |body: &str| {
        format!(
            "{}\n{}\n",
            header_line("01a101f1-equal", CWD),
            message_line("m1", None, "user", body)
        )
    };
    write_text(&path, &build("AAAA 扩散"));
    let (mut cache, session) = cache_with_session(&path, "ses_01a101f1-equal");

    // 等长改写：体积不变，只能靠 mtime 判断内容已不可信。
    std::thread::sleep(std::time::Duration::from_millis(20));
    write_text(&path, &build("BBBB 扩散"));
    let result = cache
        .search(&session, &path, "AAAA", 50, None)
        .expect("搜索成功");
    assert_eq!(result.total_hits, 0, "等长改写后旧内容必须失效");
    assert_eq!(
        cache
            .search(&session, &path, "BBBB", 50, None)
            .expect("搜索成功")
            .total_hits,
        1
    );
}

#[test]
fn oversized_entry_is_truncated_and_flagged() {
    let dir = TempDir::new("search-oversized");
    let path = session_path(&dir, "01a101f1-big");
    let long_body = format!("扩散{}", "汉".repeat(25_000));
    let text = format!(
        "{}\n{}\n",
        header_line("01a101f1-big", CWD),
        message_line("m1", None, "assistant", &long_body)
    );
    write_text(&path, &text);

    let (mut cache, session) = cache_with_session(&path, "ses_01a101f1-big");
    let result = cache
        .search(&session, &path, "扩散", 50, None)
        .expect("搜索成功");
    assert_eq!(result.hits.len(), 1);
    let hit = &result.hits[0];
    assert!(hit.truncated, "超长条目必须标记 truncated");
    assert!(
        hit.snippet.chars().count() <= 200 + 80 + 1,
        "片段来自截断后的正文：{} 字符",
        hit.snippet.chars().count()
    );

    // 截断点之后的内容不再可搜：这是明确的上限行为，不是静默错误。
    let tail = format!("尾巴{}", "尾".repeat(24_000));
    let text = format!(
        "{}\n{}\n",
        header_line("01a101f1-big2", CWD),
        message_line(
            "m1",
            None,
            "assistant",
            &format!("{}扩散{}", "汉".repeat(300), tail)
        )
    );
    let path2 = session_path(&dir, "01a101f1-big2");
    write_text(&path2, &text);
    let mut cache2 = SearchCache::new();
    let session2 = SessionId::new("ses_01a101f1-big2");
    let beyond = cache2
        .search(&session2, &path2, "尾巴", 50, None)
        .expect("搜索成功");
    assert_eq!(beyond.total_hits, 0, "截断后的内容不可搜（有界缓存的上限）");
}

#[test]
fn budget_evicts_oldest_text_and_reports_degraded() {
    let dir = TempDir::new("search-budget");
    let path = session_path(&dir, "01a101f1-budget");
    write_text(&path, &large_session("01a101f1-budget", 200, 1));

    // 单会话预算压到 4 KiB：只可能留下最近的若干条正文。
    let mut cache = SearchCache::with_budget(SearchBudget::with_limits(4 * 1024, 4 * 1024));
    let session = SessionId::new("ses_01a101f1-budget");
    let result = cache
        .search(&session, &path, "扩散", 500, None)
        .expect("搜索成功");
    assert!(result.degraded, "预算淘汰必须如实报告 degraded");
    assert!(
        result.total_hits < 201,
        "被淘汰的旧条目不应再命中：{}",
        result.total_hits
    );
    assert!(
        cache.bytes() <= 4 * 1024,
        "缓存占用必须在预算内：{}",
        cache.bytes()
    );
    let newest = result.hits.last().expect("最新条目必须还能命中");
    assert_eq!(newest.ordinal, 200, "最新条目永远是最近写入的那条");
}

#[test]
fn global_budget_evicts_least_recently_used_session() {
    let dir = TempDir::new("search-global");
    let mut cache = SearchCache::with_budget(SearchBudget::with_limits(2 * 1024, 3 * 1024));
    let mut sessions = Vec::new();
    for index in 0..4 {
        let id = format!("01a101f1-g{index}");
        let path = session_path(&dir, &id);
        write_text(&path, &large_session(&id, 40, 1));
        let session = SessionId::new(format!("ses_{id}"));
        cache
            .search(&session, &path, "扩散", 10, None)
            .expect("搜索成功");
        sessions.push((session, path));
    }
    assert!(
        cache.bytes() <= 3 * 1024,
        "全局预算必须生效：{}",
        cache.bytes()
    );
    assert!(
        cache.session_count() < 4,
        "超预算时必须淘汰最久未使用的会话"
    );
    // 最近查询过的会话仍在缓存里。
    let (last, _) = sessions.last().expect("至少一个会话");
    assert!(cache.cached_session(last).is_some());
}

#[test]
fn paging_uses_after_ordinal_without_changing_total() {
    let dir = TempDir::new("search-paging");
    let path = session_path(&dir, "01a101f1-page");
    write_text(&path, &large_session("01a101f1-page", 60, 1));

    let (mut cache, session) = cache_with_session(&path, "ses_01a101f1-page");
    let first = cache
        .search(&session, &path, "扩散", 10, None)
        .expect("搜索成功");
    assert_eq!(first.hits.len(), 10);
    assert_eq!(first.total_hits, 60);
    assert!(first.truncated, "还有下一页时必须标记 truncated");

    let last_ordinal = first.hits.last().map(|hit| hit.ordinal).unwrap_or(0);
    let second = cache
        .search(&session, &path, "扩散", 10, Some(last_ordinal))
        .expect("搜索成功");
    assert_eq!(second.hits.len(), 10);
    assert_eq!(second.total_hits, 60, "翻页不改变命中总数");
    assert!(
        second.hits.first().map(|hit| hit.ordinal) > Some(last_ordinal),
        "第二页必须接在第一页之后"
    );
}

#[test]
fn empty_and_overlong_queries_have_explicit_behaviour() {
    let dir = TempDir::new("search-bounds");
    let path = session_path(&dir, "01a101f1-bounds");
    write_text(&path, &large_session("01a101f1-bounds", 10, 2));
    let (mut cache, session) = cache_with_session(&path, "ses_01a101f1-bounds");

    for query in ["", "   "] {
        let result = cache
            .search(&session, &path, query, 50, None)
            .expect("空查询不是错误");
        assert_eq!(result.hits.len(), 0);
        assert_eq!(result.total_hits, 0);
        assert!(result.scanned_entries > 0, "空查询也要报告扫描规模");
    }

    let no_hit = cache
        .search(&session, &path, "不存在的关键词", 50, None)
        .expect("无命中不是错误");
    assert_eq!(no_hit.total_hits, 0);
    assert!(no_hit.hits.is_empty());

    let too_long = "长".repeat(MAX_QUERY_CHARS + 1);
    let error = cache
        .search(&session, &path, &too_long, 50, None)
        .expect_err("超长查询必须明确失败");
    assert_eq!(error.code().as_str(), "E_SEARCH_QUERY_TOO_LONG");
    assert!(error.recoverable(), "缩短查询即可重试");

    // 恰好等于上限必须被接受。
    let exact = "长".repeat(MAX_QUERY_CHARS);
    assert!(
        cache.search(&session, &path, &exact, 50, None).is_ok(),
        "等于上限的查询必须接受"
    );
}

#[test]
fn missing_file_reports_a_typed_error() {
    let dir = TempDir::new("search-missing");
    let path = dir.child("nope.jsonl");
    let mut cache = SearchCache::new();
    let error = cache
        .search(&SessionId::new("ses_missing"), &path, "扩散", 50, None)
        .expect_err("文件不存在必须失败");
    assert_eq!(error.code().as_str(), "E_SESSION_FILE_MISSING");
}

#[test]
fn empty_lines_and_corrupt_lines_keep_ordinals_aligned() {
    let dir = TempDir::new("search-ordinals");
    let path = session_path(&dir, "01a101f1-ord");
    let text = [
        header_line("01a101f1-ord", CWD),
        String::new(), // 空行：索引与搜索都不产生条目
        message_line("m1", None, "user", "第一条 扩散"),
        "not json".to_owned(),
        message_line("m2", None, "assistant", "第二条 扩散"),
        String::new(),
    ]
    .join("\n");
    write_text(&path, &format!("{text}\n"));

    let (mut cache, session) = cache_with_session(&path, "ses_01a101f1-ord");
    let result = cache
        .search(&session, &path, "扩散", 50, None)
        .expect("搜索成功");
    let ordinals: Vec<u64> = result.hits.iter().map(|hit| hit.ordinal).collect();
    // 头部 = 0，m1 = 1，损坏行 = 2，m2 = 3：序号与分页索引同源同序。
    assert_eq!(ordinals, vec![1, 3]);
    assert_eq!(result.scanned_entries, 4);
}
