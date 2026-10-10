/// Tauri shell for the shared FontAlloy frontend (ADR-0002, ADR-0004).
///
/// v1 of this shell hosts the window and the catalog storage: the webview
/// downloads the font catalog (issue #17) into the app's writable data
/// directory through the fs plugin, restricted to `catalog/` under
/// `appDataDir()` — the same on-disk layout the core binary sidecar will
/// read in a later ticket. Merging is delegated to that sidecar.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
