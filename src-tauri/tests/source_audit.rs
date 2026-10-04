//! Collection-wide source audit.
//!
//! Answers one question with numbers instead of impressions: **what fraction
//! of a shared collection actually works, and why do the rest fail?**
//!
//! The distinction that matters is between two very different failures:
//!
//! - **network** — the site could not be reached from this machine (DNS, ISP,
//!   the site is down, geo-blocked). Says nothing about the source rules.
//! - **rule** — the site answered, but the Legado rules did not match its
//!   markup. This is the category that is ours to fix, and it is completely
//!   independent of which network the audit runs from.
//!
//! Ignored by default because it hits the network. Run with:
//!
//! ```text
//! cargo test --test source_audit -- --ignored --nocapture
//! ```
//!
//! Override the collection and the sample size with environment variables:
//!
//! ```text
//! SERIOUS_AUDIT_URL=https://.../json/id/163.json
//! SERIOUS_AUDIT_LIMIT=40
//! SERIOUS_AUDIT_WORKERS=6
//! ```

use serious_lib::engine::verify::{self, Target};
use serious_lib::model::Source;
use serious_lib::repo;
use serious_lib::store::Health;
use std::collections::BTreeMap;
use std::sync::atomic::AtomicBool;
use std::sync::Mutex;
use std::time::Instant;

const DEFAULT_URL: &str = "https://www.yck2026.fun/yuedu/rsss/json/id/163.json";

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

/// Why a source failed, split into what we can fix and what we cannot.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Bucket {
    /// Every stage passed.
    Working,
    /// The site never answered from this machine.
    Unreachable,
    /// The site answered but the rules matched nothing useful.
    RuleBroken(String),
    /// Checked but neither healthy nor cleanly broken.
    Degraded(String),
}

impl Bucket {
    fn of(src: &Source, health: &Health) -> Self {
        let fail = |key: &str| health.stages.iter().find(|s| s.key == key && s.state == serious_lib::store::StageState::Fail);

        // A homepage or list fetch error means we never saw the real page.
        if let Some(stage) = fail("homepage").or_else(|| fail("list")) {
            let detail = stage.detail.to_lowercase();
            let transport = ["无法访问", "网络请求失败", "timed out", "超时", "dns", "connection"]
                .iter()
                .any(|m| detail.contains(m));
            return if transport {
                Bucket::Unreachable
            } else {
                // HTTP 4xx/5xx: the site answered, it just refused us.
                Bucket::Degraded(format!("{}: {}", stage.label, stage.detail))
            };
        }

        let hard_failed = health.stages.iter().any(|s| s.state == serious_lib::store::StageState::Fail);

        // A single-page source *is* the article; it produces no list, so
        // counting it as broken for having zero items would be wrong.
        if serious_lib::engine::verify::is_single_page(src) {
            return if hard_failed { Bucket::RuleBroken(health.status.clone()) } else { Bucket::Working };
        }

        // Reached the site, but no usable content came out.
        let usable = health.item_count > 0 && !health.stages.iter().any(|s| {
            s.key == "list" && s.detail.contains("没有链接")
        });
        if usable {
            Bucket::Working
        } else {
            let reason = health
                .stages
                .iter()
                .find(|s| s.state == serious_lib::store::StageState::Warn || s.state == serious_lib::store::StageState::Fail)
                .map(|s| format!("{}: {}", s.label, s.detail))
                .unwrap_or_else(|| health.status.clone());
            Bucket::RuleBroken(reason)
        }
    }
}

