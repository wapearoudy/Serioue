//! Rendering a page in an offscreen webview and reading the DOM back.
//!
//! Roughly 50 of the 52 reachable sources in a sample declare `enableJs` and
//! build their content in the browser, so a server-side parser cannot read
//! them at all. This is the only lever on that, and it works because
//! [`WebviewWindow::eval_with_callback`] hands the script's value back through
//! a Rust closure — plain `eval` returns `Result<(), Error>` and drops it.
//!
//! Used as a *fallback*: the ordinary fetch path runs first, and this only
//! happens when it produced nothing usable on a source that asks for
//! JavaScript. Offscreen windows are serialised, and each one costs a couple
//! of seconds, so it must never be the happy path.
//!
//! The `render_probe` command is the diagnostic used to establish that this
//! works at all; `render_html` is the one the engine calls.

use once_cell::sync::Lazy;
use serde::Serialize;
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, WebviewUrl, WebviewWindowBuilder};

/// How long a page gets to run its scripts.
const SETTLE: Duration = Duration::from_millis(2500);
/// Cap on the HTML we will hold in memory for one page.
const MAX_HTML: usize = 4 * 1024 * 1024;

/// Offscreen windows are serialised: one at a time, so they cannot fight over
/// the foreground, and a burst of sources cannot spawn a burst of windows.
static GATE: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

/// A fresh window label, so repeated renders never collide.
pub fn probe_label() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    N.fetch_add(1, Ordering::Relaxed)
}

#[derive(Debug, Clone, Serialize)]
pub struct RenderProbe {
    /// The window built and the page loaded.
    pub loaded: bool,
    /// Characters of rendered HTML recovered.
    pub html_len: usize,
    /// Document title after scripts ran — the cheapest sign that JS executed.
    pub title: String,
    /// How many anchor links the rendered document exposes.
    pub link_count: usize,
    /// What went wrong, if anything.
    pub error: Option<String>,
}

impl RenderProbe {
    fn failed(reason: impl Into<String>) -> Self {
        RenderProbe {
            loaded: false,
            html_len: 0,
            title: String::new(),
            link_count: 0,
            error: Some(reason.into()),
        }
    }
}

/// Render `url` and return its post-JavaScript HTML.
///
/// Blocking; callers should run it off the async runtime. Serialised behind
/// [`GATE`], so concurrent callers queue rather than opening windows together.
pub fn fetch_rendered(app: &AppHandle, url: &str) -> Result<String, String> {
    let parsed: tauri::Url = url
        .parse()
        .map_err(|e| format!("不是有效的地址: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!("不支持的地址格式: {}", parsed.scheme()));
    }

    let _gate = GATE.lock().unwrap_or_else(|e| e.into_inner());

    let window = WebviewWindowBuilder::new(
        app,
        format!("render-{}", probe_label()),
        WebviewUrl::External(parsed),
    )
    .visible(false)
    .inner_size(1280.0, 900.0)
    .build()
    .map_err(|e| format!("无法创建渲染窗口: {e}"))?;

    // Let the document and its scripts finish. A slow page is better than a
    // false negative, and this only runs when the cheap path already failed.
    std::thread::sleep(SETTLE);

    let html = read_from(&window, "document.documentElement.outerHTML || ''");
    let _ = window.destroy();

    if html.is_empty() {
        return Err("页面没有返回任何内容（加载失败或站点拒绝访问）".into());
    }
    if html.chars().count() > MAX_HTML {
        return Err("渲染结果过大，已放弃".into());
    }
    Ok(html)
}

/// Evaluate `js` in `window` and wait for its value to come back.
///
/// The value arrives **JSON-encoded**: a string result comes back quoted, with
/// `<` written as `<`. Handing that straight to an HTML parser silently
/// produces a page of nothing, so it is decoded here rather than at every
/// call site.
fn read_from(window: &tauri::WebviewWindow, js: &str) -> String {
    let (tx, rx) = mpsc::channel::<String>();
    if window.eval_with_callback(js, move |v| {
        let _ = tx.send(v);
    }).is_err() {
        return String::new();
    }
    let raw = rx.recv_timeout(Duration::from_secs(8)).unwrap_or_default();
    if raw.starts_with('"') {
        return serde_json::from_str::<String>(&raw).unwrap_or(raw);
    }
    raw
}

/// Diagnostics: render a page and report what came back, without the HTML.
pub fn probe_blocking(app: &AppHandle, url: &str) -> RenderProbe {
    let parsed: tauri::Url = match url.parse() {
        Ok(u) => u,
        Err(e) => return RenderProbe::failed(format!("not a url: {e}")),
    };

    let _gate = GATE.lock().unwrap_or_else(|e| e.into_inner());

    let window = match WebviewWindowBuilder::new(
        app,
        format!("render-{}", probe_label()),
        WebviewUrl::External(parsed),
    )
    .visible(false)
    .inner_size(1280.0, 900.0)
    .build()
    {
        Ok(w) => w,
        Err(e) => return RenderProbe::failed(format!("window build failed: {e}")),
    };

    std::thread::sleep(SETTLE);
    let html = read_from(&window, "document.documentElement.outerHTML || ''");
    let title = read_from(&window, "document.title || ''");
    let links = read_from(&window, "document.querySelectorAll('a[href]').length");
    let _ = window.destroy();

    if html.is_empty() {
        return RenderProbe::failed("the page returned no HTML (load failed, or the site blocked it)");
    }
    RenderProbe {
        loaded: true,
        html_len: html.chars().count(),
        title,
        link_count: links.parse().unwrap_or(0),
        error: None,
    }
}