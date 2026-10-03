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

use serious_lib::engine::{browse, selector::Doc};
use serious_lib::model::Source;
use serious_lib::repo;

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