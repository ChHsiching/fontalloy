/// Tauri shell for the shared FontAlloy frontend (ADR-0002, ADR-0004).
///
/// v1 of this shell only hosts the window: local font loading happens in
/// the webview through the FontFace(arrayBuffer) path, and merging will be
/// delegated to the core binary sidecar in a later ticket.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
