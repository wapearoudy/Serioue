use once_cell::sync::Lazy;
use regex::Regex;
use std::hash::{DefaultHasher, Hash, Hasher};
use url::Url;

static META_CHARSET: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"(?i)<meta[^>]+charset=["']?\s*([a-z0-9_\-]+)"#).unwrap());
static META_REFRESH: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"(?i)<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["'][^"']*url=([^"'>]+)"#).unwrap());
static TITLE_TAG: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?is)<title[^>]*>(.*?)</title>").unwrap());
static TAG_STRIP: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?s)<[^>]*>").unwrap());
static WS: Lazy<Regex> = Lazy::new(|| Regex::new(r"[\s\u{00a0}]+").unwrap());

/// Collapse whitespace and drop zero-width characters.
pub fn clean_text(s: &str) -> String {
    let s = s.replace(['\u{200b}', '\u{feff}'], "");
    let mut out = String::with_capacity(s.len());
    let mut last_space = false;
    for ch in s.chars() {
        if ch.is_whitespace() || ch == '\u{00a0}' {
            if !last_space && !out.is_empty() {
                out.push(' ');
            }
            last_space = true;
        } else {
            out.push(ch);
            last_space = false;
        }
    }
    out.trim().to_string()
}

/// Plain text from an HTML fragment (tags removed, entities decoded).
pub fn html_to_text(html: &str) -> String {
    let with_breaks = html
        .replace("</p>", "\n")
        .replace("</div>", "\n")
        .replace("</li>", "\n")
        .replace("<br>", "\n")
        .replace("<br/>", "\n")
        .replace("<br />", "\n");
    let stripped = TAG_STRIP.replace_all(&with_breaks, " ");
    // Trim each line and drop blank ones so extracted text reads cleanly.
    decode_entities(&stripped)
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn decode_entities(s: &str) -> String {
    let mut out = s.to_string();
    for (pat, rep) in [
        ("&nbsp;", " "),
        ("&amp;", "&"),
        ("&lt;", "<"),
        ("&gt;", ">"),
        ("&quot;", "\""),
        ("&#39;", "'"),
        ("&apos;", "'"),
        ("&ldquo;", "\u{201c}"),
        ("&rdquo;", "\u{201d}"),
    ] {
        if out.contains(pat) {
            out = out.replace(pat, rep);
        }
    }
    // Numeric entities, decimal and hex.
    let numeric = Regex::new(r"&#(x?)([0-9a-fA-F]+);").unwrap();
    out = numeric
        .replace_all(&out, |c: &regex::Captures| {
            let hex = &c[1];
            let digits = &c[2];
            let code = u32::from_str_radix(digits, if hex.is_empty() { 10 } else { 16 }).unwrap_or(0xFFFD);
            char::from_u32(code).unwrap_or('\u{FFFD}').to_string()
        })
        .to_string();
    out
}

pub fn extract_title(html: &str) -> Option<String> {
    TITLE_TAG
        .captures(html).map(|c| clean_text(&decode_entities(&c[1])))
        .filter(|s| !s.is_empty())
}

/// Decode bytes into text, honouring the HTTP charset then a `<meta>` hint.
pub fn decode_body(bytes: &[u8], content_type_charset: Option<&str>) -> String {
    let mut encoding = None;
    if let Some(cs) = content_type_charset {
        if let Some(e) = encoding_rs::Encoding::for_label(cs.trim().as_bytes()) {
            encoding = Some(e);
        }
    }
    // The document may not be valid UTF-8, so sniff the head as Latin-1 (a
    // superset that never fails to decode) rather than as UTF-8.
    let head_len = bytes.len().min(2048);
    let head = String::from_utf8_lossy(&bytes[..head_len]).to_string();
    let sniffed = META_CHARSET.captures(&head).and_then(|c| {
        let label = c[1].trim();
        // Strip a trailing part such as `gb2312`.
        let label = label.split('-').next().unwrap_or(label);
        encoding_rs::Encoding::for_label(label.as_bytes())
    });
    let encoding = encoding.or(sniffed).unwrap_or(encoding_rs::UTF_8);

    let (text, _, _) = encoding.decode(bytes);
    text.into_owned()
}

/// Resolve `href` against `base`, tolerating protocol-relative and root paths.
pub fn absolute_url(href: &str, base: &str) -> String {
    let href = href.trim();
    if href.is_empty() {
        return String::new();
    }
    // `//host/path`
    if let Some(rest) = href.strip_prefix("//") {
        let scheme = Url::parse(base).map(|u| u.scheme().to_string()).unwrap_or_else(|_| "https".into());
        return format!("{scheme}://{rest}");
    }
    if href.starts_with("http://") || href.starts_with("https://") {
        return href.to_string();
    }
    match Url::parse(base) {
        Ok(b) => match b.join(href) {
            Ok(u) => u.to_string(),
            Err(_) => href.to_string(),
        },
        Err(_) => href.to_string(),
    }
}

/// A URL fragment carried by a `content` rule, e.g. `{{$.model.url}}`.
pub fn is_json_path(rule: &str) -> bool {
    let r = rule.trim();
    r.starts_with("$") || r.starts_with('@')
}

/// Short stable hash used for cache keys.
pub fn hash_key(parts: &[&str]) -> String {
    let mut h = DefaultHasher::new();
    for p in parts {
        p.hash(&mut h);
    }
    format!("{:016x}", h.finish())
}

/// Shorten a URL for display, keeping it recognizable.
pub fn short_url(url: &str, max: usize) -> String {
    let s = url.trim();
    if s.chars().count() <= max {
        return s.to_string();
    }
    let keep = max.saturating_sub(1) / 2;
    let head: String = s.chars().take(keep).collect();
    let tail: String = {
        let all: Vec<char> = s.chars().collect();
        all[all.len() - keep..].iter().collect()
    };
    format!("{head}…{tail}")
}

/// Collapse runs of whitespace without allocating a regex pass.
pub fn squeeze(s: &str) -> String {
    WS.replace_all(s, " ").trim().to_string()
}

/// A `<meta http-equiv="refresh">` target, for pages that redirect in markup.
pub fn meta_refresh(html: &str) -> Option<String> {
    META_REFRESH
        .captures(html).map(|c| c[1].trim().to_string())
        .filter(|u| !u.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_urls() {
        assert_eq!(absolute_url("/a/b", "https://x.com/c/d"), "https://x.com/a/b");
        assert_eq!(absolute_url("e.html", "https://x.com/c/d"), "https://x.com/c/e.html");
        assert_eq!(absolute_url("//y.com/z", "https://x.com/"), "https://y.com/z");
        assert_eq!(absolute_url("https://q.com", "https://x.com/"), "https://q.com");
    }

    #[test]
    fn decodes_charset_hint() {
        // `<p>你好</p>` encoded as GBK, so the `<meta charset>` sniff has to run.
        let mut bytes = Vec::from(&b"<meta charset=\"gbk\"><p>"[..]);
        bytes.extend_from_slice(&[0xc4, 0xe3, 0xba, 0xc3]); // 你好 in GBK
        bytes.extend_from_slice(b"</p>");
        let decoded = decode_body(&bytes, None);
        assert!(decoded.contains("你好"), "got {decoded:?}");
    }

    #[test]
    fn strips_html() {
        let text = html_to_text("<p>a<b>bold</b></p><p>c</p>");
        assert_eq!(text.replace('\n', "|"), "a bold|c");
    }

    #[test]
    fn entities() {
        assert_eq!(decode_entities("a&amp;b&#39;c&#x4e2d;"), "a&b'c中");
    }
}