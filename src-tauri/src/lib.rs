pub mod commands;
pub mod engine;
pub mod error;
pub mod model;
pub mod reading_stats;
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

            // Give the engine a way to render a page when the ordinary fetch
            // finds nothing on a source that needs JavaScript. Registered here
            // because only the app holds a window handle.
            {
                let handle = app.handle().clone();
                engine::browse::set_renderer(Arc::new(move |url: &str| {
                    render_probe::fetch_rendered(&handle, url).ok()
                }));
            }

            // The render switch is a stored preference, not a constant.
            engine::browse::set_render_enabled(
                app.state::<commands::AppState>().store.settings().render_js,
            );

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
            commands::list_shelf,
            commands::add_shelf,
            commands::remove_shelf,
            commands::shelf_progress,
            commands::list_highlights,
            commands::highlights_for,
            commands::add_highlight,
            commands::remove_highlight,
            commands::update_highlight_note,
            commands::fetch_text,
            commands::clear_history,
            commands::render_probe,
            commands::render_html,
            commands::continue_reading,
            commands::get_progress,
            commands::get_progress_many,
            commands::save_progress,
            commands::reading_stats,
            commands::list_collections,
            commands::remove_collection,
            commands::get_settings,
            commands::set_settings,
            commands::clear_cache,
            commands::cache_stats,
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
