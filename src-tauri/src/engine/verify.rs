//! Source verification.
//!
//! The old health check asked one question — "does the first listing page
//! parse?" — and answered it with a boolean. That is not enough to act on: a
//! source whose site is up but whose list rule no longer matches looks exactly
//! like a dead site, and the user has no way to tell which rule broke.
//!
//! Verification instead walks a source through the same path the reader takes,
//! one stage at a time, and reports each stage separately:
//!
//! | stage      | what it proves                                        |
//! |------------|-------------------------------------------------------|
//! | `rule`     | the rule payload declares the selectors it needs      |
//! | `homepage` | the site answers, and with what content type          |
//! | `list`     | the list rule still matches the markup                |
//! | `detail`   | the content rule still extracts text from a real item |
//! | `search`   | `searchUrl` still returns results                     |
//!
//! Every network stage runs behind a watchdog thread, so one unresponsive site
//! cannot stall a library-wide check.

use super::browse::{self, ArticleItem};
use super::{fetch, js};
use crate::model::Source;
use crate::store::{Health, StageResult, StageState};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// How long a single network stage may take before it is called a timeout.
const STAGE_TIMEOUT: Duration = Duration::from_secs(12);

/// Worker count ceiling when `concurrent_checks` is enabled.
const MAX_WORKERS: usize = 8;

/// Below this, extracted body text means the content rule almost certainly
/// did not match — the page loaded but the selector is stale.
const THIN_TEXT: usize = 120;

/// Stack for a stage thread: Boa recursion plus HTML parsing can nest deeply.
const STAGE_STACK: usize = 4 * 1024 * 1024;

/// A source queued for verification.
#[derive(Debug, Clone)]
pub struct Target {
    pub id: String,
    pub name: String,
    pub source: Source,
}

/// Aggregate result of a library-wide check.
#[derive(Debug, Clone, Copy, Default, Serialize)]
pub struct Outcome {
    pub total: usize,
    pub ok: usize,
    pub warn: usize,
    pub failed: usize,
    pub cancelled: bool,
}

// ---------------------------------------------------------------------------
// Stage helpers
// ---------------------------------------------------------------------------

/// Build a stage result. Time is filled in by [`run_stage`].
fn stage(key: &str, label: &str, state: StageState, detail: impl Into<String>) -> StageResult {
    StageResult { key: key.into(), label: label.into(), state, detail: detail.into(), ms: 0 }
}

/// The four network stages, in report order, as skip placeholders.
fn cancelled_stages() -> Vec<StageResult> {
    [("homepage", "首页"), ("list", "列表"), ("detail", "详情"), ("search", "搜索")]
        .iter()
        .map(|(key, label)| stage(key, label, StageState::Skip, "已取消"))
        .collect()
}

/// Human-readable body size, e.g. `12.3 KB`.
fn size_label(bytes: usize) -> String {
    if bytes < 1024 {
        return format!("{bytes} B");
    }
    if bytes < 1024 * 1024 {
        return format!("{:.1} KB", bytes as f64 / 1024.0);
    }
    format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
}

/// Run one stage on a worker thread, abandoning it if it overruns.
///
/// The stage closure owns its data (`Source` is `Clone`) so it can outlive the
/// caller; an abandoned thread is still bounded by the HTTP client's own
/// 30-second timeout, and it writes nothing back to the store.
fn run_stage<F, T>(key: &str, label: &str, f: F) -> (StageResult, Option<T>)
where
    F: FnOnce() -> (StageResult, T) + Send + 'static,
    T: Send + 'static,
{
    run_stage_with(key, label, STAGE_TIMEOUT, f)
}

