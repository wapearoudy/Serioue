use crate::error::{AppError, AppResult};
use crate::model::Source;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// A source as stored locally: the rule payload plus user state.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredSource {
    #[serde(flatten)]
    pub source: Source,
    /// Stable id assigned on import.
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub favorite: bool,
    /// Which collection it came from.
    #[serde(default)]
    pub collection: String,
    #[serde(default)]
    pub added_at: i64,
    /// Result of the most recent health check.
    #[serde(default)]
    pub health: Option<Health>,
    #[serde(default)]
    pub note: String,
}

/// Outcome of one verification stage.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StageState {
    Ok,
    /// Passed, but something looks off — the user should read the detail.
    Warn,
    Fail,
    /// Not applicable to this source (e.g. no `searchUrl`).
    Skip,
}

impl StageState {
    /// A glyph the UI can show next to the stage name.
    pub fn glyph(self) -> &'static str {
        match self {
            StageState::Ok => "✓",
            StageState::Warn => "!",
            StageState::Fail => "✕",
            StageState::Skip => "–",
        }
    }
}

/// One line of the verification report: what was tried and what came back.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StageResult {
    /// Stable identifier, used by the UI to lay stages out in a fixed order.
    pub key: String,
    pub label: String,
    pub state: StageState,
    /// A sentence the user can act on, not a raw error dump.
    pub detail: String,
    #[serde(default)]
    pub ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Health {
    pub ok: bool,
    pub status: String,
    pub item_count: usize,
    pub checked_at: i64,
    #[serde(default)]
    pub sample: String,
    /// Per-stage detail. Absent in stores written before source verification.
    #[serde(default)]
    pub stages: Vec<StageResult>,
    #[serde(default)]
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Collection {
    pub name: String,
    pub url: String,
    pub source_url: String,
    pub author: String,
    pub count: usize,
    pub added_at: i64,
}

/// One entry on the bookshelf: something the user chose to come back to.
///
/// A "book" here is a list within a source rather than a single article, because
/// that is the unit a reader returns to — the chapter list, the album, the
/// series. The first item is stored so the shelf can offer something to open
/// before the list has been fetched again.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ShelfEntry {
    pub id: String,
    pub source_id: String,
    pub source_name: String,
    /// The category the entry was added from, e.g. `全部`.
    #[serde(default)]
    pub category: String,
    pub title: String,
    /// The first item of the list, used as the entry point.
    pub url: String,
    pub kind: String,
    #[serde(default)]
    pub added_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct HistoryEntry {
    pub id: String,
    pub source_id: String,
    pub title: String,
    pub url: String,
    pub source_name: String,
    pub viewed_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    #[serde(default = "default_true")]
    pub concurrent_checks: bool,
    #[serde(default = "default_items")]
    pub page_size: usize,
    #[serde(default)]
    pub cache_enabled: bool,
    #[serde(default)]
    pub repo_base: String,
    #[serde(default)]
    pub user_agent: String,
    // --- Reader appearance -------------------------------------------------
    /// Body text size in px.
    #[serde(default = "default_font_size")]
    pub reader_font_size: u8,
    /// Line height as a percentage of the font size.
    #[serde(default = "default_line_height")]
    pub reader_line_height: u8,
    /// `""` uses the system UI font, `"serif"` and `"sans"` pick a family.
    #[serde(default)]
    pub reader_font: String,
    /// One of `dark`, `light`, `sepia`, `green`.
    #[serde(default = "default_theme")]
    pub reader_theme: String,
    /// Reading column width in px; `0` means full width.
    #[serde(default)]
    pub reader_width: u16,
    // --- Player preferences --------------------------------------------------
    /// Volume remembered across launches, 0.0-1.0.
    #[serde(default = "default_volume")]
    pub player_volume: f32,
    /// Playback speed remembered across launches.
    #[serde(default = "default_rate")]
    pub player_rate: f32,
    /// Render script-built pages when the ordinary fetch yields nothing.
    ///
    /// Off by default. The mechanism is proven — a page whose links are built
    /// entirely by script does yield a list through it — but measured over 14
    /// real sources it changed nothing, while costing an offscreen window and
    /// a couple of seconds on every page that fails to parse. So it stays
    /// opt-in until there is evidence it earns that.
    #[serde(default)]
    pub render_js: bool,
}

/// Seconds since the epoch, for `added_at` ordering.
fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn default_true() -> bool {
    true
}
fn default_items() -> usize {
    60
}
fn default_font_size() -> u8 {
    17
}
fn default_line_height() -> u8 {
    180
}
fn default_theme() -> String {
    "dark".to_string()
}
fn default_volume() -> f32 {
    0.8
}
fn default_rate() -> f32 {
    1.0
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            concurrent_checks: true,
            page_size: default_items(),
            cache_enabled: false,
            repo_base: "https://www.yck2026.fun".to_string(),
            user_agent: String::new(),
            reader_font_size: default_font_size(),
            reader_line_height: default_line_height(),
            reader_font: String::new(),
            reader_theme: default_theme(),
            reader_width: 0,
            player_volume: default_volume(),
            player_rate: default_rate(),
            render_js: false,
        }
    }
}

