pub mod commands;
pub mod engine;
pub mod error;
pub mod model;
pub mod repo;
pub mod render_probe;
pub mod store;
pub mod update;
pub mod util;

use std::sync::Arc;
use tauri::Manager;

/// Build and run the desktop application.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let dir = commands::store_dir(app.handle())?;
            let store = store::Store::new(dir)?;
            app.manage(commands::AppState {
                store: Arc::new(store),
                cancel: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            });

            // Check for a new version shortly after launch. Failures are
            // swallowed so an offline machine is never greeted by an error.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                update::check_on_startup(handle).await;
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_sources,
            commands::get_source,
            commands::source_detail,
            commands::update_source,
            commands::remove_sources,
            commands::import_from_url,
            commands::import_from_text,
            commands::repo_base,
            commands::repo_index,
            commands::categories,
            commands::load_page,
            commands::load_article,
            commands::search_source,
            commands::check_source,
            commands::check_all,
            commands::cancel_check,
            commands::list_history,
            commands::clear_history,
            commands::render_probe,
            commands::continue_reading,
            commands::get_progress,
            commands::save_progress,
            commands::list_collections,
            commands::remove_collection,
            commands::get_settings,
            commands::set_settings,
            commands::clear_cache,
            commands::clear_cookies,
            commands::stats,
            commands::data_dir,
            commands::check_update,
            commands::install_update,
            commands::current_version,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Serious");
}
