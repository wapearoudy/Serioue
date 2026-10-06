use crate::engine::{fetch, selector::Doc};
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use url::Url;

/// A shared collection as listed on the source repository index.
#[derive(Debug, Clone, Serialize, Default)]
pub struct RepoCollection {
    /// Numeric id used in the download URL.
    pub id: String,
    pub title: String,
    pub author: String,
    pub source_count: usize,
    pub downloads: usize,
    pub date: String,
    /// Detail page URL.
    pub page_url: String,
    /// Direct JSON download URL.
    pub json_url: String,
}

/// Where this repository keeps things.
///
/// The index page, the way page 2 is named and the directory a collection's
/// JSON lives in are all the site's own vocabulary, not a protocol. A mirror
/// serves the same pages under different names, and a path built from a
/// constant fails there *quietly*: the index still parses, the list still
/// renders, and every single download 404s — which a user reads as "all the
/// sources are dead" rather than "this site lays its files out differently".
///
/// So each of them is a setting. The defaults are exactly what the original
/// repository uses, and the configured JSON path is only ever a fallback: a
/// real download link found in the page always wins, and a path that cannot be
/// derived is reported rather than guessed.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RepoPaths {
    /// Path of the first index page, relative to the base.
    pub index: String,
    /// How later index pages are addressed; `{page}` is substituted.
    pub index_page: String,
    /// Where a collection's JSON lives, as a template with `{id}`. Only a
    /// fallback: a download link found on the page always wins.
    pub json: String,
}

/// The original repository's layout, kept as the default so that changing
/// nothing here changes nothing about how it behaves.
pub const DEFAULT_INDEX_PATH: &str = "/yuedu/rsss/index.html";
pub const DEFAULT_INDEX_PAGE_PATH: &str = "/yuedu/rsss/index_{page}.html";
pub const DEFAULT_JSON_PATH: &str = "/yuedu/rsss/json/id/{id}.json";

impl Default for RepoPaths {
    fn default() -> Self {
        Self {
            index: DEFAULT_INDEX_PATH.to_string(),
            index_page: DEFAULT_INDEX_PAGE_PATH.to_string(),
            json: DEFAULT_JSON_PATH.to_string(),
        }
    }
}

/// The URL of one index page.
pub fn index_url(base: &str, page: u32, paths: &RepoPaths) -> String {
    let base = base.trim_end_matches('/');
    if page <= 1 {
        return format!("{base}{}", paths.index);
    }
    format!("{base}{}", paths.index_page.replace("{page}", &page.to_string()))
}

/// The download address for a collection id, built from the configured layout.
///
/// A last resort, not a guess to rely on: prefer what the page links to, then
/// [`derive_json_url`], and only then this.
pub fn json_url(base: &str, id: &str, paths: &RepoPaths) -> String {
    format!("{}{}", base.trim_end_matches('/'), paths.json.replace("{id}", id))
}

/// The directory name the configured JSON path uses, when it has the shape
/// this derivation understands: `…/<dir>/id/{id}.json`.
///
/// Returns `None` for a template of some other shape, because the derivation
/// below cannot honour it — the caller then falls back to [`json_url`], which
/// uses the template exactly as configured.
fn json_dir_name(paths: &RepoPaths) -> Option<String> {
    let trimmed = paths.json.trim().trim_start_matches('/');
    let dir = trimmed.rsplit_once('/').map(|(d, _)| d)?;
    let head = dir.strip_suffix("/id")?;
    head.rsplit('/').next().map(str::to_string).filter(|s| !s.is_empty())
}

