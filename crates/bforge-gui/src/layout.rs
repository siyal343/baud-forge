use egui_dock::{DockState, NodeIndex};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum TabId {
    Welcome,
    SerialMonitor,
    HexInspector,
    TxConsole,
    ProtocolDissector,
    TelemetryScope,
    Dashboards,
    HilBridge,
    VaultScrubber,
    WorkspaceConfig,
}

impl TabId {
    pub fn title(&self) -> &'static str {
        match self {
            Self::Welcome => "Hardware Setup & Welcome",
            Self::SerialMonitor => "Serial Monitor",
            Self::HexInspector => "Hex Inspector",
            Self::TxConsole => "Transmit Console",
            Self::ProtocolDissector => "Protocol Dissector Lab",
            Self::TelemetryScope => "Telemetry Oscilloscope",
            Self::Dashboards => "Dashboards & Gauges",
            Self::HilBridge => "HIL Bridge & Fault Injection",
            Self::VaultScrubber => "Vault Review & Scrubber",
            Self::WorkspaceConfig => "Workspace Config",
        }
    }
}

/// Default layout preset: Welcome in center, Serial Monitor on the right, TX Console and Hex Inspector at the bottom.
pub fn default_tree() -> DockState<TabId> {
    let mut tree = DockState::new(vec![TabId::Welcome]);
    let surface = tree.main_surface_mut();
    let [center, _right] = surface.split_right(NodeIndex::root(), 0.6_f32, vec![TabId::SerialMonitor]);
    let _ = surface.split_below(center, 0.65_f32, vec![TabId::TxConsole, TabId::HexInspector]);
    tree
}

/// Protocol Dissector Lab preset: Dissector on the left, Hex Inspector at the bottom, Serial Monitor on the right.
pub fn protocol_lab_tree() -> DockState<TabId> {
    let mut tree = DockState::new(vec![TabId::ProtocolDissector]);
    let surface = tree.main_surface_mut();
    let [left, _right] = surface.split_right(NodeIndex::root(), 0.55_f32, vec![TabId::SerialMonitor]);
    let _ = surface.split_below(left, 0.6_f32, vec![TabId::HexInspector]);
    tree
}

/// Telemetry Scope preset: Scope on top, Dashboards at the bottom, Serial Monitor on the right.
pub fn telemetry_scope_tree() -> DockState<TabId> {
    let mut tree = DockState::new(vec![TabId::TelemetryScope]);
    let surface = tree.main_surface_mut();
    let [left, _right] = surface.split_right(NodeIndex::root(), 0.65_f32, vec![TabId::SerialMonitor]);
    let _ = surface.split_below(left, 0.5_f32, vec![TabId::Dashboards]);
    tree
}

/// HIL Rig preset: HIL Bridge on the left, Serial Monitor in the center, Oscilloscope on the right.
pub fn hil_rig_tree() -> DockState<TabId> {
    let mut tree = DockState::new(vec![TabId::SerialMonitor]);
    let surface = tree.main_surface_mut();
    let [_left, center] = surface.split_left(NodeIndex::root(), 0.28_f32, vec![TabId::HilBridge]);
    let _ = surface.split_right(center, 0.6_f32, vec![TabId::TelemetryScope]);
    tree
}

/// Comprehensive preset containing all tabs in a balanced workflow layout.
pub fn comprehensive_tree() -> DockState<TabId> {
    let mut tree = DockState::new(vec![TabId::SerialMonitor, TabId::TxConsole]);
    let surface = tree.main_surface_mut();
    let [_left, center] = surface.split_left(
        NodeIndex::root(),
        0.22_f32,
        vec![TabId::Welcome, TabId::WorkspaceConfig, TabId::HilBridge],
    );
    let [mid, _right] = surface.split_right(
        center,
        0.55_f32,
        vec![TabId::TelemetryScope, TabId::Dashboards],
    );
    let _ = surface.split_below(
        mid,
        0.6_f32,
        vec![TabId::HexInspector, TabId::ProtocolDissector, TabId::VaultScrubber],
    );
    tree
}

