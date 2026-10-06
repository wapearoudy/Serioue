use super::{fetch, js, selector, template};
use crate::model::{parse_sort_url, Category, Source};
use crate::util::{absolute_url, clean_text, is_json_path};
use once_cell::sync::Lazy;
use regex::Regex;
use serde::Serialize;
use serde_json::Value;
use std::sync::{Arc, Mutex, OnceLock};

/// A normalized list item ready for the UI.
#[derive(Debug, Clone, Serialize, Default)]
pub struct ArticleItem {
    pub title: String,
    pub link: String,
    pub image: String,
    pub date: String,
    /// Hint for the reader: this item looks like playable media.
    #[serde(default)]
    pub kind: String,
}

/// One page of a category listing.
#[derive(Debug, Clone, Serialize, Default)]
pub struct ArticlePage {
    pub items: Vec<ArticleItem>,
    /// Absolute URL of the next page, when the source exposes one.
    pub next: Option<String>,
    /// The URL that was actually fetched, after redirects and templating.
    pub final_url: String,
    /// Set only when the source's own rules are known to have failed and the
    /// listing was assembled some other way. It is `None` for the ordinary
    /// case, including a page that is simply empty today.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagnosis: Option<String>,
}

/// How many bare page links are worth presenting as a listing.
///
/// Below this a page is a page, not a list, and standing its links up as one
/// shows the reader navigation chrome dressed up as content.
pub const FALLBACK_MIN_LINKS: usize = 3;

/// Why a listing looks the way it does, counted rather than guessed.
///
/// The counts are what [`parse_list_inner`] already knows; nothing here looks at
/// the page, so the rule is testable without a document.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ListShape {
    /// The source declares a list rule of its own.
    pub has_rule: bool,
    /// How many containers the rule selected.
    pub containers: usize,
    /// How many entries the rules turned into something openable.
    pub openable: usize,
    /// How many bare page links the fallback would substitute.
    pub fallback_links: usize,
}

/// A shape for the paths that never consult the source's list rule at all.
///
/// `has_rule: false` is the point: [`diagnose_list`] stays silent for these, so a
/// bare-URL source and a `ruleArticles: "body"` bookmark page — both of which
/// present links by design — are never reported as broken.
fn shape_without_rules(fallback_links: usize) -> ListShape {
    ListShape { has_rule: false, containers: 0, openable: fallback_links, fallback_links }
}

/// Explain a listing whose rules did not do the work.
///
/// This is deliberately narrow. A source whose page has nothing on it today is
/// **not** diagnosed: `containers == 0` with no links to fall back on is an empty
/// page, not a stale rule, and telling someone their source is broken when it is
/// merely quiet is worse than saying nothing.
///
/// It fires in exactly two situations, both of which are facts rather than
/// inferences:
///
/// * the rule selected nothing while the page had enough links that the
///   fallback could build a listing — the rule is demonstrably not matching this
///   page, and the user is looking at a substitute they did not ask for;
/// * the rule selected containers but none of them yielded an openable entry,
///   so the field rules are not extracting what the container holds.
pub fn diagnose_list(shape: ListShape) -> Option<String> {
    if !shape.has_rule {
        // Nothing the user wrote can be out of date.
        return None;
    }
    if shape.containers == 0 {
        if shape.fallback_links >= FALLBACK_MIN_LINKS {
            return Some(format!(
                "这个源的规则在页面上一个都没匹配上，这里列的是页面上的链接（共 {} 条）。\
                 规则可能已经过时了，换个源或重新收集规则会更好用。",
                shape.fallback_links
            ));
        }
        // No rule match *and* nothing on the page to fall back on. That is an
        // empty page, and we have no business calling it a broken source.
        return None;
    }
    if shape.openable == 0 {
        return Some(format!(
            "规则匹配到了 {} 个区块，但没能从中取出可打开的条目 —— \
             取标题或地址的那条规则多半已经对不上了。",
            shape.containers
        ));
    }
    None
}

/// Which page of a category to request.
#[derive(Debug, Clone, Default)]
pub struct PageRequest {
    /// Category URL template (`sortUrl` entry or the base URL).
    pub url_template: String,
    /// 1-based page number, used when the template carries `{{page}}`.
    pub page: u32,
    /// Explicit next-page URL produced by a previous load.
    pub next_url: Option<String>,
}

impl PageRequest {
    pub fn first(url_template: &str) -> Self {
        PageRequest {
            url_template: url_template.to_string(),
            page: 1,
            next_url: None,
        }
    }
}

// `{{page}}`, `{{page<3>}}` (start at 3), `{{bookPage}}`.
static PAGE_SLOT: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\{\{\s*(page|bookPage)\s*(?:<\s*(\d+)\s*>)?\s*\}\}").unwrap());

/// Expand page placeholders in a URL template.
pub fn expand(template: &str, page: u32) -> String {
    PAGE_SLOT
        .replace_all(template, |caps: &regex::Captures| {
            let offset: u32 = caps.get(2).and_then(|m| m.as_str().parse().ok()).unwrap_or(1);
            (page + offset - 1).to_string()
        })
        .into_owned()
}

/// Parse a body as JSON when it looks like JSON.
fn as_json(body: &str) -> Option<Value> {
    let t = body.trim_start();
    if t.starts_with('{') || t.starts_with('[') {
        serde_json::from_str(t).ok()
    } else {
        None
    }
}

/// Extract the article containers named by `ruleArticles`.
fn select_containers<'a>(
    doc: &selector::Doc,
    rule: &str,
    json: Option<&'a Value>,
    body: &str,
) -> Vec<Container<'a>> {
    let rule = rule.trim();
    if rule.is_empty() || rule == "body" || rule == "$" {
        return vec![Container::Html(doc.text())];
    }
    // A whole-JS list rule (多看阅读 `<js>JSON.parse(result)…</js>`): Legado
    // hands the response body text to `result`, so the script is evaluated
    // with the body as a string. An array becomes one container per element;
    // a lone object becomes a single container. Anything else — a scalar, or
    // a script that threw — yields no containers, and crucially does NOT fall
    // through to the selector path: the rule is JS, not CSS, and running it
    // as a selector would only misread the script and hide the real cause.
    // `looks_like_js` is the gate, and it does not catch ordinary selectors:
    // over collections 107 (127 sources) and 160 (176 sources) no
    // `ruleArticles` that is a plain selector contains `java.` / `evalJS(` /
    // `cache.` or starts with `@js:` / `<js`, so the old path is untouched.
    if js::looks_like_js(rule) {
        let input = Value::String(body.to_string());
        match js::eval_to_json(rule, &input) {
            Ok(Value::Array(arr)) => {
                return arr
                    .into_iter()
                    .map(|el| {
                        // Some rules hand back stringified objects
                        // (`item_list.map(x => JSON.stringify(x))`): unwrap
                        // one level so field rules keep working.
                        if let Value::String(s) = &el {
                            let t = s.trim();
                            if t.starts_with('{') || t.starts_with('[') {
                                if let Ok(v) = serde_json::from_str::<Value>(t) {
                                    if v.is_object() {
                                        return Container::OwnedJson(v);
                                    }
                                }
                            }
                        }
                        Container::OwnedJson(el)
                    })
                    .collect();
            }
            Ok(Value::Object(map)) => {
                return vec![Container::OwnedJson(Value::Object(map))];
            }
            // Ran but returned a scalar, or threw: no containers. The caller
            // suppresses the page-link fallback for JS rules (see
            // `parse_list_inner`), so this stays an empty list rather than a
            // fake one.
            _ => return Vec::new(),
        }
    }
    if let Some(j) = json {
        if is_json_path(rule) {
            return match jsonpath_lib::select(j, rule) {
                Ok(items) => {
                    // A rule that resolves to an array selects its elements;
                    // anything else is treated as a single container.
                    let mut out = Vec::new();
                    for item in items {
                        match item {
                            Value::Array(arr) => {
                                for el in arr {
                                    out.push(Container::Json(el));
                                }
                            }
                            other => out.push(Container::Json(other)),
                        }
                    }
                    out
                }
                Err(_) => Vec::new(),
            };
        }
    }
    doc.eval_outer(rule).into_iter().map(Container::Html).collect()
}