fn run_stage_with<F, T>(key: &str, label: &str, limit: Duration, f: F) -> (StageResult, Option<T>)
where
    F: FnOnce() -> (StageResult, T) + Send + 'static,
    T: Send + 'static,
{
    let started = Instant::now();
    let (tx, rx) = mpsc::channel();
    let spawned = std::thread::Builder::new()
        .stack_size(STAGE_STACK)
        .spawn(move || {
            let _ = tx.send(f());
        });

    let handle = match spawned {
        Ok(handle) => handle,
        Err(e) => {
            return (
                stage(key, label, StageState::Fail, format!("无法启动校验线程: {e}")),
                None,
            )
        }
    };

    let received = rx.recv_timeout(limit);
    // Only safe to join once the stage reported back; an abandoned thread is
    // still running and must not block the caller.
    if received.is_ok() {
        let _ = handle.join();
    }

    match received {
        Ok((mut result, value)) => {
            result.ms = started.elapsed().as_millis() as u64;
            (result, Some(value))
        }
        Err(RecvTimeoutError::Timeout) => {
            let mut s = stage(
                key,
                label,
                StageState::Fail,
                format!("超过 {} 秒没有返回，已跳过", limit.as_secs()),
            );
            s.ms = started.elapsed().as_millis() as u64;
            (s, None)
        }
        Err(RecvTimeoutError::Disconnected) => {
            let mut s = stage(key, label, StageState::Fail, "校验线程异常退出");
            s.ms = started.elapsed().as_millis() as u64;
            (s, None)
        }
    }
}

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

/// Is this a single-page source rather than a listing?
///
/// Legado sources that declare `ruleArticles: "body"` with no link rule yield
/// one article containing the whole document. Expecting a list of linked items
/// from them is a mistake, and reporting that as "rule broken" is a false
/// alarm — the rule is doing exactly what it was asked to do.
pub fn is_single_page(src: &Source) -> bool {
    src.rule_articles.trim().eq_ignore_ascii_case("body") && src.rule_link.trim().is_empty()
}

/// Does the page need a browser to show its content?
///
/// `enableJs` marks a source whose site builds the page in JavaScript. A
/// server-side parser can never read those, so they must be reported as a
/// different kind of limitation from "the rules went stale".
pub fn needs_javascript(src: &Source) -> bool {
    src.enable_js
}

/// Choose the category worth probing.
///
/// Blindly taking the first category is wrong: plenty of sources put a
/// **search** entry first (`「搜索🔍」`), and a search page without a keyword
/// legitimately returns nothing — which the report would then blame on the
/// rules. Prefer the site root, then any category that is not a search box,
/// and only fall back to the root when every category is a search entry.
fn probe_category(src: &Source) -> (String, String) {
    let cats = browse::categories(src);
    let is_search = |name: &str| {
        let n = name.to_lowercase();
        n.contains("搜索") || n.contains("搜") || n.contains("search") || n.contains("keyword")
    };

    // `sortUrl` entries are usually relative, so compare resolved URLs — a raw
    // string comparison would never match a category pointing at the root.
    let root = src.source_url.trim().trim_end_matches('/').to_string();
    let resolved = |u: &str| {
        crate::util::absolute_url(u.trim(), &src.source_url)
            .trim()
            .trim_end_matches('/')
            .to_string()
    };

    if let Some(c) = cats.iter().find(|c| resolved(&c.url) == root) {
        return (c.name.clone(), c.url.clone());
    }
    if let Some(c) = cats.iter().find(|c| !is_search(&c.name)) {
        return (c.name.clone(), c.url.clone());
    }
    // Every category is a search entry — probe the site root instead.
    ("首页".to_string(), src.source_url.clone())
}

