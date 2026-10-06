//! Does a source's rule still describe its page?
//!
//! Eight sources fail after a browser render even though the rendered page
//! *does* contain links. That has exactly two explanations and they call for
//! opposite responses, so this settles which one each source is:
//!
//! * **upstream redesign** — the rule names classes the site no longer serves.
//!   Nothing in the engine can fix that; the rule needs rewriting.
//! * **engine defect** — the named classes are present and full of content, and
//!   [`browse::parse_list`] still finds nothing. That is ours, and it is worth a
//!   minimal reproduction.
//!
//! The evidence is deliberately blunt: how many times does each name the rule
//! mentions actually occur in the rendered DOM, next to how many items the
//! engine's own parser produced from that same DOM. A name with a count of zero
//! cannot be missed by a parser — it is gone.
//!
//! Input is what `scripts/t8-capture.mjs` captured: several snapshots per
//! source, because a source that only sometimes works must be reported as
//! intermittent rather than as fixed.
//!
//! ```text
//! node scripts/t8-capture.mjs
//! cargo test --release --test rule_fit -- --ignored --nocapture
//! ```

use serde::Deserialize;
use serious_lib::model::Source;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Deserialize)]
struct ManifestEntry {
    name: String,
    source_url: String,
    rule_articles: String,
    rule_title: String,
    rule_link: String,
    enable_js: bool,
    probe_url: String,
    probe_category: String,
    snapshots: Vec<Snapshot>,
}

#[derive(Debug, Deserialize)]
struct Snapshot {
    attempt: usize,
    raw_len: Option<usize>,
    rendered_len: Option<usize>,
    file: Option<String>,
}

fn capture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("test-results").join("t8-render")
}

/// The class and id names a Legado selector identifies its container by.
///
/// `class.update_area_lists@tag.li` → `update_area_lists`. The trailing `li` is
/// an element name, not a marker: counting it as "the name the rule needs"
/// would let any page containing a list item look like a match. Only the
/// container names decide whether the rule still describes the page.
fn container_names(rule: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let chars: Vec<char> = rule.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let rest: String = chars[i..].iter().collect();
        // `class.` / `id.` name a container; `tag.` / `text.` do not.
        if let Some(prefix) = ["class.", "id."].iter().find(|p| rest.starts_with(**p)) {
            let name: String = chars[i + prefix.len()..]
                .iter()
                .take_while(|c| c.is_alphanumeric() || **c == '_' || **c == '-')
                .collect();
            if !name.is_empty() && !out.contains(&name) {
                out.push(name.clone());
            }
            i += prefix.len() + name.chars().count();
            continue;
        }
        if rest.starts_with("tag.") || rest.starts_with("text.") {
            i += 4;
            continue;
        }
        // A bare `.name` or `#name` is a container too.
        if chars[i] == '.' || chars[i] == '#' {
            let name: String = chars[i + 1..]
                .iter()
                .take_while(|c| c.is_alphanumeric() || **c == '_' || **c == '-')
                .collect();
            if !name.is_empty() && !out.contains(&name) {
                out.push(name.clone());
            }
            i += 1 + name.chars().count();
            continue;
        }
        i += 1;
    }
    out
}

/// Page furniture that means we were not served the content at all.
///
/// A rule cannot be stale about a page that never arrived. Reading these out of
/// the captured DOM is the difference between "upstream redesigned" and
/// "upstream is not talking to us", which call for different answers.
const BLOCK_MARKERS: &[&str] = &[
    "请验证密码",
    "验证密码",
    "密码访问",
    "安全验证",
    "请稍候",
    "just a moment",
    "cloudflare",
    "ray id",
    "enable javascript and cookies",
    "藏起来了",
    "access denied",
    "too many requests",
];

fn block_reason(html: &str) -> Option<&'static str> {
    let lower = html.to_lowercase();
    BLOCK_MARKERS.iter().find(|m| lower.contains(&m.to_lowercase())).copied()
}

fn title_of(html: &str) -> String {
    match (html.find("<title"), html.find("</title>")) {
        (Some(a), Some(b)) if b > a => html[a + 7..b].trim().to_string(),
        _ => String::new(),
    }
}