/// A list entry, either an HTML fragment, a JSON node borrowed from the
/// response body, or a JSON node owned by a whole-JS rule evaluation.
///
/// The owned arm exists because `js::eval_to_json` hands back an owned
/// `Value` while `Container::Json` only borrows: the caller holds the array
/// only as a temporary, so borrowing out of it cannot live long enough. The
/// owned value moves into the container instead — no unsafe, no leak, and no
/// global state.
enum Container<'a> {
    Html(String),
    Json(&'a Value),
    OwnedJson(Value),
}

/// The path of a URL, without scheme or host.
///
/// Classification must not look at the host: a source served from
/// `music.example.com` would otherwise mark every one of its videos as music.
fn link_path(link: &str) -> String {
    let link = link.trim();
    if link.is_empty() {
        return String::new();
    }
    let parsed = url::Url::parse(link)
        .map(|u| u.path().to_string())
        .unwrap_or_else(|_| link.split(['?', '#']).next().unwrap_or(link).to_string());
    parsed.to_lowercase()
}

/// Could this extracted value plausibly be a URL?
///
/// A rule such as `text.一键导入@onclick` yields a JavaScript call like
/// `importApp(1)`. Turning that into a link produces an item the reader can
/// never open, and the report then blames the site instead of the rule.
fn looks_like_link(value: &str) -> bool {
    let v = value.trim();
    if v.is_empty() || v.len() > 2000 {
        return false;
    }
    // A call, a snippet of markup or a phrase is not an address.
    if v.contains(char::is_whitespace) || v.contains('(') || v.contains(')') || v.contains('<') {
        return false;
    }
    let lower = v.to_lowercase();
    if lower.starts_with("javascript:") || lower.starts_with("data:") {
        return false;
    }
    v.starts_with("http://")
        || v.starts_with("https://")
        || v.starts_with("//")
        || v.starts_with('/')
        || v.starts_with("./")
        || v.starts_with("../")
        || v.contains('.')
}

/// Classify an item so the UI can offer the right affordance.
fn classify(title: &str, image: &str, link: &str) -> String {
    let path = link_path(link);
    let text = title.to_lowercase();

    const AUDIO_EXT: &[&str] = &[".mp3", ".flac", ".m4a", ".aac", ".wav", ".ogg", ".opus"];
    const AUDIO_WORDS: &[&str] = &["音乐", "歌单", "歌曲", "music", "audio"];
    const VIDEO_EXT: &[&str] = &[".m3u8", ".mp4", ".webm", ".mov", ".mkv"];
    const VIDEO_WORDS: &[&str] = &["视频", "video", "影视", "动漫", "movie", "play"];
    const IMAGE_WORDS: &[&str] = &["图片", "图集", "套图", "美图", "gallery", "photo"];
    const NOVEL_WORDS: &[&str] = &["小说", "章节", "阅读", "txt", "novel", "book"];

    // Audio is checked before video: `.m4a` and `.aac` are containers both
    // formats can use, and a music link that matched "video" would be handed
    // to the wrong player.
    let audio = AUDIO_EXT.iter().any(|e| path.ends_with(e)) || AUDIO_WORDS.iter().any(|w| text.contains(*w));
    if audio {
        return "music".into();
    }
    let video = VIDEO_EXT.iter().any(|e| path.ends_with(e)) || VIDEO_WORDS.iter().any(|w| text.contains(*w));
    if video {
        return "video".into();
    }
    if IMAGE_WORDS.iter().any(|w| text.contains(*w)) {
        return "image".into();
    }
    if NOVEL_WORDS.iter().any(|w| text.contains(*w)) {
        return "novel".into();
    }
    let _ = image;
    "article".into()
}

/// Does this URL point at an audio file the browser can play directly?
pub fn is_audio_url(url: &str) -> bool {
    let path = url.split(['?', '#']).next().unwrap_or(url).to_lowercase();
    [".mp3", ".flac", ".m4a", ".aac", ".wav", ".ogg", ".opus"]
        .iter()
        .any(|ext| path.ends_with(ext))
}

/// Audio files referenced by a page, in document order.
///
/// Music sources put tracks in `<audio src>` and `<source src>` far more often
/// than in prose, so this is what turns an article page into a playlist.
pub fn audio_from(body: &str) -> Vec<String> {
    let doc = selector::Doc::parse(body);
    let mut out: Vec<String> = Vec::new();
    for url in doc.media_urls() {
        if !is_audio_url(&url) {
            continue;
        }
        if !url.starts_with("http://") && !url.starts_with("https://") && !url.starts_with("//") {
            continue;
        }
        if !out.contains(&url) {
            out.push(url);
        }
    }
    out
}

/// Turn a list body into articles using the source's field rules.
pub fn parse_list(src: &Source, body: &str, base_url: &str) -> (Vec<ArticleItem>, Option<String>) {
    let (items, next, _) = parse_list_detailed(src, body, base_url);
    (items, next)
}

/// Parse a listing and also report what the rules managed to do, so a caller can
/// tell "the page is empty today" from "this source's rule no longer matches".
pub fn parse_list_detailed(
    src: &Source,
    body: &str,
    base_url: &str,
) -> (Vec<ArticleItem>, Option<String>, ListShape) {
    // A rule that walks the page — the 蓝奏云盘 family does, through
    // `java.getElements` / `setContent` — needs the markup to walk. Binding it
    // here rather than at each call site keeps every caller of this function
    // consistent, and the binding is dropped again on the way out.
    js::set_page(Some(body.to_string()));
    let parsed = parse_list_inner(src, body, base_url);
    js::set_page(None);
    parsed
}

fn parse_list_inner(
    src: &Source,
    body: &str,
    base_url: &str,
) -> (Vec<ArticleItem>, Option<String>, ListShape) {
    let json = as_json(body);
    let doc = selector::Doc::parse(body);

    let next = |doc: &selector::Doc, json: Option<&Value>| {
        find_next_page(src, doc, json, base_url, &src.rule_next_page)
    };

    // A source that declares no field rules at all is usually just a bare URL.
    // Rather than returning the whole page as one enormous "article", present
    // the page's content links as a browsable list.
    let has_rules = !src.rule_articles.trim().is_empty()
        || !src.rule_title.trim().is_empty()
        || !src.rule_link.trim().is_empty();
    if !has_rules && json.is_none() {
        let links = extract_links(&doc, base_url);
        if !links.is_empty() {
            let found = links.len();
            return (links, next(&doc, None), shape_without_rules(found));
        }
    }

    // Legacy collections fill in `ruleArticles: "body"` for any source without
    // an `articleUrl`. That is the single-page convention, but applied to a
    // plain bookmark page it turns a list of 100 links into one "article" whose
    // body is the entire page including its scripts. When the page really is a
    // list, prefer the list.
    let body_only = src.rule_articles.trim().eq_ignore_ascii_case("body")
        && src.rule_title.trim().is_empty()
        && src.rule_link.trim().is_empty();
    if body_only && json.is_none() {
        let links = extract_links(&doc, base_url);
        if links.len() >= FALLBACK_MIN_LINKS {
            let found = links.len();
            return (links, next(&doc, None), shape_without_rules(found));
        }
    }

    // Pick the list rule: the source's own, an inferred HTML pattern, or the
    // first array of objects when the body is JSON.
    let rule = if !src.rule_articles.trim().is_empty() {
        src.rule_articles.clone()
    } else if json.is_some() {
        infer_json_rule(json.as_ref().unwrap())
    } else {
        infer_list_rule(&doc)
    };

    let containers = select_containers(&doc, &rule, json.as_ref(), body);
    let mut items = Vec::new();
    // Whether ruleArticles is a whole-JS block. Known before any fallback
    // decision, because a failed JS rule must not be papered over with page
    // links: a substitute list built from raw anchors would read as success
    // while carrying none of the rule's content.
    let rule_is_js = js::looks_like_js(&rule);

    for (i, container) in containers.iter().enumerate() {
        let (title, link, image, date) = match container {
            Container::Html(html) => (
                // Only the title falls back to the container's text; an empty
                // link/image/date rule must yield nothing, not the whole text.
                field_html(&src.rule_title, html, true),
                field_html(&src.rule_link, html, false),
                field_html(&src.rule_image, html, false),
                field_html(&src.rule_pub_date, html, false),
            ),
            Container::Json(value) => (
                field_json(&src.rule_title, value, "ruleTitle"),
                field_json(&src.rule_link, value, "ruleLink"),
                field_json(&src.rule_image, value, "ruleImage"),
                field_json(&src.rule_pub_date, value, "rulePubDate"),
            ),
            Container::OwnedJson(value) => (
                field_json(&src.rule_title, value, "ruleTitle"),
                field_json(&src.rule_link, value, "ruleLink"),
                field_json(&src.rule_image, value, "ruleImage"),
                field_json(&src.rule_pub_date, value, "rulePubDate"),
            ),
        };
        let _ = i;

        let title = clean_text(&title);
        if title.is_empty() && link.is_empty() && image.is_empty() {
            continue;
        }
        let link = if looks_like_link(&link) {
            absolute_url(&link, base_url)
        } else {
            String::new()
        };
        let image = absolute_url(&image, base_url);

        items.push(ArticleItem {
            title: if title.is_empty() { clean_text(&link) } else { title.clone() },
            kind: classify(&title, &image, &link),
            link,
            image,
            date: clean_text(&date),
        });
    }

    // Deduplicate by link, keeping the first occurrence.
    let mut seen = std::collections::HashSet::new();
    items.retain(|it| it.link.is_empty() || seen.insert(it.link.clone()));

    // The rules did not produce anything usable: either nothing matched, or
    // what matched carries no address. Plenty of sites render their content
    // links in the HTML and use JavaScript only for chrome and lazy images, so
    // a link list is often a working substitute where the selector is stale.
    // Falling back beats showing an empty or unopenable page — except when
    // the list rule is a whole-JS block: there the script is the rule, and a
    // substitute built from raw page links would read as success while
    // carrying none of the rule's content. A throwing or empty JS rule stays
    // an empty list, and `ListShape` still records the attempt (rule present,
    // zero containers) so the diagnosis names the rule rather than the page.
    let nothing_openable = items.is_empty() || items.iter().all(|it| it.link.is_empty());
    let openable = items.iter().filter(|it| !it.link.is_empty()).count();
    let has_rule = !src.rule_articles.trim().is_empty();
    let container_count = containers.len();
    if nothing_openable && json.is_none() && !rule_is_js {
        let links = extract_links(&doc, base_url);
        if links.len() >= FALLBACK_MIN_LINKS {
            // This is the silent case worth naming: the rule produced nothing
            // and the reader is being shown a substitute they never asked for.
            let shape = ListShape {
                has_rule,
                containers: container_count,
                openable,
                fallback_links: links.len(),
            };
            return (links, next(&doc, None), shape);
        }
    }

    let next = find_next_page(src, &doc, json.as_ref(), base_url, &src.rule_next_page);
    let shape = ListShape {
        has_rule,
        containers: container_count,
        openable,
        fallback_links: 0,
    };
    (items, next, shape)
}

