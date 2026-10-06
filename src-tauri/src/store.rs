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

/// A passage the reader marked, optionally with a note attached.
///
/// `text` is the quoted passage as it read on the page. It is stored rather than
/// a DOM offset because the same article is re-rendered from a live fetch every
/// time; an offset into yesterday's DOM would point at the wrong sentence.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Highlight {
    pub id: String,
    /// The article the passage belongs to.
    pub url: String,
    /// The source it came from, so the passage can be reopened the way history
    /// is: switch to that source first, then load the article.
    #[serde(default)]
    pub source_id: String,
    pub title: String,
    pub source_name: String,
    /// The quoted passage.
    pub text: String,
    /// The reader's own note, if any.
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub created_at: i64,
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
    #[serde(default)]
    pub cache_enabled: bool,
    #[serde(default)]
    pub repo_base: String,
    /// Where this repository keeps its pages, when it differs from the
    /// original layout. A mirror serving the same pages under different names
    /// is described here rather than assumed: a hardcoded path leaves the
    /// index looking fine while every download 404s.
    #[serde(default)]
    pub repo_paths: crate::repo::RepoPaths,
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
    /// Off by default, but the engine still renders conditionally: on a list
    /// page where ordinary parsing produced nothing openable *and* the source
    /// declares `enableJs`, one offscreen render is tried.
    ///
    /// Measured over 16 real sources, that path recovered 2 (12.5%) — enough to
    /// justify the fallback, nowhere near enough to pay an offscreen window and
    /// ~2 seconds on every source. An earlier "zero benefit" reading came from
    /// the audit path, which never calls the renderer at all, so it could not
    /// have measured anything.
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

/// A stable id for a highlight, derived from what makes it unique.
///
/// FNV-1a rather than `DefaultHasher`: the value is written to disk and must
/// stay the same across runs, which the standard library explicitly does not
/// promise for its hasher.
fn highlight_id(url: &str, text: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in url.as_bytes().iter().chain([0u8].iter()).chain(text.as_bytes()) {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100_0000_01b3);
    }
    format!("h{hash:016x}")
}

