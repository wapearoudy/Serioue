use serde::Serialize;
use std::sync::{Arc, Mutex, MutexGuard};
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

/// Progress reported while an update is downloading.
#[derive(Debug, Clone, Serialize)]
pub struct UpdateProgress {
    pub downloaded: u64,
    pub total: Option<u64>,
    /// 0-100, or `None` when the total size is unknown.
    pub percent: Option<u8>,
}

/// What `check_update` found.
#[derive(Debug, Clone, Serialize)]
pub struct UpdateInfo {
    pub available: bool,
    pub version: String,
    pub current_version: String,
    pub date: Option<String>,
    pub body: Option<String>,
}

/// Why an update check failed.
///
/// "No release published yet" is a normal state for a young project, not a
/// malfunction, and showing it as a red error makes a working feature look
/// broken.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum UpdateFailure {
    /// The machine cannot reach the update endpoint.
    Offline,
    /// The endpoint answered, but there is no release to install — either the
    /// project has never published one, or the latest release is still a draft.
    NoRelease,
    /// Anything else, including a signature that does not verify.
    Other,
}

/// An error the frontend can act on.
#[derive(Debug, Clone, Serialize)]
pub struct UpdateError {
    pub message: String,
    /// True when the failure looks like "no network" rather than "no update".
    pub offline: bool,
    pub reason: UpdateFailure,
}

impl UpdateError {
    fn new(message: String) -> Self {
        let reason = classify(&message);
        Self { offline: reason == UpdateFailure::Offline, message, reason }
    }
}

/// Cached update between the check and the install click, so the download does
/// not have to re-query GitHub.
static PENDING: Mutex<Option<tauri_plugin_updater::Update>> = Mutex::new(None);

/// Lock helper that ignores poisoning: a panicked download must not brick the
/// updater for the rest of the session.
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

pub async fn check(app: &AppHandle) -> Result<UpdateInfo, UpdateError> {
    let current = app.package_info().version.to_string();

    let updater = app
        .updater()
        .map_err(|e| UpdateError::new(e.to_string()))?;

    match updater.check().await {
        Ok(Some(update)) => {
            let info = UpdateInfo {
                available: true,
                version: update.version.clone(),
                current_version: current,
                date: update.date.map(|d| d.to_string()),
                body: update.body.clone(),
            };
            // Hold on to it so `install_update` can reuse the manifest.
            *lock(&PENDING) = Some(update);
            Ok(info)
        }
        Ok(None) => {
            *lock(&PENDING) = None;
            Ok(UpdateInfo {
                available: false,
                version: String::new(),
                current_version: current,
                date: None,
                body: None,
            })
        }
        Err(e) => {
            let message = e.to_string();
            Err(UpdateError::new(message))
        }
    }
}

/// Download and install a previously-checked update.
pub async fn install(app: &AppHandle) -> Result<(), UpdateError> {
    let cached = lock(&PENDING).take();

    let update = match cached {
        Some(u) => u,
        None => {
            // Nothing cached (for example after a restart): check again.
            let updater = app.updater().map_err(|e| UpdateError::new(e.to_string()))?;
            let found = updater.check().await.map_err(|e| UpdateError::new(e.to_string()))?;
            match found {
                Some(u) => u,
                None => {
                    return Err(UpdateError {
                        message: "没有可安装的新版本".into(),
                        offline: false,
                        reason: UpdateFailure::Other,
                    })
                }
            }
        }
    };

    download_and_install(app, update).await
}

async fn download_and_install(
    app: &AppHandle,
    update: tauri_plugin_updater::Update,
) -> Result<(), UpdateError> {
    // Both callbacks need the running totals, and each closure needs its own
    // handle, so the state is shared behind an Arc rather than moved twice.
    let progress = Arc::new(Mutex::new((0u64, None::<u64>)));
    let p_chunk = Arc::clone(&progress);
    let p_done = Arc::clone(&progress);
    let h_chunk = app.clone();
    let h_done = app.clone();

    update
        .download_and_install(
            move |chunk, content_length| {
                let (downloaded, total) = {
                    let mut guard = lock(&p_chunk);
                    guard.0 += chunk as u64;
                    if let Some(len) = content_length {
                        guard.1 = Some(len);
                    }
                    *guard
                };
                let percent = total
                    .filter(|t| *t > 0)
                    .map(|t| ((downloaded as f64 / t as f64) * 100.0).clamp(0.0, 100.0) as u8);
                let _ = h_chunk.emit(
                    "update-progress",
                    UpdateProgress { downloaded, total, percent },
                );
            },
            move || {
                let (downloaded, total) = *lock(&p_done);
                let _ = h_done.emit(
                    "update-progress",
                    UpdateProgress { downloaded, total, percent: Some(100) },
                );
            },
        )
        .await
        .map_err(|e| UpdateError::new(e.to_string()))
}