/// Resolve the path to `%APPDATA%/BaudForge/dock_layout.json` on Windows.
pub fn dock_layout_path() -> Option<PathBuf> {
    if let Ok(appdata) = std::env::var("APPDATA") {
        Some(PathBuf::from(appdata).join("BaudForge").join("dock_layout.json"))
    } else if let Ok(profile) = std::env::var("USERPROFILE") {
        Some(PathBuf::from(profile).join("AppData").join("Roaming").join("BaudForge").join("dock_layout.json"))
    } else {
        None
    }
}

/// Ensure any non-finite (NaN / Nothing) rects in newly built or unrendered trees are sanitized to Rect::ZERO.
/// This guarantees valid JSON serialization and deserialization across all states.
pub fn sanitize_tree(tree: &mut DockState<TabId>) {
    for surface in tree.iter_surfaces_mut() {
        for node in surface.iter_nodes_mut() {
            match node {
                egui_dock::Node::Leaf {
                    rect,
                    viewport,
                    ..
                } => {
                    if !rect.is_finite() {
                        *rect = egui::Rect::ZERO;
                    }
                    if !viewport.is_finite() {
                        *viewport = egui::Rect::ZERO;
                    }
                }
                egui_dock::Node::Vertical { rect, .. }
                | egui_dock::Node::Horizontal { rect, .. } => {
                    if !rect.is_finite() {
                        *rect = egui::Rect::ZERO;
                    }
                }
                _ => {}
            }
        }
    }
}

/// Persist dock state tree to `%APPDATA%/BaudForge/dock_layout.json`.
pub fn save_dock_state(tree: &DockState<TabId>) -> bool {
    let Some(path) = dock_layout_path() else {
        return false;
    };
    if let Some(parent) = path.parent() {
        if std::fs::create_dir_all(parent).is_err() {
            return false;
        }
    }
    let mut cloned = tree.clone();
    sanitize_tree(&mut cloned);
    match serde_json::to_string_pretty(&cloned) {
        Ok(json) => std::fs::write(path, json).is_ok(),
        Err(_) => false,
    }
}

/// Load dock state tree from `%APPDATA%/BaudForge/dock_layout.json`.
pub fn load_dock_state() -> Option<DockState<TabId>> {
    let path = dock_layout_path()?;
    let content = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tab_titles() {
        assert_eq!(TabId::Welcome.title(), "Hardware Setup & Welcome");
        assert_eq!(TabId::SerialMonitor.title(), "Serial Monitor");
        assert_eq!(TabId::HexInspector.title(), "Hex Inspector");
        assert_eq!(TabId::TxConsole.title(), "Transmit Console");
        assert_eq!(TabId::ProtocolDissector.title(), "Protocol Dissector Lab");
        assert_eq!(TabId::TelemetryScope.title(), "Telemetry Oscilloscope");
        assert_eq!(TabId::Dashboards.title(), "Dashboards & Gauges");
        assert_eq!(TabId::HilBridge.title(), "HIL Bridge & Fault Injection");
        assert_eq!(TabId::VaultScrubber.title(), "Vault Review & Scrubber");
        assert_eq!(TabId::WorkspaceConfig.title(), "Workspace Config");
    }

    #[test]
    fn test_all_layout_presets_serde() {
        let mut presets = [
            ("default", default_tree()),
            ("protocol_lab", protocol_lab_tree()),
            ("telemetry_scope", telemetry_scope_tree()),
            ("hil_rig", hil_rig_tree()),
            ("comprehensive", comprehensive_tree()),
        ];

        for (name, tree) in presets.iter_mut() {
            sanitize_tree(tree);
            let serialized = serde_json::to_string_pretty(tree)
                .unwrap_or_else(|e| panic!("preset {name} failed to serialize: {e}"));
            let deserialized: DockState<TabId> = serde_json::from_str(&serialized)
                .unwrap_or_else(|e| panic!("preset {name} failed to deserialize: {e}"));
            assert_eq!(
                tree.iter_all_tabs().count(),
                deserialized.iter_all_tabs().count(),
                "Tab count mismatch in {name}"
            );
        }
    }
}
