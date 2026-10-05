use crate::engine::browse::{self, ArticlePage, PageRequest};
use crate::engine::verify::{self, Target};
use crate::error::{AppError, AppResult};
use crate::model::{Category, Source};
use crate::repo;
use crate::store::{Collection, Health, HistoryEntry, Settings, SourcePatch, StoredSource, Store};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{Emitter, Manager, State};

pub struct AppState {
    pub store: Arc<Store>,
    /// Set by `cancel_check`; the batch worker pool polls it between stages.
    pub cancel: Arc<AtomicBool>,
}

/// Handle for the source JSON the user dragged onto the window.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportResult {
    pub added: usize,
    pub skipped: usize,
    pub collection: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SourceSummary {
    pub id: String,
    pub name: String,
    pub url: String,
    pub group: String,
    pub enabled: bool,
    pub favorite: bool,
    pub collection: String,
    pub health: Option<Health>,
    pub note: String,
    pub category_count: usize,
    pub has_search: bool,
    pub js_enabled: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct CategoriesResponse {
    pub source: SourceSummary,
    pub categories: Vec<Category>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ArticleResponse {
    pub title: String,
    pub html: String,
    pub text: String,
    pub final_url: String,
    pub media: Vec<String>,
    /// Audio files on the page, for the music player.
    pub audio: Vec<String>,
}

fn summary(stored: &StoredSource) -> SourceSummary {
    SourceSummary {
        id: stored.id.clone(),
        name: stored.source.display_name().to_string(),
        url: stored.source.source_url.clone(),
        group: stored.source.source_group.clone(),
        enabled: stored.enabled,
        favorite: stored.favorite,
        collection: stored.collection.clone(),
        health: stored.health.clone(),
        note: stored.note.clone(),
        category_count: browse::categories(&stored.source).len(),
        has_search: !stored.source.search_url.trim().is_empty(),
        js_enabled: stored.source.enable_js,
    }
}

/// Run a blocking closure on a worker thread so the UI never stalls.
async fn blocking<T, F>(f: F) -> AppResult<T>
where
    F: FnOnce() -> AppResult<T> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| AppError::other(format!("task failed: {e}")))?
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn list_sources(
    state: State<'_, AppState>,
    filter: Option<String>,
) -> AppResult<Vec<SourceSummary>> {
    let store = state.store.clone();
    blocking(move || {
        let needle = filter.unwrap_or_default().trim().to_lowercase();
        Ok(store
            .sources()
            .iter()
            .filter(|s| {
                if needle.is_empty() {
                    return true;
                }
                let s = &s.source;
                s.display_name().to_lowercase().contains(&needle)
                    || s.source_url.to_lowercase().contains(&needle)
                    || s.source_group.to_lowercase().contains(&needle)
            })
            .map(summary)
            .collect())
    })
    .await
}

#[tauri::command]
pub async fn get_source(state: State<'_, AppState>, id: String) -> AppResult<SourceSummary> {
    let store = state.store.clone();
    blocking(move || {
        let s = store.source(&id).ok_or_else(|| AppError::NotFound(id.clone()))?;
        Ok(summary(&s))
    })
    .await
}

#[tauri::command]
pub async fn source_detail(state: State<'_, AppState>, id: String) -> AppResult<Source> {
    let store = state.store.clone();
    blocking(move || {
        store
            .source(&id)
            .map(|s| s.source)
            .ok_or(AppError::NotFound(id))
    })
    .await
}

#[tauri::command]
pub async fn update_source(
    state: State<'_, AppState>,
    id: String,
    patch: SourcePatch,
) -> AppResult<()> {
    let store = state.store.clone();
    blocking(move || store.update_source(&id, patch)).await
}

#[tauri::command]
pub async fn remove_sources(state: State<'_, AppState>, ids: Vec<String>) -> AppResult<usize> {
    let store = state.store.clone();
    blocking(move || store.remove_sources(&ids)).await
}

/// Import a collection from a JSON URL (the repository's download link).
#[tauri::command]
pub async fn import_from_url(
    state: State<'_, AppState>,
    url: String,
    name: Option<String>,
) -> AppResult<ImportResult> {
    let store = state.store.clone();
    blocking(move || {
        let sources = repo::fetch_collection(&url)?;
        let count = sources.len();
        let collection_name = name.unwrap_or_else(|| "手动导入".to_string());
        let (added, skipped) = store.add_sources(sources, &collection_name)?;
        store.add_collection(Collection {
            name: collection_name.clone(),
            url: url.clone(),
            source_url: String::new(),
            author: String::new(),
            count,
            added_at: chrono::Utc::now().timestamp(),
        })?;
        Ok(ImportResult { added, skipped, collection: collection_name })
    })
    .await
}

/// Import sources from raw JSON text (drag & drop, paste, local file).
#[tauri::command]
pub async fn import_from_text(
    state: State<'_, AppState>,
    text: String,
    name: Option<String>,
) -> AppResult<ImportResult> {
    let store = state.store.clone();
    blocking(move || {
        let sources = Source::parse_collection(&text).map_err(AppError::Import)?;
        let count = sources.len();
        let collection_name = name.unwrap_or_else(|| "手动导入".to_string());
        let (added, skipped) = store.add_sources(sources, &collection_name)?;
        store.add_collection(Collection {
            name: collection_name.clone(),
            url: format!("local:{}", collection_name),
            source_url: String::new(),
            author: String::new(),
            count,
            added_at: chrono::Utc::now().timestamp(),
        })?;
        Ok(ImportResult { added, skipped, collection: collection_name })
    })
    .await
}

// ---------------------------------------------------------------------------
// Repository browsing
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn repo_base(state: State<'_, AppState>) -> AppResult<String> {
    Ok(state.store.settings().repo_base)
}

#[tauri::command]
pub async fn repo_index(
    state: State<'_, AppState>,
    page: Option<u32>,
) -> AppResult<Vec<repo::RepoCollection>> {
    let base = state.store.settings().repo_base;
    blocking(move || repo::fetch_index(&base, page.unwrap_or(1))).await
}

// ---------------------------------------------------------------------------
// Browsing
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn categories(
    state: State<'_, AppState>,
    id: String,
) -> AppResult<CategoriesResponse> {
    let store = state.store.clone();
    blocking(move || {
        let stored = store
            .source(&id)
            .ok_or_else(|| AppError::NotFound(id.clone()))?;
        Ok(CategoriesResponse {
            source: summary(&stored),
            categories: browse::categories(&stored.source),
        })
    })
    .await
}

#[derive(Debug, Clone, Deserialize)]
pub struct LoadPageArgs {
    pub id: String,
    /// Category URL template; falls back to the source URL when empty.
    pub url: Option<String>,
    pub page: Option<u32>,
    pub next: Option<String>,
}

#[tauri::command]
pub async fn load_page(
    state: State<'_, AppState>,
    args: LoadPageArgs,
    app: tauri::AppHandle,
) -> AppResult<ArticlePage> {
    let store = state.store.clone();
    let result = blocking(move || {
        let stored = store
            .source(&args.id)
            .ok_or_else(|| AppError::NotFound(args.id.clone()))?;
        let template = args
            .url
            .filter(|u| !u.trim().is_empty())
            .unwrap_or_else(|| stored.source.source_url.clone());
        let req = PageRequest {
            url_template: template,
            page: args.page.unwrap_or(1),
            next_url: args.next,
        };
        browse::load_page(&stored.source, &req)
    })
    .await?;

    let _ = app.emit("page-loaded", &result);
    Ok(result)
}

/// Reject a link before it reaches the HTTP client.
///
/// reqwest's "builder error" says nothing useful to a reader. Sources do carry
/// links the client cannot use, and the report should name the problem.
fn check_url(raw: &str) -> AppResult<()> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(AppError::other("没有可打开的地址"));
    }
    match url::Url::parse(trimmed) {
        Ok(u) if matches!(u.scheme(), "http" | "https") => Ok(()),
        Ok(u) if u.scheme() == "file" => Ok(()),
        Ok(u) => Err(AppError::other(format!("不支持的链接格式：{}", u.scheme()))),
        Err(_) => Err(AppError::other(format!(
            "地址格式有误：{}",
            trimmed.chars().take(80).collect::<String>()
        ))),
    }
}