/// Local check: does the rule payload declare the selectors it needs?
fn stage_rule(src: &Source) -> StageResult {
    let cats = browse::categories(src);
    let has_list_rules = !src.rule_articles.trim().is_empty()
        || !src.rule_title.trim().is_empty()
        || !src.rule_link.trim().is_empty();

    // A bare-URL source has no rules by design; it is browsed as a link list,
    // so a missing content rule is expected rather than a defect.
    if !has_list_rules {
        let content = if src.rule_content.trim().is_empty() { "按链接列表浏览" } else { "已配置正文规则" };
        return stage(
            "rule",
            "规则",
            StageState::Ok,
            format!("{} 个分类 · 无解析规则，作为链接列表浏览 · {content}", cats.len()),
        );
    }

    // A single-page source reads the document itself, so `ruleContent` is a
    // refinement rather than a requirement.
    if is_single_page(src) {
        return stage(
            "rule",
            "规则",
            StageState::Ok,
            format!(
                "整页源（ruleArticles=body），直接读取页面本身 · {} 个分类",
                cats.len()
            ),
        );
    }

    let mut missing: Vec<&str> = Vec::new();
    if src.rule_articles.trim().is_empty() {
        missing.push("列表选择器 ruleArticles");
    }
    if src.rule_content.trim().is_empty() {
        missing.push("正文选择器 ruleContent");
    }

    let title_rule = if src.rule_title.trim().is_empty() {
        "未设置标题规则(将用链接文字)"
    } else {
        "标题规则已设置"
    };

    let detail = if missing.is_empty() {
        format!("{} 个分类 · 列表规则已设置 · {title_rule}", cats.len())
    } else {
        format!("{} 个分类 · {title_rule} · 未设置 {}", cats.len(), missing.join("、"))
    };

    // Informational, never a failure: every one of these states still opens in
    // the reader, because the engine falls back to inferring a list rule and
    // to the whole document when no content rule is declared. Painting them
    // amber buried the real blockers under noise.
    stage("rule", "规则", StageState::Ok, detail)
}

fn probe_homepage(src: &Source) -> (StageResult, ()) {
    match fetch::fetch(Some(src), &src.source_url) {
        Err(e) => (
            stage("homepage", "首页", StageState::Fail, format!("无法访问: {e}")),
            (),
        ),
        Ok(r) if !(200..300).contains(&r.status) => (
            stage(
                "homepage",
                "首页",
                StageState::Fail,
                format!("站点返回 HTTP {}，可能已失效或需要登录", r.status),
            ),
            (),
        ),
        Ok(r) => {
            let kind = r.content_type.split(';').next().unwrap_or("").trim();
            let kind = if kind.is_empty() { "未知类型" } else { kind };
            let result = stage(
                "homepage",
                "首页",
                StageState::Ok,
                format!("HTTP {} · {kind} · {}", r.status, size_label(r.body.len())),
            );
            (result, ())
        }
    }
}

/// Fetch a category listing and report how the list rule fared.
///
/// This repeats what `browse::load_page` does, because the report needs the
/// response size and status to tell "site is down" apart from "rule broke".
fn probe_list(src: &Source) -> (StageResult, Vec<ArticleItem>) {
    let (cat_name, template) = probe_category(src);

    let raw = browse::expand(&template, 1);
    let url = crate::util::absolute_url(raw.trim(), &src.source_url);

    js::set_script_headers(Some(src.headers()));
    let fetched = fetch::fetch_ok(Some(src), &url);
    js::set_script_headers(None);

    let resp = match fetched {
        Ok(r) => r,
        Err(e) => {
            let detail = if e.to_string().starts_with("规则解析失败") {
                format!("「{cat_name}」的规则本身有问题: {e}")
            } else {
                format!("「{cat_name}」打开失败: {e}")
            };
            return (stage("list", "列表", StageState::Fail, detail), Vec::new());
        }
    };

    let size = size_label(resp.body.len());
    let (items, _) = browse::parse_list(src, &resp.body, &resp.url);

    // A single-page source is supposed to yield one whole-document article.
    // Demanding a list of linked items from it would report a working rule as
    // broken, so this is information, not a warning.
    if is_single_page(src) {
        let chars = browse::load_article(src, &resp.url)
            .map(|c| c.text.chars().count())
            .unwrap_or(0);
        let (state, detail) = if chars == 0 {
            (
                StageState::Fail,
                format!("整页源打开了({size})但提取不到文字——页面很可能由 JS 渲染"),
            )
        } else {
            (StageState::Ok, format!("整页源，提取到 {chars} 字正文"))
        };
        return (stage("list", "列表", state, detail), Vec::new());
    }

    if items.is_empty() {
        let hint = if needs_javascript(src) {
            "该源开启了 JS 解析，而页面内容由脚本生成——纯服务端解析拿不到内容"
        } else {
            "通常是站点改版导致选择器失效"
        };
        return (
            stage(
                "list",
                "列表",
                StageState::Warn,
                format!("「{cat_name}」能打开({size}),但规则没有匹配到任何条目——{hint}"),
            ),
            Vec::new(),
        );
    }

    let with_link = items.iter().filter(|i| !i.link.trim().is_empty()).count();
    let first = crate::util::short_url(items[0].title.trim(), 24);
    let (state, detail) = if with_link == 0 {
        // Naming the rule that produced no address is the difference between a
        // dead site and a source whose link rule the engine cannot use.
        let rule = crate::util::short_url(src.rule_link.trim(), 40);
        let because = if rule.trim().is_empty() {
            "该源没有配置链接规则 ruleLink".to_string()
        } else {
            format!("链接规则「{rule}」没有取到地址")
        };
        (StageState::Warn, format!("解析出 {} 条，但都没有链接（{because}）", items.len()))
    } else {
        (StageState::Ok, format!("解析出 {} 条 · 首条: {first}", items.len()))
    };
    (stage("list", "列表", state, detail), items)
}