/// How far through an article the reader had got.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Progress {
    /// 0.0-1.0 of the scrollable height.
    pub ratio: f32,
    #[serde(default)]
    pub updated_at: i64,
}

#[derive(Debug, Default)]
struct Inner {
    sources: HashMap<String, StoredSource>,
    collections: Vec<Collection>,
    history: Vec<HistoryEntry>,
    shelf: Vec<ShelfEntry>,
    settings: Settings,
    /// Reading position per article URL.
    progress: HashMap<String, Progress>,
}

/// JSON-backed persistence.
///
/// Sources are small and the working set is bounded by what the user imports,
/// so a single in-memory map plus atomic JSON writes keeps the app dependency
/// free and fast enough while staying easy to inspect and back up.
pub struct Store {
    dir: PathBuf,
    inner: Mutex<Inner>,
}

impl Store {
    pub fn new(dir: PathBuf) -> AppResult<Self> {
        std::fs::create_dir_all(&dir)?;

        // The cache directory is optional: a failed attempt here (antivirus
        // holding a handle, a locked-down profile) must not stop the app from
        // starting. It is re-created lazily by the cache writer.
        if let Err(e) = std::fs::create_dir_all(dir.join("cache")) {
            log::warn!("cache directory unavailable, continuing without it: {e}");
        }

        let store = Store { dir, inner: Mutex::new(Inner::default()) };
        store.load()?;
        Ok(store)
    }

    fn path(&self, name: &str) -> PathBuf {
        self.dir.join(name)
    }

    fn load(&self) -> AppResult<()> {
        let mut inner = self.inner.lock().map_err(|_| AppError::Storage("lock poisoned".into()))?;
        if let Ok(text) = std::fs::read_to_string(self.path("sources.json")) {
            match serde_json::from_str::<Vec<StoredSource>>(&text) {
                Ok(list) => {
                    for s in list {
                        inner.sources.insert(s.id.clone(), s);
                    }
                }
                Err(e) => log::warn!("sources.json is corrupt, starting empty: {e}"),
            }
        }
        if let Ok(text) = std::fs::read_to_string(self.path("collections.json")) {
            if let Ok(list) = serde_json::from_str::<Vec<Collection>>(&text) {
                inner.collections = list;
            }
        }
        if let Ok(text) = std::fs::read_to_string(self.path("history.json")) {
            if let Ok(list) = serde_json::from_str::<Vec<HistoryEntry>>(&text) {
                inner.history = list;
            }
        }
        if let Ok(text) = std::fs::read_to_string(self.path("shelf.json")) {
            if let Ok(list) = serde_json::from_str::<Vec<ShelfEntry>>(&text) {
                inner.shelf = list;
            }
        }
        if let Ok(text) = std::fs::read_to_string(self.path("settings.json")) {
            if let Ok(s) = serde_json::from_str::<Settings>(&text) {
                inner.settings = s;
            }
        }
        if let Ok(text) = std::fs::read_to_string(self.path("progress.json")) {
            if let Ok(map) = serde_json::from_str::<HashMap<String, Progress>>(&text) {
                inner.progress = map;
            }
        }
        Ok(())
    }

    /// Write a JSON file atomically (temp file + rename).
    fn write_atomic(&self, name: &str, value: &impl Serialize) -> AppResult<()> {
        let text = serde_json::to_string_pretty(value)?;
        let final_path = self.path(name);
        let tmp = final_path.with_extension("json.tmp");
        std::fs::write(&tmp, text)?;
        std::fs::rename(&tmp, &final_path)?;
        Ok(())
    }