/// Turn a page into a list of its content links.
///
/// Many shared sources are a bare URL with no rules at all. Showing the page's
/// anchors turns that into a usable, browsable list instead of one giant
/// article. Navigation and asset links are filtered out.
fn extract_links(doc: &selector::Doc, base_url: &str) -> Vec<ArticleItem> {
    const MAX: usize = 200;
    const MIN_TITLE_CHARS: usize = 2;
    /// A link whose text is longer than this is layout, not a list entry.
    const MAX_TITLE_CHARS: usize = 120;

    // One pass over the document keeps hrefs, titles and covers in the same
    // order, and avoids re-parsing each anchor in isolation.
    let hrefs = doc.eval("a@href");
    let titles = doc.eval("a@text");
    let covers = doc.eval("a@all@img@data-src");
    let covers_alt = doc.eval("a@all@img@src");

    let mut items: Vec<ArticleItem> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    for (i, href) in hrefs.iter().enumerate() {
        let href = href.trim();
        if href.is_empty()
            || href.starts_with('#')
            || href.starts_with("javascript:")
            || href.starts_with("mailto:")
            || href.starts_with("tel:")
        {
            continue;
        }
        if href.trim_end_matches('/') == base_url.trim_end_matches('/') {
            continue;
        }

        let title = titles.get(i).map(|t| clean_text(t)).unwrap_or_default();
        if title.chars().count() < MIN_TITLE_CHARS
            || title.chars().count() > MAX_TITLE_CHARS
        {
            continue;
        }

        let link = absolute_url(href, base_url);
        if !link.starts_with("http://") && !link.starts_with("https://") {
            continue;
        }
        if !seen.insert(link.clone()) {
            continue;
        }

        let cover = covers
            .get(i)
            .or_else(|| covers_alt.get(i))
            .cloned()
            .unwrap_or_default();

        items.push(ArticleItem {
            kind: classify(&title, &cover, &link),
            title,
            link,
            image: absolute_url(&cover, base_url),
            date: String::new(),
        });

        if items.len() >= MAX {
            break;
        }
    }
    items
}

/// Evaluate a field rule against an HTML container.
///
/// `allow_text` controls what an *empty* rule means: for a title the container's
/// own text is a sensible default, but for a link or image it would put the
/// entire element text into the wrong field.
fn field_html(rule: &str, container: &str, allow_text: bool) -> String {
    if rule.trim().is_empty() {
        if !allow_text {
            return String::new();
        }
        return clean_text(&selector::Doc::parse(container).text());
    }
    let doc = selector::Doc::parse(container);
    first_non_empty(&doc.eval(rule))
}

/// Split `selector@js:code` into the selector and the script that follows it.
///
/// Legado allows a script to trail the selector, and live sources use it:
/// `$.address@js:result.replace(/rtmp:\//, "")`. The engine handled only the
/// prefix form `@js:…`, so this whole string was handed to the JSONPath parser,
/// which matched nothing and the source yielded items with no link at all.
fn split_js_suffix(rule: &str) -> Option<(&str, &str)> {
    let at = rule.rfind("@js:")?;
    let (selector, rest) = rule.split_at(at);
    Some((selector, rest[4..].trim()))
}

/// Evaluate a `selector@js:code` rule: the selector picks the value, and that
/// value is what `result` means inside the script.
fn apply_js_suffix(rule: &str, value: &Value) -> Option<String> {
    let (selector, code) = split_js_suffix(rule)?;
    let picked = if selector.trim().is_empty() {
        value.clone()
    } else {
        let raw = selector::eval_json(value, selector)
            .into_iter()
            .find(|s| !s.trim().is_empty())?;
        Value::String(raw)
    };
    Some(clean_text(&js::eval_to_string(code, &picked)))
}

/// Evaluate a field rule against a JSON node, with CMS-API defaults.
///
/// The fallback keys are chosen per field: a single shared key list would let
/// `{"title","url"}` satisfy the image and date fields too.
fn field_json(rule: &str, value: &Value, field_name: &str) -> String {
    if !rule.trim().is_empty() {
        // `selector@js:code` before the bare `@js:` form: the leading selector
        // is not a script, and must not be mistaken for one.
        if let Some(out) = apply_js_suffix(rule, value) {
            if !out.is_empty() {
                return out;
            }
        }
        if js::looks_like_js(rule) {
            js::set_script_headers(None);
            return clean_text(&js::eval_to_string(rule, value));
        }
        let out = selector::eval_json(value, rule);
        if let Some(v) = out.into_iter().find(|s| !s.trim().is_empty()) {
            return v;
        }
    }

    // Standard CMS collections expose `/api.php/provide/vod`.
    let keys: &[&str] = match field_name {
        "ruleTitle" => &["vod_name", "name", "title"],
        "ruleLink" => &["vod_id", "url", "link", "play_url"],
        "ruleImage" => &["vod_pic", "pic", "cover", "coverUrl", "image"],
        _ => &["vod_time", "time", "pubDate", "date"],
    };
    for key in keys {
        if let Some(v) = value.get(key) {
            let s = template::value_to_string(v);
            if !s.trim().is_empty() {
                return s;
            }
        }
    }
    String::new()
}

fn first_non_empty(values: &[String]) -> String {
    values
        .iter()
        .map(|v| v.trim())
        .find(|v| !v.is_empty())
        .unwrap_or_default()
        .to_string()
}

/// Guess a JSONPath for the first array of objects in a JSON body.
///
/// CMS APIs wrap their results differently (`list`, `data`, `result`, …), so
/// search the common keys first and then fall back to a recursive scan.
fn infer_json_rule(json: &Value) -> String {
    for key in ["list", "data", "result", "results", "items", "videos", "rows"] {
        if let Some(arr) = json.get(key) {
            if arr.is_array() && !arr.as_array().unwrap().is_empty() {
                return format!("$.{key}");
            }
        }
    }
    // Recursive scan for the first array whose elements are objects.
    fn find(value: &Value) -> Option<String> {
        match value {
            Value::Object(map) => {
                for (k, v) in map {
                    if v.is_array() && v.as_array().is_some_and(|a| a.iter().any(|x| x.is_object())) {
                        return Some(format!("$.{k}"));
                    }
                }
                for (_, v) in map {
                    if let Some(p) = find(v) {
                        return Some(p);
                    }
                }
                None
            }
            Value::Array(arr) => {
                for v in arr {
                    if let Some(p) = find(v) {
                        return Some(p);
                    }
                }
                None
            }
            _ => None,
        }
    }
    find(json).unwrap_or_default()
}