/// Visible text, scripts and styles removed — enough to recognise a page.
fn visible_text(html: &str) -> String {
    let stripped = html
        .replace("<script", "\u{0}")
        .replace("<style", "\u{0}");
    let mut out = String::new();
    let mut skip = false;
    for c in stripped.chars() {
        match c {
            '\u{0}' => skip = true,
            '<' => skip = false,
            '>' if skip => {}
            _ => out.push(c),
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[test]
#[ignore]
fn compares_every_rule_with_the_page_it_is_meant_for() {
    let dir = capture_dir();
    let manifest_path = dir.join("manifest.json");
    assert!(
        manifest_path.exists(),
        "no capture at {} — run: node scripts/t8-capture.mjs",
        manifest_path.display()
    );
    let manifest: Vec<ManifestEntry> =
        serde_json::from_str(&std::fs::read_to_string(&manifest_path).unwrap()).unwrap();

    println!("\n===== rule vs rendered page =====");
    let mut verdict: BTreeMap<String, &'static str> = BTreeMap::new();

    for entry in &manifest {
        let src = Source {
            source_url: entry.source_url.clone(),
            source_name: entry.name.clone(),
            rule_articles: entry.rule_articles.clone(),
            rule_title: entry.rule_title.clone(),
            rule_link: entry.rule_link.clone(),
            enable_js: entry.enable_js,
            ..Default::default()
        };
        let names = container_names(&entry.rule_articles);

        println!("\n--- {} ---", entry.name);
        println!("  probe        : [{}] {}", entry.probe_category, entry.probe_url);
        println!("  ruleArticles : {}", entry.rule_articles);
        println!("  ruleTitle    : {}", entry.rule_title.replace('\n', " "));
        println!("  ruleLink     : {}", entry.rule_link.replace('\n', " "));
        println!("  containers   : {}", names.join(", "));

        let mut items_seen: Vec<usize> = Vec::new();
        let mut all_zero = true;
        let mut names_present_anywhere = false;
        let mut blocked_everywhere = true;
        let mut first_title = String::new();
        let mut first_text = String::new();

        for snap in &entry.snapshots {
            let Some(file) = &snap.file else {
                println!(
                    "  #{} raw {:>7} B · rendered FAILED",
                    snap.attempt,
                    snap.raw_len.map(|n| n.to_string()).unwrap_or_else(|| "-".into())
                );
                blocked_everywhere = false;
                continue;
            };
            let html = std::fs::read_to_string(dir.join(file)).unwrap_or_default();
            let (items, _) = serious_lib::engine::browse::parse_list(&src, &html, &entry.probe_url);
            let openable = items.iter().filter(|i| !i.link.trim().is_empty()).count();

            let counts: Vec<String> = names
                .iter()
                .map(|n| {
                    let hits = html.matches(n.as_str()).count();
                    if hits > 0 {
                        names_present_anywhere = true;
                    }
                    format!("{n}={hits}")
                })
                .collect();
            let marker = block_reason(&html);
            if marker.is_none() {
                blocked_everywhere = false;
            }
            if first_title.is_empty() {
                first_title = title_of(&html);
                // Truncate on a char boundary: these pages are Chinese, and
                // slicing bytes would panic rather than shorten.
                let text = visible_text(&html);
                first_text = text.chars().take(80).collect();
            }

            println!(
                "  #{} raw {:>7} B · rendered {:>7} B · engine items {:>3} (openable {:>3}) · containers: {} · {}",
                snap.attempt,
                snap.raw_len.map(|n| n.to_string()).unwrap_or_else(|| "-".into()),
                snap.rendered_len.map(|n| n.to_string()).unwrap_or_else(|| "-".into()),
                items.len(),
                openable,
                if counts.is_empty() { "(none)".to_string() } else { counts.join(" ") },
                match marker {
                    Some(m) => format!("page is a wall: {m:?}"),
                    None => "looks like content".to_string(),
                },
            );
            items_seen.push(openable);
            if openable > 0 {
                all_zero = false;
            }
        }

        println!("  page title   : {first_title:?}");
        println!("  page text    : {first_text}");

        // The classification, stated as the rules it follows.
        //
        // 1. The page we were served is a password wall or a bot challenge. The
        //    content never arrived, so the rule cannot be judged stale and the
        //    engine cannot be blamed: say what actually happened.
        // 2. Otherwise, if the container the rule names is absent from every
        //    snapshot, the rule describes markup this site no longer serves.
        // 3. Otherwise, if the container is there with content and the parser
        //    still found nothing, that is ours — and it is the only branch that
        //    earns a fix.
        // 4. Snapshots that disagree with each other make the source
        //    intermittent, which is its own answer.
        let varies = items_seen.windows(2).any(|w| w[0] != w[1]);

        let kind = if blocked_everywhere && !names_present_anywhere {
            "upstream is not serving the page (password wall / bot challenge)"
        } else if !names_present_anywhere {
            "upstream redesign — the rule names containers the page no longer contains"
        } else if varies {
            "intermittent — same source, different result across snapshots"
        } else if all_zero {
            "engine defect — the containers are on the page and the parser found nothing"
        } else {
            "working — the engine parsed this rendered page"
        };
        println!("  => {kind}");
        verdict.insert(entry.name.clone(), kind);
    }

    println!("\n===== verdict =====");
    for (name, kind) in &verdict {
        println!("  {name:<22} {kind}");
    }
    println!();
    assert_eq!(verdict.len(), manifest.len(), "every source must be classified");
}