    pub fn sources(&self) -> Vec<StoredSource> {
        let Ok(inner) = self.inner.lock() else { return Vec::new() };
        let mut list: Vec<StoredSource> = inner.sources.values().cloned().collect();
        list.sort_by(|a, b| {
            b.source
                .custom_order
                .cmp(&a.source.custom_order)
                .then_with(|| a.source.display_name().cmp(b.source.display_name()))
        });
        list
    }

    pub fn source(&self, id: &str) -> Option<StoredSource> {
        self.inner.lock().ok()?.sources.get(id).cloned()
    }

    /// Find a source by its base URL, used when re-opening a cached article.
    pub fn source_by_url(&self, url: &str) -> Option<StoredSource> {
        let inner = self.inner.lock().ok()?;
        inner
            .sources
            .values()
            .find(|s| s.source.source_url == url)
            .cloned()
    }

    /// Add sources, skipping ones whose identity is already present.
    /// Returns (added, skipped).
    pub fn add_sources(&self, incoming: Vec<Source>, collection: &str) -> AppResult<(usize, usize)> {
        let mut inner = self.inner.lock().map_err(|_| AppError::Storage("lock poisoned".into()))?;
        let mut existing_keys: std::collections::HashSet<String> =
            inner.sources.values().map(|s| s.source.key()).collect();
        let mut existing_ids: std::collections::HashSet<String> =
            inner.sources.keys().cloned().collect();

        let now = chrono::Utc::now().timestamp();
        let mut added = 0usize;
        let mut skipped = 0usize;

        for src in incoming {
            let key = src.key();
            if existing_keys.contains(&key) {
                skipped += 1;
                continue;
            }
            let mut id = crate::util::hash_key(&[&key]);
            // Guard against hash collisions.
            let mut n = 1;
            while existing_ids.contains(&id) {
                id = crate::util::hash_key(&[&key, &n.to_string()]);
                n += 1;
            }
            existing_ids.insert(id.clone());
            existing_keys.insert(key);

            inner.sources.insert(
                id.clone(),
                StoredSource {
                    source: src,
                    id,
                    enabled: true,
                    favorite: false,
                    collection: collection.to_string(),
                    added_at: now,
                    health: None,
                    note: String::new(),
                },
            );
            added += 1;
        }
        self.write_atomic("sources.json", &inner.sources.values().collect::<Vec<_>>())?;
        Ok((added, skipped))
    }

    pub fn update_source(&self, id: &str, patch: SourcePatch) -> AppResult<()> {
        let mut inner = self.inner.lock().map_err(|_| AppError::Storage("lock poisoned".into()))?;
        if let Some(s) = inner.sources.get_mut(id) {
            if let Some(v) = patch.enabled {
                s.enabled = v;
            }
            if let Some(v) = patch.favorite {
                s.favorite = v;
            }
            if let Some(v) = patch.custom_order {
                s.source.custom_order = v;
            }
            if let Some(v) = patch.note {
                s.note = v;
            }
        }
        self.write_atomic("sources.json", &inner.sources.values().collect::<Vec<_>>())?;
        Ok(())
    }

    pub fn remove_sources(&self, ids: &[String]) -> AppResult<usize> {
        let mut inner = self.inner.lock().map_err(|_| AppError::Storage("lock poisoned".into()))?;
        let mut removed = 0;
        for id in ids {
            if inner.sources.remove(id).is_some() {
                removed += 1;
            }
        }
        self.write_atomic("sources.json", &inner.sources.values().collect::<Vec<_>>())?;
        Ok(removed)
    }

    pub fn set_health(&self, id: &str, health: Health) -> AppResult<()> {
        self.set_health_batch(&[(id.to_string(), health)])
    }

    /// Apply many health results under a single lock and a single write.
    ///
    /// A full-library check produces one result per source; writing the whole
    /// `sources.json` once per result would serialise the worker pool on disk
    /// I/O for no benefit.
    pub fn set_health_batch(&self, items: &[(String, Health)]) -> AppResult<()> {
        if items.is_empty() {
            return Ok(());
        }
        let mut inner = self.inner.lock().map_err(|_| AppError::Storage("lock poisoned".into()))?;
        let mut changed = false;
        for (id, health) in items {
            if let Some(s) = inner.sources.get_mut(id) {
                s.health = Some(health.clone());
                changed = true;
            }
        }
        if !changed {
            return Ok(());
        }
        self.write_atomic("sources.json", &inner.sources.values().collect::<Vec<_>>())?;
        Ok(())
    }