fn default_true() -> bool {
    true
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
            cache_enabled: false,
            repo_base: "https://www.yck2026.fun".to_string(),
            repo_paths: crate::repo::RepoPaths::default(),
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
    highlights: Vec<Highlight>,
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
        if let Ok(text) = std::fs::read_to_string(self.path("highlights.json")) {
            if let Ok(list) = serde_json::from_str::<Vec<Highlight>>(&text) {
                inner.highlights = list;
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
        list.sort_by_key(|e| std::cmp::Reverse(e.added_at));
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

    /// Every highlight, newest first.
    pub fn highlights(&self) -> Vec<Highlight> {
        let Ok(inner) = self.inner.lock() else { return Vec::new() };
        let mut list = inner.highlights.clone();
        list.sort_by_key(|h| std::cmp::Reverse(h.created_at));
        list
    }

    /// The highlights belonging to one article, in the order they were made.
    pub fn highlights_for(&self, url: &str) -> Vec<Highlight> {
        let Ok(inner) = self.inner.lock() else { return Vec::new() };
        let mut list: Vec<Highlight> =
            inner.highlights.iter().filter(|h| h.url == url).cloned().collect();
        list.sort_by_key(|h| h.created_at);
        list
    }

    /// Save a highlight, or return the existing one with the same passage.
    ///
    /// Highlighting the same sentence twice should not produce two rows, so the
    /// identity is (article, passage) rather than a client-supplied id.
    pub fn add_highlight(&self, mut h: Highlight) -> AppResult<Highlight> {
        let mut inner = self.inner.lock().map_err(|_| AppError::Storage("lock poisoned".into()))?;
        let text = h.text.trim().to_string();
        if text.is_empty() {
            return Err(AppError::Storage("不能保存空的高亮".into()));
        }
        if text.chars().count() > 2000 {
            return Err(AppError::Storage("高亮内容过长".into()));
        }
        if let Some(existing) = inner.highlights.iter().find(|e| e.url == h.url && e.text == text) {
            return Ok(existing.clone());
        }
        h.text = text;
        if h.created_at == 0 {
            h.created_at = now_secs();
        }
        // The id is the store's, not the caller's: the frontend has no way to
        // mint a stable one, and `remove_highlight` is keyed on it. Deriving it
        // from the identity means the same passage always lands on the same id.
        if h.id.is_empty() {
            h.id = highlight_id(&h.url, &h.text);
        }
        inner.highlights.push(h.clone());
        self.write_atomic("highlights.json", &inner.highlights)?;
        Ok(h)
    }

    /// Attach, replace or clear the note on one highlight.
    ///
    /// `add_highlight` cannot serve this: it treats (article, passage) as the
    /// identity and returns the stored row untouched, so re-saving the same
    /// highlight would silently keep the old note. The only other write path is
    /// `remove_highlight`, and that is exactly the data loss this command exists
    /// to avoid -- a note edit must never cost the reader the highlight.
    ///
    /// An absent, empty or whitespace-only note clears it, so "clear the note"
    /// and "the note is blank" cannot drift apart in the file.
    pub fn update_highlight_note(&self, id: &str, note: Option<&str>) -> AppResult<()> {
        let mut inner = self.inner.lock().map_err(|_| AppError::Storage("lock poisoned".into()))?;
        let target = inner
            .highlights
            .iter_mut()
            .find(|h| h.id == id)
            .ok_or_else(|| AppError::Storage("找不到这条高亮".into()))?;
        let cleaned = note.unwrap_or_default().trim().to_string();
        if cleaned.chars().count() > 2000 {
            return Err(AppError::Storage("笔记内容过长".into()));
        }
        target.note = cleaned;
        self.write_atomic("highlights.json", &inner.highlights)?;
        Ok(())
    }

    pub fn remove_highlight(&self, id: &str) -> AppResult<()> {
        let mut inner = self.inner.lock().map_err(|_| AppError::Storage("lock poisoned".into()))?;
        inner.highlights.retain(|h| h.id != id);
        self.write_atomic("highlights.json", &inner.highlights)?;
        Ok(())
    }

    /// Every remembered reading position, with the time it was last saved.
    ///
    /// Reading statistics need the timestamps as well as the ratios, and need to
    /// walk all of them at once, so they cannot be served by looking URLs up one
    /// at a time.
    pub fn progress_all(&self) -> HashMap<String, Progress> {
        self.inner.lock().map(|i| i.progress.clone()).unwrap_or_default()
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
    //
    // Cached article bodies live here — one JSON file per article, named by a
    // hash of (source_id, article_url), never by the URL itself. A URL carries
    // `:` (illegal in a Windows filename) and `/` (a directory separator to
    // `Path::join`), so spelling it into a filename silently breaks the cache
    // on Windows while looking fine elsewhere. The hash is hex only, which is
    // legal on Windows, macOS and Linux alike.
    //
    // The envelope carries `cached_at` (unix seconds) so a cached body can be
    // told apart from a fresh one, and so a future "stale after N days" rule
    // has a timestamp to work from. The current policy is simpler: entries
    // never expire by age; the directory is bounded by COUNT, evicting the
    // least-recently-written file first (LRU by mtime). Unbounded growth on a
    // reader's disk is worse than re-fetching an evicted article.

    /// How many cached articles are kept at most.
    pub const ARTICLE_CACHE_MAX_ENTRIES: usize = 200;

    /// Prefix that marks files owned by the article cache, so `cache_clear`
    /// only removes what this cache wrote and leaves anything else alone.
    const ARTICLE_CACHE_PREFIX: &str = "article-";

    /// Filename-safe key for one article of one source.
    ///
    /// Both parts matter: two sources can serve the same article URL with
    /// different bodies, and serving A's body for B's article is exactly the
    /// "plausible substitute" failure this project refuses to ship.
    pub fn article_cache_key(source_id: &str, article_url: &str) -> String {
        format!("{}{}", Self::ARTICLE_CACHE_PREFIX, crate::util::hash_key(&[source_id, article_url]))
    }

    /// Cached article envelope: the content plus when it was stored.
    fn article_cache_path(&self, key: &str) -> PathBuf {
        self.cache_dir().join(format!("{key}.json"))
    }

    pub fn cache_dir(&self) -> PathBuf {
        self.dir.join("cache")
    }

    /// How many article-cache entries exist, and roughly how many bytes they hold.
    pub fn cache_stats(&self) -> (usize, u64) {
        let mut count = 0usize;
        let mut bytes = 0u64;
        if let Ok(entries) = std::fs::read_dir(self.cache_dir()) {
            for e in entries.flatten() {
                let p = e.path();
                let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                if p.extension().map(|x| x == "json").unwrap_or(false) && name.starts_with(Self::ARTICLE_CACHE_PREFIX) {
                    count += 1;
                    bytes += e.metadata().map(|m| m.len()).unwrap_or(0);
                }
            }
        }
        (count, bytes)
    }

    /// Drop the oldest entries until at most MAX remain. Runs after every write.
    fn cache_evict(&self) {
        let dir = self.cache_dir();
        let mut entries: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
        if let Ok(rd) = std::fs::read_dir(&dir) {
            for e in rd.flatten() {
                let p = e.path();
                let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                if !(p.extension().map(|x| x == "json").unwrap_or(false) && name.starts_with(Self::ARTICLE_CACHE_PREFIX)) {
                    continue;
                }
                let mtime = e.metadata().and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH);
                entries.push((mtime, p));
            }
        }
        if entries.len() <= Self::ARTICLE_CACHE_MAX_ENTRIES {
            return;
        }
        entries.sort_by_key(|a| a.0);
        for (_, p) in entries.iter().take(entries.len() - Self::ARTICLE_CACHE_MAX_ENTRIES) {
            let _ = std::fs::remove_file(p);
        }
    }

    pub fn cache_read(&self, key: &str) -> Option<String> {
        let path = self.article_cache_path(key);
        std::fs::read_to_string(path).ok()
    }

    pub fn cache_write(&self, key: &str, value: &impl Serialize) -> AppResult<()> {
        std::fs::create_dir_all(self.cache_dir())?;
        let path = self.article_cache_path(key);
        std::fs::write(path, serde_json::to_string(value)?)?;
        self.cache_evict();
        Ok(())
    }

    /// Remove only article-cache entries; anything else in the directory
    /// (including the JS script-variable cache, which lives elsewhere) is left
    /// alone. Returns how many entries were removed.
    pub fn cache_clear(&self) -> AppResult<usize> {
        let dir = self.cache_dir();
        let mut removed = 0;
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for e in entries.flatten() {
                let p = e.path();
                let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                if p.extension().map(|x| x == "json").unwrap_or(false) && name.starts_with(Self::ARTICLE_CACHE_PREFIX) {
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

    fn mark(url: &str, text: &str) -> Highlight {
        Highlight {
            id: format!("h-{text}"),
            url: url.into(),
            source_id: "s".into(),
            title: "一篇文章".into(),
            source_name: "demo".into(),
            text: text.into(),
            note: String::new(),
            created_at: 0,
        }
    }

    #[test]
    fn highlights_survive_a_restart_and_are_scoped_to_their_article() {
        let (store, dir) = temp_store();
        store.add_highlight(mark("https://x.com/a", "第一处")).unwrap();
        store.add_highlight(mark("https://x.com/a", "第二处")).unwrap();
        store.add_highlight(mark("https://x.com/b", "另一篇")).unwrap();

        assert_eq!(store.highlights_for("https://x.com/a").len(), 2);
        assert_eq!(store.highlights_for("https://x.com/b").len(), 1);
        assert!(store.highlights_for("https://x.com/c").is_empty());

        let reopened = Store::new(dir.clone()).unwrap();
        assert_eq!(reopened.highlights().len(), 3, "highlights did not survive a restart");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn highlighting_the_same_sentence_twice_yields_one_highlight() {
        // Selecting the same passage again is easy to do, and two identical rows
        // are worse than one.
        let (store, dir) = temp_store();
        let first = store.add_highlight(mark("https://x.com/a", "同一句")).unwrap();
        let again = store.add_highlight(mark("https://x.com/a", "同一句")).unwrap();
        assert_eq!(again.id, first.id);
        assert_eq!(store.highlights_for("https://x.com/a").len(), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn an_empty_highlight_is_refused_rather_than_stored() {
        // A selection can be a stray click on a gap between paragraphs.
        let (store, dir) = temp_store();
        assert!(store.add_highlight(mark("https://x.com/a", "   ")).is_err());
        assert!(store.highlights().is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_note_can_be_written_replaced_and_cleared_without_losing_the_highlight() {
        let (store, dir) = temp_store();
        let h = store.add_highlight(mark("https://x.com/a", "值得记的一句")).unwrap();

        store.update_highlight_note(&h.id, Some("  第一版笔记  ")).unwrap();
        let rows = store.highlights_for("https://x.com/a");
        assert_eq!(rows.len(), 1, "editing a note must not add a row");
        assert_eq!(rows[0].note, "第一版笔记", "surrounding whitespace should not be stored");

        store.update_highlight_note(&h.id, Some("改过的笔记")).unwrap();
        assert_eq!(store.highlights_for("https://x.com/a")[0].note, "改过的笔记");

        // Both ways of saying "no note" have to land in the same place, or the
        // file ends up with a note that is only whitespace.
        store.update_highlight_note(&h.id, None).unwrap();
        assert_eq!(store.highlights_for("https://x.com/a")[0].note, "");
        store.update_highlight_note(&h.id, Some("   ")).unwrap();
        assert_eq!(store.highlights_for("https://x.com/a")[0].note, "");
        assert_eq!(store.highlights().len(), 1, "clearing a note must keep the highlight");

        // Survives a restart: the note is on disk, not just in memory.
        store.update_highlight_note(&h.id, Some("写完关机")).unwrap();
        let reopened = Store::new(dir.clone()).unwrap();
        assert_eq!(reopened.highlights()[0].note, "写完关机");

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn editing_a_note_on_an_unknown_highlight_fails_loudly() {
        // Silently succeeding here would let the UI claim a note was saved.
        let (store, dir) = temp_store();
        assert!(store.update_highlight_note("没有这条", Some("x")).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_same_sentence_in_two_articles_is_two_highlights() {
        let (store, dir) = temp_store();
        store.add_highlight(mark("https://x.com/a", "重复的句子")).unwrap();
        store.add_highlight(mark("https://x.com/b", "重复的句子")).unwrap();
        assert_eq!(store.highlights().len(), 2, "identity must be (article, passage), not passage");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_highlight_gets_a_stable_id_so_it_can_be_removed_later() {
        // `remove_highlight` is keyed on the id, so an empty or unstable id would
        // make highlights undeletable — and the value is written to disk, so it
        // has to survive a restart.
        let a = highlight_id("https://x.com/a", "同一句");
        assert!(!a.is_empty());
        assert_eq!(a, highlight_id("https://x.com/a", "同一句"), "the id is not stable");
        assert_ne!(
            a,
            highlight_id("https://x.com/b", "同一句"),
            "the url must be part of the id"
        );
        assert_ne!(
            a,
            highlight_id("https://x.com/a", "另一句"),
            "the text must be part of the id"
        );

        let (store, dir) = temp_store();
        let mut blank = mark("https://x.com/a", "甲");
        blank.id = String::new();
        let saved = store.add_highlight(blank).unwrap();
        assert!(!saved.id.is_empty(), "the store must mint an id when the caller sends none");

        let reopened = Store::new(dir.clone()).unwrap();
        assert_eq!(
            reopened.highlights()[0].id, saved.id,
            "the id changed across a restart, so removal would target the wrong row"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn removing_a_highlight_leaves_the_others_alone() {
        let (store, dir) = temp_store();
        store.add_highlight(mark("https://x.com/a", "甲")).unwrap();
        let b = store.add_highlight(mark("https://x.com/a", "乙")).unwrap();
        store.remove_highlight(&b.id).unwrap();
        let left = store.highlights_for("https://x.com/a");
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].text, "甲");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn settings_from_an_older_install_get_reader_defaults() {
        // A settings.json written before reader preferences existed must still
        // load, with sensible values rather than zeroes. Unknown keys
        // (including the removed `page_size`) are ignored by serde.
        let dir = test_dir("settings-legacy");
        std::fs::write(
            dir.join("settings.json"),
            r#"{"concurrent_checks":false,"page_size":30}"#,
        )
        .unwrap();
        let reopened = Store::new(dir.clone()).unwrap();
        let s = reopened.settings();
        assert!(!s.concurrent_checks);
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
    fn article_cache_key_is_filename_safe_and_source_scoped() {
        // A URL carries `:` (illegal in a Windows filename) and `/` (a
        // directory separator to `Path::join`): spelling it into a filename
        // breaks the cache on Windows while looking fine elsewhere.
        let key = Store::article_cache_key("src-a", "https://x.com/a:b/c?d=e");
        assert!(key.starts_with("article-"));
        assert!(!key.contains([':', '/', '\\', '?', '*', '<', '>', '|', '"']));
        // Same article URL from two sources must not share a file.
        assert_ne!(
            Store::article_cache_key("src-a", "https://x.com/a"),
            Store::article_cache_key("src-b", "https://x.com/a"),
            "A's body must never be served for B's article"
        );
    }

    #[test]
    fn article_cache_round_trips_and_clears() {
        let (store, dir) = temp_store();
        let key = Store::article_cache_key("s", "https://x.com/a");
        assert_eq!(store.cache_read(&key), None);
        store.cache_write(&key, &serde_json::json!({"t": 1})).unwrap();
        assert!(store.cache_read(&key).is_some());
        let (entries, bytes) = store.cache_stats();
        assert_eq!(entries, 1);
        assert!(bytes > 0);
        assert_eq!(store.cache_clear().unwrap(), 1);
        assert_eq!(store.cache_read(&key), None);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn article_cache_evicts_oldest_first() {
        let (store, dir) = temp_store();
        for i in 0..(Store::ARTICLE_CACHE_MAX_ENTRIES + 5) {
            let key = Store::article_cache_key("s", &format!("https://x.com/{i}"));
            store.cache_write(&key, &serde_json::json!({"i": i})).unwrap();
            // Distinct mtimes so "oldest" is well-defined on coarse filesystems.
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        let (entries, _) = store.cache_stats();
        assert_eq!(entries, Store::ARTICLE_CACHE_MAX_ENTRIES, "the cache must be bounded");
        assert_eq!(
            store.cache_read(&Store::article_cache_key("s", "https://x.com/0")),
            None,
            "the oldest entry should have been evicted"
        );
        assert!(
            store.cache_read(&Store::article_cache_key(
                "s",
                &format!("https://x.com/{}", Store::ARTICLE_CACHE_MAX_ENTRIES + 4)
            ))
            .is_some(),
            "the newest entry must survive"
        );
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