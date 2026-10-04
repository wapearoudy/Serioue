//! Rule-based end-to-end checks against a real, rule-heavy collection.
//!
//! Ignored by default. Run with:
//!
//! ```text
//! cargo test --test live_rules -- --ignored --nocapture
//! ```
//!
//! This is the important one: collection 163 ships real Legado rules
//! (`class.video-player@all`, `$.model.data`, `{{$.model.title}}`, `##`
//! regex operators), so it exercises the selector engine, the template engine
//! and the JSON path together — not just the bare-URL fallback.

use serious_lib::engine::verify::{self, Target};
use serious_lib::engine::{browse, selector::Doc};
use serious_lib::model::Source;
use serious_lib::repo;
use serious_lib::store::StageState;
use std::sync::atomic::AtomicBool;

const COLLECTION: &str = "https://www.yck2026.fun/yuedu/rsss/json/id/163.json";

#[test]
#[ignore]
fn parses_rule_based_sources() {
    let sources = repo::fetch_collection(COLLECTION).expect("collection fetch failed");
    assert!(sources.len() >= 8, "expected many sources, got {}", sources.len());

    let mut with_rules = 0;
    for s in &sources {
        if !s.rule_articles.trim().is_empty() {
            with_rules += 1;
        }
        println!(
            "{} | articles={:?} title={:?} link={:?} js={} cats={}",
            s.display_name(),
            s.rule_articles.chars().take(30).collect::<String>(),
            s.rule_title.chars().take(24).collect::<String>(),
            s.rule_link.chars().take(24).collect::<String>(),
            s.enable_js,
            browse::categories(s).len(),
        );
    }
    assert!(with_rules > 0, "collection should carry real list rules");
}

#[test]
#[ignore]
fn renders_content_template() {
    // A JSON content rule shaped like the ones in this collection.
    let src = Source {
        source_name: "template".into(),
        source_url: "https://api.example.com".into(),
        rule_content: "<div><h3>{{$.model.title}}</h3><span>{{$.model.durationFormat}}</span>\
                       <p>{{$.model.onlineTime##T|.000.*## }}</p></div>".into(),
        ..Default::default()
    };
    let json = serde_json::json!({
        "model": {
            "title": "示例影片",
            "durationFormat": "12:34",
            "onlineTime": "2024-05-01T10:00:00.000Z"
        }
    });
    let body = json.to_string();
    let parsed = serde_json::from_str(&body).unwrap();
    let (html, text) = browse::extract_content(&src, &body, Some(&parsed));
    assert!(html.contains("示例影片"), "{html}");
    assert!(html.contains("12:34"), "{html}");
    assert!(text.contains("示例影片"), "{text}");
}

#[test]
#[ignore]
fn parses_video_card_markup() {
    // A source shaped like the PlayAV entry in collection 163.
    let src = Source {
        source_name: "PlayAV".into(),
        source_url: "https://playav.tv/".into(),
        rule_articles: "class.video-player@all".into(),
        rule_title: "img@alt".into(),
        rule_link: "a@href".into(),
        rule_image: "img@data-src".into(),
        rule_pub_date: ".duration@text".into(),
        ..Default::default()
    };
    let mut body = String::from("<div class=\"list\">");
    for i in 1..=4 {
        body.push_str(&format!(
            r#"<div class="video-player">
                  <a href="/watch/{i}.html">
                    <img data-src="/cover/{i}.jpg" alt="标题{i}"/>
                    <span class="duration">12:0{i}</span>
                  </a>
                </div>"#
        ));
    }
    body.push_str("</div>");

    let (items, _) = browse::parse_list(&src, &body, "https://playav.tv/");
    assert_eq!(items.len(), 4, "{items:#?}");
    assert_eq!(items[0].title, "标题1");
    assert_eq!(items[0].link, "https://playav.tv/watch/1.html");
    assert_eq!(items[0].image, "https://playav.tv/cover/1.jpg");
    assert_eq!(items[0].date, "12:01");
}

#[test]
#[ignore]
fn parses_json_list_rule() {
    // `ruleArticles: "$.model.data"` shape.
    let src = Source {
        source_name: "json".into(),
        source_url: "https://api.example.com".into(),
        rule_articles: "$.model.data".into(),
        rule_title: "$.title".into(),
        rule_link: "$.url".into(),
        ..Default::default()
    };
    let body = r#"{"model":{"data":[
        {"title":"第一条","url":"/a"},
        {"title":"第二条","url":"/b"},
        {"title":"第三条","url":"/c"}]}}"#;
    let (items, _) = browse::parse_list(&src, body, "https://api.example.com");
    assert_eq!(items.len(), 3, "{items:#?}");
    assert_eq!(items[0].title, "第一条");
    assert_eq!(items[1].link, "https://api.example.com/b");
}