/// Heuristic: distinguish connectivity problems from "you are up to date".
fn is_offline_error(message: &str) -> bool {
    let m = message.to_lowercase();
    // Both "timeout" and "timed out" appear in reqwest/hyper errors.
    m.contains("dns")
        || m.contains("resolve")
        || m.contains("connect")
        || m.contains("timeout")
        || m.contains("timed out")
        || m.contains("network")
        || m.contains("offline")
        || m.contains("failed to fetch")
        // reqwest's generic transport failure. For the updater this always
        // means "we never reached GitHub", so telling the user to check their
        // network is the actionable answer.
        || m.contains("error sending request")
        || m.contains("request failed")
}

/// Sort an updater failure into a state the UI can present honestly.
///
/// Order matters: a missing `latest.json` must be recognised *before* the
/// generic fetch heuristics, otherwise "could not fetch ..." reads as a
/// connectivity problem and the user is told to check their network.
fn classify(message: &str) -> UpdateFailure {
    let m = message.to_lowercase();

    // What tauri-plugin-updater says when the endpoint is missing or is not a
    // release manifest — a 404 from `releases/latest/download/latest.json`.
    if m.contains("could not fetch a valid release json")
        || m.contains("valid release json")
        || m.contains("404")
        || m.contains("not found")
    {
        return UpdateFailure::NoRelease;
    }

    if is_offline_error(&m) {
        return UpdateFailure::Offline;
    }
    UpdateFailure::Other
}

/// Check once on startup, silently ignoring failures.
///
/// A user with no network should not be greeted by an update error, so this
/// never surfaces one; the settings page offers an explicit check.
pub async fn check_on_startup(app: AppHandle) {
    // Small delay so the window paints first.
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;

    if let Ok(info) = check(&app).await {
        if info.available {
            let _ = app.emit("update-available", &info);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_offline_errors() {
        assert!(is_offline_error("error sending request: dns error"));
        assert!(is_offline_error("operation timed out"));
        assert!(is_offline_error("connect timeout"));
        assert!(!is_offline_error("404 Not Found"));
        assert!(!is_offline_error("invalid signature"));
    }

    #[test]
    fn a_missing_manifest_is_not_reported_as_offline() {
        // This is the exact string the plugin returns when no release exists.
        let message = "Could not fetch a valid release JSON from the remote";
        assert_eq!(classify(message), UpdateFailure::NoRelease);
        // The user must not be told to check their network.
        assert!(!is_offline_error(message), "{message}");
    }

    #[test]
    fn a_404_is_a_missing_release_not_a_network_problem() {
        assert_eq!(classify("404 Not Found"), UpdateFailure::NoRelease);
    }

    #[test]
    fn real_network_failures_still_read_as_offline() {
        assert_eq!(classify("error sending request: dns error"), UpdateFailure::Offline);
        assert_eq!(classify("request timed out"), UpdateFailure::Offline);
    }

    #[test]
    fn reqwest_transport_errors_read_as_offline() {
        // What the updater reports when the host cannot be reached at all.
        let message = "error sending request for url (https://github.com/a/b/releases/latest/download/latest.json)";
        assert_eq!(classify(message), UpdateFailure::Offline);
        assert!(UpdateError::new(message.to_string()).offline);
    }

    #[test]
    fn a_signature_failure_is_its_own_thing() {
        assert_eq!(classify("invalid signature"), UpdateFailure::Other);
    }

    #[test]
    fn the_error_carries_its_own_classification() {
        let e = UpdateError::new("Could not fetch a valid release JSON from the remote".into());
        assert_eq!(e.reason, UpdateFailure::NoRelease);
        assert!(!e.offline);

        let e = UpdateError::new("dns error".into());
        assert!(e.offline);
    }

    #[test]
    fn percent_math() {
        let percent = |d: u64, t: Option<u64>| -> Option<u8> {
            t.filter(|t| *t > 0)
                .map(|t| ((d as f64 / t as f64) * 100.0).clamp(0.0, 100.0) as u8)
        };
        assert_eq!(percent(50, Some(100)), Some(50));
        assert_eq!(percent(200, Some(100)), Some(100));
        assert_eq!(percent(50, None), None);
        assert_eq!(percent(5, Some(0)), None);
    }
}