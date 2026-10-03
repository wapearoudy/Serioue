use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// A source as it appears in a shared collection JSON.
///
/// The repositories on yck2026.fun ship two different generations of format:
/// the current one (list/content rules, like `ruleArticles`) and the legacy RSS
/// one (`articleUrl` / `itemTitle` / ...). Both are normalized into this struct.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Source {
    // ---- identity -------------------------------------------------------
    #[serde(rename = "sourceUrl", default)]
    pub source_url: String,
    #[serde(rename = "sourceName", default)]
    pub source_name: String,
    #[serde(rename = "sourceGroup", default)]
    pub source_group: String,
    #[serde(rename = "sourceIcon", default)]
    pub source_icon: String,
    #[serde(rename = "customOrder", default)]
    pub custom_order: i64,

    // ---- request --------------------------------------------------------
    /// Raw JSON header object, e.g. `{"User-Agent":"...","Cookie":"..."}`.
    #[serde(rename = "header", default)]
    pub header: String,
    #[serde(rename = "enabledCookieJar", default)]
    pub enabled_cookie_jar: Option<bool>,
    #[serde(rename = "loadWithBaseUrl", default)]
    pub load_with_base_url: Option<bool>,

    // ---- navigation -----------------------------------------------------
    /// Newline separated `name::url` entries. `{{page}}` marks the page slot.
    #[serde(rename = "sortUrl", default)]
    pub sort_url: String,

    // ---- list rules -----------------------------------------------------
    #[serde(rename = "ruleArticles", default)]
    pub rule_articles: String,
    #[serde(rename = "ruleTitle", default)]
    pub rule_title: String,
    #[serde(rename = "ruleLink", default)]
    pub rule_link: String,
    #[serde(rename = "ruleImage", default)]
    pub rule_image: String,
    #[serde(rename = "rulePubDate", default)]
    pub rule_pub_date: String,
    #[serde(rename = "ruleNextPage", default)]
    pub rule_next_page: String,
    #[serde(rename = "singleUrl", default)]
    pub single_url: bool,
    #[serde(rename = "articleStyle", default)]
    pub article_style: i64,
    #[serde(rename = "style", default)]
    pub style: String,

    // ---- content rules --------------------------------------------------
    #[serde(rename = "ruleContent", default)]
    pub rule_content: String,

    // ---- search ---------------------------------------------------------
    #[serde(rename = "searchUrl", default)]
    pub search_url: String,
    #[serde(rename = "ruleSearch", default)]
    pub rule_search: String,
    #[serde(rename = "ruleSearchList", default)]
    pub rule_search_list: String,
    #[serde(rename = "ruleSearchName", default)]
    pub rule_search_name: String,
    #[serde(rename = "ruleSearchLink", default)]
    pub rule_search_link: String,
    #[serde(rename = "ruleSearchCover", default)]
    pub rule_search_cover: String,

    // ---- scripting ------------------------------------------------------
    #[serde(rename = "enableJs", default)]
    pub enable_js: bool,
    #[serde(rename = "injectJs", default)]
    pub inject_js: String,

    /// Any fields we do not model, preserved so exports round-trip cleanly.
    #[serde(flatten, default, skip_serializing_if = "Map::is_empty")]
    pub extra: Map<String, Value>,
}

impl Source {
    /// Stable identity for dedup/merge across imports.
    pub fn key(&self) -> String {
        format!("{}|{}", self.source_name.trim(), self.source_url.trim())
    }

    pub fn display_name(&self) -> &str {
        if self.source_name.trim().is_empty() {
            &self.source_url
        } else {
            &self.source_name
        }
    }

    /// Parse one source, accepting both the modern and legacy RSS schemas.
    pub fn from_value(v: &Value) -> Result<Self, String> {
        let mut map: Map<String, Value> = match v {
            Value::Object(m) => m.clone(),
            _ => return Err("源条目不是 JSON 对象".into()),
        };

        // Normalize the legacy RSS schema onto the current field names.
        let legacy = [
            ("articleUrl", "ruleLink"),
            ("itemTitle", "ruleTitle"),
            ("itemContent", "ruleContent"),
            ("itemDescription", "ruleContent"),
            ("itemImage", "ruleImage"),
        ];
        for (old, new) in legacy {
            if !map.contains_key(new) {
                if let Some(val) = map.get(old) {
                    if !val.is_null() && !val.as_str().unwrap_or_default().is_empty() {
                        map.insert(new.to_string(), val.clone());
                    }
                }
            }
        }
        // Legacy sources describe their list page via articleUrl and have no
        // explicit list selector; the article URL *is* the list page.
        if !map.contains_key("ruleArticles") {
            let link = map
                .get("ruleLink")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            if link.is_empty() || link.contains("{{page}}") || link.contains("java.") || link.contains("<js>") {
                map.insert("ruleArticles".into(), Value::String("body".into()));
            }
        }

        serde_json::from_value(Value::Object(map)).map_err(|e| e.to_string())
    }