#[test]
#[ignore]
fn expands_page_templates() {
    // `sortUrl` entries carry `{{page}}`.
    assert_eq!(browse::expand("https://a.com/p/{{page}}", 1), "https://a.com/p/1");
    assert_eq!(browse::expand("https://a.com/p/{{page}}", 12), "https://a.com/p/12");
}

#[test]
#[ignore]
fn js_rule_executes() {
    // `enableJs` sources run `java.ajax`; verify the sandbox computes a URL.
    // Both entries resolve to the same link, so dedup leaves a single item.
    let src = Source {
        source_name: "js".into(),
        source_url: "https://a.com".into(),
        rule_link: "@js:'https://a.com/p/' + (1 + 1)".into(),
        rule_articles: "$.list".into(),
        ..Default::default()
    };
    let body = r#"{"list":[{"title":"x"},{"title":"y"}]}"#;
    let (items, _) = browse::parse_list(&src, body, "https://a.com");
    assert_eq!(items.len(), 1, "{items:#?}");
    assert_eq!(items[0].link, "https://a.com/p/2", "{items:#?}");
    assert_eq!(items[0].title, "x");
    // A `{"title","url"}` node must not leak into the image or date fields.
    assert_eq!(items[0].image, "", "{items:#?}");
    assert_eq!(items[0].date, "", "{items:#?}");
}

#[test]
#[ignore]
fn media_extraction_from_article() {
    let doc = Doc::parse(
        r#"<div><video src="https://cdn.x.com/a.mp4" poster="https://cdn.x.com/p.jpg"></video></div>"#,
    );
    let media = doc.media_urls();
    assert!(media.iter().any(|m| m.ends_with(".mp4")), "{media:?}");
}

// ---------------------------------------------------------------------------
// Source verification
// ---------------------------------------------------------------------------

#[test]
#[ignore]
fn verifies_a_real_source_end_to_end() {
    let sources = repo::fetch_collection(COLLECTION).expect("collection fetch failed");
    let src = sources
        .first()
        .expect("collection is empty")
        .clone();

    let health = verify::verify(&src, None);

    // The report must always carry every stage, in order, whatever happened.
    let keys: Vec<_> = health.stages.iter().map(|s| s.key.as_str()).collect();
    assert_eq!(
        keys,
        vec!["rule", "homepage", "list", "detail", "search"],
        "stage order must be stable: {health:#?}"
    );

    println!("{} -> {}", src.display_name(), health.status);
    for s in &health.stages {
        println!("  {} {:<6} {:>6}  {}", s.state.glyph(), s.label, format!("{}ms", s.ms), s.detail);
    }

    // The rule stage is local, so it never fails on content.
    assert_eq!(health.stages[0].state, StageState::Ok, "{health:#?}");
    // A stage that ran must say something useful.
    for s in &health.stages {
        assert!(!s.detail.trim().is_empty(), "stage {} has no detail", s.key);
    }
}

#[test]
#[ignore]
fn a_dead_source_reports_a_failure_rather_than_hanging() {
    let src = Source {
        source_name: "dead".into(),
        // A domain reserved by RFC 5737 that will never answer.
        source_url: "http://192.0.2.1/".into(),
        rule_articles: "@class=item".into(),
        rule_content: "@class=content".into(),
        ..Default::default()
    };

    let started = std::time::Instant::now();
    let health = verify::verify(&src, None);
    let elapsed = started.elapsed();

    assert!(!health.ok);
    assert!(
        health.stages.iter().any(|s| s.state == StageState::Fail),
        "an unreachable site must fail a stage: {health:#?}"
    );
    // The watchdog, not the HTTP client's own timeout, is the ceiling here.
    assert!(elapsed < std::time::Duration::from_secs(60), "took {elapsed:?}");
    println!("dead source rejected in {elapsed:?}: {}", health.status);
}

#[test]
#[ignore]
fn batch_verification_reports_every_source() {
    let sources = repo::fetch_collection(COLLECTION).expect("collection fetch failed");
    let targets: Vec<Target> = sources
        .iter()
        .take(6)
        .map(|s| Target {
            id: s.source_url.clone(),
            name: s.display_name().to_string(),
            source: s.clone(),
        })
        .collect();
    let total = targets.len();

    let mut seen: Vec<String> = Vec::new();
    let outcome = verify::verify_many(targets, 3, &AtomicBool::new(false), |t, h| {
        println!("{:<24} {}", t.name, h.status);
        seen.push(t.id.clone());
    });

    assert_eq!(seen.len(), total);
    assert_eq!(outcome.total, total);
    assert_eq!(outcome.ok + outcome.warn + outcome.failed, total);
    assert!(!outcome.cancelled);
    println!("{total} sources: {} ok, {} warn, {} failed", outcome.ok, outcome.warn, outcome.failed);
}