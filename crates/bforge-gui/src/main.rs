#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use bforge_gui::app::BaudForgeApp;
use eframe::egui;

fn main() -> eframe::Result {
    let native_options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size([1280.0, 800.0])
            .with_min_inner_size([800.0, 540.0])
            .with_title("BaudForge // HIL Workbench")
            .with_decorations(true)
            .with_resizable(true),
        ..Default::default()
    };

    eframe::run_native(
        "BaudForge",
        native_options,
        Box::new(|cc| Ok(Box::new(BaudForgeApp::new(cc)))),
    )
}
