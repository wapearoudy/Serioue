use crate::model::Source;
use once_cell::sync::Lazy;
use reqwest::blocking::Client;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, ACCEPT, ACCEPT_LANGUAGE, USER_AGENT};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

static CLIENT: Lazy<Client> = Lazy::new(|| {
    Client::builder()
        .danger_accept_invalid_certs(true)
        .danger_accept_invalid_hostnames(true)
        .timeout(Duration::from_secs(30))
        .connect_timeout(Duration::from_secs(15))
        .build()
        .expect("failed to build http client")
});

/// Cookie jars keyed by source, stored as `name=value` strings.
///
/// reqwest's blocking client does not expose a pluggable cookie provider, so we
/// manage the `Cookie` header and parse `Set-Cookie` ourselves. This keeps
/// sessions per-source without leaking cookies between unrelated sources.
static JARS: Lazy<Mutex<HashMap<String, Vec<String>>>> = Lazy::new(|| Mutex::new(HashMap::new()));

pub struct Response {
    pub url: String,
    pub body: String,
    pub status: u16,
    pub content_type: String,
}

fn jar_get(key: &str) -> Vec<String> {
    JARS.lock().map(|j| j.get(key).cloned().unwrap_or_default()).unwrap_or_default()
}

fn jar_set(key: &str, cookies: Vec<String>) {
    if let Ok(mut j) = JARS.lock() {
        // Bound growth; a source rarely needs more than a few dozen cookies.
        let mut list = cookies;
        if list.len() > 64 {
            let extra = list.len() - 64;
            list.drain(0..extra);
        }
        j.insert(key.to_string(), list);
    }
}

pub fn clear_cookies() {
    if let Ok(mut j) = JARS.lock() {
        j.clear();
    }
}

/// Fold a `Set-Cookie` header value into a `name=value` pair.
fn parse_set_cookie(set_cookie: &str) -> Option<String> {
    let first = set_cookie.split(';').next()?;
    let (name, value) = first.split_once('=')?;
    let name = name.trim();
    let value = value.trim();
    if name.is_empty() {
        return None;
    }
    // An expired cookie removes the entry.
    if set_cookie.to_lowercase().contains("max-age=0") {
        return Some(format!("\u{0}{name}"));
    }
    Some(format!("{name}={value}"))
}

/// Fetch a URL using the source's declared headers and cookie jar.
pub fn fetch(source: Option<&Source>, url: &str) -> crate::error::AppResult<Response> {
    let mut headers = HeaderMap::new();
    headers.insert(
        USER_AGENT,
        HeaderValue::from_static(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
             (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
        ),
    );
    headers.insert(
        ACCEPT,
        HeaderValue::from_static("text/html,application/xhtml+xml,application/json,application/xml,*/*;q=0.8"),
    );
    headers.insert(ACCEPT_LANGUAGE, HeaderValue::from_static("zh-CN,zh;q=0.9,en;q=0.8"));

    let source_key = source.map(|s| s.key()).unwrap_or_default();
    let mut declared_cookie: Option<String> = None;

    if let Some(src) = source {
        for (name, value) in src.headers() {
            if name.eq_ignore_ascii_case("cookie") {
                declared_cookie = Some(value);
                continue;
            }
            if let (Ok(n), Ok(v)) = (HeaderName::from_bytes(name.as_bytes()), HeaderValue::from_str(&value)) {
                headers.insert(n, v);
            }
        }
    }

    // Merge the declared cookie with anything the jar has collected.
    let mut cookie_pairs: Vec<String> = Vec::new();
    if let Some(c) = declared_cookie {
        cookie_pairs.extend(
            c.split(';')
                .map(|p| p.trim().to_string())
                .filter(|p| !p.is_empty()),
        );
    }
    if let Some(src) = source {
        if src.cookie_jar_enabled() {
            for pair in jar_get(&source_key) {
                if !pair.starts_with('\u{0}') && !cookie_pairs.contains(&pair) {
                    cookie_pairs.push(pair);
                }
            }
        }
    }
    if !cookie_pairs.is_empty() {
        if let Ok(v) = HeaderValue::from_str(&cookie_pairs.join("; ")) {
            headers.insert(reqwest::header::COOKIE, v);
        }
    }

    let resp = CLIENT
        .get(url)
        .headers(headers)
        .send()
        .map_err(|e| crate::error::AppError::Network(e.to_string()))?;

    let status = resp.status().as_u16();
    let final_url = resp.url().to_string();
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();

    // Persist refreshed cookies.
    if let Some(src) = source {
        if src.cookie_jar_enabled() {
            let mut jar = jar_get(&source_key);
            for value in resp.headers().get_all(reqwest::header::SET_COOKIE).iter() {
                if let Ok(s) = value.to_str() {
                    if let Some(pair) = parse_set_cookie(s) {
                        let name = pair.split('=').next().unwrap_or_default().trim().to_string();
                        if let Some(name) = name.strip_prefix('\u{0}') {
                            jar.retain(|p| !p.starts_with(&format!("{name}=")));
                        } else {
                            jar.retain(|p| !p.starts_with(&format!("{name}=")));
                            jar.push(pair);
                        }
                    }
                }
            }
            jar_set(&source_key, jar);
        }
    }

    let bytes = resp
        .bytes()
        .map_err(|e| crate::error::AppError::Network(e.to_string()))?;

    let charset = content_type
        .split(';')
        .find_map(|p| p.trim().strip_prefix("charset=").map(|s| s.trim().trim_matches('"')));
    let body = crate::util::decode_body(&bytes, charset);

    Ok(Response { url: final_url, body, status, content_type })
}

/// Fetch and require a 2xx status.
pub fn fetch_ok(source: Option<&Source>, url: &str) -> crate::error::AppResult<Response> {
    let r = fetch(source, url)?;
    if !(200..300).contains(&r.status) {
        return Err(crate::error::AppError::Http(format!("HTTP {}", r.status)));
    }
    Ok(r)
}