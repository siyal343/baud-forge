//! The desktop window (D-62, spec 0036).
//!
//! The shell owns the engine: it opens on a workspace picker, starts a session in this
//! process when a workspace is chosen, and moves the window to the workbench the engine
//! serves. Nothing here touches the contract — one data path, whether a person runs
//! `bforge serve` or this binary.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use bforge_core::ProjectConfig;
use bforge_core::serve::{Server, VaultSource};
use bforge_core::session::{Session, session_ports_from_config};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

/// A session this shell started, and the lever that stops it.
struct Running {
    port: u16,
    stop: Arc<AtomicBool>,
    /// `None` in review mode, where an existing vault is read and nothing records.
    workspace: Option<PathBuf>,
    vault: PathBuf,
}

#[derive(Default)]
struct Engine {
    running: Mutex<Option<Running>>,
}

impl Engine {
    /// Stop the current session, if any. The server thread exits on the flag.
    fn stop(&self) {
        let running = self.running.lock().unwrap().take();
        if let Some(running) = running {
            running
                .stop
                .store(true, std::sync::atomic::Ordering::Relaxed);
            // The server polls the flag every few milliseconds; give it a moment so the
            // vault is sealed before another session can start.
            std::thread::sleep(std::time::Duration::from_millis(250));
        }
    }
}

/// Where the workbench assets live: beside the executable, or the repository's build.
fn ui_directory() -> Option<PathBuf> {
    let beside = std::env::current_exe().ok()?.parent()?.join("ui");
    if beside.join("index.html").exists() {
        return Some(beside);
    }
    let repository = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../ui/dist");
    repository.join("index.html").exists().then_some(repository)
}

fn default_vault() -> PathBuf {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_secs())
        .unwrap_or(0);
    std::env::temp_dir().join(format!("bforge-gui-{stamp}.bflog"))
}

/// Window geometry, kept beside the workspace list so a launch looks like the last one.
fn geometry_path() -> Option<PathBuf> {
    recent_path().and_then(|path| path.parent().map(|parent| parent.join("window.json")))
}

/// The window bits the geometry code needs, from either handle type Tauri hands out.
trait GeometryWindow {
    fn outer_position(&self) -> tauri::Result<tauri::PhysicalPosition<i32>>;
    fn inner_size(&self) -> tauri::Result<tauri::PhysicalSize<u32>>;
    fn set_size(&self, size: tauri::PhysicalSize<u32>) -> tauri::Result<()>;
    fn set_position(&self, position: tauri::PhysicalPosition<i32>) -> tauri::Result<()>;
}

impl GeometryWindow for &tauri::WebviewWindow {
    fn outer_position(&self) -> tauri::Result<tauri::PhysicalPosition<i32>> {
        tauri::WebviewWindow::outer_position(self)
    }
    fn inner_size(&self) -> tauri::Result<tauri::PhysicalSize<u32>> {
        tauri::WebviewWindow::inner_size(self)
    }
    fn set_size(&self, size: tauri::PhysicalSize<u32>) -> tauri::Result<()> {
        tauri::WebviewWindow::set_size(self, size)
    }
    fn set_position(&self, position: tauri::PhysicalPosition<i32>) -> tauri::Result<()> {
        tauri::WebviewWindow::set_position(self, position)
    }
}

impl GeometryWindow for &tauri::Window {
    fn outer_position(&self) -> tauri::Result<tauri::PhysicalPosition<i32>> {
        tauri::Window::outer_position(self)
    }
    fn inner_size(&self) -> tauri::Result<tauri::PhysicalSize<u32>> {
        tauri::Window::inner_size(self)
    }
    fn set_size(&self, size: tauri::PhysicalSize<u32>) -> tauri::Result<()> {
        tauri::Window::set_size(self, size)
    }
    fn set_position(&self, position: tauri::PhysicalPosition<i32>) -> tauri::Result<()> {
        tauri::Window::set_position(self, position)
    }
}

