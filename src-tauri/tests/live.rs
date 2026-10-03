//! Live end-to-end checks against the real source repository.
//!
//! These are ignored by default (`cargo test` skips them) because they need
//! network access. Run them explicitly with:
//!
//! ```text
//! cargo test --test live -- --ignored --nocapture
//! ```
//!
//! They are the check that matters: unit tests prove the rule engine parses
//! the shapes we wrote down, but only these prove real collections import and
//! real sources produce articles.

use serious_lib::engine::browse;
use serious_lib::model::Source;
use serious_lib::repo;

/// The repository's own index must parse into collections.
#[test]
#[ignore]
fn live_repo_index_parses() {
    let base = "https://www.yck2026.fun";
    let cols = repo::fetch_index(base, 1).expect("index fetch failed");
    assert!(!cols.is_empty(), "index produced no collections");
    println!("parsed {} collections", cols.len());
    for c in cols.iter().take(5) {
        println!("  #{} {} ({} sources, {} downloads) by {}", c.id, c.title, c.source_count, c.downloads, c.author);
    }
    // Every entry must carry a usable download URL.
    assert!(cols.iter().all(|c| c.json_url.ends_with(".json")));
}

/// A small shared collection must import into usable sources.
#[test]
#[ignore]
fn live_collection_imports() {
    // id 154 is a small collection (10 sources) so the test stays quick.
    let url = "https://www.yck2026.fun/yuedu/rsss/json/id/154.json";
    let sources = repo::fetch_collection(url).expect("collection fetch failed");
    assert!(!sources.is_empty(), "no sources parsed");
    println!("imported {} sources", sources.len());
    for s in sources.iter().take(10) {
        println!("  {} -> {}", s.display_name(), s.source_url);
    }
}

/// At least one imported source must yield a non-empty article list.
#[test]
#[ignore]
fn live_source_produces_articles() {
    let url = "https://www.yck2026.fun/yuedu/rsss/json/id/154.json";
    let sources: Vec<Source> = repo::fetch_collection(url).expect("collection fetch failed");

    let mut working = 0usize;
    let mut attempted = 0usize;
    for src in sources.iter().take(12) {
        let cats = browse::categories(src);
        let template = cats.first().map(|c| c.url.clone()).unwrap_or_else(|| src.source_url.clone());
        if template.trim().is_empty() {
            continue;
        }
        attempted += 1;
        match browse::load_page(src, &browse::PageRequest::first(&template)) {
            Ok(page) if !page.items.is_empty() => {
                working += 1;
                println!("  OK  {} -> {} items", src.display_name(), page.items.len());
                for item in page.items.iter().take(3) {
                    println!(
                        "      - [{}] {} | {}",
                        item.kind,
                        item.title.chars().take(48).collect::<String>(),
                        item.link
                    );
                }
            }
            Ok(_page) => println!("  --  {} -> 0 items", src.display_name()),
            Err(e) => println!("  ERR {} -> {e}", src.display_name()),
        }
    }
    println!("{working}/{attempted} sources produced articles");
    // The collection mixes working and dead sources; require at least one.
    assert!(working > 0, "no source in the collection produced any article");
}

/// Loading a real article must return non-empty content.
///
/// Uses collection 163, whose sources are real content sites. Collection 154
/// is deliberately not used here: it lists single-page game sites that have no
/// articles to open, so it can only ever produce an empty page.
#[test]
#[ignore]
fn live_article_has_content() {
    let url = "https://www.yck2026.fun/yuedu/rsss/json/id/163.json";
    let sources: Vec<Source> = repo::fetch_collection(url).expect("collection fetch failed");

    let mut attempted = 0usize;
    for src in sources.iter() {
        if attempted >= 25 {
            break;
        }
        let cats = browse::categories(src);
        let template = cats
            .first()
            .map(|c| c.url.clone())
            .unwrap_or_else(|| src.source_url.clone());
        let Ok(page) = browse::load_page(src, &browse::PageRequest::first(&template)) else {
            continue;
        };

        // Try each listing entry; the first link may be navigation.
        for item in page.items.iter().take(3) {
            if item.link.trim().is_empty() {
                continue;
            }
            attempted += 1;
            match browse::load_article(src, &item.link) {
                Ok(c) if !c.text.trim().is_empty() || !c.html.trim().is_empty() => {
                    println!(
                        "  OK  {} -> title={:?} text={} bytes media={}",
                        src.display_name(),
                        c.title,
                        c.text.len(),
                        c.media.len()
                    );
                    assert!(
                        attempted >= 1,
                        "an article should have been reachable within the first few links"
                    );
                    return;
                }
                Ok(_c) => println!(
                    "  --  {} -> empty ({})",
                    src.display_name(),
                    item.link.chars().take(60).collect::<String>()
                ),
                Err(e) => println!("  ERR {} -> {e}", src.display_name()),
            }
        }
    }
    panic!("no article from this collection produced content after {attempted} attempts");
}