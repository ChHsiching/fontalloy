/// Tauri shell for the shared FontAlloy frontend (ADR-0002, ADR-0004).
///
/// The shell owns four native capabilities the webview cannot:
///
/// 1. **The core sidecar** (issue #16): the bundled `fontalloy` binary is
///    spawned as `fontalloy serve --port 0` with the app's catalog font
///    directory (`appDataDir/catalog/families`) as `--font-dir` — the
///    same on-disk layout the webview downloads into (issue #17) — and
///    the webview origins on the CORS allowlist. The bound URL is read
///    from the sidecar's stdout startup line and handed to the frontend
///    through the `serve_url` command (and a `serve-ready` event); the
///    child is killed on app exit so no orphaned service survives.
/// 2. **Local font files with real paths**: the native open dialog
///    (`pick_font_files`) returns absolute paths, and `read_font_file`
///    streams the bytes back over the raw IPC pipe — recipes can name
///    the file, and no fs-scope widening beyond the catalog is needed.
///    `list_font_dir` (round 13) lists the font files beside a picked
///    file so one pick registers the family sitting next to it.
/// 3. **The artifact save** (round 12): synthesis writes each built
///    font straight into the configured output directory — `park_save_path`
///    joins and parks `<output dir>/<name>` (no dialog), and
///    `save_artifact` then receives the font bytes as a raw IPC body (no
///    JSON serialization of a multi-MB font) and writes them there.
///    `default_output_dir` resolves the directory (`<OS Downloads>/fontalloy`,
///    the app-data fonts dir as the fallback when no download dir
///    exists), and `pick_output_dir` backs the 设置 entry 输出目录.
///    The native save dialog survives as the EXPLICIT export:
///    `prepare_save` runs it and parks the chosen path for
///    `save_artifact` (the 另存为 affordance on a completed row).
/// 4. **Clipboard-read enablement** (round 18): the main window is
///    built in `run` with `enable_clipboard_access`, so the kit context
///    menu's 粘贴 can read `navigator.clipboard` (denied on WebView2
///    without it).

use std::path::PathBuf;
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager, RunEvent, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// How long `serve_url` waits for the sidecar's startup line.
const SERVE_STARTUP_TIMEOUT: Duration = Duration::from_secs(10);

/// The webview origins allowed on the sidecar's CORS allowlist: the
/// packaged Windows origin, the packaged macOS/Linux origin, and the
/// Vite dev server (`tauri dev` loads the webview from there).
const ALLOWED_ORIGINS: [&str; 3] = [
    "http://tauri.localhost",
    "tauri://localhost",
    "http://localhost:5173",
];

/// Shared state between the spawn thread, the commands, and shutdown.
#[derive(Default)]
struct ShellState {
    /// The bound service URL, set once the startup line arrives.
    serve_url: Mutex<Option<String>>,
    serve_url_changed: Condvar,
    /// The live sidecar child, killed on app exit.
    sidecar: Mutex<Option<CommandChild>>,
    /// The path chosen by the last `prepare_save`, consumed by
    /// `save_artifact`.
    pending_save: Mutex<Option<PathBuf>>,
}

/// The startup-line contract (ticket #11): exactly one stdout line,
/// `http://127.0.0.1:<port>`.
fn parse_startup_line(line: &str) -> Option<String> {
    let trimmed = line.trim_end();
    let port = trimmed.strip_prefix("http://127.0.0.1:")?;
    if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) {
        Some(trimmed.to_string())
    } else {
        None
    }
}

/// The bound serve URL, waiting (bounded) for the startup line.
///
/// `None` means the sidecar did not come up (missing binary, failed
/// bind) — the frontend renders that as "service unavailable" and the
/// app stays otherwise fully usable.
#[tauri::command]
async fn serve_url(state: State<'_, ShellState>) -> Result<Option<String>, String> {
    let mut guard = state
        .serve_url
        .lock()
        .map_err(|_| "shell state poisoned")?;
    let deadline = Instant::now() + SERVE_STARTUP_TIMEOUT;
    while guard.is_none() {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Ok(None);
        }
        let (next, timed_out) = state
            .serve_url_changed
            .wait_timeout(guard, remaining)
            .map_err(|_| "shell state poisoned")?;
        guard = next;
        if timed_out.timed_out() && guard.is_none() && Instant::now() >= deadline {
            return Ok(None);
        }
    }
    Ok(guard.clone())
}

/// Native multi-select font dialog; `null` when it could not open.
#[tauri::command]
async fn pick_font_files(app: AppHandle) -> Result<Option<Vec<String>>, String> {
    let picked = app
        .dialog()
        .file()
        .add_filter("字体文件", &["ttf", "otf", "ttc", "woff2", "woff"])
        .blocking_pick_files();
    match picked {
        None => Ok(None),
        Some(files) => {
            let mut paths = Vec::new();
            for file in files {
                paths.push(
                    file.into_path()
                        .map_err(|err| err.to_string())?
                        .to_string_lossy()
                        .into_owned(),
                );
            }
            Ok(Some(paths))
        }
    }
}