#[derive(serde::Serialize, serde::Deserialize)]
struct Geometry {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

fn save_geometry(window: impl GeometryWindow) {
    // Resize and move events arrive in bursts: write at most once a second.
    static LAST: Mutex<Option<std::time::Instant>> = Mutex::new(None);
    {
        let mut last = LAST.lock().unwrap();
        if let Some(at) = *last
            && at.elapsed() < std::time::Duration::from_millis(800)
        {
            return;
        }
        *last = Some(std::time::Instant::now());
    }
    let (Ok(position), Ok(size)) = (window.outer_position(), window.inner_size()) else {
        return;
    };
    let geometry = Geometry {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    };
    let Some(path) = geometry_path() else { return };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(text) = serde_json::to_string_pretty(&geometry) {
        let _ = std::fs::write(path, text);
    }
}

fn restore_geometry(window: impl GeometryWindow) {
    let Some(path) = geometry_path() else { return };
    let Ok(text) = std::fs::read_to_string(path) else {
        return;
    };
    let Ok(geometry) = serde_json::from_str::<Geometry>(&text) else {
        return;
    };
    let _ = window.set_size(tauri::PhysicalSize::new(
        geometry.width.max(640),
        geometry.height.max(480),
    ));
    let _ = window.set_position(tauri::PhysicalPosition::new(geometry.x, geometry.y));
}

/// The workspace list, kept beside the application's other settings.
fn recent_path() -> Option<PathBuf> {
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from))
        .or_else(|| std::env::var_os("HOME").map(PathBuf::from))?;
    Some(base.join("BaudForge").join("recent.json"))
}

fn read_recent() -> Vec<String> {
    let Some(path) = recent_path() else {
        return Vec::new();
    };
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    serde_json::from_str::<Vec<String>>(&text).unwrap_or_default()
}

fn remember(path: &Path) {
    let Some(file) = recent_path() else {
        return;
    };
    let mut recent = read_recent();
    let entry = path.display().to_string();
    recent.retain(|item| item != &entry);
    recent.insert(0, entry);
    recent.truncate(8);
    if let Some(parent) = file.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(text) = serde_json::to_string_pretty(&recent) {
        let _ = std::fs::write(file, text);
    }
}

/// Start a session from a workspace, and return the URL it serves.
fn start(app: &tauri::AppHandle, path: &Path, vault: Option<PathBuf>) -> Result<String, String> {
    let engine = app.state::<Engine>();
    engine.stop();

    let text =
        std::fs::read_to_string(path).map_err(|error| format!("{}: {error}", path.display()))?;
    let config: ProjectConfig =
        toml::from_str(&text).map_err(|error| format!("{}: {error}", path.display()))?;
    let vault = vault.unwrap_or_else(default_vault);

    let ports = session_ports_from_config(&config, &[]).map_err(|error| error.to_string())?;
    let mut session = Session::start(ports, Some(&vault), config.workspace.elf_path.clone())
        .map_err(|error| format!("{}: {error}", vault.display()))?;
    session
        .enable_decode(&config.ports)
        .map_err(|error| error.to_string())?;
    session
        .enable_bridges(&config.bridges)
        .map_err(|error| error.to_string())?;
    if let Some(script) = config.workspace.script_path.as_deref() {
        session
            .enable_script(Path::new(script))
            .map_err(|error| error.to_string())?;
    }
    if let Some(script) = config.workspace.rx_script_path.as_deref() {
        session
            .enable_rx_script(Path::new(script))
            .map_err(|error| error.to_string())?;
    }
    if let Some(elf) = config.workspace.elf_path.as_deref() {
        // A stale image must not stop a session: the badge is a bonus.
        let _ = session.enable_symbols(Path::new(elf));
    }

    let server = Server::bind("127.0.0.1:0".parse().expect("an address"))
        .map_err(|error| error.to_string())?;
    let port = server
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    let server = match ui_directory() {
        Some(directory) => server.with_ui(directory),
        None => server,
    };
    let server = server.with_vault(VaultSource {
        path: vault.clone(),
        ports: config.ports.clone(),
    });
    let stop = server.stop_handle();

    std::thread::spawn(move || {
        if let Err(error) = server.run(session, None) {
            eprintln!("bforge-gui: the engine stopped: {error}");
        }
    });

    // The vault cannot describe itself yet, so the workspace is copied beside it. Review
    // reads that copy, which is what makes a reviewed capture decode (D-111).
    let sidecar = vault.with_extension("bforge.toml");
    if sidecar != path {
        let _ = std::fs::copy(path, &sidecar);
    }

    *engine.running.lock().unwrap() = Some(Running {
        port,
        stop,
        workspace: Some(path.to_path_buf()),
        vault,
    });
    remember(path);
    Ok(format!("http://127.0.0.1:{port}"))
}

#[tauri::command]
fn pick_workspace() -> Option<String> {
    let file = rfd::FileDialog::new()
        .add_filter("workspace", &["toml"])
        .set_title("Open a BaudForge workspace")
        .pick_file()?;
    Some(file.display().to_string())
}