/// Derive the JSON address from the detail page's own path.
///
/// `…/content/id/203.html` with the default layout gives `…/json/id/203.json`:
/// the prefix comes from the page in hand, and only the last directory — the
/// one the configuration names — is swapped. That is a derivation from the page
/// rather than a constant pasted over the base URL.
///
/// Returns `None` when the page is not shaped like a detail page — `/c/203` or
/// `/detail/203.html` say nothing about where the JSON lives. Inventing an
/// address there is how a download turns into a 404 that looks like a dead
/// source, so the caller is expected to report the gap instead.
fn derive_json_url(page_url: &str, paths: &RepoPaths) -> Option<String> {
    let mut url = Url::parse(page_url).ok()?;
    let id = id_from_url(page_url)?;
    let segments: Vec<String> = url
        .path_segments()
        .map(|s| s.map(str::to_string).collect())
        .unwrap_or_default();

    // The id directory, and the detail directory that sits beside it.
    let at = segments.iter().rposition(|s| s == "id")?;
    if at == 0 || segments.len() <= at + 1 {
        return None;
    }
    if !segments[at + 1].starts_with(|c: char| c.is_ascii_digit()) {
        return None;
    }
    // Everything before the detail directory is the site's own prefix.
    let prefix = segments[..at - 1].join("/");

    let name = json_dir_name(paths)?;
    let mut out: Vec<String> = if prefix.is_empty() {
        Vec::new()
    } else {
        prefix.split('/').map(str::to_string).collect()
    };
    out.push(name);
    out.push("id".to_string());
    out.push(format!("{id}.json"));

    url.set_path(&out.join("/"));
    Some(url.to_string())
}

/// Does this link look like a collection's detail page?
///
/// Asked of every link in a card, so it has to answer "could this be the page
/// describing collection N?" without knowing the site's path layout. The shape
/// that survives a site redesign is the trailing id: a last segment that starts
/// with digits. Assets and download links are ruled out because they are not
/// pages a reader would open.
fn is_detail_href(href: &str) -> bool {
    let href = href.trim();
    if href.is_empty()
        || href.starts_with('#')
        || href.starts_with("javascript:")
        || href.starts_with("mailto:")
        || href.starts_with("tel:")
        || href.contains(char::is_whitespace)
    {
        return false;
    }
    let last = href
        .split(['?', '#'])
        .next()
        .unwrap_or(href)
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or("");
    let lower = last.to_ascii_lowercase();
    if [".json", ".css", ".js", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".zip", ".rar", ".apk", ".txt", ".xml"]
        .iter()
        .any(|ext| lower.ends_with(ext))
    {
        return false;
    }
    last.starts_with(|c: char| c.is_ascii_digit())
}

/// The download address for a collection, preferring what the page offers.
///
/// In order: a real JSON link among the card's own links, then the address
/// derived from the detail page's path. When neither exists the error names
/// the page, because "this repository's downloads are somewhere I do not
/// recognise" is a fixable report and a fabricated URL is not.
fn discover_json_url(
    hrefs: &[String],
    page_url: &str,
    base: &str,
    paths: &RepoPaths,
) -> Result<String, String> {
    let id = id_from_url(page_url);

    // A link that is already a download, preferably the one for this id.
    let mut json_links = hrefs
        .iter()
        .filter(|h| h.to_ascii_lowercase().split(['?', '#']).next().unwrap_or(h).ends_with(".json"))
        .map(|h| crate::util::absolute_url(h, base));
    let mut found: Option<String> = None;
    for link in json_links.by_ref() {
        let matches_id = id
            .as_deref()
            .zip(id_from_url(&link))
            .map(|(a, b)| a == b)
            .unwrap_or(false);
        if matches_id {
            return Ok(link);
        }
        found.get_or_insert(link);
    }
    if let Some(link) = found {
        return Ok(link);
    }

    if let Some(derived) = derive_json_url(page_url, paths) {
        return Ok(derived);
    }

    Err(format!(
        "找不到合集的下载地址：{page_url} 上没有指向 .json 的链接，它的路径形态也无法推导（\
         可在设置里调整仓库的路径：索引页、翻页方式、JSON 目录）"
    ))
}

