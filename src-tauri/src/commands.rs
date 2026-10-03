use crate::engine::browse::{self, ArticlePage, PageRequest};
use crate::error::{AppError, AppResult};
use crate::model::{Category, Source};
use crate::repo;
use crate::store::{Collection, Health, HistoryEntry, Settings, SourcePatch, StoredSource, Store};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{Emitter, Manager, State};

pub struct AppState {
    pub store: Arc<Store>,
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
        let content = browse::load_article(&stored.source, &url)?;
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
// Health checks
// ---------------------------------------------------------------------------

/// Probe one source: fetch its first page and count the parsed items.
#[tauri::command]
pub async fn check_source(state: State<'_, AppState>, id: String) -> AppResult<Health> {
    let store = state.store.clone();
    let health = blocking(move || {
        let stored = store
            .source(&id)
            .ok_or_else(|| AppError::NotFound(id.clone()))?;
        let result = probe(&stored.source);
        store.set_health(&id, result.clone())?;
        Ok(result)
    })
    .await?;
    Ok(health)
}

fn probe(source: &Source) -> Health {
    let now = chrono::Utc::now().timestamp();
    let categories = browse::categories(source);
    let template = categories
        .first()
        .map(|c| c.url.clone())
        .unwrap_or_else(|| source.source_url.clone());

    match browse::load_page(source, &PageRequest::first(&template)) {
        Ok(page) => Health {
            ok: !page.items.is_empty(),
            status: if page.items.is_empty() {
                "可访问，但没有解析出内容".into()
            } else {
                "正常".into()
            },
            item_count: page.items.len(),
            checked_at: now,
            sample: page
                .items
                .first()
                .map(|i| crate::util::short_url(&i.title, 40))
                .unwrap_or_default(),
        },
        Err(e) => Health {
            ok: false,
            status: e.to_string(),
            item_count: 0,
            checked_at: now,
            sample: String::new(),
        },
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct CheckProgress {
    pub done: usize,
    pub total: usize,
    pub current: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CheckSummary {
    pub total: usize,
    pub ok: usize,
    pub failed: usize,
}

/// Check many sources, streaming progress events to the frontend.
#[tauri::command]
pub async fn check_all(
    state: State<'_, AppState>,
    ids: Option<Vec<String>>,
    app: tauri::AppHandle,
) -> AppResult<CheckSummary> {
    let store = state.store.clone();
    let store_for_list = store.clone();
    let targets: Vec<StoredSource> = blocking(move || {
        let all = store_for_list.sources();
        Ok(match ids {
            Some(list) => all.into_iter().filter(|s| list.contains(&s.id)).collect(),
            None => all,
        })
    })
    .await?;

    let total = targets.len();
    let app2 = app.clone();
    let summary = tauri::async_runtime::spawn_blocking(move || {
        let mut ok = 0usize;
        let mut failed = 0usize;
        for (i, stored) in targets.iter().enumerate() {
            let _ = app2.emit(
                "check-progress",
                CheckProgress {
                    done: i,
                    total,
                    current: stored.source.display_name().to_string(),
                },
            );
            let health = probe(&stored.source);
            if health.ok {
                ok += 1;
            } else {
                failed += 1;
            }
            let _ = store.set_health(&stored.id, health);
        }
        let _ = app2.emit(
            "check-progress",
            CheckProgress { done: total, total, current: String::new() },
        );
        CheckSummary { total, ok, failed }
    })
    .await
    .map_err(|e| AppError::other(e.to_string()))?;

    Ok(summary)
}

// ---------------------------------------------------------------------------
// Library: history, collections, settings, cache
// ---------------------------------------------------------------------------

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
    blocking(move || store.set_settings(settings)).await
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
        body: if e.offline {
            Some(format!("__offline__{}", e.message))
        } else {
            Some(format!("__error__{}", e.message))
        },
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