#[tauri::command]
fn recent_workspaces() -> Vec<String> {
    read_recent()
}

/// The example workspace that needs no hardware, if it is beside the binary.
#[tauri::command]
fn demo_workspace(app: tauri::AppHandle) -> Result<String, String> {
    let beside = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf));
    let candidates = [
        beside
            .clone()
            .map(|dir| dir.join("examples/loopback-demo.bforge.toml")),
        Some(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../../examples/loopback-demo.bforge.toml"),
        ),
    ];
    let Some(path) = candidates.into_iter().flatten().find(|path| path.exists()) else {
        return Err(
            "the demo workspace is not installed next to the application; open your own instead"
                .to_string(),
        );
    };
    let _ = app;
    Ok(path.display().to_string())
}

#[tauri::command]
fn start_workspace(
    app: tauri::AppHandle,
    path: String,
    vault: Option<String>,
) -> Result<String, String> {
    start(&app, Path::new(&path), vault.map(PathBuf::from))
}

/// Choose where the next session records. The name comes from the workspace.
#[tauri::command]
fn pick_vault(suggest: String) -> Option<String> {
    rfd::FileDialog::new()
        .add_filter("BaudForge vault", &["bflog"])
        .set_title("Where should this session record?")
        .set_file_name(&suggest)
        .save_file()
        .map(|path| path.display().to_string())
}

/// Open a recorded vault to read it: no ports, no recording, the file is not written.
///
/// The session is started without a writer, so review cannot damage the file it opens.
#[tauri::command]
fn start_review(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let vault = PathBuf::from(&path);
    bforge_storage::LogReader::open(&vault).map_err(|error| format!("{}: {error}", path))?;

    // A workspace copied beside the vault gives the review its port names and schema. A
    // vault without one still reads, as raw records.
    let sidecar = vault.with_extension("bforge.toml");
    let config = std::fs::read_to_string(&sidecar)
        .ok()
        .and_then(|text| toml::from_str::<ProjectConfig>(&text).ok());
    let ports = config
        .as_ref()
        .map(|config| config.ports.clone())
        .unwrap_or_default();

    let engine = app.state::<Engine>();
    engine.stop();

    let session = Session::review();
    let server = Server::bind("127.0.0.1:0".parse().expect("an address"))
        .map_err(|error| error.to_string())?;
    let port = server
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    let server = match ui_directory() {
        Some(directory) => server.with_ui(directory),
        None => server,
    };
    let server = server.with_vault(VaultSource {
        path: vault.clone(),
        ports,
    });
    let stop = server.stop_handle();
    std::thread::spawn(move || {
        if let Err(error) = server.run(session, None) {
            eprintln!("bforge-gui: the review engine stopped: {error}");
        }
    });

    *engine.running.lock().unwrap() = Some(Running {
        port,
        stop,
        workspace: None,
        vault,
    });
    Ok(format!("http://127.0.0.1:{port}"))
}

/// Load the bundled workbench, pointed at an engine and optionally at traces.
///
/// `plot` takes `port.field:mode` entries, so a shortcut can open a view directly:
/// `bforge-gui workspace.toml --plot obc.flags:bits`.
fn open_workbench(
    window: &tauri::WebviewWindow,
    base: &str,
    plot: Option<&str>,
    rows: Option<&str>,
    query: Option<&str>,
) -> Result<(), String> {
    // A nonce per launch: the webview caches the bundle by URL, and a rebuilt frontend
    // served at the same address is not revalidated. Without this, a new build can be
    // invisible until the cache is cleared by hand.
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_millis())
        .unwrap_or(0);
    let mut url = format!("index.html?api={base}&v={nonce}");
    if let Some(rows) = rows {
        url.push_str(&format!("&rows={rows}"));
    }
    if let Some(query) = query {
        // Raw extra parameters, for a view that is easier to describe than to click:
        // `--query "play=1"`.
        let trimmed = query.trim_start_matches('&');
        if !trimmed.is_empty() {
            url.push('&');
            url.push_str(trimmed);
        }
    }
    if let Some(plot) = plot {
        let encoded: String = plot
            .chars()
            .map(|character| match character {
                ':' => "%3A".to_string(),
                ',' => "%2C".to_string(),
                other => other.to_string(),
            })
            .collect();
        url.push_str(&format!("&plot={encoded}"));
    }
    let script = format!("location.replace('{url}')");
    window.eval(&script).map_err(|error| error.to_string())
}

#[tauri::command]
fn stop_workspace(app: tauri::AppHandle) {
    app.state::<Engine>().stop();
}