#[test]
#[ignore]
fn checks_a_bare_url_source() {
    // A bare-URL source is browsed as a link list, so this exercises
    // `extract_links` against a page that is known to contain many links.
    let url = env_or("SERIOUS_BARE_URL", "https://www.yck2026.fun/yuedu/rsss/index.html");
    let src = Source {
        source_name: "bare".into(),
        source_url: url.clone(),
        ..Default::default()
    };
    let resp = serious_lib::engine::fetch::fetch_ok(None, &url).expect("fetch failed");
    println!("fetched {} bytes from {url}", resp.body.len());

    let (items, _) = serious_lib::engine::browse::parse_list(&src, &resp.body, &resp.url);
    println!("parse_list produced {} item(s)", items.len());
    for item in items.iter().take(8) {
        println!("  title={:?} link={:?}", item.title, item.link);
    }

    // The two passes behind `extract_links` must line up; count them.
    let doc = serious_lib::engine::selector::Doc::parse(&resp.body);
    let hrefs = doc.eval("a@href");
    let titles = doc.eval("a@text");
    println!("a@href -> {} value(s)", hrefs.len());
    println!("a@text -> {} value(s)", titles.len());
    assert!(
        titles.len() >= hrefs.len() - 2,
        "title and href passes drifted apart ({} vs {})",
        titles.len(),
        hrefs.len(),
    );
}

#[test]
#[ignore]
fn lists_collections_by_size() {
    // Useful for picking an audit target: the index paginates, so scan a few
    // pages and report the largest collections first.
    let base = env_or("SERIOUS_REPO_BASE", "https://www.yck2026.fun");
    let mut all = Vec::new();
    for page in 1..=4 {
        match repo::fetch_index(&base, page) {
            Ok(list) if !list.is_empty() => all.extend(list),
            _ => break,
        }
    }
    all.sort_by_key(|c| std::cmp::Reverse(c.source_count));
    println!("{} collection(s) across 4 page(s)", all.len());
    for c in all.iter().take(15) {
        println!("  {:>4}  {:<28} {}", c.source_count, c.title, c.json_url);
    }
    assert!(!all.is_empty(), "the repository index returned nothing");
}

#[test]
#[ignore]
fn diagnoses_one_source() {
    // Point this at a single failing source to see what the engine actually
    // receives. Guessing from the verdict alone is how the audit gets wrong.
    let url = env_or("SERIOUS_AUDIT_URL", DEFAULT_URL);
    let needle = env_or("SERIOUS_AUDIT_MATCH", "秘密入口");
    let dump = env_or("SERIOUS_AUDIT_DUMP", "3000");

    let sources = repo::fetch_collection(&url).expect("collection fetch failed");
    let src = sources
        .iter()
        .find(|s| s.display_name().contains(&needle))
        .unwrap_or_else(|| panic!("no source matching {needle:?}"));

    println!("=== {} ===", src.display_name());
    println!("sourceUrl : {}", src.source_url);
    println!("sortUrl   : {:?}", src.sort_url.chars().take(160).collect::<String>());
    println!("ruleArt   : {:?}", src.rule_articles);
    println!("ruleTitle : {:?}", src.rule_title);
    println!("ruleLink  : {:?}", src.rule_link);
    println!("ruleCont  : {:?}", src.rule_content.chars().take(120).collect::<String>());
    println!("enableJs  : {}", src.enable_js);
    println!("categories:");
    for c in serious_lib::engine::browse::categories(src) {
        println!("   {:<16} {}", c.name, c.url);
    }

    let health = verify::verify(src, None);
    println!("\nverdict: {}", health.status);
    for s in &health.stages {
        println!("  {} {:<6} {:>7}  {}", s.state.glyph(), s.label, format!("{}ms", s.ms), s.detail);
    }

    // Pull the probe page again and show what came back.
    let cats = serious_lib::engine::browse::categories(src);
    let probe = cats
        .first()
        .map(|c| c.url.clone())
        .unwrap_or_else(|| src.source_url.clone());
    let probe = serious_lib::engine::browse::expand(&probe, 1);
    let probe = serious_lib::util::absolute_url(probe.trim(), &src.source_url);
    println!("\nprobe url: {probe}");
    match serious_lib::engine::fetch::fetch_ok(Some(src), &probe) {
        Ok(r) => {
            println!("status {} · {} · {} bytes", r.status, r.content_type, r.body.len());
            let n: usize = dump.parse().unwrap_or(3000);
            println!("--- body ---\n{}\n--- end ---", r.body.chars().take(n).collect::<String>());
        }
        Err(e) => println!("probe fetch failed: {e}"),
    }
}