/// Guess a list container when the source has no `ruleArticles`.
fn infer_list_rule(doc: &selector::Doc) -> String {
    for candidate in [
        "class.video-card@all",
        "class.book-item@all",
        "class.post-item@all",
        "class.item@all",
        "class.list-item@all",
        "class.entry@all",
        "class.article@all",
        "class.res@all",
        "ul li@all",
        "article@all",
    ] {
        if doc.eval_outer(candidate).len() >= 3 {
            return candidate.to_string();
        }
    }
    String::new()
}

const NEXT_LABELS: &[&str] = &["下一页", "下页", "next", "»", ">", "末页"];

/// Locate the next page URL from the rendered list.
fn find_next_page(
    src: &Source,
    doc: &selector::Doc,
    json: Option<&Value>,
    base_url: &str,
    next_rule: &str,
) -> Option<String> {
    if let Some(j) = json {
        for key in ["page", "pageurl", "page_url", "next"] {
            if let Some(v) = j.get(key) {
                let s = template::value_to_string(v);
                if !s.trim().is_empty() && (s.starts_with("http") || s.starts_with('/')) {
                    return Some(absolute_url(&s, base_url));
                }
            }
        }
        return None;
    }

    let _ = src;
    if !next_rule.trim().is_empty() {
        let v = first_non_empty(&doc.eval(next_rule));
        if !v.is_empty() && (v.starts_with("http") || v.starts_with('/') || v.contains("page")) {
            return Some(absolute_url(&v, base_url));
        }
    }
    doc.find_link_by_text(NEXT_LABELS)
        .map(|href| absolute_url(&href, base_url))
}

/// Fetch and parse one page of a category.
/// Renders a URL in a webview and returns its post-JavaScript HTML.
///
/// The engine has no handle on the window, so the render path is injected at
/// startup by the command layer. When nothing is registered — in unit tests,
/// or on a build without webviews — this returns `None` and every caller falls
/// back to what the ordinary fetch produced.
pub type RenderFn = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;

static RENDERER: OnceLock<Mutex<Option<RenderFn>>> = OnceLock::new();

/// Register the browser-backed fetcher. Called once during startup.
pub fn set_renderer(f: RenderFn) {
    if let Ok(mut slot) = RENDERER.get_or_init(|| Mutex::new(None)).lock() {
        *slot = Some(f);
    }
}

/// Render `url`, if a renderer is registered.
pub fn rendered_html(url: &str) -> Option<String> {
    let guard = RENDERER.get()?.lock().ok()?;
    let render = guard.as_ref()?;
    render(url)
}

/// A page fetched by rendering rather than by a plain request.
///
/// Rendering costs a couple of seconds, so the result is held briefly: the
/// reader opens the same page repeatedly (a listing, then an article, then the
/// contents) and re-rendering each time would be painful.
static RENDER_CACHE: Lazy<Mutex<Vec<(String, std::time::Instant, String)>>> =
    Lazy::new(|| Mutex::new(Vec::new()));

const RENDER_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(120);
const RENDER_CACHE_MAX: usize = 8;

/// Render `url`, reusing a recent result when there is one.
pub fn render_cached(url: &str) -> Option<String> {
    let now = std::time::Instant::now();
    if let Ok(mut cache) = RENDER_CACHE.lock() {
        cache.retain(|(_, at, _)| now.duration_since(*at) < RENDER_CACHE_TTL);
        if let Some((_, _, html)) = cache.iter().find(|(u, _, _)| u == url) {
            return Some(html.clone());
        }
    }
    let html = rendered_html(url)?;
    if let Ok(mut cache) = RENDER_CACHE.lock() {
        if cache.len() >= RENDER_CACHE_MAX {
            cache.remove(0);
        }
        cache.push((url.to_string(), now, html.clone()));
    }
    Some(html)
}

pub fn load_page(src: &Source, req: &PageRequest) -> crate::error::AppResult<ArticlePage> {
    let raw = match &req.next_url {
        Some(u) if !u.trim().is_empty() => u.clone(),
        _ => expand(&req.url_template, req.page.max(1)),
    };
    let url = absolute_url(raw.trim(), &src.source_url);

    js::set_script_headers(Some(src.headers()));
    let resp = fetch::fetch_ok(Some(src), &url);
    js::set_script_headers(None);
    let resp = resp?;

    let (items, next, shape) = parse_list_detailed(src, &resp.body, &resp.url);
    let diagnosis = diagnose_list(shape);

    // The cheap path produced nothing usable on a source that asks for
    // JavaScript. Rendering is offered only in that case, never on a page that
    // already parsed: an offscreen window costs a couple of seconds, and
    // [`should_render`] is where that decision is made and tested.
    let rendered = if should_render_now(src, &items, &resp.body, &resp.url) {
        render_cached(&resp.url).map(|html| parse_list(src, &html, &resp.url))
    } else {
        None
    };

    match rendered {
        // Rendering gave us something we can actually open; prefer it.
        Some((new_items, new_next))
            if !new_items.is_empty() && new_items.iter().any(|i| !i.link.is_empty()) =>
        {
            Ok(ArticlePage { items: new_items, next: new_next.or(next), final_url: resp.url, diagnosis })
        }
        _ => Ok(ArticlePage { items, next, final_url: resp.url, diagnosis }),
    }
}

/// Is rendering this page worth a couple of seconds?
///
/// Every condition must hold, and each one is a reason not to bother:
///
/// * the source declares it needs JavaScript — nobody else should pay for it;
/// * the user has not switched the fallback off;
/// * a renderer is actually registered;
/// * the ordinary fetch produced nothing openable — **this is what keeps the
///   cost off healthy sources**. Rendering a listing that already parsed would
///   buy nothing and cost an offscreen window plus a couple of seconds;
/// * the response is a real document rather than an empty body, and the URL is
///   something a webview can be pointed at.
///
/// The two ambient facts (`switch_on`, `renderer_ready`) are parameters rather
/// than reads of globals so the whole decision can be tested without a webview;
/// [`should_render_now`] supplies the live values.
fn should_render(
    src: &Source,
    items: &[ArticleItem],
    body: &str,
    url: &str,
    switch_on: bool,
    renderer_ready: bool,
) -> bool {
    src.enable_js
        && switch_on
        && renderer_ready
        && nothing_openable(items)
        && !body.trim().is_empty()
        && url.starts_with("http")
}

/// The same decision, with the live switch and renderer state.
///
/// "Nothing openable" covers two shapes: no items at all, and the single-page
/// reading that yields one item with no address — which is what a script-built
/// page looks like before it is rendered.
fn nothing_openable(items: &[ArticleItem]) -> bool {
    !items.iter().any(|i| !i.link.trim().is_empty())
}

fn should_render_now(src: &Source, items: &[ArticleItem], body: &str, url: &str) -> bool {
    should_render(src, items, body, url, render_enabled(), rendered_html_available())
}

/// Whether the browser-render fallback starts switched on.
///
/// Off, matching [`crate::store::Settings::render_js`]'s own default. It used to
/// start `true` here while the stored preference said `false`, so any path that
/// verified a source before the preference had been applied rendered anyway —
/// the expensive branch without the user having opted in. The measured
/// behaviour justifies the choice: over 16 script-built sources, rendering
/// rescued 2 (12.5%), which is worth having and not worth paying for on every
/// source by default.
const RENDER_DEFAULT: bool = false;

static RENDER_ENABLED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(RENDER_DEFAULT);

pub fn set_render_enabled(on: bool) {
    RENDER_ENABLED.store(on, std::sync::atomic::Ordering::Relaxed);
}

pub fn render_enabled() -> bool {
    RENDER_ENABLED.load(std::sync::atomic::Ordering::Relaxed)
}

/// Whether a renderer has been registered.
pub fn rendered_html_available() -> bool {
    RENDERER.get().and_then(|s| s.lock().ok()).map(|s| s.is_some()).unwrap_or(false)
}