#[tauri::command]
pub async fn load_article(
    state: State<'_, AppState>,
    id: String,
    url: String,
    title: Option<String>,
) -> AppResult<ArticleResponse> {
    let store = state.store.clone();
    let content = blocking(move || {
        let stored = store
            .source(&id)
            .ok_or_else(|| AppError::NotFound(id.clone()))?;
        let target = crate::util::absolute_url(url.trim(), &stored.source.source_url);
        check_url(&target)?;
        let content = browse::load_article(&stored.source, &target)?;
        store.push_history(HistoryEntry {
            id: String::new(),
            source_id: id.clone(),
            title: title.clone().unwrap_or_else(|| content.title.clone()),
            url: url.clone(),
            source_name: stored.source.display_name().to_string(),
            viewed_at: chrono::Utc::now().timestamp(),
        })?;
        Ok(content)
    })
    .await?;

    Ok(ArticleResponse {
        title: content.title,
        html: content.html,
        text: content.text,
        final_url: content.final_url,
        media: content.media,
        audio: content.audio,
    })
}

/// Search within a source using its `searchUrl`, falling back to a plain
/// keyword request against the site's search path.
#[tauri::command]
pub async fn search_source(
    state: State<'_, AppState>,
    id: String,
    keyword: String,
) -> AppResult<ArticlePage> {
    let store = state.store.clone();
    blocking(move || {
        let stored = store
            .source(&id)
            .ok_or_else(|| AppError::NotFound(id.clone()))?;
        let src = &stored.source;

        if !src.search_url.trim().is_empty() {
            let url = browse::expand(&src.search_url.replace("{{keyWord}}", &keyword), 1);
            let url = crate::util::absolute_url(url.trim(), &src.source_url);
            let resp = crate::engine::fetch::fetch_ok(Some(src), &url)?;
            let (items, next) = browse::parse_list(src, &resp.body, &resp.url);
            return Ok(ArticlePage { items, next, final_url: resp.url });
        }

        // Fallback: a query on the source's own domain.
        let base = url::Url::parse(&src.source_url)
            .map_err(|e| AppError::other(format!("源地址无效: {e}")))?;
        let mut joined = base.join("search").map_err(|e| AppError::other(e.to_string()))?;
        joined
            .query_pairs_mut()
            .append_pair("keyword", &keyword)
            .append_pair("wd", &keyword);
        let url = joined.to_string();
        let resp = crate::engine::fetch::fetch_ok(Some(src), &url)?;
        let (items, next) = browse::parse_list(src, &resp.body, &resp.url);
        Ok(ArticlePage { items, next, final_url: resp.url })
    })
    .await
}