#[test]
#[ignore]
fn audits_a_collection() {
    let url = env_or("SERIOUS_AUDIT_URL", DEFAULT_URL);
    let limit: usize = env_or("SERIOUS_AUDIT_LIMIT", "40").parse().unwrap_or(40);
    let workers: usize = env_or("SERIOUS_AUDIT_WORKERS", "6").parse().unwrap_or(6);

    let sources = repo::fetch_collection(&url).expect("collection fetch failed");
    println!("collection {url} carries {} source(s)", sources.len());
    let sample: Vec<Source> = sources.into_iter().take(limit).collect();

    let targets: Vec<Target> = sample
        .iter()
        .map(|s| Target {
            id: s.source_url.clone(),
            name: s.display_name().to_string(),
            source: s.clone(),
        })
        .collect();

    let buckets: Mutex<BTreeMap<&'static str, Vec<String>>> = Mutex::new(BTreeMap::new());
    let detail: Mutex<Vec<(String, Bucket)>> = Mutex::new(Vec::new());

    let started = Instant::now();
    let outcome = verify::verify_many(targets, workers, &AtomicBool::new(false), |target, health| {
        let bucket = Bucket::of(&target.source, &health);
        let line = format!("{} — {}", target.name, health.status);
        let key = match &bucket {
            Bucket::Working => "working",
            Bucket::Unreachable => "unreachable",
            Bucket::RuleBroken(_) => "rule-broken",
            Bucket::Degraded(_) => "degraded",
        };
        buckets.lock().unwrap().entry(key).or_default().push(line);
        detail.lock().unwrap().push((target.name.clone(), bucket));
    });
    let took = started.elapsed();

    let buckets = buckets.into_inner().unwrap();
    let total = outcome.total.max(1) as f64;

    println!("\n===== 审计结果 / audit of {url} =====");
    println!("sampled {} source(s) in {:.1}s with {workers} worker(s)\n", outcome.total, took.as_secs_f64());
    for (key, list) in &buckets {
        println!("  {key:<12} {:>3}  ({:.0}%)", list.len(), list.len() as f64 / total * 100.0);
    }

    // The actionable number: of everything we could actually reach, how much
    // produced usable content?
    let reachable = outcome.total - buckets.get("unreachable").map(|v| v.len()).unwrap_or(0);
    let working = buckets.get("working").map(|v| v.len()).unwrap_or(0);
    println!("\n  of {reachable} reachable source(s), {working} work ({:.0}%)",
        if reachable == 0 { 0.0 } else { working as f64 / reachable as f64 * 100.0 });

    // Why the failures happen decides what is worth building. A page that
    // needs a browser is a different problem from a stale selector.
    let mut js_needs_browser = 0usize;
    let mut stale_rules = 0usize;
    for s in &sample {
        if !serious_lib::engine::verify::needs_javascript(s) {
            continue;
        }
        let health = verify::verify(s, None);
        if health.ok || health.stages.iter().any(|st| st.state == serious_lib::store::StageState::Fail) {
            js_needs_browser += 1;
        } else {
            stale_rules += 1;
        }
    }
    let single_page = sample.iter().filter(|s| serious_lib::engine::verify::is_single_page(s)).count();
    println!("\n  profile of the {}-source sample:", sample.len());
    println!("    declared enableJs          {js_needs_browser}");
    println!("    single-page (rule=body)    {single_page}");
    println!("    js sources still parsing    {stale_rules}");

    if let Some(list) = buckets.get("rule-broken") {
        println!("\n----- rule-broken (the ones we can fix) -----");
        for line in list {
            println!("  {line}");
        }
    }
    if let Some(list) = buckets.get("degraded") {
        println!("\n----- degraded -----");
        for line in list {
            println!("  {line}");
        }
    }

    let _ = detail;
    assert_eq!(working + buckets.get("rule-broken").map(|v| v.len()).unwrap_or(0)
        + buckets.get("unreachable").map(|v| v.len()).unwrap_or(0)
        + buckets.get("degraded").map(|v| v.len()).unwrap_or(0), outcome.total);
}