/// The category tabs for a source, with a default entry when it declares none.
pub fn categories(src: &Source) -> Vec<Category> {
    let cats = parse_sort_url(&src.sort_url);
    if cats.is_empty() {
        vec![Category {
            name: "首页".to_string(),
            url: src.source_url.clone(),
            row: 0,
            paged: src.source_url.contains("{{page}}"),
        }]
    } else {
        cats
    }
}

/// Fetch a detail page and extract its readable content.
pub fn load_article(src: &Source, url: &str) -> crate::error::AppResult<ArticleContent> {
    js::set_script_headers(Some(src.headers()));
    let resp = fetch::fetch_ok(Some(src), url)?;
    js::set_script_headers(None);

    // Some sites answer with a meta-refresh shell instead of content.
    let body = if crate::util::html_to_text(&resp.body).trim().is_empty() {
        match crate::util::meta_refresh(&resp.body) {
            Some(target) => {
                let next = absolute_url(&target, &resp.url);
                if next.trim().is_empty() {
                    resp.body
                } else {
                    js::set_script_headers(Some(src.headers()));
                    let followed = fetch::fetch_ok(Some(src), &next);
                    js::set_script_headers(None);
                    followed.map(|r| r.body).unwrap_or_else(|_| resp.body.clone())
                }
            }
            None => resp.body,
        }
    } else {
        resp.body
    };

    let json = as_json(&body);
    let (html, text) = extract_content(src, &body, json.as_ref());

    Ok(ArticleContent {
        title: extract_title(&body, json.as_ref()),
        html,
        text,
        final_url: resp.url,
        media: media_from(&body),
        audio: audio_from(&body),
    })
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct ArticleContent {
    pub title: String,
    /// Renderable HTML body (media tags preserved).
    pub html: String,
    /// Plain text fallback.
    pub text: String,
    pub final_url: String,
    /// Direct media URLs found in the body, for the player/gallery.
    pub media: Vec<String>,
    /// Audio files only, so the music player does not have to filter.
    pub audio: Vec<String>,
}

/// Collect playable media URLs from a document.
fn media_from(body: &str) -> Vec<String> {
    let doc = selector::Doc::parse(body);
    let mut out = Vec::new();
    for url in doc.media_urls() {
        if (url.starts_with("http://") || url.starts_with("https://") || url.starts_with("//"))
            && !out.contains(&url) {
                out.push(url);
            }
    }
    out
}

fn extract_title(body: &str, json: Option<&Value>) -> String {
    if let Some(j) = json {
        for key in ["title", "name", "vod_name"] {
            if let Some(v) = j.get(key) {
                let s = template::value_to_string(v);
                if !s.trim().is_empty() {
                    return clean_text(&s);
                }
            }
        }
    }
    if let Some(t) = crate::util::extract_title(body) {
        return t;
    }
    let doc = selector::Doc::parse(body);
    for rule in ["h1@text", "h2@text", ".title@text"] {
        let v = first_non_empty(&doc.eval(rule));
        if !v.is_empty() && v.chars().count() < 200 {
            return clean_text(&v);
        }
    }
    String::new()
}

/// Extract the readable content, honouring `ruleContent` when present.
pub fn extract_content(src: &Source, body: &str, json: Option<&Value>) -> (String, String) {
    let rule = src.rule_content.trim();
    let doc = selector::Doc::parse(body);

    if !rule.is_empty() {
        // Template / inline-script content rendered against JSON.
        if rule.contains("{{") || js::looks_like_js(rule) {
            if let Some(j) = json {
                let rendered = template::render_template(rule, j);
                if !rendered.trim().is_empty() && !rendered.contains("{{") {
                    return normalize(&rendered, &src.source_url);
                }
            }
        }
        // A `<js>` block whose result is markup.
        if let Some(code) = template::extract_js_block(rule) {
            if let Some(j) = json {
                let out = js::eval_to_string(&code, j);
                if !out.trim().is_empty() {
                    return normalize(&out, &src.source_url);
                }
            }
        }
        if let Some(j) = json {
            if is_json_path(rule) {
                if let Some(v) = selector::eval_json(j, rule)
                    .into_iter()
                    .find(|s| !s.trim().is_empty())
                {
                    let rendered = template::render_template(&v, j);
                    return normalize(&rendered, &src.source_url);
                }
            }
        }
        // HTML content selector.
        let out = doc.eval_outer(rule);
        if let Some(joined) = out.into_iter().find(|s| s.len() > 40) {
            return normalize(&joined, &src.source_url);
        }
    }

    // Generic extraction for sources with no usable content rule.
    for candidate in [
        "class.article-content",
        "class.content",
        "class.post-content",
        "class.entry-content",
        "class.theme-content",
        "id.content",
        "id.article",
        "article",
    ] {
        if let Some(joined) = doc.eval_outer(candidate).into_iter().find(|s| s.len() > 120) {
            return normalize(&joined, &src.source_url);
        }
    }

    if let Some(j) = json {
        let pretty = serde_json::to_string_pretty(j).unwrap_or_default();
        return (
            format!("<pre>{}</pre>", crate::util::decode_entities(&pretty)),
            crate::util::html_to_text(&pretty),
        );
    }

    let text = readable_text(body);
    (body.to_string(), text)
}

/// Elements that are never article content.
///
/// Only used on the last-resort path, when no content rule matched and none of
/// the usual containers exists. Without it the reader shows the navigation,
/// the footer and the inline scripts along with the article.
///
/// Built per tag because the regex crate has no backreferences, so a single
/// `\1` closing tag will not compile.
static CHROME: Lazy<Vec<Regex>> = Lazy::new(|| {
    [
        "script", "style", "noscript", "template", "svg", "iframe", "form", "nav", "aside", "header",
        "footer",
    ]
    .iter()
    .map(|tag| Regex::new(&format!(r"(?is)<{tag}\b[^>]*>.*?</{tag}\s*>")).unwrap())
    .collect()
});

/// Drop chrome elements from a document.
fn strip_chrome(body: &str) -> String {
    let mut out = body.to_string();
    for re in CHROME.iter() {
        out = re.replace_all(&out, "").into_owned();
    }
    out
}

/// Strip chrome before falling back to "the whole page".
///
/// The setting banner and inline scripts of a site are not article content, and
/// a reader should not have to scroll past them. A page that turns out to be
/// *nothing but* chrome keeps its original text rather than going blank.
pub fn readable_text(body: &str) -> String {
    let stripped = crate::util::html_to_text(&strip_chrome(body));
    if stripped.trim().chars().count() < 20 {
        return crate::util::html_to_text(body);
    }
    stripped
}

/// Make relative URLs absolute and derive the plain-text fallback.
fn normalize(html: &str, base_url: &str) -> (String, String) {
    let html = absolutize_html(html, base_url);
    let text = crate::util::html_to_text(&html);
    (html, text)
}

static ABS_URL: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"(?i)(src|poster|href)\s*=\s*["']([^"']+)["']"#).unwrap());

/// Rewrite relative `src`/`poster`/`href` values to absolute URLs.
fn absolutize_html(html: &str, base_url: &str) -> String {
    if base_url.is_empty() {
        return html.to_string();
    }
    ABS_URL
        .replace_all(html, |caps: &regex::Captures| {
            let attr = &caps[1];
            let url = &caps[2];
            let lower = url.trim();
            if lower.starts_with("data:") || lower.starts_with('#') || lower.is_empty() {
                return caps[0].to_string();
            }
            if lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("//") {
                return caps[0].to_string();
            }
            let abs = absolute_url(lower, base_url);
            let quote = if caps[0].contains('\'') { '\'' } else { '"' };
            format!("{attr}={quote}{abs}{quote}")
        })
        .into_owned()
}

#[cfg(test)]
mod suffix_tests {
    use super::*;
    use serde_json::json;

    /// A live source's rule, verbatim in shape.
    fn address() -> Value {
        json!({ "address": "rtmp://live.example.com/stream", "title": "某直播间" })
    }

    #[test]
    fn a_script_after_the_selector_runs_on_the_selected_value() {
        let out = field_json(r#"$.address@js:result.replace(/^rtmp:\/\//, "")"#, &address(), "ruleLink");
        assert_eq!(out, "live.example.com/stream");
    }

    #[test]
    fn a_bare_script_still_works() {
        let out = field_json("@js:result.title", &address(), "ruleTitle");
        assert_eq!(out, "某直播间");
    }

    #[test]
    fn a_plain_selector_is_untouched() {
        let out = field_json("$.title", &address(), "ruleTitle");
        assert_eq!(out, "某直播间");
    }

    #[test]
    fn a_missing_key_falls_through_to_the_field_defaults() {
        // Nothing to select, so the script never runs and the usual CMS keys
        // still get their chance rather than the row coming back blank.
        let value = json!({ "title": "备用" });
        let out = field_json("$.nope@js:result", &value, "ruleTitle");
        assert_eq!(out, "备用");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // -- the diagnosis ------------------------------------------------------
    //
    // The false-positive half matters more than the true-positive half: a source
    // that is merely quiet today must never be told its rule is broken.

    #[test]
    fn a_rule_that_matched_nothing_and_the_page_had_links_is_explained() {
        let d = diagnose_list(ListShape {
            has_rule: true,
            containers: 0,
            openable: 0,
            fallback_links: 12,
        })
        .expect("a substituted listing should say so");
        assert!(d.contains("12"), "the count should be in the sentence: {d}");
        assert!(d.contains("规则"), "{d}");
    }

    #[test]
    fn containers_without_a_single_openable_entry_is_explained() {
        let d = diagnose_list(ListShape {
            has_rule: true,
            containers: 7,
            openable: 0,
            fallback_links: 0,
        })
        .expect("matched-but-unusable containers should say so");
        assert!(d.contains('7'), "{d}");
    }

    #[test]
    fn a_page_that_is_simply_empty_today_is_not_diagnosed() {
        // No container matched *and* there was nothing to stand up as a list.
        // That is an empty page, not a stale rule — saying otherwise would
        // accuse a healthy source every time its site has nothing new.
        assert_eq!(
            diagnose_list(ListShape {
                has_rule: true,
                containers: 0,
                openable: 0,
                fallback_links: 0,
            }),
            None
        );
        // One or two stray links is still not a listing.
        for n in [1usize, 2] {
            assert_eq!(
                diagnose_list(ListShape {
                    has_rule: true,
                    containers: 0,
                    openable: 0,
                    fallback_links: n,
                }),
                None,
                "{n} links should not read as a list"
            );
        }
    }

    #[test]
    fn a_working_source_is_never_diagnosed() {
        assert_eq!(
            diagnose_list(ListShape {
                has_rule: true,
                containers: 30,
                openable: 30,
                fallback_links: 0,
            }),
            None
        );
    }

    #[test]
    fn a_source_without_its_own_rule_is_never_diagnosed() {
        // Bare-URL and `ruleArticles: body` sources present links by design.
        // Diagnosing them would fire on every single load.
        assert_eq!(
            diagnose_list(shape_without_rules(40)),
            None
        );
        assert_eq!(
            diagnose_list(ListShape {
                has_rule: false,
                containers: 0,
                openable: 40,
                fallback_links: 40,
            }),
            None
        );
    }

    fn src_with(rules: (&str, &str, &str)) -> Source {
        Source {
            source_url: "https://example.com".into(),
            rule_articles: rules.0.into(),
            rule_title: rules.1.into(),
            rule_link: rules.2.into(),
            ..Default::default()
        }
    }

    #[test]
    fn expands_page_slot() {
        assert_eq!(expand("https://a.com/p/{{page}}.html", 3), "https://a.com/p/3.html");
    }

    #[test]
    fn expands_page_with_offset() {
        assert_eq!(expand("https://a.com/p/{{page<2>}}.html", 1), "https://a.com/p/2.html");
        assert_eq!(expand("https://a.com/p/{{page<2>}}.html", 2), "https://a.com/p/3.html");
    }

    #[test]
    fn parses_html_list() {
        let src = src_with(("class.item@all", "img@alt", "a@href"));
        let body = r#"<div>
            <div class="item"><a href="/a"><img alt="A"/></a></div>
            <div class="item"><a href="/b"><img alt="B"/></a></div>
            <div class="item"><a href="/c"><img alt="C"/></a></div>
        </div>"#;
        let (items, _) = parse_list(&src, body, "https://example.com");
        assert_eq!(items.len(), 3);
        assert_eq!(items[0].title, "A");
        assert_eq!(items[0].link, "https://example.com/a");
    }

    #[test]
    fn infers_list_rule_when_absent() {
        let src = Source { source_url: "https://x.com".into(), ..Default::default() };
        let mut body = String::from("<ul>");
        for i in 0..5 {
            body.push_str(&format!(r#"<li class="list-item"><a href="/{i}">Item {i}</a></li>"#));
        }
        body.push_str("</ul>");
        let (items, _) = parse_list(&src, &body, "https://x.com");
        assert!(items.len() >= 5, "got {}", items.len());
        assert_eq!(items[0].title, "Item 0");
    }

    #[test]
    fn parses_json_cms_list() {
        let mut src = Source { source_url: "https://api.x.com".into(), ..Default::default() };
        src.rule_articles = "$.list".into();
        src.rule_title = "$.vod_name".into();
        src.rule_link = "$.vod_id".into();
        let body = r#"{"list":[{"vod_name":"片1","vod_id":"m3u8/1.m3u8"},
                              {"vod_name":"片2","vod_id":"m3u8/2.m3u8"}]}"#;
        let (items, _) = parse_list(&src, body, "https://api.x.com");
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].title, "片1");
        // A `.m3u8` link should be offered as video.
        assert_eq!(items[0].kind, "video");
    }

    #[test]
    fn json_cms_defaults_without_rules() {
        let src = Source { source_url: "https://api.x.com".into(), ..Default::default() };
        let body = r#"{"list":[{"vod_name":"默认名","vod_id":"/p/9"}]}"#;
        let (items, _) = parse_list(&src, body, "https://api.x.com");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].title, "默认名");
    }

    #[test]
    fn a_javascript_call_is_not_treated_as_a_link() {
        // `text.一键导入@onclick` yields a JS call; turning it into a link
        // produces an item the reader can never open.
        assert!(!looks_like_link("importApp(1)"));
        assert!(!looks_like_link("javascript:void(0)"));
        assert!(!looks_like_link(""));
        assert!(!looks_like_link("hello world"));
        assert!(looks_like_link("/a/b.html"));
        assert!(looks_like_link("https://x.com/a"));
        assert!(looks_like_link("//cdn.x.com/a.mp3"));
    }

    #[test]
    fn audio_links_are_offered_as_music() {
        let mut src = Source { source_url: "https://music.x.com".into(), ..Default::default() };
        src.rule_articles = "class.song@all".into();
        src.rule_title = "a@text".into();
        src.rule_link = "a@href".into();
        let body = r#"<ul>
            <li class="song"><a href="/s/1.mp3">第一首</a></li>
            <li class="song"><a href="/s/2.flac">第二首</a></li>
            <li class="song"><a href="/m/3.m3u8">某视频</a></li>
          </ul>"#;
        let (items, _) = parse_list(&src, body, "https://music.x.com");
        assert_eq!(items[0].kind, "music");
        assert_eq!(items[1].kind, "music");
        // Audio must not swallow video.
        assert_eq!(items[2].kind, "video");
    }

    #[test]
    fn the_host_name_cannot_hijack_classification() {
        // A source served from a `music.` domain must not classify its videos
        // as music just because of the hostname.
        assert_eq!(classify("某视频", "", "https://music.x.com/m/3.m3u8"), "video");
        assert_eq!(classify("第一首", "", "https://music.x.com/s/1.mp3"), "music");
        assert_eq!(classify("MV", "", "https://videos.x.com/w/9.mp4"), "video");
    }

    #[test]
    fn a_music_title_is_recognised_without_an_extension() {
        // A track with no audio extension and no keyword ("稻香") carries no
        // signal at all — only explicit words like 歌单 can be matched.
        assert_eq!(classify("热门歌单", "", "https://x.com/list/9"), "music");
        assert_eq!(classify("纯音乐", "", "https://x.com/list/9"), "music");
        assert_eq!(classify("周杰伦 - 稻香", "", "https://x.com/list/9"), "article");
    }

    #[test]
    fn recognises_audio_urls_with_query_strings() {
        assert!(is_audio_url("https://cdn.x.com/a.mp3"));
        assert!(is_audio_url("https://cdn.x.com/a.flac?token=abc"));
        assert!(is_audio_url("https://cdn.x.com/a.M4A#t=10"));
        assert!(!is_audio_url("https://cdn.x.com/a.mp4"));
        assert!(!is_audio_url("https://cdn.x.com/playlist"));
    }

    #[test]
    fn collects_audio_players_from_a_page() {
        let body = r#"
            <audio src="https://cdn.x.com/one.mp3"></audio>
            <audio><source src="https://cdn.x.com/two.flac"/></audio>
            <img src="https://cdn.x.com/cover.jpg">
            <video src="https://cdn.x.com/clip.mp4"></video>
        "#;
        let audio = audio_from(body);
        assert_eq!(audio, vec!["https://cdn.x.com/one.mp3", "https://cdn.x.com/two.flac"]);
    }

    #[test]
    fn audio_urls_are_deduplicated_and_absolute_only() {
        let body = r#"
            <audio src="https://cdn.x.com/a.mp3"></audio>
            <audio src="https://cdn.x.com/a.mp3"></audio>
            <audio src="data:audio/mpeg;base64,AAAA"></audio>
        "#;
        let audio = audio_from(body);
        assert_eq!(audio, vec!["https://cdn.x.com/a.mp3"]);
    }

    #[test]
    fn a_body_rule_source_with_many_links_is_still_a_list() {
        // Legacy collections set `ruleArticles: "body"` whenever `articleUrl`
        // is absent. Applied to a bookmark page that produced one "article"
        // containing the whole page, scripts included.
        let src = Source {
            source_url: "https://example.com/".into(),
            rule_articles: "body".into(),
            ..Default::default()
        };
        let body: String = (1..=8)
            .map(|i| format!("<li><a href=\"/page/{i}\">条目 {i}</a></li>"))
            .collect::<Vec<_>>()
            .join("");
        let (items, _) = parse_list(&src, &format!("<html><body>{body}</body></html>"), "https://example.com/");
        assert_eq!(items.len(), 8, "{}", items.len());
        assert_eq!(items[0].title, "条目 1");
        assert_eq!(items[0].link, "https://example.com/page/1");
    }

    #[test]
    fn a_body_rule_source_with_no_links_stays_single_page() {
        // A genuine single-page source must keep reading as one article.
        let src = Source {
            source_url: "https://example.com/".into(),
            rule_articles: "body".into(),
            ..Default::default()
        };
        let body = "<html><body><article>一段正文，没有链接。</article></body></html>";
        let (items, _) = parse_list(&src, body, "https://example.com/");
        assert_eq!(items.len(), 1, "a lone article is not a link list");
    }

    #[test]
    fn a_stale_list_rule_falls_back_to_the_page_links() {
        // The selector matches nothing — common on sites that changed markup.
        // The page's own links are usually still good enough to browse.
        let src = Source {
            source_url: "https://example.com/".into(),
            rule_articles: "class.gone".into(),
            rule_title: "a@text".into(),
            rule_link: "a@href".into(),
            ..Default::default()
        };
        let body: String = (1..=6)
            .map(|i| format!("<p><a href=\"/post/{i}\">文章 {i}</a></p>"))
            .collect();
        let (items, _) = parse_list(&src, &format!("<html><body>{body}</body></html>"), "https://example.com/");
        assert_eq!(items.len(), 6, "{}", items.len());
        assert_eq!(items[0].title, "文章 1");
        assert_eq!(items[0].link, "https://example.com/post/1");
    }

    #[test]
    fn items_without_links_also_fall_back_to_the_page_links() {
        // The rule matched containers but produced no address — just as
        // unusable as matching nothing at all.
        let src = Source {
            source_url: "https://example.com/".into(),
            rule_articles: "class.item".into(),
            rule_title: "h2@text".into(),
            ..Default::default()
        };
        let body: String = (1..=4)
            .map(|i| format!("<div class=\"item\"><h2>标题 {i}</h2></div><p><a href=\"/p/{i}\">打开</a></p>"))
            .collect();
        let (items, _) = parse_list(&src, &format!("<html><body>{body}</body></html>"), "https://example.com/");
        assert!(items.iter().any(|i| i.link.contains("/p/")), "{items:#?}");
    }

    #[test]
    fn the_fallback_stays_quiet_when_the_page_has_few_links() {
        let src = Source {
            source_url: "https://example.com/".into(),
            rule_articles: "class.gone".into(),
            ..Default::default()
        };
        let body = r#"<html><body><a href="/only">唯一</a><p>正文</p></body></html>"#;
        let (items, _) = parse_list(&src, body, "https://example.com/");
        // One link is navigation, not a listing.
        assert!(items.is_empty(), "{items:#?}");
    }

    #[test]
    fn the_last_resort_drops_navigation_and_scripts() {
        let src = Source { source_url: "https://x.com/".into(), ..Default::default() };
        let body = r#"<html><body>
            <nav><a href="/a">导航一</a><a href="/b">导航二</a></nav>
            <header>网站标题栏</header>
            <p>这是真正的正文内容，应当保留下来供读者阅读。</p>
            <footer>版权所有</footer>
            <script>var secret = "不该出现的代码";</script>
            <style>body{color:red}</style>
          </body></html>"#;
        let (_, text) = extract_content(&src, body, None);
        assert!(text.contains("真正的正文内容"), "{text}");
        assert!(!text.contains("导航一"), "{text}");
        assert!(!text.contains("网站标题栏"), "{text}");
        assert!(!text.contains("版权所有"), "{text}");
        assert!(!text.contains("不该出现的代码"), "{text}");
    }

    #[test]
    fn the_last_resort_keeps_a_page_that_is_all_chrome() {
        // Stripping must not empty a page that happens to be nothing but nav.
        let src = Source { source_url: "https://x.com/".into(), ..Default::default() };
        let (_, text) = extract_content(&src, "<html><body><nav>只有导航</nav></body></html>", None);
        assert!(!text.is_empty(), "chrome-only page produced no text at all");
    }

    #[test]
    fn finds_next_page_link() {
        let src = Source { source_url: "https://x.com".into(), ..Default::default() };
        let body = r#"<div><a href="/page/2">下一页</a></div>"#;
        let doc = selector::Doc::parse(body);
        let next = find_next_page(&src, &doc, None, "https://x.com", "");
        assert_eq!(next.as_deref(), Some("https://x.com/page/2"));
    }

    #[test]
    fn absolutizes_rendered_media() {
        let html = r#"<video src="/v.mp4" poster="a.jpg"></video>"#;
        let out = absolutize_html(html, "https://m.com/detail/1");
        assert!(out.contains("https://m.com/v.mp4"), "{out}");
        assert!(out.contains("https://m.com/detail/a.jpg"), "{out}");
    }

    #[test]
    fn leaves_absolute_urls_alone() {
        let html = r#"<img src="https://cdn.x.com/a.jpg">"#;
        assert_eq!(absolutize_html(html, "https://m.com/"), html);
    }

    #[test]
    fn categories_default_to_home() {
        let src = Source { source_url: "https://x.com".into(), ..Default::default() };
        let cats = categories(&src);
        assert_eq!(cats.len(), 1);
        assert_eq!(cats[0].name, "首页");
    }

    #[test]
    fn bare_url_source_becomes_link_list() {
        // A source with no rules: the page's links become the listing.
        let src = Source { source_url: "https://x.com".into(), ..Default::default() };
        let body = r##"
          <ul>
            <li><a href="/a"><img data-src="/a.jpg" alt="A"/> 第一章</a></li>
            <li><a href="/b"><img src="/b.jpg" alt="B"/> 第二章</a></li>
            <li><a href="/a">第一章</a></li>
            <li><a href="#top">顶部</a></li>
            <li><a href="javascript:void(0)">脚本</a></li>
          </ul>"##;
        let (items, _) = parse_list(&src, body, "https://x.com");
        assert_eq!(items.len(), 2, "got {items:#?}");
        assert_eq!(items[0].title, "第一章");
        assert_eq!(items[0].link, "https://x.com/a");
        assert_eq!(items[0].image, "https://x.com/a.jpg");
        assert_eq!(items[1].title, "第二章");
    }

    #[test]
    fn link_list_skips_absurd_titles() {
        let src = Source { source_url: "https://x.com".into(), ..Default::default() };
        let long = "很长的标题".repeat(60);
        let body = format!(r#"<a href="/long">{long}</a><a href="/ok">正常</a>"#);
        let (items, _) = parse_list(&src, &body, "https://x.com");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].title, "正常");
    }

    #[test]
    fn extracts_content_with_rule() {
        let mut src = Source { source_url: "https://x.com".into(), ..Default::default() };
        src.rule_content = "id.content".into();
        let body = r#"<body><div id="content"><p>正文内容在这里</p></div></body>"#;
        let (html, text) = extract_content(&src, body, None);
        assert!(html.contains("正文内容"));
        assert!(text.contains("正文内容"));
    }

    // ---- the offscreen render gate -----------------------------------------
    //
    // Rendering is the only lever left on sources that build their content in
    // the browser, and it costs an offscreen window plus a couple of seconds.
    // These pin the rule that keeps that cost off sources that do not need it.

    fn js_source() -> Source {
        Source { source_url: "https://x.com".into(), enable_js: true, ..Default::default() }
    }

    fn open_item() -> ArticleItem {
        ArticleItem { title: "第一章".into(), link: "https://x.com/a".into(), ..Default::default() }
    }

    #[test]
    fn renders_when_a_js_source_yields_nothing_openable() {
        // The one case the fallback exists for: the source asks for a browser
        // and the ordinary fetch came back with nothing to open.
        assert!(should_render(&js_source(), &[], "<html></html>", "https://x.com/", true, true));
    }

    #[test]
    fn a_single_item_without_an_address_still_counts_as_nothing() {
        // What a script-built page looks like before rendering: one entry, and
        // no link to open.
        let orphan = ArticleItem { title: "首页".into(), ..Default::default() };
        assert!(should_render(
            &js_source(),
            std::slice::from_ref(&orphan),
            "<html></html>",
            "https://x.com/",
            true,
            true
        ));
    }

    #[test]
    fn never_renders_a_page_that_already_parsed() {
        // The branch that matters for cost: a healthy listing must not pay for
        // an offscreen window.
        assert!(!should_render(
            &js_source(),
            &[open_item()],
            "<html><a href='/a'>A</a></html>",
            "https://x.com/",
            true,
            true
        ));
    }

    #[test]
    fn respects_the_users_switch() {
        assert!(!should_render(&js_source(), &[], "<html></html>", "https://x.com/", false, true));
    }

    #[test]
    fn needs_a_registered_renderer() {
        assert!(!should_render(&js_source(), &[], "<html></html>", "https://x.com/", true, false));
    }

    #[test]
    fn never_renders_a_source_that_does_not_declare_javascript() {
        let plain = Source { source_url: "https://x.com".into(), ..Default::default() };
        assert!(!should_render(&plain, &[], "<html></html>", "https://x.com/", true, true));
    }

    #[test]
    fn never_renders_an_empty_body_or_a_non_http_address() {
        let src = js_source();
        assert!(!should_render(&src, &[], "   ", "https://x.com/", true, true));
        assert!(!should_render(&src, &[], "<html></html>", "file:///tmp/x.html", true, true));
        assert!(!should_render(&src, &[], "<html></html>", "magnet:?xt=urn:btih:1", true, true));
    }

    #[test]
    fn the_engine_default_matches_the_stored_preference() {
        // The engine and the settings store have to agree on the default, or a
        // source verified before the preference is applied renders anyway.
        assert_eq!(
            RENDER_DEFAULT,
            crate::store::Settings::default().render_js,
            "the render fallback and Settings::render_js disagree about the default"
        );
    }

    // ---- whole-JS list rules ------------------------------------------------
    //
    // 多看阅读 (collection 160): `ruleArticles` is not a selector at all but
    // one `<js>` block whose `JSON.parse(result)` proves Legado hands it the
    // response body text. The production path used to feed that script to the
    // CSS selector parser, which matched nothing — a source that ran without
    // errors and always listed nothing.

    /// The Duokan rule, copied verbatim from collection 160.
    fn duokan_source() -> Source {
        Source {
            source_url: "https://www.duokan.com/store/v0/android/feed".into(),
            rule_articles: "<js>\nJSON.parse(result).items.map(bk=>({\na:bk.title+bk.summary,\nb:java.timeFormat(bk.create_time*1000),\nc:bk.book_cover,\nd:\"https://www.duokan.com/store/v0/android/feed/\"+bk.id\n}))\n</js>"
                .into(),
            rule_title: "a".into(),
            rule_link: "d".into(),
            rule_image: "c".into(),
            rule_pub_date: "b".into(),
            ..Default::default()
        }
    }

    /// Same shape as the real endpoint: an object with an `items` array.
    fn duokan_body() -> String {
        r#"{"items":[
            {"id":"3001","title":"第一本书","summary":"·简介一","create_time":1709613223,"book_cover":"https://c/1.jpg"},
            {"id":"3002","title":"第二本书","summary":"·简介二","create_time":1709613300,"book_cover":"https://c/2.jpg"},
            {"id":"3003","title":"第三本书","summary":"·简介三","create_time":1709613400,"book_cover":"https://c/3.jpg"}
        ]}"#
            .to_string()
    }

    #[test]
    fn a_whole_js_list_rule_produces_items_through_parse_list() {
        // Through `parse_list_detailed`, not just `eval_to_json`: the point is
        // the production path, selector bypass and all.
        let src = duokan_source();
        let (items, _, shape) = parse_list_detailed(&src, &duokan_body(), "https://www.duokan.com");
        assert!(
            items.len() >= 2,
            "the whole-JS rule should yield items, got {items:#?}"
        );
        // Fields really come from the rule: title carries the summary, the
        // link is the feed address the rule builds, the date is formatted.
        assert!(
            items[0].title.contains("第一本书") && items[0].title.contains("·简介一"),
            "title should be title+summary, got {:?}",
            items[0].title
        );
        assert_eq!(
            items[1].link,
            "https://www.duokan.com/store/v0/android/feed/3002"
        );
        assert!(
            items[0].date.contains('-') && items[0].date.len() >= 8,
            "date should be a formatted date, got {:?}",
            items[0].date
        );
        assert_eq!(items[0].image, "https://c/1.jpg");
        // And the proof this came from rule evaluation, not the page-link
        // fallback: the fallback is suppressed for JS rules, so
        // `fallback_links` is 0 while the rule did the work.
        assert!(shape.has_rule, "the source declares its own rule");
        assert_eq!(
            shape.fallback_links, 0,
            "a JS-rule listing must never be a page-link substitute: {shape:?}"
        );
        assert!(
            shape.openable >= 2,
            "the shape should record what the rule produced: {shape:?}"
        );
    }

    #[test]
    fn an_ordinary_selector_rule_is_untouched_by_the_js_branch() {
        // `looks_like_js` must not catch a plain selector: `class.item@all`
        // carries none of the JS markers, and the old path is byte-identical.
        let src = src_with(("class.item@all", "img@alt", "a@href"));
        let body = r#"<div>
            <div class="item"><a href="/a"><img alt="A"/></a></div>
            <div class="item"><a href="/b"><img alt="B"/></a></div>
            <div class="item"><a href="/c"><img alt="C"/></a></div>
        </div>"#;
        let (items, _, shape) = parse_list_detailed(&src, body, "https://example.com");
        assert_eq!(items.len(), 3);
        assert_eq!(items[0].title, "A");
        assert_eq!(items[0].link, "https://example.com/a");
        assert!(!js::looks_like_js("class.item@all"));
        assert_eq!(shape.fallback_links, 0);
    }

    #[test]
    fn a_throwing_js_rule_lists_nothing_and_names_the_rule() {
        // A JS rule that throws is a rule failure, not an empty page: the
        // list stays empty (no page-link substitute) and the shape still says
        // the rule was there, so `diagnose_list` can point at the rule.
        let src = Source {
            source_url: "https://www.duokan.com/store/v0/android/feed".into(),
            rule_articles: "<js>JSON.parse(result).items.map(bk => { throw new Error('boom'); })</js>"
                .into(),
            rule_title: "a".into(),
            rule_link: "d".into(),
            ..Default::default()
        };
        let body = "<html><body>\
            <a href=\"/p/1\">文章一</a><a href=\"/p/2\">文章二</a>\
            <a href=\"/p/3\">文章三</a><a href=\"/p/4\">文章四</a>\
            </body></html>";
        let (items, _, shape) =
            parse_list_detailed(&src, body, "https://www.duokan.com");
        assert!(
            items.is_empty(),
            "a throwing JS rule must list nothing, not page links: {items:#?}"
        );
        assert!(shape.has_rule, "{shape:?}");
        assert_eq!(shape.containers, 0, "{shape:?}");
        assert_eq!(shape.fallback_links, 0, "{shape:?}");
        let diagnosis = diagnose_list(shape);
        assert!(
            diagnosis.is_none(),
            "an empty page with no substitute is quiet, not broken: {diagnosis:?}"
        );
    }
}