// ---------------------------------------------------------------------------
// Source verification
// ---------------------------------------------------------------------------

/// Verify one source: rule, homepage, list, detail, search.
///
/// The result is persisted so the sidebar dot reflects it, and returned so the
/// caller can show the full stage report immediately.
#[tauri::command]
pub async fn check_source(state: State<'_, AppState>, id: String) -> AppResult<Health> {
    let store = state.store.clone();
    let health = blocking(move || {
        let stored = store.source(&id).ok_or_else(|| AppError::NotFound(id.clone()))?;
        let health = verify::verify(&stored.source, None);
        store.set_health(&id, health.clone())?;
        Ok(health)
    })
    .await?;
    Ok(health)
}

#[derive(Debug, Clone, Serialize)]
pub struct CheckEvent {
    pub done: usize,
    pub total: usize,
    pub current: String,
    pub source_id: String,
    pub name: String,
    pub health: Health,
}

#[derive(Debug, Clone, Serialize)]
pub struct CheckSummary {
    pub total: usize,
    pub ok: usize,
    pub warn: usize,
    pub failed: usize,
    pub cancelled: bool,
}

/// Which sources a batch run should cover.
fn in_scope(stored: &StoredSource, scope: &str, now: i64) -> bool {
    match scope {
        // Re-check everything that did not come out clean, warnings included.
        "failed" => stored.health.as_ref().map(|h| !h.ok).unwrap_or(false),
        // Never checked.
        "unchecked" => stored.health.is_none(),
        // Healthy, but the last check is old enough to be worth repeating.
        "stale" => match &stored.health {
            Some(h) => !h.ok || now - h.checked_at > STALE_AFTER_SECONDS,
            None => true,
        },
        _ => true,
    }
}

/// A successful check older than this is offered for re-checking.
const STALE_AFTER_SECONDS: i64 = 3 * 24 * 3600;

/// How many completed results to buffer before writing `sources.json`.
const FLUSH_EVERY: usize = 8;