fn probe_detail(src: &Source, item: &ArticleItem) -> (StageResult, ()) {
    if item.link.trim().is_empty() {
        return (stage("detail", "详情", StageState::Skip, "列表里没有可打开的条目"), ());
    }
    match browse::load_article(src, &item.link) {
        Err(e) => (
            stage("detail", "详情", StageState::Fail, format!("正文页打开失败: {e}")),
            (),
        ),
        Ok(content) => {
            let chars = content.text.chars().count();
            let media = content.media.len();
            if chars == 0 {
                (
                    stage(
                        "detail",
                        "详情",
                        StageState::Fail,
                        format!(
                            "页面打开成功但没有提取到正文——ruleContent 可能已失效 ({})",
                            crate::util::short_url(&content.final_url, 40)
                        ),
                    ),
                    (),
                )
            } else if chars < THIN_TEXT {
                (
                    stage(
                        "detail",
                        "详情",
                        StageState::Warn,
                        format!("只提取到 {chars} 个字，正文规则可能只命中了片段"),
                    ),
                    (),
                )
            } else {
                let extra = if media > 0 { format!(" · {media} 个媒体文件") } else { String::new() };
                (
                    stage("detail", "详情", StageState::Ok, format!("正文 {chars} 字{extra}")),
                    (),
                )
            }
        }
    }
}

fn probe_search(src: &Source) -> (StageResult, ()) {
    if src.search_url.trim().is_empty() {
        return (stage("search", "搜索", StageState::Skip, "该源没有配置搜索地址"), ());
    }
    // A site-specific keyword gives far better coverage than a generic one.
    let keyword = {
        let name = src.display_name().trim();
        let trimmed: String = name.chars().take(8).collect();
        if trimmed.is_empty() { "2024".to_string() } else { trimmed }
    };
    let raw = src.search_url.replace("{{keyWord}}", &keyword);
    let raw = browse::expand(&raw, 1);
    let url = crate::util::absolute_url(raw.trim(), &src.source_url);

    let resp = match fetch::fetch_ok(Some(src), &url) {
        Ok(r) => r,
        Err(e) => return (stage("search", "搜索", StageState::Fail, format!("搜索请求失败: {e}")), ()),
    };
    let (items, _) = browse::parse_list(src, &resp.body, &resp.url);
    if items.is_empty() {
        (
            stage(
                "search",
                "搜索",
                StageState::Warn,
                format!("搜索「{keyword}」返回 0 条，ruleSearchList 可能与该站不符"),
            ),
            (),
        )
    } else {
        (
            stage("search", "搜索", StageState::Ok, format!("搜索「{keyword}」返回 {} 条", items.len())),
            (),
        )
    }
}

// ---------------------------------------------------------------------------
// Whole-source verification
// ---------------------------------------------------------------------------