/// Fetch the list of shared collections from the repository index.
///
/// The site paginates with `index_N.html`; `page` is 1-based.
pub fn fetch_index(base: &str, page: u32) -> AppResult<Vec<RepoCollection>> {
    fetch_index_with(base, page, &RepoPaths::default())
}

/// The same, against a repository whose paths are configured.
pub fn fetch_index_with(base: &str, page: u32, paths: &RepoPaths) -> AppResult<Vec<RepoCollection>> {
    let url = index_url(base, page, paths);

    let resp = fetch::fetch_ok(None, &url)?;
    parse_index_with(&resp.body, base, paths)
}

/// Parse the index page markup into collection entries, using the default paths.
pub fn parse_index(html: &str, base: &str) -> AppResult<Vec<RepoCollection>> {
    parse_index_with(html, base, &RepoPaths::default())
}

/// Parse the index page markup into collection entries.
///
/// The live index is a card grid (`div.ylist`), not a table, so cards are
/// preferred and the table form is kept as a fallback for older pages.
pub fn parse_index_with(html: &str, base: &str, paths: &RepoPaths) -> AppResult<Vec<RepoCollection>> {
    let page = Doc::parse(html);

    let cards = page.eval_outer("class.ylist@all");
    if !cards.is_empty() {
        let mut out = Vec::new();
        for card in cards {
            if let Some(c) = parse_card(&card, base, paths)? {
                out.push(c);
            }
        }
        if !out.is_empty() {
            return Ok(out);
        }
    }

    // Older table-based layout.
    let rows = page.eval_outer("class.layui-table-tbody@tr@all");
    let rows = if rows.is_empty() { page.eval_outer("tbody@tr@all") } else { rows };
    let mut out = Vec::new();
    for row in rows {
        // Re-parse the row inside a table wrapper: html5ever drops the cells of
        // a bare `<tr>` fragment, which would merge every column into one.
        let row_doc = Doc::parse(&format!("<table><tbody>{row}</tbody></table>"));
        if let Some(c) = parse_row(&row_doc, base, paths)? {
            out.push(c);
        }
    }
    Ok(out)
}

/// Pull the numeric value out of a `标签: 123` cell.
fn number_after(text: &str, label: &str) -> usize {
    text.split_once(label)
        .map(|(_, rest)| {
            rest.chars()
                .filter(|c| c.is_ascii_digit())
                .collect::<String>()
                .parse()
                .unwrap_or(0)
        })
        .unwrap_or(0)
}

/// Value after the first `:` or `：`.
fn value_after_colon(text: &str) -> String {
    text.split_once(':')
        .or_else(|| text.split_once('：'))
        .map(|(_, v)| v.trim().to_string())
        .unwrap_or_default()
}

/// Parse one card from the modern grid layout.
fn parse_card(card_html: &str, base: &str, paths: &RepoPaths) -> AppResult<Option<RepoCollection>> {
    let card = Doc::parse(card_html);
    let hrefs = card.eval("a@href");
    // No link at all means this is not a collection card: skip it quietly. A
    // link that is there but unidentifiable is a different story, and is
    // reported below.
    let Some(href) = hrefs
        .iter()
        .find(|h| is_detail_href(h))
        .cloned()
        // A card whose only link is the download still identifies its
        // collection, and that link is the address we want anyway.
        .or_else(|| hrefs.iter().find(|h| h.to_ascii_lowercase().ends_with(".json")).cloned())
    else {
        return Ok(None);
    };
    let id = id_from_href(&href).ok_or_else(|| {
        AppError::other(format!("合集链接 {href} 里没有编号，无法判断它是哪个合集"))
    })?;
    let title = card
        .eval("a@text")
        .into_iter()
        .map(|t| crate::util::clean_text(&t))
        .find(|t| !t.is_empty())
        .unwrap_or_default();

    let spans: Vec<String> = card
        .eval("span@text")
        .into_iter()
        .map(|t| crate::util::clean_text(&t))
        .filter(|t| !t.is_empty())
        .collect();
    let author = spans
        .iter()
        .find(|s| s.contains("用户"))
        .map(|s| value_after_colon(s))
        .unwrap_or_default();
    let source_count = spans
        .iter()
        .find(|s| s.contains("源数量"))
        .map(|s| number_after(s, "源数量"))
        .unwrap_or(0);
    let downloads = spans
        .iter()
        .find(|s| s.contains("下载"))
        .map(|s| number_after(s, "下载"))
        .unwrap_or(0);
    let date = card
        .eval("p@text")
        .into_iter()
        .map(|t| crate::util::clean_text(&t))
        .find(|t| !t.is_empty())
        .unwrap_or_default();

    let page_url = crate::util::absolute_url(&href, base);
    let json_url = discover_json_url(&hrefs, &page_url, base, paths).map_err(AppError::other)?;

    Ok(Some(RepoCollection {
        title,
        author,
        source_count,
        downloads,
        date,
        page_url,
        json_url,
        id,
    }))
}

