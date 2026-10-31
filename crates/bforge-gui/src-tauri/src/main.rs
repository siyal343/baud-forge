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
    workspace: PathBuf,
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
fn start(app: &tauri::AppHandle, path: &Path) -> Result<String, String> {
    let engine = app.state::<Engine>();
    engine.stop();

    let text =
        std::fs::read_to_string(path).map_err(|error| format!("{}: {error}", path.display()))?;
    let config: ProjectConfig =
        toml::from_str(&text).map_err(|error| format!("{}: {error}", path.display()))?;
    let vault = default_vault();

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

    *engine.running.lock().unwrap() = Some(Running {
        port,
        stop,
        workspace: path.to_path_buf(),
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
fn start_workspace(app: tauri::AppHandle, path: String) -> Result<String, String> {
    start(&app, Path::new(&path))
}

/// Load the bundled workbench, pointed at an engine.
fn open_workbench(window: &tauri::WebviewWindow, base: &str) -> Result<(), String> {
    let script = format!("location.replace('index.html?api={base}')");
    window.eval(&script).map_err(|error| error.to_string())
}

#[tauri::command]
fn stop_workspace(app: tauri::AppHandle) {
    app.state::<Engine>().stop();
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
                running.workspace.display()
            )
        })
}

fn main() {
    tauri::Builder::default()
        .manage(Engine::default())
        .invoke_handler(tauri::generate_handler![
            pick_workspace,
            recent_workspaces,
            demo_workspace,
            start_workspace,
            stop_workspace,
            engine_state
        ])
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                restore_geometry(&window);
            }
            // A workspace on the command line still works, which is what a script or a
            // shortcut with an argument does.
            let from_args = std::env::args_os()
                .skip(1)
                .map(PathBuf::from)
                .find(|argument| !argument.to_string_lossy().starts_with("--"));
            if let Some(path) = from_args {
                let handle = app.handle().clone();
                match start(&handle, &path) {
                    Ok(base) => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = open_workbench(&window, &base);
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