    /// Parse a whole collection file (array, or object wrapping an array).
    pub fn parse_collection(text: &str) -> Result<Vec<Source>, String> {
        let value: Value = serde_json::from_str(text)
            .map_err(|e| format!("不是合法的 JSON: {e}"))?;

        let items: Vec<Value> = match &value {
            Value::Array(a) => a.clone(),
            Value::Object(map) => {
                // Some exports wrap the list: {"data":[...]}, {"sources":[...]}
                let mut found = None;
                for key in ["data", "sources", "list", "items", "result"] {
                    if let Some(Value::Array(a)) = map.get(key) {
                        found = Some(a.clone());
                        break;
                    }
                }
                match found {
                    Some(a) => a,
                    None => return Err("找不到源数组（顶层既不是数组，也没有 data/sources/list 字段）".into()),
                }
            }
            _ => return Err("顶层结构既不是数组也不是对象".into()),
        };

        let mut out = Vec::with_capacity(items.len());
        let mut errors = Vec::new();
        for (i, item) in items.iter().enumerate() {
            match Source::from_value(item) {
                Ok(s) if !s.source_url.trim().is_empty() => out.push(s),
                Ok(_) => {}
                Err(e) => errors.push(format!("#{i}: {e}")),
            }
        }
        if out.is_empty() && !errors.is_empty() {
            return Err(format!("解析出 0 个可用源：{}", errors.join("; ")));
        }
        Ok(out)
    }

    /// Parse the declared request headers into (name, value) pairs.
    pub fn headers(&self) -> Vec<(String, String)> {
        let raw = self.header.trim();
        if raw.is_empty() {
            return Vec::new();
        }
        // Some sources write bare lines (`User-Agent: xxx`) instead of JSON.
        if !raw.starts_with('{') {
            return raw
                .lines()
                .filter_map(|l| {
                    let l = l.trim();
                    l.split_once(':').map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))
                })
                .filter(|(k, _)| !k.is_empty())
                .collect();
        }
        match serde_json::from_str::<Map<String, Value>>(raw) {
            Ok(m) => m
                .into_iter()
                .filter_map(|(k, v)| match v {
                    Value::String(s) => Some((k, s)),
                    Value::Number(n) => Some((k, n.to_string())),
                    Value::Bool(b) => Some((k, b.to_string())),
                    _ => None,
                })
                .collect(),
            Err(_) => Vec::new(),
        }
    }

    pub fn cookie_jar_enabled(&self) -> bool {
        self.enabled_cookie_jar.unwrap_or(true)
    }

    pub fn load_with_base_url(&self) -> bool {
        self.load_with_base_url.unwrap_or(true)
    }
}

/// One category tab parsed out of `sortUrl`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Category {
    pub name: String,
    pub url: String,
    /// Row index, so a multi-row `$$$` layout can be rendered as grouped tabs.
    #[serde(default)]
    pub row: usize,
    /// True when the URL carries a `{{page}}` slot.
    #[serde(default)]
    pub paged: bool,
}

/// Parse `sortUrl` into categories.
///
/// Supported shapes, matching Legado:
///   `名称::url`
///   `名称::url$$$名称2::url2`   (second tab row)
///   `名称::url{{page}}`
pub fn parse_sort_url(sort_url: &str) -> Vec<Category> {
    let mut out = Vec::new();
    for (row, line) in sort_url.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        for (col, cell) in line.split("$$$").enumerate() {
            let cell = cell.trim();
            if cell.is_empty() {
                continue;
            }
            // Prefer the LAST `::` so URLs containing `::` survive.
            let Some((name, url)) = cell.rsplit_once("::") else {
                continue;
            };
            let name = name.trim();
            let url = url.trim();
            if url.is_empty() {
                continue;
            }
            out.push(Category {
                name: if name.is_empty() { "默认".into() } else { name.to_string() },
                paged: url.contains("{{page}}"),
                url: url.to_string(),
                row: row * 100 + col,
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_modern_source() {
        let text = r#"{
          "sourceName": "PlayAV",
          "sourceUrl": "https://playav.tv/",
          "ruleArticles": "class.video-player@all",
          "ruleTitle": "img@alt",
          "ruleLink": "a@href",
          "sortUrl": "首页::https://playav.tv/page/{{page}}"
        }"#;
        let srcs = Source::parse_collection(&format!("[{text}]")).unwrap();
        assert_eq!(srcs.len(), 1);
        assert_eq!(srcs[0].source_name, "PlayAV");
        assert_eq!(parse_sort_url(&srcs[0].sort_url).len(), 1);
    }

    #[test]
    fn parses_legacy_rss_source() {
        let text = r#"[{
          "title": "老源", "sourceUrl": "https://a.com/",
          "articleUrl": "https://a.com/list?page={{page}}",
          "itemTitle": "a@title"
        }]"#;
        let srcs = Source::parse_collection(text).unwrap();
        assert_eq!(srcs[0].rule_title, "a@title");
        assert_eq!(srcs[0].rule_articles, "body");
    }

    #[test]
    fn sort_url_multiline_and_rows() {
        let cats = parse_sort_url("国产::https://a.com/1{{page}}\n欧美::https://a.com/2\n$$$福利::https://a.com/3");
        assert_eq!(cats.len(), 3);
        assert!(cats[0].paged);
        assert_eq!(cats[2].name, "福利");
    }

    #[test]
    fn headers_from_json_and_lines() {
        let s = Source { header: r#"{"User-Agent":"x","Referer":"y"}"#.into(), ..Default::default() };
        assert_eq!(s.headers().len(), 2);
        let s = Source { header: "User-Agent: x\nReferer: y".into(), ..Default::default() };
        assert_eq!(s.headers().len(), 2);
    }
}