    pub fn collections(&self) -> Vec<Collection> {
        let Ok(inner) = self.inner.lock() else { return Vec::new() };
        let mut list = inner.collections.clone();
        list.sort_by_key(|c| std::cmp::Reverse(c.added_at));
        list
    }

    pub fn add_collection(&self, collection: Collection) -> AppResult<()> {
        let mut inner = self.inner.lock().map_err(|_| AppError::Storage("lock poisoned".into()))?;
        // Replace an existing entry with the same URL.
        inner.collections.retain(|c| c.url != collection.url);
        inner.collections.push(collection);
        self.write_atomic("collections.json", &inner.collections)?;
        Ok(())
    }

    pub fn remove_collection(&self, url: &str) -> AppResult<()> {
        let mut inner = self.inner.lock().map_err(|_| AppError::Storage("lock poisoned".into()))?;
        inner.collections.retain(|c| c.url != url);
        self.write_atomic("collections.json", &inner.collections)?;
        Ok(())
    }

    pub fn history(&self, limit: usize) -> Vec<HistoryEntry> {
        let Ok(inner) = self.inner.lock() else { return Vec::new() };
        let mut list = inner.history.clone();
        list.sort_by_key(|h| std::cmp::Reverse(h.viewed_at));
        list.truncate(limit);
        list
    }

    pub fn push_history(&self, entry: HistoryEntry) -> AppResult<()> {
        let mut inner = self.inner.lock().map_err(|_| AppError::Storage("lock poisoned".into()))?;
        inner.history.retain(|h| h.url != entry.url);
        inner.history.insert(0, entry);
        if inner.history.len() > 500 {
            inner.history.truncate(500);
        }
        self.write_atomic("history.json", &inner.history)?;
        Ok(())
    }

    pub fn clear_history(&self) -> AppResult<()> {
        let mut inner = self.inner.lock().map_err(|_| AppError::Storage("lock poisoned".into()))?;
        inner.history.clear();
        inner.progress.clear();
        self.write_atomic("history.json", &inner.history)?;
        self.write_atomic("progress.json", &inner.progress)?;
        Ok(())
    }

    /// The bookshelf, newest first.
    pub fn shelf(&self) -> Vec<ShelfEntry> {
        let Ok(inner) = self.inner.lock() else { return Vec::new() };
        let mut list = inner.shelf.clone();
        list.sort_by(|a, b| b.added_at.cmp(&a.added_at));
        list
    }

    pub fn on_shelf(&self, id: &str) -> bool {
        let Ok(inner) = self.inner.lock() else { return false };
        inner.shelf.iter().any(|e| e.id == id)
    }

    /// Add an entry, or return the existing one if it is already there.
    ///
    /// Re-adding must not duplicate: the star on a list header is clicked, not
    /// a form, and a double click should not leave two rows.
    pub fn add_shelf(&self, mut entry: ShelfEntry) -> AppResult<ShelfEntry> {
        let mut inner = self.inner.lock().map_err(|_| AppError::Storage("lock poisoned".into()))?;
        if let Some(existing) = inner.shelf.iter().find(|e| e.id == entry.id) {
            return Ok(existing.clone());
        }
        // `added_at` has one-second resolution, so two books saved within the
        // same second would come back in an arbitrary order and the shelf would
        // not reliably be newest-first. Stepping past the highest stamp already
        // in use keeps the order the user expects.
        let newest = inner.shelf.iter().map(|e| e.added_at).max().unwrap_or(0);
        entry.added_at = entry.added_at.max(now_secs()).max(newest + 1);
        inner.shelf.push(entry.clone());
        self.write_atomic("shelf.json", &inner.shelf)?;
        Ok(entry)
    }

    pub fn remove_shelf(&self, id: &str) -> AppResult<()> {
        let mut inner = self.inner.lock().map_err(|_| AppError::Storage("lock poisoned".into()))?;
        inner.shelf.retain(|e| e.id != id);
        self.write_atomic("shelf.json", &inner.shelf)?;
        Ok(())
    }

