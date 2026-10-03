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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Health {
    pub ok: bool,
    pub status: String,
    pub item_count: usize,
    pub checked_at: i64,
    #[serde(default)]
    pub sample: String,
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
}

fn default_true() -> bool {
    true
}
fn default_items() -> usize {
    60
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            concurrent_checks: true,
            page_size: default_items(),
            cache_enabled: false,
            repo_base: "https://www.yck2026.fun".to_string(),
            user_agent: String::new(),
        }
    }
}

#[derive(Debug, Default)]
struct Inner {
    sources: HashMap<String, StoredSource>,
    collections: Vec<Collection>,
    history: Vec<HistoryEntry>,
    settings: Settings,
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
        if let Ok(text) = std::fs::read_to_string(self.path("settings.json")) {
            if let Ok(s) = serde_json::from_str::<Settings>(&text) {
                inner.settings = s;
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
        let mut inner = self.inner.lock().map_err(|_| AppError::Storage("lock poisoned".into()))?;
        if let Some(s) = inner.sources.get_mut(id) {
            s.health = Some(health);
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
        self.write_atomic("history.json", &inner.history)?;
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