/// Read one font file as raw bytes (the zero-JSON binary pipe).
#[tauri::command]
fn read_font_file(path: String) -> Result<tauri::ipc::Response, String> {
    let bytes = std::fs::read(&path)
        .map_err(|err| format!("无法读取 {path}: {err}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// The font file extensions the sibling scan considers — the same set
/// the pick dialog filters on.
const FONT_EXTENSIONS: [&str; 5] = ["ttf", "otf", "ttc", "woff2", "woff"];

/// List the font files beside a picked file (round 13, owner item 7).
///
/// The frontend's local family discovery scans the PARENT directory of
/// a file the user explicitly picked through the dialog — never an
/// arbitrary path — so one pick can register the whole family's faces
/// sitting next to it. Entries are filtered to the font suffixes and
/// returned sorted, as full paths.
#[tauri::command]
fn list_font_dir(path: String) -> Result<Vec<String>, String> {
    let picked = std::path::Path::new(&path);
    let directory = picked
        .parent()
        .ok_or_else(|| "所拾文件没有父目录".to_string())?;
    let entries = std::fs::read_dir(directory)
        .map_err(|err| format!("无法列出 {}: {err}", directory.display()))?;
    let mut fonts = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|err| err.to_string())?;
        let candidate = entry.path();
        let is_font = candidate.is_file()
            && candidate
                .extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| FONT_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
                .unwrap_or(false);
        if is_font {
            fonts.push(candidate.to_string_lossy().into_owned());
        }
    }
    fonts.sort();
    Ok(fonts)
}

/// Run the native save dialog and park the chosen path. `default_name`
/// suggests the file name; `None` = the user canceled. This is the
/// EXPLICIT 另存为 flow only — synthesis itself saves without a dialog
/// (round 12).
#[tauri::command]
async fn prepare_save(
    app: AppHandle,
    state: State<'_, ShellState>,
    default_name: String,
) -> Result<Option<String>, String> {
    let extension = default_name.rsplit_once('.').map(|(_, ext)| ext.to_string());
    let dialog = app.dialog().file().set_file_name(&default_name);
    let dialog = match extension.as_deref() {
        Some(ext) => dialog.add_filter("字体输出", &[ext]),
        None => dialog,
    };
    let Some(chosen) = dialog.blocking_save_file() else {
        return Ok(None);
    };
    let path = chosen
        .into_path()
        .map_err(|err| err.to_string())?
        .to_string_lossy()
        .into_owned();
    *state
        .pending_save
        .lock()
        .map_err(|_| "shell state poisoned")? = Some(PathBuf::from(&path));
    Ok(Some(path))
}

/// The default output directory (round 12): `<OS Downloads>/fontalloy`,
/// falling back to the app's own data directory when the platform has
/// no download directory (headless Linux). Created on demand; the same
/// file name saves over whatever the previous build of that name left.
#[tauri::command]
async fn default_output_dir(app: AppHandle) -> Result<String, String> {
    let dir = match app.path().download_dir() {
        Ok(downloads) => downloads.join("fontalloy"),
        Err(_) => app
            .path()
            .app_data_dir()
            .map_err(|err| format!("无法定位输出目录: {err}"))?
            .join("fonts"),
    };
    std::fs::create_dir_all(&dir)
        .map_err(|err| format!("无法创建输出目录 {}: {err}", dir.display()))?;
    Ok(dir.to_string_lossy().into_owned())
}

/// The native directory picker behind the 设置 entry 输出目录.
/// `None` = the user canceled.
#[tauri::command]
async fn pick_output_dir(app: AppHandle) -> Result<Option<String>, String> {
    let Some(chosen) = app.dialog().file().blocking_pick_folder() else {
        return Ok(None);
    };
    Ok(Some(
        chosen
            .into_path()
            .map_err(|err| err.to_string())?
            .to_string_lossy()
            .into_owned(),
    ))
}

/// Join and park the DEFAULT-path save target (`<dir>/<name>`, no
/// dialog); returns the joined path for the completion line.
#[tauri::command]
fn park_save_path(
    state: State<'_, ShellState>,
    dir: String,
    name: String,
) -> Result<String, String> {
    let path = PathBuf::from(&dir).join(&name);
    *state
        .pending_save
        .lock()
        .map_err(|_| "shell state poisoned")? = Some(path.clone());
    Ok(path.to_string_lossy().into_owned())
}

/// Write the built font (raw IPC body) to the parked path — chosen by
/// the 另存为 dialog (`prepare_save`) or joined by the default-path
/// save (`park_save_path`); whichever parked last wins.
#[tauri::command]
fn save_artifact(state: State<'_, ShellState>, request: tauri::ipc::Request) -> Result<(), String> {
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.clone(),
        _ => {
            return Err("save_artifact expects the font bytes as a raw body".to_string());
        }
    };
    let mut pending = state
        .pending_save
        .lock()
        .map_err(|_| "shell state poisoned")?;
    let Some(path) = pending.take() else {
        return Err("没有待保存的路径（请先选择保存位置）".to_string());
    };
    drop(pending);
    std::fs::write(&path, bytes).map_err(|err| format!("无法写入 {}: {err}", path.display()))
}