    /// How far through `url` the reader had got, if it was ever opened.
    pub fn progress(&self, url: &str) -> Option<f32> {
        let inner = self.inner.lock().ok()?;
        inner.progress.get(url).map(|p| p.ratio)
    }

    /// Remember a reading position.
    ///
    /// The ratio is stored rather than a pixel offset on purpose: changing the
    /// font size or the window height re-lays the page, and only a fraction of
    /// the scrollable height survives that.
    pub fn set_progress(&self, url: &str, ratio: f32) -> AppResult<()> {
        let mut inner = self.inner.lock().map_err(|_| AppError::Storage("lock poisoned".into()))?;
        let ratio = ratio.clamp(0.0, 1.0);
        inner.progress.insert(
            url.to_string(),
            Progress { ratio, updated_at: chrono::Utc::now().timestamp() },
        );
        // Bound growth; a reader rarely returns to hundreds of old articles.
        if inner.progress.len() > 500 {
            let mut entries: Vec<(String, i64)> = inner
                .progress
                .iter()
                .map(|(k, v)| (k.clone(), v.updated_at))
                .collect();
            entries.sort_by_key(|(_, at)| *at);
            let drop_n = entries.len().saturating_sub(500);
            for (url, _) in entries.into_iter().take(drop_n) {
                inner.progress.remove(&url);
            }
        }
        self.write_atomic("progress.json", &inner.progress)?;
        Ok(())
    }

    pub fn settings(&self) -> Settings {
        self.inner.lock().map(|i| i.settings.clone()).unwrap_or_default()
    }

    pub fn set_settings(&self, settings: Settings) -> AppResult<()> {
        let mut inner = self.inner.lock().map_err(|_| AppError::Storage("lock poisoned".into()))?;
        inner.settings = settings;
        self.write_atomic("settings.json", &inner.settings)?;
        Ok(())
    }

    // ---- article cache -------------------------------------------------

    pub fn cache_dir(&self) -> PathBuf {
        self.dir.join("cache")
    }

    pub fn cache_read(&self, key: &str) -> Option<String> {
        let path = self.cache_dir().join(format!("{key}.json"));
        std::fs::read_to_string(path).ok()
    }

    pub fn cache_write(&self, key: &str, value: &impl Serialize) -> AppResult<()> {
        let path = self.cache_dir().join(format!("{key}.json"));
        std::fs::write(path, serde_json::to_string(value)?)?;
        Ok(())
    }

