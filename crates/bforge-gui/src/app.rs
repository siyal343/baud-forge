use eframe::egui::{self, Color32, RichText, Stroke};
use egui_dock::{DockArea, DockState};
use crate::layout::{
    comprehensive_tree, default_tree, hil_rig_tree, load_dock_state, protocol_lab_tree,
    save_dock_state, telemetry_scope_tree, TabId,
};
use crate::tabs::{BaudForgeTabViewer, TabAction};
use crate::theme::{
    apply_theme, dock_style, COLOR_BORDER_HAIRLINE, COLOR_SIGNAL_RX,
    COLOR_SIGNAL_TRIGGER, COLOR_SIGNAL_TX, COLOR_SURFACE_ELEVATED,
    COLOR_TEXT_MUTED, COLOR_TEXT_PRIMARY,
};

/// Connection lifecycle states.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionStatus {
    Connected,
    Idle,
    Recording,
}

impl SessionStatus {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Connected => "CONNECTED",
            Self::Idle => "IDLE",
            Self::Recording => "RECORDING",
        }
    }

    pub fn color(&self) -> Color32 {
        match self {
            Self::Connected => COLOR_SIGNAL_RX,
            Self::Idle => COLOR_TEXT_MUTED,
            Self::Recording => COLOR_SIGNAL_TRIGGER,
        }
    }
}

/// Root BaudForge GUI application struct.
pub struct BaudForgeApp {
    /// Active egui_dock tree state.
    pub dock_state: DockState<TabId>,
    /// Tab viewer rendering implementation.
    pub tab_viewer: BaudForgeTabViewer,
    /// Currently selected preset identifier.
    pub current_preset: &'static str,
    /// Hardware session status.
    pub session_status: SessionStatus,
    /// Active serial port name.
    pub port_name: String,
    /// Configured baud rate.
    pub baud_rate: u32,
    /// Framing description.
    pub framing_format: String,
    /// RX bytes counter.
    pub rx_bytes: u64,
    /// TX bytes counter.
    pub tx_bytes: u64,
    /// Packets processed per second.
    pub packets_per_sec: u32,
    /// Vault recording target path.
    pub vault_path: String,
    /// Track if initial theme application occurred.
    pub theme_initialized: bool,
}

impl BaudForgeApp {
    /// Create a new application instance.
    pub fn new(_cc: &eframe::CreationContext<'_>) -> Self {
        // Attempt restoring persisted layout from disk, fallback to default
        let dock_state = load_dock_state().unwrap_or_else(default_tree);

        Self {
            dock_state,
            tab_viewer: BaudForgeTabViewer::default(),
            current_preset: "Default",
            session_status: SessionStatus::Connected,
            port_name: "COM3 (Virtual Loopback)".to_string(),
            baud_rate: 921600,
            framing_format: "COBS+CRC32".to_string(),
            rx_bytes: 1_482_920,
            tx_bytes: 34_810,
            packets_per_sec: 500,
            vault_path: "./vaults/session_20261102.bflog".to_string(),
            theme_initialized: false,
        }
    }

    /// Switch active dock layout to a given preset.
    pub fn switch_preset(&mut self, name: &'static str) {
        self.current_preset = name;
        self.dock_state = match name {
            "Protocol Lab" => protocol_lab_tree(),
            "Scope" => telemetry_scope_tree(),
            "HIL Rig" => hil_rig_tree(),
            "Comprehensive" => comprehensive_tree(),
            _ => default_tree(),
        };
    }

    /// Process queued tab actions.
    fn handle_tab_actions(&mut self) {
        if let Some(action) = self.tab_viewer.pending_action.take() {
            match action {
                TabAction::SelectPreset(preset) => self.switch_preset(preset),
                TabAction::QuickConnect => {
                    self.session_status = SessionStatus::Connected;
                }
                TabAction::LoadImuDemo => {
                    self.session_status = SessionStatus::Connected;
                    self.switch_preset("Scope");
                }
                TabAction::OpenProtocolLab => {
                    self.switch_preset("Protocol Lab");
                }
                TabAction::OpenTelemetryScope => {
                    self.switch_preset("Scope");
                }
                TabAction::LoadVault => {
                    self.session_status = SessionStatus::Recording;
                    self.switch_preset("Comprehensive");
                }
                TabAction::AddTab(tab) => {
                    self.dock_state.main_surface_mut().push_to_focused_leaf(tab);
                }
            }
        }
    }