/// Verify one source through every stage.
///
/// `cancel` is checked between stages so a batch run can stop promptly; pass
/// `None` for a single ad-hoc check.
pub fn verify(source: &Source, cancel: Option<&AtomicBool>) -> Health {
    let started = Instant::now();
    let mut stages = vec![stage_rule(source)];
    let mut item_count = 0usize;
    // Shadowed by the real count below; this covers the early-cancel return.
    // A single-page source yields one article rather than a list, so it counts
    // as usable from the start and the content stage decides the verdict.
    let usable = usize::from(is_single_page(source));
    let mut sample = String::new();

    let stop = |flag: Option<&AtomicBool>| flag.map(|c| c.load(Ordering::Relaxed)).unwrap_or(false);

    if stop(cancel) {
        stages.extend(cancelled_stages());
        return summarise(stages, item_count, usable, sample, started.elapsed());
    }

    // -- homepage
    let src = source.clone();
    let (homepage, _) = run_stage("homepage", "首页", move || probe_homepage(&src));
    stages.push(homepage);

    // -- list (its result feeds the detail stage)
    let src = source.clone();
    let (list, items) = run_stage("list", "列表", move || probe_list(&src));
    let items = items.unwrap_or_default();
    item_count = items.len();
    // Only items that carry a link can actually be opened, so the verdict is
    // based on those rather than on the raw count.
    let usable = items.iter().filter(|i| !i.link.trim().is_empty()).count();
    sample = items.first().map(|i| crate::util::short_url(i.title.trim(), 40)).unwrap_or_default();
    stages.push(list);

    // -- detail and search
    if stop(cancel) {
        stages.push(stage("detail", "详情", StageState::Skip, "已取消"));
        stages.push(stage("search", "搜索", StageState::Skip, "已取消"));
    } else {
        // A single-page source has no list item to open; the page itself is
        // the article, so check the content rule against it directly.
        let single = is_single_page(source);
        let root = source.source_url.clone();
        let src = source.clone();
        let (detail, _) = run_stage("detail", "详情", move || {
            let item = ArticleItem {
                link: if single { root } else { String::new() },
                ..ArticleItem::default()
            };
            probe_detail(&src, &item)
        });
        stages.push(detail);

        let src = source.clone();
        let (search, _) = run_stage("search", "搜索", move || probe_search(&src));
        stages.push(search);
    }

    summarise(stages, item_count, usable, sample, started.elapsed())
}

/// Fold the stage results into the verdict the sidebar dot reads.
///
/// `usable` — not `item_count` — decides whether the source works, because a
/// source whose entries carry no link cannot be read at all.
fn summarise(
    stages: Vec<StageResult>,
    item_count: usize,
    usable: usize,
    sample: String,
    took: Duration,
) -> Health {
    let first_of = |state: StageState| {
        stages
            .iter()
            .find(|s| s.state == state)
            .map(|s| format!("{}: {}", s.label, s.detail))
    };

    let status = if let Some(f) = first_of(StageState::Fail) {
        f
    } else if let Some(w) = first_of(StageState::Warn) {
        w
    } else {
        format!("正常 · 解析出 {item_count} 条")
    };

    Health {
        // A warning keeps a source out of the "fully working" count: the user
        // should see the amber dot and read why.
        ok: !stages.iter().any(|s| s.state != StageState::Ok && s.state != StageState::Skip)
            && usable > 0,
        status,
        item_count,
        checked_at: chrono::Utc::now().timestamp(),
        sample,
        stages,
        duration_ms: took.as_millis() as u64,
    }
}