    pub fn cache_clear(&self) -> AppResult<usize> {
        let dir = self.cache_dir();
        let mut removed = 0;
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for e in entries.flatten() {
                if e.path().extension().map(|x| x == "json").unwrap_or(false) {
                    let _ = std::fs::remove_file(e.path());
                    removed += 1;
                }
            }
        }
        Ok(removed)
    }

    /// Whether a cache directory can be written to.
    pub fn cache_writable(&self) -> bool {
        let p: &Path = &self.dir;
        p.exists()
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct SourcePatch {
    pub enabled: Option<bool>,
    pub favorite: Option<bool>,
    pub custom_order: Option<i64>,
    pub note: Option<String>,
}

/// Which articles the 继续阅读 shelf should offer, and their positions.
///
/// Returns `(url, progress)` pairs so the caller can join them against history
/// without repeating the thresholds.
pub fn resumable(history: &[HistoryEntry], progress: &dyn Fn(&str) -> Option<f32>) -> Vec<(String, f32)> {
    history
        .iter()
        .filter_map(|h| {
            let p = progress(&h.url).unwrap_or(0.0);
            // Untouched and finished articles are not worth offering.
            if p <= 0.02 || p >= 0.98 {
                return None;
            }
            Some((h.url.clone(), p))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scratch directory under the crate's own target dir.
///
/// The system temp directory is not always writable (sandboxes, locked-down
/// CI), so tests derive their path from `CARGO_TARGET_DIR` when it is set.
fn test_dir(tag: &str) -> PathBuf {
        let base = std::env::var("CARGO_MANIFEST_DIR")
            .map(|d| PathBuf::from(d).join("target").join("test-tmp"))
            .unwrap_or_else(|_| std::env::temp_dir());
        let dir = base.join(format!("serious-{tag}-{}", rand::random::<u64>()));
        let _ = std::fs::create_dir_all(&dir);
        dir
    }

    fn temp_store() -> (Store, PathBuf) {
        let dir = test_dir("store");
        (Store::new(dir.clone()).unwrap(), dir)
    }

    fn sample(name: &str, url: &str) -> Source {
        Source { source_name: name.into(), source_url: url.into(), ..Default::default() }
    }

    #[test]
    fn reading_progress_round_trips() {
        let (store, dir) = temp_store();
        assert_eq!(store.progress("https://x.com/a"), None);
        store.set_progress("https://x.com/a", 0.42).unwrap();
        assert_eq!(store.progress("https://x.com/a"), Some(0.42));
        // A second store over the same directory must see it.
        let reopened = Store::new(dir.clone()).unwrap();
        assert_eq!(reopened.progress("https://x.com/a"), Some(0.42));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn reading_progress_is_clamped() {
        let (store, dir) = temp_store();
        store.set_progress("https://x.com/a", 5.0).unwrap();
        assert_eq!(store.progress("https://x.com/a"), Some(1.0));
        store.set_progress("https://x.com/b", -3.0).unwrap();
        assert_eq!(store.progress("https://x.com/b"), Some(0.0));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn only_half_read_articles_are_offered_back() {
        let history: Vec<HistoryEntry> = ["a", "b", "c", "d", "e"]
            .iter()
            .map(|u| HistoryEntry {
                id: String::new(),
                source_id: "s".into(),
                title: format!("T{u}"),
                url: format!("https://x.com/{u}"),
                source_name: "demo".into(),
                viewed_at: 0,
            })
            .collect();
        let known = |u: &str| -> Option<f32> {
            match u.rsplit('/').next()? {
                "a" => Some(0.5),  // genuinely half read
                "b" => Some(0.0),  // opened but never scrolled
                "c" => Some(0.99), // finished
                "d" => Some(1.0),  // finished
                _ => None,         // no record at all
            }
        };
        let got = resumable(&history, &known);
        assert_eq!(
            got,
            vec![("https://x.com/a".to_string(), 0.5)],
            "only the half-read article should be offered: {got:?}"
        );
    }

    #[test]
    fn nothing_in_progress_means_an_empty_shelf() {
        let history: Vec<HistoryEntry> = vec![HistoryEntry {
            id: String::new(),
            source_id: "s".into(),
            title: "T".into(),
            url: "https://x.com/a".into(),
            source_name: "demo".into(),
            viewed_at: 0,
        }];
        assert!(resumable(&history, &|_| None).is_empty());
        assert!(resumable(&history, &|_| Some(0.9)).len() == 1);
    }

    #[test]
    fn clearing_history_forgets_reading_positions() {
        let (store, dir) = temp_store();
        store.set_progress("https://x.com/a", 0.5).unwrap();
        store.clear_history().unwrap();
        assert_eq!(store.progress("https://x.com/a"), None);
        let _ = std::fs::remove_dir_all(dir);
    }

    fn entry(id: &str, added_at: i64) -> ShelfEntry {
        ShelfEntry {
            id: id.into(),
            source_id: "s".into(),
            source_name: "demo".into(),
            category: "全部".into(),
            title: format!("书 {id}"),
            url: format!("https://x.com/{id}"),
            kind: "novel".into(),
            added_at,
        }
    }

    #[test]
    fn the_bookshelf_survives_a_restart_and_sorts_newest_first() {
        let (store, dir) = temp_store();
        // `added_at` is supplied by the backend, not the caller: a stale client
        // must not be able to reorder the shelf.
        store.add_shelf(entry("a", 0)).unwrap();
        store.add_shelf(entry("b", 0)).unwrap();
        store.add_shelf(entry("c", 0)).unwrap();

        let ids: Vec<String> = store.shelf().iter().map(|e| e.id.clone()).collect();
        assert_eq!(ids, ["c", "b", "a"], "the shelf is not newest-first");

        let reopened = Store::new(dir.clone()).unwrap();
        assert_eq!(reopened.shelf().len(), 3, "the shelf did not survive a restart");
        assert_eq!(reopened.shelf()[0].title, "书 c");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn adding_the_same_book_twice_leaves_one_row() {
        // The star on a list header is clicked, not a form; a double click must
        // not produce two entries.
        let (store, dir) = temp_store();
        let first = store.add_shelf(entry("a", 0)).unwrap();
        let again = store.add_shelf(entry("a", 999)).unwrap();
        assert_eq!(again.added_at, first.added_at, "the existing entry was not returned as-is");
        assert_eq!(store.shelf().len(), 1, "the shelf duplicated an entry");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn books_added_within_one_second_still_come_back_newest_first() {
        // `added_at` is second-granular, and saving two books is fast. Without
        // stepping past the previous stamp the order of the shelf would be
        // whatever the sort happened to leave.
        let (store, dir) = temp_store();
        for id in ["a", "b", "c"] {
            store.add_shelf(entry(id, 0)).unwrap();
        }
        let ids: Vec<String> = store.shelf().iter().map(|e| e.id.clone()).collect();
        assert_eq!(ids, ["c", "b", "a"], "same-second adds came back in the wrong order");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn removing_from_the_bookshelf_is_idempotent() {
        let (store, dir) = temp_store();
        store.add_shelf(entry("a", 0)).unwrap();
        store.remove_shelf("a").unwrap();
        store.remove_shelf("a").unwrap();
        assert!(!store.on_shelf("a"));
        assert!(store.shelf().is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn settings_from_an_older_install_get_reader_defaults() {
        // A settings.json written before reader preferences existed must still
        // load, with sensible values rather than zeroes.
        let dir = test_dir("settings-legacy");
        std::fs::write(
            dir.join("settings.json"),
            r#"{"concurrent_checks":false,"page_size":30}"#,
        )
        .unwrap();
        let reopened = Store::new(dir.clone()).unwrap();
        let s = reopened.settings();
        assert!(!s.concurrent_checks);
        assert_eq!(s.page_size, 30);
        assert_eq!(s.reader_font_size, 17);
        assert_eq!(s.reader_line_height, 180);
        assert_eq!(s.reader_theme, "dark");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn adds_and_deduplicates() {
        let (store, dir) = temp_store();
        let (added, skipped) = store
            .add_sources(vec![sample("A", "https://a.com")], "col")
            .unwrap();
        assert_eq!((added, skipped), (1, 0));

        let (added, skipped) = store
            .add_sources(vec![sample("A", "https://a.com"), sample("B", "https://b.com")], "col")
            .unwrap();
        assert_eq!((added, skipped), (1, 1));
        assert_eq!(store.sources().len(), 2);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn persists_across_instances() {
        let (store, dir) = temp_store();
        store.add_sources(vec![sample("A", "https://a.com")], "col").unwrap();

        let reopened = Store::new(dir.clone()).unwrap();
        assert_eq!(reopened.sources().len(), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn toggles_favorite_and_enabled() {
        let (store, dir) = temp_store();
        store.add_sources(vec![sample("A", "https://a.com")], "col").unwrap();
        let id = store.sources()[0].id.clone();
        store
            .update_source(&id, SourcePatch { favorite: Some(true), enabled: Some(false), ..Default::default() })
            .unwrap();
        let s = store.source(&id).unwrap();
        assert!(s.favorite);
        assert!(!s.enabled);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn removes_sources() {
        let (store, dir) = temp_store();
        store
            .add_sources(vec![sample("A", "https://a.com"), sample("B", "https://b.com")], "col")
            .unwrap();
        let ids: Vec<String> = store.sources().iter().map(|s| s.id.clone()).collect();
        assert_eq!(store.remove_sources(&ids).unwrap(), 2);
        assert!(store.sources().is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn history_dedupes_and_orders() {
        let (store, dir) = temp_store();
        store
            .push_history(HistoryEntry {
                id: "1".into(), source_id: "s".into(), title: "t".into(),
                url: "https://a.com/1".into(), source_name: "A".into(), viewed_at: 1,
            })
            .unwrap();
        store
            .push_history(HistoryEntry {
                id: "2".into(), source_id: "s".into(), title: "t".into(),
                url: "https://a.com/1".into(), source_name: "A".into(), viewed_at: 2,
            })
            .unwrap();
        assert_eq!(store.history(10).len(), 1);
        assert_eq!(store.history(10)[0].viewed_at, 2);
        let _ = std::fs::remove_dir_all(dir);
    }
}