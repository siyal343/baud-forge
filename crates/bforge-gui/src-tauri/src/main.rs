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
    Ok(format!("http://127.0.0.1:{port}/"))
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
            // A workspace on the command line still works, which is what a script or a
            // shortcut with an argument does.
            let from_args = std::env::args_os()
                .skip(1)
                .map(PathBuf::from)
                .find(|argument| !argument.to_string_lossy().starts_with("--"));
            if let Some(path) = from_args {
                let handle = app.handle().clone();
                match start(&handle, &path) {
                    Ok(url) => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.navigate(url.parse().expect("a URL"));
                        }
                    }
                    Err(error) => eprintln!("bforge-gui: {error}"),
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("the window failed to start");
}

use tauri::Manager;