/// Parse one row from the older table layout.
fn parse_row(row: &Doc, base: &str, paths: &RepoPaths) -> AppResult<Option<RepoCollection>> {
    let hrefs = row.eval("a@href");
    let Some(href) = hrefs
        .iter()
        .find(|h| is_detail_href(h))
        .cloned()
        .or_else(|| hrefs.iter().find(|h| h.to_ascii_lowercase().ends_with(".json")).cloned())
    else {
        return Ok(None);
    };
    let id = id_from_href(&href)
        .ok_or_else(|| AppError::other(format!("合集链接 {href} 里没有编号，无法判断它是哪个合集")))?;
    let title = row
        .eval("a@text")
        .into_iter()
        .map(|t| crate::util::clean_text(&t))
        .find(|t| !t.is_empty())
        .unwrap_or_default();

    let texts: Vec<String> = row
        .eval("td@text")
        .into_iter()
        .map(|t| crate::util::clean_text(&t))
        .filter(|t| !t.is_empty())
        .collect();

    let author = texts
        .iter()
        .find(|t| t.contains("用户"))
        .map(|t| value_after_colon(t))
        .unwrap_or_default();
    let source_count = texts
        .iter()
        .find(|t| t.contains("数量"))
        .map(|t| number_after(t, "数量"))
        .unwrap_or(0);
    let downloads = texts
        .iter()
        .find(|t| t.contains("下载"))
        .map(|t| number_after(t, "下载"))
        .unwrap_or(0);

    let page_url = crate::util::absolute_url(&href, base);
    let json_url = discover_json_url(&hrefs, &page_url, base, paths).map_err(AppError::other)?;

    Ok(Some(RepoCollection {
        title,
        author,
        source_count,
        downloads,
        date: texts.first().cloned().unwrap_or_default(),
        page_url,
        json_url,
        id,
    }))
}

/// The numeric id a detail link carries.
///
/// The site decides what a collection's link looks like; all that can be relied
/// on is that the number is the leading run of digits in the last segment.
fn id_from_href(href: &str) -> Option<String> {
    // `…/pack/42/` is the same page as `…/pack/42`; the trailing slash just
    // moves the id out of the last segment.
    id_from_url(href.trim().trim_end_matches('/'))
}

/// Fetch and parse one collection's source JSON.
///
/// The site redirects to a CDN and rate-limits bursts, so a transient failure
/// is retried a few times before giving up.
pub fn fetch_collection(url: &str) -> AppResult<Vec<crate::model::Source>> {
    let mut last: Option<crate::error::AppError> = None;
    for attempt in 0..3u32 {
        match fetch::fetch_ok(None, url) {
            Ok(resp) => {
                return crate::model::Source::parse_collection(&resp.body)
                    .map_err(|e| AppError::Import(format!("{url}: {e}")))
            }
            Err(e) => {
                last = Some(e);
                if attempt < 2 {
                    std::thread::sleep(std::time::Duration::from_millis(600 * (attempt as u64 + 1)));
                }
            }
        }
    }
    Err(last.unwrap_or_else(|| AppError::Import(format!("{url}: 请求失败"))))
}

