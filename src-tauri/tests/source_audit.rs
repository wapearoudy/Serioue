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

    // Phase 1 — which of these can this machine open at all?
    //
    // Roughly half of any given sample is dead, DNS-blocked or geo-restricted,
    // and that share drifts between runs. Folding it into the same denominator
    // as engine quality makes the number unmeasurable: an improvement is
    // invisible under the noise. So reachability is settled first, and the
    // pass rate is reported over what this machine can actually reach.
    let probe_started = Instant::now();
    // Reachability probes are independent one-shot requests, so they go out
    // concurrently; doing them one at a time dominated the whole audit.
    let threads = workers.clamp(1, 16);
    let chunk = sample.len().div_ceil(threads).max(1);
    let parts: Vec<Vec<&Source>> = sample.chunks(chunk).map(|c| c.iter().collect()).collect();
    let found: Vec<Vec<Source>> = std::thread::scope(|scope| {
        let handles: Vec<_> = parts
            .iter()
            .map(|part| {
                scope.spawn(move || {
                    let mut ok = Vec::new();
                    for s in part {
                        let probe = s.source_url.trim();
                        if probe.starts_with("http")
                            && serious_lib::engine::fetch::fetch_ok(Some(s), probe).is_ok()
                        {
                            ok.push((*s).clone());
                        }
                    }
                    ok
                })
            })
            .collect();
        handles.into_iter().filter_map(|h| h.join().ok()).collect()
    });
    let mut reachable: Vec<Source> = Vec::new();
    for part in found {
        reachable.extend(part);
    }
    println!(
        "phase 1: {} of {} reachable from this machine in {:.1}s ({threads} threads)",
        reachable.len(),
        sample.len(),
        probe_started.elapsed().as_secs_f64(),
    );
    let unreachable_count = sample.len() - reachable.len();
    if reachable.is_empty() {
        println!("nothing reachable; the audit cannot say anything about the engine");
        return;
    }

    let targets: Vec<Target> = reachable
        .iter()
        .map(|s| Target {
            id: s.source_url.clone(),
            name: s.display_name().to_string(),
            source: s.clone(),
        })
        .collect();

    let buckets: Mutex<BTreeMap<&'static str, Vec<String>>> = Mutex::new(BTreeMap::new());
    let detail: Mutex<Vec<(String, Bucket)>> = Mutex::new(Vec::new());
    let js_total = Mutex::new(0usize);
    let single_page = Mutex::new(0usize);
    let no_js_working = Mutex::new(0usize);

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
        if serious_lib::engine::verify::needs_javascript(&target.source) {
            *js_total.lock().unwrap() += 1;
        }
        if serious_lib::engine::verify::is_single_page(&target.source) {
            *single_page.lock().unwrap() += 1;
        }
        if matches!(bucket, Bucket::Working)
            && !serious_lib::engine::verify::needs_javascript(&target.source)
        {
            *no_js_working.lock().unwrap() += 1;
        }
        buckets.lock().unwrap().entry(key).or_default().push(line);
        detail.lock().unwrap().push((target.name.clone(), bucket));
    });
    let took = started.elapsed();
    let js_total = *js_total.lock().unwrap();
    let single_page = *single_page.lock().unwrap();
    let no_js_working = *no_js_working.lock().unwrap();

    let buckets = buckets.into_inner().unwrap();
    let total = outcome.total.max(1) as f64;

    println!("\n===== 审计结果 / audit of {url} =====");
    println!(
        "verified {} reachable source(s) in {:.1}s with {workers} worker(s)",
        outcome.total,
        took.as_secs_f64(),
    );
    println!("({unreachable_count} source(s) could not be opened here and are excluded)\n");
    for (key, list) in &buckets {
        println!("  {key:<12} {:>3}  ({:.0}%)", list.len(), list.len() as f64 / total * 100.0);
    }

    // The headline number: of what this machine can reach, how much does the
    // engine actually handle?
    let working = buckets.get("working").map(|v| v.len()).unwrap_or(0);
    let broken = outcome.total - working;
    println!(
        "\n  ENGINE PASS RATE: {working}/{} reachable = {:.0}%  ({broken} not handled)",
        outcome.total,
        working as f64 / total * 100.0,
    );

    // Why the failures happen decides what is worth building. A page that
    // needs a browser is a different problem from a stale selector. Collected
    // during the run rather than by verifying everything a second time.
    println!("\n  profile of the {} reachable source(s):", outcome.total);
    println!("    work without a browser      {no_js_working}");
    println!("    declare enableJs            {js_total}");
    println!("    single-page (rule=body)     {single_page}");

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