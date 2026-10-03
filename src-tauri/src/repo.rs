use crate::engine::{fetch, selector::Doc};
use crate::error::{AppError, AppResult};
use serde::Serialize;

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

const INDEX_PATH: &str = "/yuedu/rsss/index.html";

/// Build the URL of a collection's JSON file from the configured base.
pub fn json_url(base: &str, id: &str) -> String {
    format!("{}/yuedu/rsss/json/id/{}.json", base.trim_end_matches('/'), id)
}

/// Fetch the list of shared collections from the repository index.
///
/// The site paginates with `index_N.html`; `page` is 1-based.
pub fn fetch_index(base: &str, page: u32) -> AppResult<Vec<RepoCollection>> {
    let base = base.trim_end_matches('/');
    let url = if page <= 1 {
        format!("{base}{INDEX_PATH}")
    } else {
        format!("{base}/yuedu/rsss/index_{page}.html")
    };

    let resp = fetch::fetch_ok(None, &url)?;
    parse_index(&resp.body, base)
}

/// Parse the index page markup into collection entries.
///
/// The live index is a card grid (`div.ylist`), not a table, so cards are
/// preferred and the table form is kept as a fallback for older pages.
pub fn parse_index(html: &str, base: &str) -> AppResult<Vec<RepoCollection>> {
    let page = Doc::parse(html);

    let cards = page.eval_outer("class.ylist@all");
    if !cards.is_empty() {
        let mut out = Vec::new();
        for card in cards {
            if let Some(c) = parse_card(&card, base) {
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
        if let Some(c) = parse_row(&row_doc, base) {
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
fn parse_card(card_html: &str, base: &str) -> Option<RepoCollection> {
    let card = Doc::parse(card_html);
    let href = card
        .eval("a@href")
        .into_iter()
        .find(|h| h.contains("/content/id/"))?;
    let id = id_from_href(&href)?;
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

    Some(RepoCollection {
        title,
        author,
        source_count,
        downloads,
        date,
        page_url: crate::util::absolute_url(&href, base),
        json_url: json_url(base, &id),
        id,
    })
}

/// Parse one row from the older table layout.
fn parse_row(row: &Doc, base: &str) -> Option<RepoCollection> {
    let href = row
        .eval("a@href")
        .into_iter()
        .find(|h| h.contains("/content/id/"))?;
    let id = id_from_href(&href)?;
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

    Some(RepoCollection {
        title,
        author,
        source_count,
        downloads,
        date: texts.first().cloned().unwrap_or_default(),
        page_url: crate::util::absolute_url(&href, base),
        json_url: json_url(base, &id),
        id,
    })
}

/// Extract the numeric id from a `/content/id/NN.html` link.
fn id_from_href(href: &str) -> Option<String> {
    let tail = href.split("/content/id/").nth(1)?;
    let id: String = tail.chars().take_while(|c| c.is_ascii_digit()).collect();
    if id.is_empty() {
        None
    } else {
        Some(id)
    }
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
        assert_eq!(
            json_url("https://www.yck2026.fun/", "42"),
            "https://www.yck2026.fun/yuedu/rsss/json/id/42.json"
        );
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