/// Turn a repository page URL or JSON URL into an id, when possible.
pub fn id_from_url(url: &str) -> Option<String> {
    let tail = url.rsplit('/').next()?;
    let digits: String = tail.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        None
    } else {
        Some(digits)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The live index uses a card grid, not a table.
    const CARD_INDEX: &str = r#"
      <html><body>
        <div class="ylist">
          <h2><a href="/yuedu/rsss/content/id/203.html">自用</a>
            <p class="m-right"> 4天前</p>
          </h2>
          <span class="layui-badge-rim" title="UID:13852">用户: JB1M8</span>
          <span class="layui-badge-rim">源数量:71</span>
          <span class="layui-badge-rim">下载:11958</span>
        </div>
        <div class="ylist">
          <h2><a href="/yuedu/rsss/content/id/202.html">【阅读资源】订阅合集</a>
            <p class="m-right">09/15 19:55</p>
          </h2>
          <span>用户: DowneyRem</span>
          <span>源数量:6</span>
          <span>下载:18485</span>
        </div>
      </body></html>"#;

    const TABLE_INDEX: &str = r#"
      <html><body>
      <table class="layui-table">
        <tbody class="layui-table-tbody">
          <tr>
            <td><a href="/yuedu/rsss/content/id/203.html">自用</a></td>
            <td>4天前</td>
            <td>用户: JB1M8</td>
            <td>源数量: 71</td>
            <td>下载: 11849</td>
          </tr>
          <tr>
            <td><a href="/yuedu/rsss/content/id/202.html">合集</a></td>
            <td>09/15 19:55</td>
            <td>用户: DowneyRem</td>
            <td>源数量: 6</td>
            <td>下载: 18485</td>
          </tr>
        </tbody>
      </table>
      </body></html>"#;

    #[test]
    fn parses_card_index() {
        let cols = parse_index(CARD_INDEX, "https://www.yck2026.fun").unwrap();
        assert_eq!(cols.len(), 2);

        let first = &cols[0];
        assert_eq!(first.id, "203");
        assert_eq!(first.title, "自用");
        assert_eq!(first.author, "JB1M8");
        assert_eq!(first.source_count, 71);
        assert_eq!(first.downloads, 11958);
        assert_eq!(first.date, "4天前");
        assert_eq!(
            first.json_url,
            "https://www.yck2026.fun/yuedu/rsss/json/id/203.json"
        );
        assert!(first.page_url.ends_with("/yuedu/rsss/content/id/203.html"));
    }

    #[test]
    fn parses_table_index() {
        let cols = parse_index(TABLE_INDEX, "https://www.yck2026.fun").unwrap();
        assert_eq!(cols.len(), 2);
        assert_eq!(cols[0].id, "203");
        assert_eq!(cols[0].author, "JB1M8");
        assert_eq!(cols[0].source_count, 71);
        assert_eq!(cols[0].downloads, 11849);
    }

    #[test]
    fn builds_json_url() {
        // The default layout still produces the original address, which is the
        // point of defaulting to it.
        assert_eq!(
            json_url("https://www.yck2026.fun/", "42", &RepoPaths::default()),
            "https://www.yck2026.fun/yuedu/rsss/json/id/42.json"
        );
    }

    #[test]
    fn builds_index_urls_from_the_configured_paths() {
        let d = RepoPaths::default();
        assert_eq!(index_url("https://x.test/", 1, &d), "https://x.test/yuedu/rsss/index.html");
        assert_eq!(index_url("https://x.test", 3, &d), "https://x.test/yuedu/rsss/index_3.html");

        // A mirror that names things differently is described, not guessed.
        let other = RepoPaths {
            index: "/library/index.html".into(),
            index_page: "/library/page-{page}.html".into(),
            json: "/library/data/{id}.json".into(),
        };
        assert_eq!(index_url("https://m.test", 1, &other), "https://m.test/library/index.html");
        assert_eq!(index_url("https://m.test", 2, &other), "https://m.test/library/page-2.html");
        assert_eq!(json_url("https://m.test", "7", &other), "https://m.test/library/data/7.json");
    }

    #[test]
    fn recognizes_a_detail_link_without_knowing_the_path() {
        // The original shape, and shapes this site has never used.
        for (href, id) in [
            ("/yuedu/rsss/content/id/203.html", "203"),
            ("/c/203", "203"),
            ("/detail/203.html", "203"),
            ("https://other.test/pack/42/", "42"),
        ] {
            assert!(is_detail_href(href), "{href} should look like a detail page");
            assert_eq!(id_from_href(href).as_deref(), Some(id), "{href}");
        }
        // And the things that are not detail pages.
        for href in [
            "",
            "#top",
            "javascript:;",
            "mailto:a@b.test",
            "/yuedu/rsss/index.html",
            "/static/logo.png",
            "/yuedu/rsss/json/id/203.json",
            "/about-us.html",
        ] {
            assert!(!is_detail_href(href), "{href} should not look like a detail page");
        }
    }

    #[test]
    fn takes_the_download_address_from_the_page_when_it_is_linked() {
        // A site whose paths we have never seen: the id comes from the link and
        // the address from the page, not from a template.
        let html = r#"
          <html><body><div class="ylist">
            <h2><a href="/c/203">合集</a></h2>
            <a href="/c/203">详情</a>
            <a href="/dl/203.json">下载</a>
            <span>源数量: 7</span>
          </div></body></html>"#;
        let cols = parse_index(html, "https://mirror.test").unwrap();
        assert_eq!(cols.len(), 1);
        assert_eq!(cols[0].id, "203");
        assert_eq!(cols[0].page_url, "https://mirror.test/c/203");
        assert_eq!(cols[0].json_url, "https://mirror.test/dl/203.json");
    }

    #[test]
    fn derives_the_download_address_from_the_detail_path() {
        // No JSON link on the card: the address is derived from the detail
        // page's own path, keeping the site's prefix.
        let html = r#"
          <html><body><div class="ylist">
            <h2><a href="/yuedu/rsss/content/id/203.html">自用</a></h2>
            <span>源数量:71</span>
          </div></body></html>"#;
        let cols = parse_index(html, "https://www.yck2026.fun").unwrap();
        assert_eq!(cols[0].json_url, "https://www.yck2026.fun/yuedu/rsss/json/id/203.json");
    }

    #[test]
    fn refuses_to_invent_a_download_address() {
        // A detail page shaped like nothing we can derive from, with no link to
        // a download. Returning a plausible URL here is what turns "this site
        // lays its files out differently" into "every source is dead".
        let html = r#"
          <html><body><div class="ylist">
            <h2><a href="/detail/203.html">某合集</a></h2>
            <span>源数量:71</span>
          </div></body></html>"#;
        let err = parse_index(html, "https://mirror.test").unwrap_err();
        let text = err.to_string();
        assert!(text.contains("下载地址"), "{text}");
        assert!(text.contains("/detail/203.html"), "{text}");
    }

    #[test]
    fn extracts_id_from_url() {
        assert_eq!(id_from_url("https://x/yuedu/rsss/json/id/203.json").as_deref(), Some("203"));
        assert_eq!(id_from_url("https://x/content/id/9.html").as_deref(), Some("9"));
        assert_eq!(id_from_url("https://x/none"), None);
    }

    #[test]
    fn extracts_number_after_label() {
        assert_eq!(number_after("源数量:71", "源数量"), 71);
        assert_eq!(number_after("下载:11958", "下载"), 11958);
        assert_eq!(number_after("用户: JB", "下载"), 0);
    }
}