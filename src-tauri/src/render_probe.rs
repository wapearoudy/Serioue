//! A spike: can a rendered DOM be read back out of a webview?
//!
//! The audit says roughly 50 of 52 reachable sources declare `enableJs`, and
//! only one of them works without a browser engine. That makes "render the
//! page and hand the DOM back to the Rust parser" the only remaining lever for
//! source coverage — but only if Tauri can actually return rendered HTML.
//!
//! The obvious approach does not work: `WebviewWindow::eval` returns
//! `Result<(), Error>` and throws away the script's value.
//! [`WebviewWindow::eval_with_callback`] is the one that hands the result back
//! through a Rust closure.
//!
//! This is deliberately a measurement, not a feature. It builds an offscreen
//! window, loads a URL, and reports what came back. If the answer were no,
//! nobody would have to spend a day building the real thing.
//!
//! Not wired into the interface: only the native smoke test calls it.

use once_cell::sync::Lazy;
use serde::Serialize;
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, WebviewUrl, WebviewWindowBuilder};

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

/// Offscreen windows are serialised: one at a time, so they cannot fight over
/// the foreground.
static GATE: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

/// A fresh window label, so repeated probes never collide.
pub fn probe_label() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    N.fetch_add(1, Ordering::Relaxed)
}

/// Load `url` in an offscreen window and read the rendered DOM back.
///
/// Blocks the calling thread for a few seconds; the command wrapper runs it on
/// a worker thread.
pub fn probe_blocking(app: &AppHandle, url: &str) -> RenderProbe {
    let parsed: tauri::Url = match url.parse() {
        Ok(u) => u,
        Err(e) => return RenderProbe::failed(format!("not a url: {e}")),
    };

    let _gate = GATE.lock().unwrap_or_else(|e| e.into_inner());

    let window = match WebviewWindowBuilder::new(
        app,
        format!("probe-{}", probe_label()),
        WebviewUrl::External(parsed),
    )
    .visible(false)
    .inner_size(1280.0, 900.0)
    .build()
    {
        Ok(w) => w,
        Err(e) => return RenderProbe::failed(format!("window build failed: {e}")),
    };

    // Give the document and its scripts a moment. A slow page is better than a
    // false negative, and the audit runs off the critical path.
    std::thread::sleep(Duration::from_millis(2500));

    let html_rx = mpsc::channel::<String>();
    let title_rx = mpsc::channel::<String>();
    let links_rx = mpsc::channel::<String>();

    let html_tx = html_rx.0.clone();
    if window
        .eval_with_callback(
            "document.documentElement.outerHTML || ''",
            move |v| {
                let _ = html_tx.send(v);
            },
        )
        .is_err()
    {
        let _ = window.destroy();
        return RenderProbe::failed("eval_with_callback was refused");
    }

    let title_tx = title_rx.0.clone();
    let _ = window.eval_with_callback("document.title || ''", move |v| {
        let _ = title_tx.send(v);
    });
    let links_tx = links_rx.0.clone();
    let _ = window.eval_with_callback("document.querySelectorAll('a[href]').length", move |v| {
        let _ = links_tx.send(v);
    });

    let html = html_rx.1.recv_timeout(Duration::from_secs(8)).unwrap_or_default();
    let title = title_rx.1.recv_timeout(Duration::from_secs(4)).unwrap_or_default();
    let links = links_rx.1.recv_timeout(Duration::from_secs(4)).unwrap_or_default();
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