//! The desktop window (D-62).
//!
//! The window is a WebView2 view onto the same HTTP surface the browser uses: the
//! engine runs on a thread, the workbench is the built `ui/dist`, and nothing here
//! touches the contract. One data path, one set of panels, whether a person runs
//! `bforge serve` or this binary.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use bforge_core::ProjectConfig;
use bforge_core::serve::{Server, VaultSource};
use bforge_core::session::{Session, session_ports_from_config};
use std::path::{Path, PathBuf};
use tauri::Manager;

/// The built workbench: beside the executable, or the repository's build output.
fn ui_directory() -> Option<PathBuf> {
    let beside = std::env::current_exe().ok()?.parent()?.join("ui");
    if beside.join("index.html").exists() {
        return Some(beside);
    }
    let repository = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../ui/dist");
    repository.join("index.html").exists().then_some(repository)
}

/// The workspace: the first argument, or `.bforge.toml` at the top of the repository.
fn workspace_path() -> Option<PathBuf> {
    std::env::args_os()
        .skip(1)
        .map(PathBuf::from)
        .find(|argument| !argument.to_string_lossy().starts_with("--"))
        .or_else(|| {
            let example = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../.bforge.toml");
            example.exists().then_some(example)
        })
}

/// `--vault <path>`, or a session file in the temporary directory.
///
/// The window records by default: a monitor that forgets is one someone has to
/// remember to start, and the scrubber has nothing to show without a vault.
fn vault_path() -> PathBuf {
    let mut arguments = std::env::args_os().skip(1);
    while let Some(argument) = arguments.next() {
        if argument == "--vault" {
            return arguments
                .next()
                .map(PathBuf::from)
                .unwrap_or_else(default_vault);
        }
    }
    default_vault()
}

fn default_vault() -> PathBuf {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_secs())
        .unwrap_or(0);
    std::env::temp_dir().join(format!("bforge-gui-{stamp}.bflog"))
}

fn fail(message: String) -> ! {
    eprintln!("bforge-gui: {message}");
    std::process::exit(2);
}

fn main() {
    let Some(workspace) = workspace_path() else {
        fail("no workspace: pass a .bforge.toml path as the first argument".to_string());
    };
    let text = std::fs::read_to_string(&workspace)
        .unwrap_or_else(|error| fail(format!("{}: {error}", workspace.display())));
    let config: ProjectConfig = toml::from_str(&text)
        .unwrap_or_else(|error| fail(format!("{}: {error}", workspace.display())));

    let vault = vault_path();
    let mut session = session_ports_from_config(&config, &[])
        .and_then(|ports| Session::start(ports, Some(&vault), config.workspace.elf_path.clone()))
        .unwrap_or_else(|error| fail(format!("{}: {error}", vault.display())));
    if let Err(error) = session.enable_decode(&config.ports) {
        fail(error.to_string());
    }
    if let Err(error) = session.enable_bridges(&config.bridges) {
        fail(error.to_string());
    }
    if let Some(script) = config.workspace.script_path.as_deref() {
        if let Err(error) = session.enable_script(Path::new(script)) {
            fail(error.to_string());
        }
    }
    if let Some(elf) = config.workspace.elf_path.as_deref() {
        // A stale image must not stop a session: the badge is a bonus.
        if let Err(error) = session.enable_symbols(Path::new(elf)) {
            eprintln!("bforge-gui: warning: {error}");
        }
    }

    let server = Server::bind("127.0.0.1:0".parse().expect("an address"))
        .unwrap_or_else(|error| fail(error.to_string()));
    let port = server
        .local_addr()
        .unwrap_or_else(|error| fail(error.to_string()))
        .port();
    let server = match ui_directory() {
        Some(directory) => server.with_ui(directory),
        None => server,
    };
    let server = server.with_vault(VaultSource {
        path: vault.clone(),
        ports: config.ports.clone(),
    });

    std::thread::spawn(move || {
        // Runs until the process ends; the window is the only way out.
        if let Err(error) = server.run(session, None) {
            eprintln!("bforge-gui: serve stopped: {error}");
        }
    });

    let url = format!("http://127.0.0.1:{port}/");
    println!(
        "bforge-gui: engine {url}, workspace {}",
        workspace.display()
    );
    tauri::Builder::default()
        .setup(move |app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.navigate(url.parse().expect("a URL"));
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("the window failed to start");
}