/// The same-name collision pre-flight (round 17, owner item 3): does
/// the default-path save target `<dir>/<name>` already hold a file?
/// Joins and stats WITHOUT writing; returns `(exists, joined_path)`
/// so the frontend can name the exact colliding target in its prompt.
#[tauri::command]
fn artifact_exists(dir: String, name: String) -> (bool, String) {
    let path = PathBuf::from(&dir).join(&name);
    (
        path.symlink_metadata().is_ok(),
        path.to_string_lossy().into_owned(),
    )
}

/// Open a URL in the SYSTEM browser (round 5, owner item 12): the
/// webview's `<a target="_blank">` is a no-op here, so the top bar's
/// GitHub link routes through this command. https-only by contract.
#[tauri::command]
async fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err("refusing to open a non-https URL".to_string());
    }
    #[allow(deprecated)] // superseded by tauri-plugin-opener (follow-up)
    app.shell()
        .open(url, None)
        .map_err(|err| err.to_string())
}

/// Spawn the `fontalloy serve` sidecar and watch its stdout.
fn spawn_sidecar(handle: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let font_dir = handle
        .path()
        .app_data_dir()?
        .join("catalog")
        .join("families");
    // The catalog may not have downloaded yet — serve treats a missing
    // --font-dir as an empty listing, but create it so downloads land
    // where the sidecar looks.
    std::fs::create_dir_all(&font_dir)?;

    let mut command = handle.shell().sidecar("fontalloy")?;
    command = command.args([
        "serve",
        "--port",
        "0",
        "--font-dir",
        &font_dir.to_string_lossy(),
    ]);
    for origin in ALLOWED_ORIGINS {
        command = command.args(["--allow-origin", origin]);
    }

    let (mut rx, child) = command
        // The sidecar lifecycle watchdog: if the app dies without a
        // chance to kill the process tree, the stdin pipe closes and
        // the service stops itself gracefully (serve's STDIN_WATCH_ENV).
        .env("FONTALLOY_SERVE_STDIN_WATCH", "1")
        .spawn()?;
    let state = handle.state::<ShellState>();
    *state.sidecar.lock().map_err(|_| "state poisoned")? = Some(child);

    let watcher = handle.clone();
    std::thread::spawn(move || {
        while let Some(event) = rx.blocking_recv() {
            match event {
                CommandEvent::Stdout(line) => {
                    let text = String::from_utf8_lossy(&line).into_owned();
                    if let Some(url) = parse_startup_line(&text) {
                        let state = watcher.state::<ShellState>();
                        if let Ok(mut guard) = state.serve_url.lock() {
                            *guard = Some(url.clone());
                        }
                        state.serve_url_changed.notify_all();
                        let _ = watcher.emit("serve-ready", url);
                    }
                }
                CommandEvent::Stderr(line) => {
                    // serve's fatal startup errors go to stderr; surface
                    // them on our own stderr for release diagnostics.
                    let text = String::from_utf8_lossy(&line).into_owned();
                    eprint!("[fontalloy-sidecar] {text}");
                }
                CommandEvent::Error(err) => {
                    eprintln!("[fontalloy-sidecar] {err}");
                }
                CommandEvent::Terminated(status) => {
                    eprintln!("[fontalloy-sidecar] terminated: {status:?}");
                    break;
                }
                _ => {}
            }
        }
    });
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(ShellState::default())
        .invoke_handler(tauri::generate_handler![
            serve_url,
            pick_font_files,
            read_font_file,
            list_font_dir,
            prepare_save,
            save_artifact,
            default_output_dir,
            pick_output_dir,
            park_save_path,
            artifact_exists,
            open_external
        ])
        .setup(|app| {
            // The main window is built HERE, not in tauri.conf.json: the
            // round-18 context menu's 粘贴 reads `navigator.clipboard
            // .readText()`, and on WebView2 that read is denied unless the
            // webview's clipboard attribute is set — a builder-time-only
            // switch (`enable_clipboard_access`; there is no config key
            // for it, and no IPC capability to grant, because the async
            // Clipboard API never crosses Tauri's permission system).
            // Every other property replicates the config window this
            // replaces: same "main" label (the capabilities' window
            // selector), title, size, minimums, and frameless mode.
            tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::default(),
            )
            .title("FontAlloy")
            .inner_size(1280.0, 800.0)
            .min_inner_size(960.0, 600.0)
            .decorations(false)
            .enable_clipboard_access()
            .build()
            .expect("failed to create the main window");

            let handle = app.handle().clone();
            // The sidecar is spawn-critical for merging, not for the app:
            // a failure leaves the shell up with "service unavailable".
            if let Err(err) = spawn_sidecar(&handle) {
                eprintln!("[fontalloy-sidecar] failed to spawn: {err}");
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                // Kill the sidecar so no orphaned service survives the app.
                if let Ok(mut guard) = app.state::<ShellState>().sidecar.lock() {
                    if let Some(child) = guard.take() {
                        let _ = child.kill();
                    }
                }
            }
        });
}