/// Verify many sources on a worker pool, streaming each result to the UI.
///
/// `scope` narrows the run to `"all"`, `"failed"`, `"unchecked"` or `"stale"`;
/// `ids`, when given, narrows it further.
#[tauri::command]
pub async fn check_all(
    state: State<'_, AppState>,
    ids: Option<Vec<String>>,
    scope: Option<String>,
    app: tauri::AppHandle,
) -> AppResult<CheckSummary> {
    let store = state.store.clone();
    let scope = scope.unwrap_or_else(|| "all".to_string());
    let settings_concurrent = store.settings().concurrent_checks;

    let store_for_list = store.clone();
    let targets: Vec<Target> = blocking(move || {
        let now = chrono::Utc::now().timestamp();
        let all = store_for_list.sources();
        Ok(all
            .into_iter()
            .filter(|s| ids.as_ref().map(|l| l.contains(&s.id)).unwrap_or(true))
            .filter(|s| in_scope(s, &scope, now))
            .map(|s| Target { id: s.id, name: s.source.display_name().to_string(), source: s.source })
            .collect())
    })
    .await?;

    let total = targets.len();
    let cancel = state.cancel.clone();
    cancel.store(false, Ordering::Relaxed);

    let workers = if settings_concurrent { 6 } else { 1 };

    // `verify_many` spawns its own worker pool and runs `sink` on this
    // blocking-pool thread, so persisting and emitting stay in one place.
    let outcome = blocking(move || {
        let mut batch: Vec<(String, Health)> = Vec::with_capacity(FLUSH_EVERY);
        let mut done = 0usize;
        let outcome = verify::verify_many(targets, workers, &cancel, |target, health| {
            done += 1;
            let _ = app.emit(
                "check-progress",
                CheckEvent {
                    done,
                    total,
                    current: target.name.clone(),
                    source_id: target.id.clone(),
                    name: target.name.clone(),
                    health: health.clone(),
                },
            );
            batch.push((target.id.clone(), health));
            if batch.len() >= FLUSH_EVERY {
                let _ = store.set_health_batch(&batch);
                batch.clear();
            }
        });
        let _ = store.set_health_batch(&batch);
        Ok::<_, AppError>(outcome)
    })
    .await?;

    Ok(CheckSummary {
        total: outcome.total,
        ok: outcome.ok,
        warn: outcome.warn,
        failed: outcome.failed,
        cancelled: outcome.cancelled,
    })
}

/// Ask a running `check_all` to stop after the sources in flight.
#[tauri::command]
pub async fn cancel_check(state: State<'_, AppState>) -> AppResult<()> {
    state.cancel.store(true, Ordering::Relaxed);
    Ok(())
}

// ---------------------------------------------------------------------------
// Library: history, collections, settings, cache
// ---------------------------------------------------------------------------

/// Render a page in an offscreen webview and return its post-JavaScript HTML.
///
/// The engine calls this only as a fallback, when an ordinary fetch of a
/// script-built source produced nothing. It is exposed as a command so the
/// frontend can show what the fallback would have found.
#[tauri::command]
pub async fn render_html(app: tauri::AppHandle, url: String) -> AppResult<String> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(crate::render_probe::fetch_rendered(&app, &url));
    });
    match rx.recv_timeout(std::time::Duration::from_secs(40)) {
        Ok(Ok(html)) => Ok(html),
        Ok(Err(e)) => Err(AppError::other(e)),
        Err(e) => Err(AppError::other(format!("渲染超时: {e}"))),
    }
}

/// Measure whether a rendered DOM can be read back from an offscreen webview.
///
/// This exists to settle a design question with a number rather than an
/// opinion: roughly 50 of 52 reachable sources declare `enableJs`, so the only
/// remaining lever on source coverage is rendering the page. It is not part of
/// the product surface and only the native smoke test calls it.
#[tauri::command]
pub async fn render_probe(
    app: tauri::AppHandle,
    url: String,
) -> crate::render_probe::RenderProbe {
    // Window creation is synchronous and main-thread-bound, so it moves off
    // the async runtime.
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(crate::render_probe::probe_blocking(&app, &url));
    });
    rx.recv_timeout(std::time::Duration::from_secs(40))
        .unwrap_or_else(|e| crate::render_probe::RenderProbe {
            loaded: false,
            html_len: 0,
            title: String::new(),
            link_count: 0,
            error: Some(format!("probe timed out: {e}")),
        })
}

