#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use bforge_gui::app::BaudForgeApp;
use eframe::egui;

fn load_icon() -> Option<egui::IconData> {
    let icon_bytes = include_bytes!("../icons/icon.png");
    match image::load_from_memory(icon_bytes) {
        Ok(img) => Some(egui::IconData {
            rgba: img.to_rgba8().into_raw(),
            width: img.width(),
            height: img.height(),
        }),
        Err(err) => {
            eprintln!("Warning: failed to decode application icon: {err}");
            None
        }
    }
}

fn main() -> eframe::Result {
    let mut viewport = egui::ViewportBuilder::default()
        .with_inner_size([1280.0, 800.0])
        .with_min_inner_size([800.0, 540.0])
        .with_title("BaudForge // HIL Workbench")
        .with_decorations(true)
        .with_resizable(true);

    if let Some(icon) = load_icon() {
        viewport = viewport.with_icon(icon);
    }

    let native_options = eframe::NativeOptions {
        viewport,
        ..Default::default()
    };

    eframe::run_native(
        "BaudForge",
        native_options,
        Box::new(|cc| Ok(Box::new(BaudForgeApp::new(cc)))),
    )
}