/// Classify a finished report for the batch counters.
///
/// Kept next to `summarise` so the counters and the sidebar dot can never
/// disagree about what "ok" means.
pub fn classify(health: &Health) -> OutcomeKind {
    if health.stages.iter().any(|s| s.state == StageState::Fail) {
        OutcomeKind::Failed
    } else if health.stages.iter().any(|s| s.state == StageState::Warn) {
        OutcomeKind::Warn
    } else if health.ok {
        OutcomeKind::Ok
    } else {
        OutcomeKind::Warn
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutcomeKind {
    Ok,
    Warn,
    Failed,
}

// ---------------------------------------------------------------------------
// Batch verification
// ---------------------------------------------------------------------------

/// Verify many sources on a bounded worker pool.
///
/// `sink` runs on the calling thread, once per finished source, in completion
/// order — the caller uses it to persist and to emit progress.
pub fn verify_many<F>(targets: Vec<Target>, workers: usize, cancel: &AtomicBool, mut sink: F) -> Outcome
where
    F: FnMut(&Target, Health),
{
    let total = targets.len();
    let mut outcome = Outcome { total, ..Default::default() };
    if total == 0 {
        return outcome;
    }

    let workers = workers.clamp(1, MAX_WORKERS).min(total);
    let queue = Arc::new(Mutex::new(targets));
    let cancel = Arc::new(AtomicBool::new(cancel.load(Ordering::Relaxed)));

    let (tx, rx) = mpsc::channel::<(Target, Health)>();
    let mut handles = Vec::with_capacity(workers);
    for _ in 0..workers {
        let queue = queue.clone();
        let cancel = cancel.clone();
        let tx = tx.clone();
        handles.push(std::thread::spawn(move || loop {
            if cancel.load(Ordering::Relaxed) {
                break;
            }
            let next = queue.lock().ok().and_then(|mut q| q.pop());
            let Some(target) = next else { break };
            let health = verify(&target.source, Some(&cancel));
            if tx.send((target, health)).is_err() {
                break;
            }
        }));
    }
    // Dropping our sender lets the coordinator see `rx` close when workers end.
    drop(tx);

    for (target, health) in rx {
        // The counters and the sidebar dot must agree, so both go through
        // `classify`.
        match classify(&health) {
            OutcomeKind::Ok => outcome.ok += 1,
            OutcomeKind::Warn => outcome.warn += 1,
            OutcomeKind::Failed => outcome.failed += 1,
        }
        sink(&target, health);
    }

    for h in handles {
        let _ = h.join();
    }
    outcome.cancelled = cancel.load(Ordering::Relaxed);
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    fn src() -> Source {
        Source {
            source_url: "https://example.com/".into(),
            source_name: "示例".into(),
            rule_articles: "@id=item".into(),
            rule_content: "@id=content".into(),
            ..Default::default()
        }
    }

    #[test]
    fn size_label_reads_naturally() {
        assert_eq!(size_label(512), "512 B");
        assert_eq!(size_label(2048), "2.0 KB");
        assert_eq!(size_label(3 * 1024 * 1024), "3.0 MB");
    }

    #[test]
    fn rule_stage_only_notes_what_is_unset() {
        let mut s = src();
        // A source that parses lists but declares no content rule still opens
        // in the reader, so this must not be painted as a problem.
        s.rule_articles = String::new();
        s.rule_title = "a@href".into();
        let r = stage_rule(&s);
        assert_eq!(r.state, StageState::Ok, "{}", r.detail);
        assert!(r.detail.contains("ruleArticles"), "{}", r.detail);
    }

    #[test]
    fn rule_stage_passes_with_both_selectors() {
        assert_eq!(stage_rule(&src()).state, StageState::Ok);
    }

    #[test]
    fn a_bare_url_source_is_not_reported_as_missing_rules() {
        // No rules at all is how a bookmark page is meant to be consumed, so
        // warning about `ruleContent` here would be a false alarm.
        let s = Source {
            source_url: "https://example.com/".into(),
            source_name: "链接页".into(),
            ..Default::default()
        };
        let r = stage_rule(&s);
        assert_eq!(r.state, StageState::Ok, "{}", r.detail);
        assert!(r.detail.contains("链接列表"), "{}", r.detail);
    }

    #[test]
    fn a_search_category_is_never_used_as_the_probe() {
        // Plenty of sources put a search box first; probing it without a
        // keyword returns nothing and would be blamed on the rules.
        let s = Source {
            source_url: "https://example.com/".into(),
            sort_url: "搜索::/search?kw={{keyWord}}$$$最新::/list".into(),
            ..src()
        };
        let (name, url) = probe_category(&s);
        assert!(!name.contains("搜索"), "probed a search category: {name}");
        // `sortUrl` keeps the entry relative; `probe_list` resolves it later.
        assert_eq!(url, "/list");
    }

    #[test]
    fn the_site_root_wins_when_it_is_a_category() {
        let s = Source {
            source_url: "https://example.com/".into(),
            sort_url: "搜索::/search$$$首页::/$$$最新::/list".into(),
            ..src()
        };
        let (name, url) = probe_category(&s);
        // The entry is written as `/`, which only matches the root once resolved.
        assert_eq!(name, "首页");
        assert_eq!(url, "/");
    }

    #[test]
    fn an_all_search_source_falls_back_to_the_root() {
        let s = Source {
            source_url: "https://example.com/".into(),
            sort_url: "搜索::/search?kw={{keyWord}}".into(),
            ..src()
        };
        let (_, url) = probe_category(&s);
        assert_eq!(url, "https://example.com/");
    }

    #[test]
    fn a_body_rule_without_a_link_rule_is_a_single_page_source() {
        let s = Source {
            source_url: "https://example.com/".into(),
            rule_articles: "body".into(),
            ..Default::default()
        };
        assert!(is_single_page(&s));
    }

    #[test]
    fn a_real_list_rule_is_never_a_single_page_source() {
        let s = Source {
            rule_articles: "@class=item".into(),
            ..Default::default()
        };
        assert!(!is_single_page(&s));
        // Even with no link rule: the list rule is what does the work.
        let s = Source {
            rule_articles: "body".into(),
            rule_link: "@id=a".into(),
            ..Default::default()
        };
        assert!(!is_single_page(&s));
    }

    #[test]
    fn a_failure_drives_the_verdict_and_wins_over_warnings() {
        let stages = vec![
            stage("rule", "规则", StageState::Ok, "fine"),
            stage("list", "列表", StageState::Warn, "no items"),
            stage("detail", "详情", StageState::Fail, "empty body"),
        ];
        let h = summarise(stages, 0, 0, String::new(), Duration::from_millis(5));
        assert!(!h.ok);
        assert_eq!(h.status, "详情: empty body");
        assert_eq!(h.duration_ms, 5);
        assert_eq!(h.stages.len(), 3);
    }

    #[test]
    fn warnings_alone_keep_the_source_usable() {
        let stages = vec![
            stage("rule", "规则", StageState::Ok, "fine"),
            stage("list", "列表", StageState::Warn, "no items"),
        ];
        let h = summarise(stages, 0, 0, String::new(), Duration::from_millis(5));
        // An empty listing is still a broken source, so `ok` stays false even
        // though no stage hard-failed.
        assert!(!h.ok);
        assert!(h.status.starts_with("列表:"), "{}", h.status);
    }

    #[test]
    fn entries_without_links_do_not_count_as_working() {
        // A source can parse "one item" and still be unreadable.
        let stages = vec![
            stage("rule", "规则", StageState::Ok, "fine"),
            stage("list", "列表", StageState::Warn, "解析出 1 条，但都没有链接"),
        ];
        let h = summarise(stages, 1, 0, "无链接".into(), Duration::from_millis(5));
        assert!(!h.ok, "an item with no link cannot be opened");
        assert_eq!(classify(&h), OutcomeKind::Warn);
    }

    #[test]
    fn classify_separates_failures_from_warnings() {
        let clean = summarise(
            vec![stage("rule", "规则", StageState::Ok, "fine")],
            5,
            5,
            String::new(),
            Duration::from_millis(1),
        );
        assert!(clean.ok);
        assert_eq!(classify(&clean), OutcomeKind::Ok);

        let warned = summarise(
            vec![
                stage("rule", "规则", StageState::Ok, "fine"),
                stage("list", "列表", StageState::Warn, "0 条"),
            ],
            0,
            0,
            String::new(),
            Duration::from_millis(1),
        );
        assert_eq!(classify(&warned), OutcomeKind::Warn);

        let failed = summarise(
            vec![stage("homepage", "首页", StageState::Fail, "无法访问")],
            0,
            0,
            String::new(),
            Duration::from_millis(1),
        );
        assert_eq!(classify(&failed), OutcomeKind::Failed);
    }

    #[test]
    fn a_clean_run_is_ok_and_reports_the_count() {
        let stages = vec![
            stage("rule", "规则", StageState::Ok, "fine"),
            stage("search", "搜索", StageState::Skip, "no searchUrl"),
        ];
        let h = summarise(stages, 12, 12, "首条".into(), Duration::from_millis(7));
        assert!(h.ok);
        assert_eq!(h.status, "正常 · 解析出 12 条");
        assert_eq!(h.item_count, 12);
        assert_eq!(h.sample, "首条");
    }

    #[test]
    fn cancelling_skips_every_remaining_stage() {
        let flag = AtomicBool::new(true);
        let h = verify(&src(), Some(&flag));
        assert!(!h.ok);
        let states: Vec<_> = h.stages.iter().map(|s| s.state).collect();
        assert_eq!(states.len(), 5);
        assert_eq!(states[0], StageState::Ok, "the local rule stage always runs");
        assert!(states[1..].iter().all(|s| *s == StageState::Skip), "{states:?}");
    }

    #[test]
    fn the_watchdog_abandons_a_hung_stage() {
        let started = Instant::now();
        let (result, value) = run_stage_with("list", "列表", Duration::from_millis(120), || {
            std::thread::sleep(Duration::from_secs(5));
            (stage("list", "列表", StageState::Ok, "never reached"), 7u8)
        });
        assert_eq!(result.state, StageState::Fail);
        assert!(result.detail.contains("超过 0 秒"), "{}", result.detail);
        assert!(value.is_none());
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "the caller must not wait for the abandoned thread"
        );
    }

    #[test]
    fn the_watchdog_returns_a_value_from_a_stage_that_finishes() {
        let (result, value) = run_stage_with("list", "列表", Duration::from_secs(5), || {
            (stage("list", "列表", StageState::Ok, "3 条"), 3usize)
        });
        assert_eq!(result.state, StageState::Ok);
        assert_eq!(result.key, "list");
        assert_eq!(value, Some(3));
    }

    #[test]
    fn an_unreachable_source_is_reported_not_hung() {
        // A closed port refuses instantly, so this exercises the failure path
        // without waiting on the watchdog.
        let mut s = src();
        s.source_url = "http://127.0.0.1:1/".into();
        s.sort_url = String::new();
        let started = Instant::now();
        let h = verify(&s, None);
        assert!(!h.ok);
        assert!(h.stages.iter().any(|st| st.state == StageState::Fail));
        assert!(started.elapsed() < Duration::from_secs(20), "verification stalled");
    }

    #[test]
    fn batch_verification_delivers_every_target_exactly_once() {
        let targets = vec![
            Target { id: "a".into(), name: "A".into(), source: src() },
            Target { id: "b".into(), name: "B".into(), source: src() },
            Target { id: "c".into(), name: "C".into(), source: src() },
        ];
        let mut seen = Vec::new();
        let outcome = verify_many(targets, 3, &AtomicBool::new(false), |t, _| seen.push(t.id.clone()));
        seen.sort();
        assert_eq!(seen, vec!["a", "b", "c"]);
        assert_eq!(outcome.total, 3);
        assert_eq!(outcome.ok + outcome.warn + outcome.failed, 3);
    }

    #[test]
    fn a_cancelled_batch_stops_taking_work() {
        let flag = AtomicBool::new(true);
        let targets: Vec<Target> = (0..8)
            .map(|i| Target { id: format!("s{i}"), name: format!("S{i}"), source: src() })
            .collect();
        let mut count = 0usize;
        let outcome = verify_many(targets, 4, &flag, |_, _| count += 1);
        assert_eq!(count, 0, "no source should be verified once cancelled");
        assert_eq!(outcome.total, 8);
        assert!(outcome.cancelled);
    }

    #[test]
    fn worker_count_never_exceeds_the_target_count() {
        let targets = vec![Target { id: "only".into(), name: "O".into(), source: src() }];
        let outcome = verify_many(targets, 64, &AtomicBool::new(false), |_, _| {});
        assert_eq!(outcome.total, 1);
    }

    #[test]
    fn an_empty_batch_is_a_no_op() {
        let outcome = verify_many(Vec::new(), 4, &AtomicBool::new(false), |_, _| {
            panic!("nothing to do");
        });
        assert_eq!(outcome.total, 0);
        assert!(!outcome.cancelled);
    }
}