/// Fetch a small text file the webview cannot fetch for itself.
///
/// A `.lrc` lives on the same host as the music, which sends no CORS headers, so
/// `fetch` from the app origin is blocked. The backend already has a client
/// carrying the right user agent and cookie jar, so it does the work.
#[tauri::command]
pub async fn fetch_text(url: String) -> AppResult<String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(AppError::other("地址必须是 http(s) 链接"));
    }
    blocking(move || Ok(crate::engine::fetch::fetch(None, &url)?.body)).await
}

#[tauri::command]
pub async fn list_history(state: State<'_, AppState>, limit: Option<usize>) -> AppResult<Vec<HistoryEntry>> {
    let store = state.store.clone();
    blocking(move || Ok(store.history(limit.unwrap_or(100)))).await
}

#[tauri::command]
pub async fn clear_history(state: State<'_, AppState>) -> AppResult<()> {
    let store = state.store.clone();
    blocking(move || store.clear_history()).await
}

/// How far through an article the reader had got.
#[tauri::command]
pub async fn get_progress(state: State<'_, AppState>, url: String) -> AppResult<f32> {
    Ok(state.store.progress(&url).unwrap_or(0.0))
}

/// Reading positions for several articles at once.
///
/// The contents drawer asks for the whole chapter list in one go; one IPC call
/// per chapter would be silly.
#[tauri::command]
pub async fn get_progress_many(
    state: State<'_, AppState>,
    urls: Vec<String>,
) -> AppResult<std::collections::HashMap<String, f32>> {
    let store = state.store.clone();
    blocking(move || {
        let mut out = std::collections::HashMap::with_capacity(urls.len());
        for url in urls {
            if let Some(p) = store.progress(&url) {
                out.insert(url, p);
            }
        }
        Ok(out)
    })
    .await
}

/// Remember a reading position so reopening the article resumes there.
#[tauri::command]
pub async fn save_progress(state: State<'_, AppState>, url: String, ratio: f32) -> AppResult<()> {
    let store = state.store.clone();
    blocking(move || store.set_progress(&url, ratio)).await
}

/// A half-read article the user can pick up again.
#[derive(Debug, Clone, Serialize)]
pub struct ContinueEntry {
    pub url: String,
    pub title: String,
    pub source_id: String,
    pub source_name: String,
    pub viewed_at: i64,
    /// 0.0-1.0 of the way through.
    pub progress: f32,
}

/// Articles that were started but not finished, newest first.
///
/// Without this the only way back to yesterday's article is the history list,
/// which is where a reader looks least often.
#[tauri::command]
pub async fn continue_reading(state: State<'_, AppState>) -> AppResult<Vec<ContinueEntry>> {
    let store = state.store.clone();
    blocking(move || {
        let history = store.history(200);
        // The thresholds live in one place so they can be tested directly.
        let positions: std::collections::HashMap<String, f32> =
            crate::store::resumable(&history, &|url| store.progress(url))
                .into_iter()
                .collect();
        Ok(history
            .into_iter()
            .filter_map(|h| {
                let progress = *positions.get(&h.url)?;
                Some(ContinueEntry {
                    url: h.url,
                    title: h.title,
                    source_id: h.source_id,
                    source_name: h.source_name,
                    viewed_at: h.viewed_at,
                    progress,
                })
            })
            .take(5)
            .collect())
    })
    .await
}

#[tauri::command]
pub async fn list_collections(state: State<'_, AppState>) -> AppResult<Vec<Collection>> {
    let store = state.store.clone();
    blocking(move || Ok(store.collections())).await
}

#[tauri::command]
pub async fn remove_collection(state: State<'_, AppState>, url: String) -> AppResult<()> {
    let store = state.store.clone();
    blocking(move || store.remove_collection(&url)).await
}

#[tauri::command]
pub async fn get_settings(state: State<'_, AppState>) -> AppResult<Settings> {
    Ok(state.store.settings())
}

#[tauri::command]
pub async fn set_settings(state: State<'_, AppState>, settings: Settings) -> AppResult<()> {
    let store = state.store.clone();
    let settings = validate_settings(settings)?;
    // The engine reads the render switch from a global, not from the store.
    crate::engine::browse::set_render_enabled(settings.render_js);
    blocking(move || store.set_settings(settings)).await
}