    /// Render application top navigation and preset selection bar.
    fn render_top_bar(&mut self, ctx: &egui::Context) {
        egui::TopBottomPanel::top("top_bar")
            .frame(
                egui::Frame::NONE
                    .fill(COLOR_SURFACE_ELEVATED)
                    .stroke(Stroke::new(1.0_f32, COLOR_BORDER_HAIRLINE))
                    .inner_margin(egui::Margin::symmetric(10, 6)),
            )
            .show(ctx, |ui| {
                ui.horizontal(|ui| {
                    // Left: Status LED, Brand Title, Version
                    let led_color = match self.session_status {
                        SessionStatus::Connected => COLOR_SIGNAL_RX,
                        SessionStatus::Idle => COLOR_TEXT_MUTED,
                        SessionStatus::Recording => COLOR_SIGNAL_TRIGGER,
                    };

                    ui.label(RichText::new("●").size(14.0).color(led_color));
                    ui.label(
                        RichText::new("BAUDFORGE // HIL WORKBENCH")
                            .color(COLOR_TEXT_PRIMARY)
                            .strong()
                            .monospace(),
                    );
                    ui.label(RichText::new("v0.9.0").color(COLOR_TEXT_MUTED).small());

                    ui.separator();

                    // Center: Layout preset switch buttons
                    ui.label(RichText::new("Presets:").color(COLOR_TEXT_MUTED).small());

                    let presets = [
                        ("Default", "Default"),
                        ("Protocol Lab", "Protocol Lab"),
                        ("Scope", "Scope"),
                        ("HIL Rig", "HIL Rig"),
                        ("Comprehensive", "Comprehensive"),
                    ];

                    for (label, preset_name) in presets {
                        let is_selected = self.current_preset == preset_name;
                        let mut btn_text = RichText::new(label);
                        if is_selected {
                            btn_text = btn_text.color(COLOR_SIGNAL_TX).strong();
                        }

                        if ui.selectable_label(is_selected, btn_text).clicked() {
                            self.switch_preset(preset_name);
                        }
                    }

                    // Right: Panel menu and persistence controls
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        if ui.button(RichText::new("↺ Reset").small()).clicked() {
                            self.switch_preset("Default");
                        }

                        if ui.button(RichText::new("💾 Save Layout").small()).clicked() {
                            save_dock_state(&self.dock_state);
                        }

                        ui.menu_button("+ Add Panel", |ui| {
                            let all_tabs = [
                                TabId::Welcome,
                                TabId::SerialMonitor,
                                TabId::HexInspector,
                                TabId::TxConsole,
                                TabId::ProtocolDissector,
                                TabId::TelemetryScope,
                                TabId::Dashboards,
                                TabId::HilBridge,
                                TabId::VaultScrubber,
                                TabId::WorkspaceConfig,
                            ];

                            for tab in all_tabs {
                                if ui.button(tab.title()).clicked() {
                                    self.dock_state.main_surface_mut().push_to_focused_leaf(tab);
                                    ui.close_menu();
                                }
                            }
                        });
                    });
                });
            });
    }

    /// Render application bottom telemetry and hardware status bar.
    fn render_bottom_bar(&mut self, ctx: &egui::Context) {
        egui::TopBottomPanel::bottom("bottom_bar")
            .frame(
                egui::Frame::NONE
                    .fill(COLOR_SURFACE_ELEVATED)
                    .stroke(Stroke::new(1.0_f32, COLOR_BORDER_HAIRLINE))
                    .inner_margin(egui::Margin::symmetric(10, 4)),
            )
            .show(ctx, |ui| {
                ui.horizontal(|ui| {
                    // Session status pill
                    ui.label(
                        RichText::new(format!("STATUS: {}", self.session_status.label()))
                            .color(self.session_status.color())
                            .strong()
                            .small()
                            .monospace(),
                    );

                    ui.separator();

                    // Hardware port and baud
                    ui.label(RichText::new("PORT:").color(COLOR_TEXT_MUTED).small());
                    ui.label(RichText::new(&self.port_name).color(COLOR_TEXT_PRIMARY).small().monospace());

                    ui.label(RichText::new("BAUD:").color(COLOR_TEXT_MUTED).small());
                    ui.label(RichText::new(format!("{}", self.baud_rate)).color(COLOR_SIGNAL_TX).small().monospace());

                    ui.label(RichText::new("FRAMING:").color(COLOR_TEXT_MUTED).small());
                    ui.label(RichText::new(&self.framing_format).color(COLOR_TEXT_PRIMARY).small().monospace());

                    ui.separator();

                    // Counters
                    ui.label(RichText::new("RX:").color(COLOR_SIGNAL_RX).small().monospace());
                    ui.label(RichText::new(format!("{} B", self.rx_bytes)).color(COLOR_TEXT_PRIMARY).small().monospace());

                    ui.label(RichText::new("TX:").color(COLOR_SIGNAL_TX).small().monospace());
                    ui.label(RichText::new(format!("{} B", self.tx_bytes)).color(COLOR_TEXT_PRIMARY).small().monospace());

                    ui.label(RichText::new("RATE:").color(COLOR_TEXT_MUTED).small());
                    ui.label(RichText::new(format!("{} pkt/s", self.packets_per_sec)).color(COLOR_SIGNAL_RX).small().monospace());

                    // Vault recording status
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        ui.label(RichText::new(&self.vault_path).color(COLOR_TEXT_MUTED).small().monospace());
                        ui.label(RichText::new("VAULT:").color(COLOR_TEXT_MUTED).small());
                    });
                });
            });
    }
}

impl eframe::App for BaudForgeApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        if !self.theme_initialized {
            apply_theme(ctx);
            self.theme_initialized = true;
        }

        self.handle_tab_actions();

        self.render_top_bar(ctx);
        self.render_bottom_bar(ctx);

        egui::CentralPanel::default()
            .frame(egui::Frame::NONE.fill(crate::theme::COLOR_BG_DEEP))
            .show(ctx, |ui| {
                DockArea::new(&mut self.dock_state)
                    .style(dock_style(ctx))
                    .show_inside(ui, &mut self.tab_viewer);
            });
    }
}