/// Write the vault beside itself in a format the person can open elsewhere (FR-STO-02).
///
/// The window has no download shelf, so this writes the file and reports where it went
/// rather than handing bytes to a browser.
#[tauri::command]
fn export_vault(app: tauri::AppHandle, format: String) -> Result<String, String> {
    let vault = {
        let running = app.state::<Engine>();
        let guard = running.running.lock().unwrap();
        guard
            .as_ref()
            .map(|running| running.vault.clone())
            .ok_or("no session to export")?
    };
    let Some(format) = bforge_storage::format_from_name(&format) else {
        return Err(format!(
            "unknown format; use {}",
            bforge_storage::FORMAT_NAMES
        ));
    };
    let mut reader = bforge_storage::LogReader::open(&vault)
        .map_err(|error| format!("{}: {error}", vault.display()))?;
    let out = vault.with_extension(bforge_storage::format_extension(format));
    let mut file =
        std::fs::File::create(&out).map_err(|error| format!("{}: {error}", out.display()))?;
    bforge_storage::export(&mut reader, format, &mut file)
        .map_err(|error| format!("{}: {error}", out.display()))?;
    Ok(out.display().to_string())
}

#[tauri::command]
fn engine_state(app: tauri::AppHandle) -> Option<String> {
    app.state::<Engine>()
        .running
        .lock()
        .unwrap()
        .as_ref()
        .map(|running| {
            format!(
                "http://127.0.0.1:{}/ {}",
                running.port,
                running
                    .workspace
                    .as_ref()
                    .map(|path| path.display().to_string())
                    .unwrap_or_else(|| "review".to_string())
            )
        })
}

fn main() {
    tauri::Builder::default()
        .manage(Engine::default())
        .invoke_handler(tauri::generate_handler![
            pick_workspace,
            pick_vault,
            start_review,
            recent_workspaces,
            demo_workspace,
            start_workspace,
            stop_workspace,
            export_vault,
            engine_state
        ])
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                restore_geometry(&window);
            }
            // A workspace on the command line still works, which is what a script or a
            // shortcut with an argument does.
            let mut args = std::env::args_os().skip(1);
            let mut plot: Option<String> = None;
            let mut rows: Option<String> = None;
            let mut query: Option<String> = None;
            let mut workspace: Option<PathBuf> = None;
            let mut vault_arg: Option<PathBuf> = None;
            let mut review = false;
            while let Some(argument) = args.next() {
                let text = argument.to_string_lossy().to_string();
                if text == "--plot" {
                    plot = args.next().map(|value| value.to_string_lossy().to_string());
                } else if text == "--rows" {
                    rows = args.next().map(|value| value.to_string_lossy().to_string());
                } else if text == "--query" {
                    query = args.next().map(|value| value.to_string_lossy().to_string());
                } else if text == "--vault" {
                    vault_arg = args.next().map(PathBuf::from);
                } else if text == "--review" {
                    review = true;
                } else if !text.starts_with("--") {
                    workspace = Some(PathBuf::from(argument));
                }
            }
            // A vault on its own is a capture to review; `--vault` beside a workspace is
            // where that session records.
            let reviewing = match (vault_arg.clone(), workspace.clone()) {
                (Some(vault), None) => Some(vault),
                (Some(vault), Some(_)) if review => Some(vault),
                (None, Some(path)) if path.extension().is_some_and(|kind| kind == "bflog") => {
                    Some(path)
                }
                _ => None,
            };
            if let Some(vault) = reviewing {
                let handle = app.handle().clone();
                match start_review(handle, vault.display().to_string()) {
                    Ok(base) => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = open_workbench(
                                &window,
                                &base,
                                plot.as_deref(),
                                rows.as_deref(),
                                Some("review=1"),
                            );
                        }
                    }
                    Err(error) => eprintln!("bforge-gui: {error}"),
                }
                return Ok(());
            }
            if let Some(path) = workspace {
                let handle = app.handle().clone();
                match start(&handle, &path, vault_arg) {
                    Ok(base) => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = open_workbench(
                                &window,
                                &base,
                                plot.as_deref(),
                                rows.as_deref(),
                                query.as_deref(),
                            );
                        }
                    }
                    Err(error) => eprintln!("bforge-gui: {error}"),
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Moved(_) => {
                save_geometry(window);
            }
            tauri::WindowEvent::CloseRequested { .. } => save_geometry(window),
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("the window failed to start");
}

use tauri::Manager;