/// Clamp reader preferences to a range the UI can actually render.
///
/// Settings arrive from a text field or a slider, so they are treated as
/// untrusted input rather than trusted configuration.
fn validate_settings(mut s: Settings) -> AppResult<Settings> {
    s.reader_font_size = s.reader_font_size.clamp(13, 30);
    s.reader_line_height = s.reader_line_height.clamp(120, 240);
    s.reader_width = s.reader_width.min(1200);
    if !s.player_volume.is_finite() {
        s.player_volume = 0.8;
    }
    s.player_volume = s.player_volume.clamp(0.0, 1.0);
    if !s.player_rate.is_finite() {
        s.player_rate = 1.0;
    }
    s.player_rate = s.player_rate.clamp(0.5, 3.0);
    if !matches!(s.reader_theme.as_str(), "dark" | "light" | "sepia" | "green") {
        s.reader_theme = "dark".to_string();
    }
    if !matches!(s.reader_font.as_str(), "" | "serif" | "sans") {
        s.reader_font = String::new();
    }
    s.page_size = s.page_size.clamp(10, 300);
    Ok(s)
}

#[tauri::command]
pub async fn clear_cache(state: State<'_, AppState>) -> AppResult<usize> {
    let store = state.store.clone();
    blocking(move || store.cache_clear()).await
}

#[tauri::command]
pub async fn clear_cookies() -> AppResult<()> {
    crate::engine::fetch::clear_cookies();
    crate::engine::js::clear_cache();
    Ok(())
}

#[tauri::command]
pub async fn stats(state: State<'_, AppState>) -> AppResult<serde_json::Value> {
    let store = state.store.clone();
    blocking(move || {
        let sources = store.sources();
        let checked: Vec<&Health> = sources.iter().filter_map(|s| s.health.as_ref()).collect();
        Ok(serde_json::json!({
            "sources": sources.len(),
            "enabled": sources.iter().filter(|s| s.enabled).count(),
            "favorites": sources.iter().filter(|s| s.favorite).count(),
            "collections": store.collections().len(),
            "history": store.history(1000).len(),
            "checked": checked.len(),
            "working": checked.iter().filter(|h| h.ok).count(),
        }))
    })
    .await
}

/// The directory holding sources, history and the cache.
#[tauri::command]
pub async fn data_dir(app: tauri::AppHandle) -> AppResult<String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::other(e.to_string()))?;
    Ok(dir.to_string_lossy().to_string())
}

/// Resolve where the store lives so `run()` can open it.
///
/// Honours `SERIOUS_DATA_DIR` so the app can be pointed at a scratch
/// directory on machines where the user profile is not writable.
pub fn store_dir(app: &tauri::AppHandle) -> AppResult<PathBuf> {
    if let Ok(custom) = std::env::var("SERIOUS_DATA_DIR") {
        if !custom.trim().is_empty() {
            return Ok(PathBuf::from(custom));
        }
    }
    app.path()
        .app_data_dir()
        .map_err(|e| AppError::other(e.to_string()))
}

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn check_update(app: tauri::AppHandle) -> crate::update::UpdateInfo {
    crate::update::check(&app).await.unwrap_or_else(|e| crate::update::UpdateInfo {
        available: false,
        version: String::new(),
        current_version: app.package_info().version.to_string(),
        date: None,
        // The marker tells the frontend which state this is; "no release yet"
        // is a normal condition and must not be painted as a failure.
        body: Some(match e.reason {
            crate::update::UpdateFailure::Offline => format!("__offline__{}", e.message),
            crate::update::UpdateFailure::NoRelease => format!("__norelease__{}", e.message),
            crate::update::UpdateFailure::Other => format!("__error__{}", e.message),
        }),
    })
}

#[tauri::command]
pub async fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    crate::update::install(&app).await.map_err(|e| e.message)
}

#[tauri::command]
pub async fn current_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

/// Exposed for tests: probe without a Tauri runtime.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fetch_text_refuses_anything_but_http() {
        // The command exists to dodge CORS for `.lrc` files, not to become a
        // general-purpose reader of local paths.
        let r = tauri::async_runtime::block_on(fetch_text("file:///C:/Windows/win.ini".into()));
        assert!(r.is_err(), "a file:// URL was accepted");
        let r = tauri::async_runtime::block_on(fetch_text("appdata://secrets".into()));
        assert!(r.is_err(), "a custom scheme was accepted");
    }

    #[test]
    fn player_preferences_are_clamped() {
        let loud = validate_settings(Settings { player_volume: 9.0, ..Default::default() }).unwrap();
        assert_eq!(loud.player_volume, 1.0);
        let muted = validate_settings(Settings { player_volume: -2.0, ..Default::default() }).unwrap();
        assert_eq!(muted.player_volume, 0.0);
        let fast = validate_settings(Settings { player_rate: 99.0, ..Default::default() }).unwrap();
        assert_eq!(fast.player_rate, 3.0);
    }

    #[test]
    fn a_nan_player_preference_falls_back_instead_of_persisting() {
        // NaN slips through comparisons in surprising ways; refuse to store it.
        let v = validate_settings(Settings {
            player_volume: f32::NAN,
            player_rate: f32::NAN,
            ..Default::default()
        })
        .unwrap();
        assert_eq!(v.player_volume, 0.8);
        assert_eq!(v.player_rate, 1.0);
    }

    #[test]
    fn reader_preferences_are_clamped_to_a_renderable_range() {
        let v = validate_settings(Settings {
            reader_font_size: 200,
            reader_line_height: 5,
            reader_width: 6000,
            ..Default::default()
        })
        .unwrap();
        assert_eq!(v.reader_font_size, 30);
        assert_eq!(v.reader_line_height, 120);
        assert_eq!(v.reader_width, 1200);
    }

    #[test]
    fn an_unknown_theme_or_font_falls_back_instead_of_being_stored() {
        let v = validate_settings(Settings {
            reader_theme: "neon".into(),
            reader_font: "comic sans".into(),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(v.reader_theme, "dark");
        assert!(v.reader_font.is_empty());
    }

    #[test]
    fn every_known_theme_and_font_survives_validation() {
        for theme in ["dark", "light", "sepia", "green"] {
            let v = validate_settings(Settings {
                reader_theme: theme.into(),
                ..Default::default()
            })
            .unwrap();
            assert_eq!(v.reader_theme, theme);
        }
        for font in ["", "serif", "sans"] {
            let v = validate_settings(Settings { reader_font: font.into(), ..Default::default() }).unwrap();
            assert_eq!(v.reader_font, font);
        }
    }

    #[test]
    fn page_size_is_bounded_too() {
        let small = validate_settings(Settings { page_size: 0, ..Default::default() }).unwrap();
        assert_eq!(small.page_size, 10);
        let large =
            validate_settings(Settings { page_size: 100_000, ..Default::default() }).unwrap();
        assert_eq!(large.page_size, 300);
    }

    #[test]
    fn unusable_links_are_rejected_with_a_readable_message() {
        // reqwest's "builder error" means nothing to a reader.
        assert!(check_url("https://a.com/x").is_ok());
        assert!(check_url("http://a.com/x").is_ok());

        let empty = check_url("   ").unwrap_err().to_string();
        assert!(empty.contains("没有可打开的地址"), "{empty}");

        let scheme = check_url("magnet:?xt=urn:btih:abc").unwrap_err().to_string();
        assert!(scheme.contains("不支持的链接格式"), "{scheme}");

        let bad = check_url("http://[oops").unwrap_err().to_string();
        assert!(bad.contains("地址格式有误"), "{bad}");
    }

    #[test]
    fn summary_reports_shape() {
        let stored = StoredSource {
            source: Source {
                source_name: "Demo".into(),
                source_url: "https://demo.com".into(),
                sort_url: "A::https://a.com{{page}}\nB::https://b.com".into(),
                enable_js: true,
                ..Default::default()
            },
            id: "abc".into(),
            enabled: true,
            favorite: true,
            collection: "c".into(),
            added_at: 0,
            health: None,
            note: String::new(),
        };
        let s = summary(&stored);
        assert_eq!(s.name, "Demo");
        assert_eq!(s.category_count, 2);
        assert!(s.js_enabled);
        assert!(s.favorite);
    }

    #[test]
    fn parses_legacy_import_text() {
        let text = r#"[{"sourceUrl":"https://a.com","sourceName":"a","articleUrl":"https://a.com/l","itemTitle":"a@title"}]"#;
        let sources = Source::parse_collection(text).unwrap();
        assert_eq!(sources.len(), 1);
    }

    #[test]
    fn ignores_invalid_items() {
        let text = r#"[{"sourceUrl":"https://a.com"}, "not-an-object", 42]"#;
        let sources = Source::parse_collection(text).unwrap();
        assert_eq!(sources.len(), 1);
    }

    #[test]
    fn reports_empty_collection_error() {
        let text = r#"["not-an-object"]"#;
        assert!(Source::parse_collection(text).is_err());
    }
}