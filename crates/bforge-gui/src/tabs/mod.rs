use egui::{self, epaint::CornerRadius, Color32, Margin, RichText, Stroke, Ui, Vec2};
use crate::layout::TabId;
use crate::theme::{
    COLOR_BORDER_HAIRLINE, COLOR_SIGNAL_FAULT, COLOR_SIGNAL_RX, COLOR_SIGNAL_TRIGGER,
    COLOR_SIGNAL_TX, COLOR_SURFACE_CARD, COLOR_TEXT_MUTED, COLOR_TEXT_PRIMARY,
};

/// High-level commands requested by user interactions inside tabs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TabAction {
    SelectPreset(&'static str),
    QuickConnect,
    StartHardwareSession,
    LoadImuDemo,
    OpenProtocolLab,
    OpenTelemetryScope,
    LoadVault,
    AddTab(TabId),
}

/// Tab viewer state and widget renderer.
pub struct BaudForgeTabViewer {
    /// Queued user action from tab controls.
    pub pending_action: Option<TabAction>,

    // Hardware Scanner & Setup State
    pub available_ports: Vec<crate::hardware::SerialPortInfo>,
    pub selected_port_idx: usize,
    pub selected_baud: u32,
    pub custom_baud_str: String,
    pub selected_framing: String,
    pub is_sniffing: bool,
    pub sniff_result: Option<String>,
    pub sniff_tx: crossbeam_channel::Sender<Option<(u32, String)>>,
    pub sniff_rx: crossbeam_channel::Receiver<Option<(u32, String)>>,

    // Serial Monitor State
    pub serial_filter: String,
    pub serial_paused: bool,
    pub serial_autoscroll: bool,
    pub serial_lines: Vec<String>,

    // TX Console State
    pub tx_hex_mode: bool,
    pub tx_input: String,
    pub tx_history: Vec<String>,
    pub tx_line_ending: crate::session::LineEnding,
    pub pending_tx: Option<crate::session::TxCommand>,

    // Hex Inspector State
    pub hex_data: Vec<u8>,
    pub hex_selected_offset: Option<usize>,
    pub hex_highlight_range: Option<std::ops::Range<usize>>,

    // Telemetry Scope State
    pub scope: crate::scope::ScopeManager,
    pub scope_channels: [bool; 4],
    pub scope_timebase_ms: f32,
    pub scope_trigger_source: usize,
    pub scope_trigger_rising: bool,
    pub scope_trigger_threshold: f32,

    // Protocol Dissector State
    pub dissector_filter: String,
    pub dissector_packet_count: usize,
    pub dissector_schema: crate::dissect::DissectorSchema,
    pub last_decoded_packet: Option<crate::dissect::DecodedPacket>,

    // HIL Bridge State
    pub hil: crate::hil::HilBridgeState,

    // Dashboards State
    pub dashboard: crate::dashboard::DashboardManager,
    pub dash_rpm: f32,
    pub dash_temp_c: f32,
    pub dash_bus_volts: f32,
    pub dash_power_ok: bool,

    // Vault Scrubber State
    pub vault: crate::vault::VaultManager,

    // Workspace Config State
    pub ws_path: String,
    pub ws_baud: u32,
    pub ws_framing: String,
    pub workspace: crate::workspace::WorkspaceState,
    pub elf_resolver: crate::workspace::ElfSymbolResolver,
    pub elf_lookup_addr: String,
}

impl Default for BaudForgeTabViewer {
    fn default() -> Self {
        let mut sample_hex = Vec::with_capacity(48);
        sample_hex.extend_from_slice(&[0xBA, 0xDE]); // sync 0xBADE
        sample_hex.extend_from_slice(&1042u32.to_le_bytes()); // seq 1042
        sample_hex.extend_from_slice(&0.02f32.to_le_bytes()); // ax
        sample_hex.extend_from_slice(&0.01f32.to_le_bytes()); // ay
        sample_hex.extend_from_slice(&9.81f32.to_le_bytes()); // az
        sample_hex.extend_from_slice(&0.012f32.to_le_bytes()); // gp
        sample_hex.extend_from_slice(&(-0.045f32).to_le_bytes()); // gq
        sample_hex.extend_from_slice(&0.003f32.to_le_bytes()); // gr
        sample_hex.extend_from_slice(&0.0f32.to_le_bytes()); // qx
        sample_hex.extend_from_slice(&0.7071f32.to_le_bytes()); // qy
        sample_hex.extend_from_slice(&0.0f32.to_le_bytes()); // qz
        sample_hex.extend_from_slice(&3650i16.to_le_bytes()); // temp_raw (36.50 C)
        let crc = bforge_framer::checksum::crc32c(&sample_hex);
        sample_hex.extend_from_slice(&crc.to_le_bytes()); // crc32

        let available_ports = crate::hardware::scan_available_ports();
        let selected_port_idx = available_ports
            .iter()
            .position(|p| p.vid_pid.is_some() && !p.port_name.contains("LOOPBACK"))
            .or_else(|| available_ports.iter().position(|p| p.vid_pid.is_some()))
            .unwrap_or(0);

        let dissector_schema = crate::dissect::DissectorSchema::BuiltinImu;
        let last_decoded_packet = crate::dissect::decode_packet(&sample_hex, &dissector_schema);
        let (sniff_tx, sniff_rx) = crossbeam_channel::unbounded();

        Self {
            pending_action: None,

            available_ports,
            selected_port_idx,
            selected_baud: 115200,
            custom_baud_str: "115200".to_string(),
            selected_framing: "Line-Delimited (\\n)".to_string(),
            is_sniffing: false,
            sniff_result: None,
            sniff_tx,
            sniff_rx,

            serial_filter: String::new(),
            serial_paused: false,
            serial_autoscroll: true,
            serial_lines: vec![
                "[00:00:00.100] [SYS] BaudForge HIL runtime core initialized (v0.9.0)".to_string(),
                "[00:00:00.250] [HAL] Virtual USB-CDC UART enumerated on COM3 @ 921600 8N1".to_string(),
                "[00:00:00.410] [IMU] Loopback session active - BNO085 9-DoF simulated stream".to_string(),
                "[00:00:00.600] [TEL] Telemetry rate: 500 Hz, sync word: 0xBAUD, payload: 48 bytes".to_string(),
                "[00:00:00.750] [FLT] Fault engine armed: BER=0.00e0, Drop=0.0%, Jitter=0ms".to_string(),
            ],

            tx_hex_mode: false,
            tx_input: "AT+STATUS".to_string(),
            tx_history: vec![
                "TX -> AT+PING".to_string(),
                "RX <- OK:PONG".to_string(),
                "TX -> AT+CONFIG:STREAM=IMU_RAW,RATE=500".to_string(),
            ],
            tx_line_ending: crate::session::LineEnding::CrLf,
            pending_tx: None,

            hex_data: sample_hex,
            hex_selected_offset: Some(0),
            hex_highlight_range: None,

            scope: crate::scope::ScopeManager::default(),
            scope_channels: [true, true, false, false],
            scope_timebase_ms: 10.0,
            scope_trigger_source: 0,
            scope_trigger_rising: true,
            scope_trigger_threshold: 1.65,

            dissector_filter: String::new(),
            dissector_packet_count: 14820,
            dissector_schema,
            last_decoded_packet,

            hil: crate::hil::HilBridgeState::default(),

            dashboard: crate::dashboard::default_dashboard(),
            dash_rpm: 4820.0,
            dash_temp_c: 42.6,
            dash_bus_volts: 24.1,
            dash_power_ok: true,

            vault: crate::vault::VaultManager::default(),

            ws_path: "./workspaces/cubesat_imu.bforge.toml".to_string(),
            ws_baud: 921600,
            ws_framing: "COBS + CRC32-Castagnoli".to_string(),
            workspace: {
                let mut ws = crate::workspace::WorkspaceState::default();
                ws.name = "CubeSat OBC Validation".to_string();
                ws.file_path = Some("./workspaces/cubesat_imu.bforge.toml".to_string());
                ws.primary_port = "COM3".to_string();
                ws.baud_rate = 921600;
                ws.framing = "cobs".to_string();
                ws.dissector_path = Some("./firmware/include/telemetry_packets.h".to_string());
                ws.elf_path = Some("./firmware/build/obc_flight_sw.elf".to_string());
                ws
            },
            elf_resolver: crate::workspace::ElfSymbolResolver::default(),
            elf_lookup_addr: "0x42001000".to_string(),
        }
    }
}

impl BaudForgeTabViewer {
    /// Render card header with instrument tag and status badge.
    fn render_header(ui: &mut Ui, tag: &str, title: &str, status: &str, status_color: Color32) {
        ui.horizontal(|ui| {
            ui.label(RichText::new(tag).color(COLOR_SIGNAL_TX).strong().monospace());
            ui.label(RichText::new(title).color(COLOR_TEXT_PRIMARY).strong());
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                ui.label(RichText::new(status).color(status_color).small().monospace());
            });
        });
        ui.separator();
    }

    /// Render Tab: Welcome & Hardware Setup Wizard.
    fn render_welcome(&mut self, ui: &mut Ui) {
        // Drain asynchronous sniffer channel updates
        while let Ok(sniff_opt) = self.sniff_rx.try_recv() {
            self.is_sniffing = false;
            if let Some((sniffed_baud, sniffed_framing)) = sniff_opt {
                self.selected_baud = sniffed_baud;
                self.custom_baud_str = sniffed_baud.to_string();
                let matched_framing = if sniffed_framing.contains("Line") {
                    "Line-Delimited (\\n)"
                } else if sniffed_framing.contains("COBS") {
                    "COBS (0x00 framing)"
                } else {
                    "Raw Binary Stream"
                };
                self.selected_framing = matched_framing.to_string();
                self.sniff_result = Some(format!(
                    "✓ Auto-detected: {} baud, {}",
                    sniffed_baud, matched_framing
                ));
            } else {
                self.sniff_result = Some(
                    "⚠ No incoming traffic detected across candidate baud rates"
                        .to_string(),
                );
            }
        }

        if self.is_sniffing {
            ui.ctx().request_repaint();
        }

        Self::render_header(
            ui,
            "[SETUP]",
            "HARDWARE ONBOARDING & SETUP",
            "STANDBY",
            COLOR_SIGNAL_TX,
        );

        egui::ScrollArea::vertical().show(ui, |ui| {
            ui.add_space(4.0);
            ui.label(
                RichText::new("Connect your microcontroller, sniffer, or run the HIL simulator.")
                    .color(COLOR_TEXT_MUTED),
            );
            ui.add_space(10.0);

            // Card 1: Hardware Connection Card
            egui::Frame::NONE
                .fill(COLOR_SURFACE_CARD)
                .stroke(Stroke::new(1.0_f32, COLOR_BORDER_HAIRLINE))
                .corner_radius(CornerRadius::same(4))
                .inner_margin(Margin::same(12))
                .show(ui, |ui| {
                    ui.label(
                        RichText::new("HARDWARE CONNECTION")
                            .color(COLOR_SIGNAL_TX)
                            .strong()
                            .monospace()
                            .small(),
                    );
                    ui.add_space(8.0);

                    // Port row: ComboBox selecting from available_ports, and a "🔄 Scan Ports" button.
                    ui.horizontal(|ui| {
                        ui.label(RichText::new("Port:").color(COLOR_TEXT_PRIMARY).strong());
                        let current_display = self
                            .available_ports
                            .get(self.selected_port_idx)
                            .map(|p| p.display_name.as_str())
                            .unwrap_or("No serial ports detected");

                        egui::ComboBox::from_id_salt("welcome_port_select")
                            .selected_text(RichText::new(current_display).color(COLOR_TEXT_PRIMARY))
                            .width(340.0)
                            .show_ui(ui, |ui| {
                                for (idx, port) in self.available_ports.iter().enumerate() {
                                    let is_selected = self.selected_port_idx == idx;
                                    if ui.selectable_label(is_selected, &port.display_name).clicked() {
                                        self.selected_port_idx = idx;
                                        self.sniff_result = None;
                                    }
                                }
                            });

                        if ui.button("🔄 Scan Ports").clicked() {
                            self.available_ports = crate::hardware::scan_available_ports();
                            if self.selected_port_idx >= self.available_ports.len() {
                                self.selected_port_idx = 0;
                            }
                            self.sniff_result = None;
                        }
                    });

                    ui.add_space(8.0);

                    // Baud rate grid buttons and custom text edit
                    ui.horizontal(|ui| {
                        ui.label(RichText::new("Baud Rate:").color(COLOR_TEXT_PRIMARY).strong());
                        let standard_bauds = [9600, 115200, 230400, 460800, 921600, 2000000];
                        for baud in standard_bauds {
                            let is_selected = self.selected_baud == baud;
                            let btn_text = if is_selected {
                                RichText::new(format!("{baud}")).color(COLOR_SIGNAL_TX).strong()
                            } else {
                                RichText::new(format!("{baud}")).color(COLOR_TEXT_MUTED)
                            };
                            if ui.button(btn_text).clicked() {
                                self.selected_baud = baud;
                                self.custom_baud_str = baud.to_string();
                            }
                        }

                        ui.add_space(4.0);
                        ui.label(RichText::new("Custom:").color(COLOR_TEXT_MUTED).small());
                        let response = ui.add(
                            egui::TextEdit::singleline(&mut self.custom_baud_str)
                                .desired_width(75.0),
                        );
                        if response.changed() {
                            if let Ok(val) = self.custom_baud_str.trim().parse::<u32>() {
                                self.selected_baud = val;
                            }
                        }
                    });

                    ui.add_space(8.0);

                    // Framing format ComboBox
                    ui.horizontal(|ui| {
                        ui.label(RichText::new("Framing:").color(COLOR_TEXT_PRIMARY).strong());
                        let framing_options = [
                            "Line-Delimited (\\n)",
                            "COBS (0x00 framing)",
                            "Length-Prefixed (u16)",
                            "Raw Binary Stream",
                        ];
                        egui::ComboBox::from_id_salt("welcome_framing_select")
                            .selected_text(RichText::new(&self.selected_framing).color(COLOR_TEXT_PRIMARY))
                            .width(240.0)
                            .show_ui(ui, |ui| {
                                for option in framing_options {
                                    let is_selected = self.selected_framing == option;
                                    if ui.selectable_label(is_selected, option).clicked() {
                                        self.selected_framing = option.to_string();
                                    }
                                }
                            });
                    });

                    ui.add_space(12.0);

                    // Action buttons row
                    ui.horizontal(|ui| {
                        let connect_btn = egui::Button::new(
                            RichText::new("🔌 Connect Microcontroller")
                                .color(Color32::BLACK)
                                .strong(),
                        )
                        .fill(COLOR_SIGNAL_RX);

                        if ui.add(connect_btn).clicked() {
                            self.pending_action = Some(TabAction::StartHardwareSession);
                        }

                        let sniff_label = if self.is_sniffing {
                            "⏳ Probing Candidate Bauds..."
                        } else {
                            "🔍 Auto-Detect Baud & Framing"
                        };
                        let sniff_btn = egui::Button::new(
                            RichText::new(sniff_label).color(COLOR_SIGNAL_TX).strong(),
                        );
                        if ui.add_enabled(!self.is_sniffing, sniff_btn).clicked() {
                            if let Some(port) = self.available_ports.get(self.selected_port_idx) {
                                self.is_sniffing = true;
                                self.sniff_result = Some("Probing candidate baud rates...".to_string());
                                let port_name = port.port_name.clone();
                                let tx = self.sniff_tx.clone();
                                std::thread::spawn(move || {
                                    let res = crate::hardware::sniff_port_baud_and_framing(&port_name);
                                    let _ = tx.send(res);
                                });
                            }
                        }
                    });

                    if let Some(ref result) = self.sniff_result {
                        ui.add_space(6.0);
                        let color = if result.starts_with('✓') {
                            COLOR_SIGNAL_RX
                        } else {
                            COLOR_SIGNAL_TRIGGER
                        };
                        ui.label(RichText::new(result).color(color).monospace().small());
                    }
                });

            ui.add_space(12.0);

            // Card 2: Simulator & Demos Card
            egui::Frame::NONE
                .fill(COLOR_SURFACE_CARD)
                .stroke(Stroke::new(1.0_f32, COLOR_BORDER_HAIRLINE))
                .corner_radius(CornerRadius::same(4))
                .inner_margin(Margin::same(12))
                .show(ui, |ui| {
                    ui.label(
                        RichText::new("SIMULATOR & DEMONSTRATION RIGS")
                            .color(COLOR_SIGNAL_TRIGGER)
                            .strong()
                            .monospace()
                            .small(),
                    );
                    ui.add_space(6.0);

                    if ui
                        .button(
                            RichText::new("⚡ Launch IMU Loopback Demo (Simulated HIL)")
                                .color(COLOR_SIGNAL_TX)
                                .strong(),
                        )
                        .clicked()
                    {
                        self.pending_action = Some(TabAction::LoadImuDemo);
                    }

                    ui.add_space(8.0);
                    ui.label(
                        RichText::new("Built-in virtual instruments for hardware-less testing:")
                            .color(COLOR_TEXT_MUTED)
                            .small(),
                    );
                    ui.label(
                        RichText::new("• Protocol Dissector Lab: Live binary parsing, payload schema inspection, and packet inspector.")
                            .color(COLOR_TEXT_PRIMARY)
                            .small(),
                    );
                    ui.label(
                        RichText::new("• Telemetry Oscilloscope: High-rate multi-channel plotting with real-time hardware trigger logic.")
                            .color(COLOR_TEXT_PRIMARY)
                            .small(),
                    );
                    ui.label(
                        RichText::new("• Fault Injection Rig: Controlled bit-error rates (BER), frame drops, and packet jitter.")
                            .color(COLOR_TEXT_PRIMARY)
                            .small(),
                    );
                });

            ui.add_space(12.0);

            // Card 3: Quick Jump cards
            egui::Frame::NONE
                .fill(COLOR_SURFACE_CARD)
                .stroke(Stroke::new(1.0_f32, COLOR_BORDER_HAIRLINE))
                .corner_radius(CornerRadius::same(4))
                .inner_margin(Margin::same(12))
                .show(ui, |ui| {
                    ui.label(
                        RichText::new("QUICK JUMP WORKSPACES")
                            .color(COLOR_TEXT_PRIMARY)
                            .strong()
                            .monospace()
                            .small(),
                    );
                    ui.add_space(6.0);

                    ui.horizontal_wrapped(|ui| {
                        if ui.button(RichText::new("🔬 Protocol Lab").strong()).clicked() {
                            self.pending_action = Some(TabAction::SelectPreset("Protocol Lab"));
                        }
                        if ui.button(RichText::new("📈 Scope").strong()).clicked() {
                            self.pending_action = Some(TabAction::SelectPreset("Scope"));
                        }
                        if ui.button(RichText::new("🛠 HIL Rig").strong()).clicked() {
                            self.pending_action = Some(TabAction::SelectPreset("HIL Rig"));
                        }
                        if ui.button(RichText::new("📦 Diff & Vault").strong()).clicked() {
                            self.pending_action = Some(TabAction::SelectPreset("Comprehensive"));
                        }
                    });
                });

            ui.add_space(12.0);
        });
    }

    /// Render Tab: Serial Monitor.
    fn render_serial_monitor(&mut self, ui: &mut Ui) {
        let status = if self.serial_paused { "PAUSED" } else { "LIVE RX" };
        let status_color = if self.serial_paused { COLOR_SIGNAL_TRIGGER } else { COLOR_SIGNAL_RX };

        Self::render_header(ui, "[SERIAL]", "Serial Monitor", status, status_color);

        // Control bar
        ui.horizontal(|ui| {
            ui.label(RichText::new("Filter:").color(COLOR_TEXT_MUTED));
            ui.text_edit_singleline(&mut self.serial_filter);

            let pause_label = if self.serial_paused { "▶ Resume" } else { "⏸ Pause" };
            if ui.button(pause_label).clicked() {
                self.serial_paused = !self.serial_paused;
            }

            if ui.button("🗑 Clear").clicked() {
                self.serial_lines.clear();
            }

            ui.checkbox(&mut self.serial_autoscroll, "Auto-scroll");
        });

        ui.separator();

        // Log lines scroll area
        egui::ScrollArea::vertical()
            .stick_to_bottom(self.serial_autoscroll)
            .show(ui, |ui| {
                for line in &self.serial_lines {
                    if !self.serial_filter.is_empty() && !line.to_lowercase().contains(&self.serial_filter.to_lowercase()) {
                        continue;
                    }

                    let color = if line.contains("[SYS]") {
                        COLOR_SIGNAL_TX
                    } else if line.contains("[IMU]") || line.contains("[TEL]") {
                        COLOR_SIGNAL_RX
                    } else if line.contains("[FLT]") {
                        COLOR_SIGNAL_FAULT
                    } else {
                        COLOR_TEXT_PRIMARY
                    };

                    let display_text = if self.elf_resolver.image.is_some() {
                        self.elf_resolver.annotate_line(line)
                    } else {
                        line.clone()
                    };

                    ui.label(RichText::new(display_text).color(color).monospace());
                }
            });
    }

    /// Render Tab: Transmit Console.
    fn render_tx_console(&mut self, ui: &mut Ui) {
        Self::render_header(ui, "[TX-CON]", "Transmit Console", "READY", COLOR_SIGNAL_TX);

        ui.horizontal(|ui| {
            ui.label(RichText::new("Format:").color(COLOR_TEXT_MUTED));
            ui.radio_value(&mut self.tx_hex_mode, false, "ASCII");
            ui.radio_value(&mut self.tx_hex_mode, true, "HEX Bytes");

            if !self.tx_hex_mode {
                ui.separator();
                ui.label(RichText::new("EOL:").color(COLOR_TEXT_MUTED));
                egui::ComboBox::from_id_salt("tx_eol_select")
                    .selected_text(match self.tx_line_ending {
                        crate::session::LineEnding::None => "None",
                        crate::session::LineEnding::Lf => "LF (\\n)",
                        crate::session::LineEnding::Cr => "CR (\\r)",
                        crate::session::LineEnding::CrLf => "CRLF (\\r\\n)",
                    })
                    .show_ui(ui, |ui| {
                        ui.selectable_value(
                            &mut self.tx_line_ending,
                            crate::session::LineEnding::CrLf,
                            "CRLF (\\r\\n)",
                        );
                        ui.selectable_value(
                            &mut self.tx_line_ending,
                            crate::session::LineEnding::Lf,
                            "LF (\\n)",
                        );
                        ui.selectable_value(
                            &mut self.tx_line_ending,
                            crate::session::LineEnding::Cr,
                            "CR (\\r)",
                        );
                        ui.selectable_value(
                            &mut self.tx_line_ending,
                            crate::session::LineEnding::None,
                            "None",
                        );
                    });
            }

            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if ui.button("Clear History").clicked() {
                    self.tx_history.clear();
                }
            });
        });

        ui.separator();

        // History area
        egui::ScrollArea::vertical()
            .max_height(140.0)
            .stick_to_bottom(true)
            .show(ui, |ui| {
                for item in &self.tx_history {
                    let color = if item.starts_with("TX") {
                        COLOR_SIGNAL_TX
                    } else {
                        COLOR_SIGNAL_RX
                    };
                    ui.label(RichText::new(item).color(color).monospace());
                }
            });

        ui.separator();

        // Input and Send button
        ui.horizontal(|ui| {
            ui.label(RichText::new("Payload:").strong());
            let response = ui.text_edit_singleline(&mut self.tx_input);
            let enter_pressed = response.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter));

            if ui.button(RichText::new("Send ▶").strong()).clicked() || enter_pressed {
                let trimmed = self.tx_input.trim();
                if !trimmed.is_empty() {
                    let cmd = if self.tx_hex_mode {
                        let clean = trimmed.replace("0x", "").replace(',', " ");
                        let bytes: Result<Vec<u8>, _> = clean
                            .split_whitespace()
                            .map(|s| u8::from_str_radix(s, 16))
                            .collect();
                        match bytes {
                            Ok(b) if !b.is_empty() => {
                                self.tx_history.push(format!("TX [HEX] -> {:02X?}", b));
                                Some(crate::session::TxCommand::Hex(b))
                            }
                            _ => {
                                self.tx_history.push(format!("TX [ERR] -> Invalid hex payload: {}", trimmed));
                                None
                            }
                        }
                    } else {
                        self.tx_history.push(format!("TX -> {}", trimmed));
                        Some(crate::session::TxCommand::Ascii(
                            trimmed.to_string(),
                            self.tx_line_ending,
                        ))
                    };

                    if let Some(tx_cmd) = cmd {
                        self.pending_tx = Some(tx_cmd);
                    }
                    self.tx_input.clear();
                }
            }
        });

        ui.horizontal(|ui| {
            ui.label(RichText::new("Presets:").color(COLOR_TEXT_MUTED).small());
            if ui.small_button("AT+STATUS").clicked() {
                self.tx_input = "AT+STATUS".to_string();
            }
            if ui.small_button("AT+PING").clicked() {
                self.tx_input = "AT+PING".to_string();
            }
            if ui.small_button("AT+RESET").clicked() {
                self.tx_input = "AT+RESET".to_string();
            }
            if ui.small_button("SYNC_BURST").clicked() {
                self.tx_input = "BAUD_PING".to_string();
            }
        });
    }

    /// Render Tab: Hex Inspector.
    fn render_hex_inspector(&mut self, ui: &mut Ui) {
        Self::render_header(
            ui,
            "[HEX-INSP]",
            "Hex Memory & Packet Inspector",
            "SYNCED",
            COLOR_SIGNAL_RX,
        );

        ui.horizontal(|ui| {
            ui.label(RichText::new(format!("Packet Size: {} bytes", self.hex_data.len())).color(COLOR_TEXT_MUTED));
            if let Some(offset) = self.hex_selected_offset {
                ui.label(RichText::new(format!("Offset: 0x{offset:04X} ({offset})")).color(COLOR_SIGNAL_TX).monospace());
            }
            if let Some(ref range) = self.hex_highlight_range {
                ui.label(
                    RichText::new(format!("Dissector Highlight: 0x{:02X}..0x{:02X} ({}B)", range.start, range.end, range.len()))
                        .color(COLOR_SIGNAL_TRIGGER)
                        .monospace(),
                );
            }
        });

        ui.separator();

        egui::ScrollArea::vertical().show(ui, |ui| {
            let chunk_size = 16;
            for (row_idx, chunk) in self.hex_data.chunks(chunk_size).enumerate() {
                let row_offset = row_idx * chunk_size;

                ui.horizontal(|ui| {
                    // Offset address
                    ui.label(RichText::new(format!("{row_offset:04X}:")).color(COLOR_TEXT_MUTED).monospace());

                    // Hex bytes
                    for (col_idx, byte) in chunk.iter().enumerate() {
                        let byte_offset = row_offset + col_idx;
                        let is_selected = self.hex_selected_offset == Some(byte_offset);
                        let is_highlighted = self
                            .hex_highlight_range
                            .as_ref()
                            .map_or(false, |r| r.contains(&byte_offset));

                        let text_color = if is_selected {
                            COLOR_SIGNAL_TRIGGER
                        } else if is_highlighted {
                            COLOR_TEXT_PRIMARY
                        } else if *byte == 0xBA || *byte == 0xDE {
                            COLOR_SIGNAL_TRIGGER
                        } else {
                            COLOR_TEXT_MUTED
                        };

                        let fill_color = if is_selected || is_highlighted {
                            COLOR_SURFACE_CARD
                        } else {
                            Color32::TRANSPARENT
                        };

                        let stroke = if is_selected {
                            Stroke::new(1.5_f32, COLOR_SIGNAL_TRIGGER)
                        } else if is_highlighted {
                            Stroke::new(1.5_f32, COLOR_SIGNAL_TX)
                        } else {
                            Stroke::NONE
                        };

                        let btn = egui::Button::new(
                            RichText::new(format!("{byte:02X}"))
                                .monospace()
                                .color(text_color)
                                .strong(),
                        )
                        .fill(fill_color)
                        .stroke(stroke)
                        .min_size(Vec2::new(20.0, 18.0));

                        if ui.add(btn).clicked() {
                            self.hex_selected_offset = Some(byte_offset);
                        }
                    }

                    // Separator between Hex and ASCII
                    ui.label(RichText::new("|").color(COLOR_BORDER_HAIRLINE));

                    // ASCII representation
                    for (col_idx, byte) in chunk.iter().enumerate() {
                        let byte_offset = row_offset + col_idx;
                        let is_selected = self.hex_selected_offset == Some(byte_offset);
                        let is_highlighted = self
                            .hex_highlight_range
                            .as_ref()
                            .map_or(false, |r| r.contains(&byte_offset));

                        let ch = if *byte >= 32 && *byte <= 126 {
                            *byte as char
                        } else {
                            '.'
                        };

                        let text_color = if is_selected {
                            COLOR_SIGNAL_TRIGGER
                        } else if is_highlighted {
                            COLOR_TEXT_PRIMARY
                        } else {
                            COLOR_TEXT_MUTED
                        };

                        let fill_color = if is_selected || is_highlighted {
                            COLOR_SURFACE_CARD
                        } else {
                            Color32::TRANSPARENT
                        };

                        let stroke = if is_selected {
                            Stroke::new(1.0_f32, COLOR_SIGNAL_TRIGGER)
                        } else if is_highlighted {
                            Stroke::new(1.0_f32, COLOR_SIGNAL_TX)
                        } else {
                            Stroke::NONE
                        };

                        let btn = egui::Button::new(
                            RichText::new(ch.to_string())
                                .monospace()
                                .color(text_color)
                                .strong(),
                        )
                        .fill(fill_color)
                        .stroke(stroke)
                        .min_size(Vec2::new(10.0, 18.0));

                        if ui.add(btn).clicked() {
                            self.hex_selected_offset = Some(byte_offset);
                        }
                    }
                });
            }
        });

        if let Some(offset) = self.hex_selected_offset {
            if offset < self.hex_data.len() {
                let byte = self.hex_data[offset];
                let ch = if byte >= 32 && byte <= 126 { byte as char } else { '.' };
                let float_val = if offset + 4 <= self.hex_data.len() {
                    Some(f32::from_le_bytes(self.hex_data[offset..offset + 4].try_into().unwrap()))
                } else {
                    None
                };
                let u16_val = if offset + 2 <= self.hex_data.len() {
                    Some(u16::from_le_bytes(self.hex_data[offset..offset + 2].try_into().unwrap()))
                } else {
                    None
                };
                let u32_val = if offset + 4 <= self.hex_data.len() {
                    Some(u32::from_le_bytes(self.hex_data[offset..offset + 4].try_into().unwrap()))
                } else {
                    None
                };

                ui.add_space(4.0);
                ui.group(|ui| {
                    ui.horizontal_wrapped(|ui| {
                        ui.label(RichText::new("BYTE INSPECT:").color(COLOR_SIGNAL_TX).strong());
                        ui.separator();
                        ui.label(RichText::new(format!("Offset: 0x{offset:04X} ({offset})")).color(COLOR_TEXT_PRIMARY).monospace());
                        ui.separator();
                        ui.label(RichText::new(format!("Hex: 0x{byte:02X}")).color(COLOR_SIGNAL_TX).monospace());
                        ui.separator();
                        ui.label(RichText::new(format!("Dec: {byte} (u8), {} (i8)", byte as i8)).color(COLOR_TEXT_PRIMARY).monospace());
                        ui.separator();
                        ui.label(RichText::new(format!("Bin: 0b{byte:08b}")).color(COLOR_SIGNAL_TRIGGER).monospace());
                        ui.separator();
                        ui.label(RichText::new(format!("ASCII: '{ch}'")).color(COLOR_TEXT_PRIMARY).monospace());
                        if let Some(f) = float_val {
                            ui.separator();
                            ui.label(RichText::new(format!("Float32 (LE): {f:+.4e} ({f:+.4})")).color(COLOR_SIGNAL_RX).monospace());
                        }
                        if let Some(u) = u16_val {
                            ui.separator();
                            ui.label(RichText::new(format!("UInt16 (LE): {u} (0x{u:04X})")).color(COLOR_TEXT_MUTED).monospace());
                        }
                        if let Some(u) = u32_val {
                            ui.separator();
                            ui.label(RichText::new(format!("UInt32 (LE): {u} (0x{u:08X})")).color(COLOR_TEXT_MUTED).monospace());
                        }
                    });
                });
            }
        }
    }

    /// Render Tab: Telemetry Oscilloscope.
    fn render_telemetry_scope(&mut self, ui: &mut Ui) {
        Self::render_header(
            ui,
            "[SCOPE]",
            "Telemetry Oscilloscope",
            if self.scope.paused {
                "PAUSED"
            } else if self.scope.trigger.is_triggered {
                "TRIGGER LOCKED"
            } else {
                "ACQUIRING"
            },
            if self.scope.paused {
                COLOR_TEXT_MUTED
            } else {
                COLOR_SIGNAL_RX
            },
        );

        self.scope.show(ui);
    }

    /// Helper rendering a field node in the protocol dissector tree.
    fn render_dissector_field_node(
        ui: &mut Ui,
        field: &crate::dissect::DecodedField,
        filter: &str,
        new_highlight: &mut Option<std::ops::Range<usize>>,
        new_selected: &mut Option<usize>,
    ) {
        let filter_lower = filter.trim().to_lowercase();
        let matches_filter = filter_lower.is_empty()
            || field.name.to_lowercase().contains(&filter_lower)
            || field.type_name.to_lowercase().contains(&filter_lower)
            || field.value_str.to_lowercase().contains(&filter_lower)
            || field.children.iter().any(|c| c.name.to_lowercase().contains(&filter_lower));

        if !matches_filter {
            return;
        }

        if field.children.is_empty() {
            let row = ui.horizontal(|ui| {
                ui.label(RichText::new("•").color(COLOR_TEXT_MUTED));
                ui.label(RichText::new(&field.type_name).color(COLOR_TEXT_MUTED).small());
                ui.label(RichText::new(&field.name).color(COLOR_TEXT_PRIMARY).strong());
                ui.label(RichText::new("=").color(COLOR_TEXT_MUTED));
                ui.label(RichText::new(&field.value_str).color(COLOR_SIGNAL_TX).monospace());

                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    ui.label(
                        RichText::new(format!(
                            "0x{:02X}..0x{:02X} ({}B)",
                            field.byte_offset,
                            field.byte_offset + field.byte_len,
                            field.byte_len
                        ))
                        .color(COLOR_TEXT_MUTED)
                        .small()
                        .monospace(),
                    );
                });
            }).response;

            if row.hovered() || row.clicked() {
                *new_highlight = Some(field.byte_offset..field.byte_offset + field.byte_len);
                if row.clicked() {
                    *new_selected = Some(field.byte_offset);
                }
            }
        } else {
            let header_text = format!(
                "{} {}: {}",
                field.type_name, field.name, field.value_str
            );

            let header_resp = egui::CollapsingHeader::new(
                RichText::new(header_text).color(COLOR_TEXT_PRIMARY).strong(),
            )
            .default_open(true)
            .show(ui, |ui| {
                for child in &field.children {
                    Self::render_dissector_field_node(ui, child, filter, new_highlight, new_selected);
                }
            });

            if header_resp.header_response.hovered() || header_resp.header_response.clicked() {
                *new_highlight = Some(field.byte_offset..field.byte_offset + field.byte_len);
                if header_resp.header_response.clicked() {
                    *new_selected = Some(field.byte_offset);
                }
            }
        }
    }

    /// Render Tab: Protocol Dissector Lab.
    fn render_protocol_dissector(&mut self, ui: &mut Ui) {
        Self::render_header(
            ui,
            "[DISSECT]",
            "Protocol Dissector Lab",
            "FRAMER: COBS+CRC32",
            COLOR_SIGNAL_TX,
        );

        // Top bar: Schema selector buttons
        ui.horizontal(|ui| {
            ui.label(RichText::new("Schema:").color(COLOR_TEXT_MUTED).strong());

            let is_imu = matches!(self.dissector_schema, crate::dissect::DissectorSchema::BuiltinImu);
            let imu_btn = egui::Button::new(
                RichText::new("[Built-in IMU 9-DoF]")
                    .color(if is_imu { COLOR_SIGNAL_TX } else { COLOR_TEXT_PRIMARY })
                    .strong(),
            )
            .fill(if is_imu { COLOR_SURFACE_CARD } else { Color32::TRANSPARENT });

            if ui.add(imu_btn).clicked() {
                self.dissector_schema = crate::dissect::DissectorSchema::BuiltinImu;
                self.last_decoded_packet = crate::dissect::decode_packet(&self.hex_data, &self.dissector_schema);
            }

            let is_c = matches!(self.dissector_schema, crate::dissect::DissectorSchema::CustomCHeader(_));
            let c_btn = egui::Button::new(
                RichText::new("[Load C Header .h...]")
                    .color(if is_c { COLOR_SIGNAL_TX } else { COLOR_TEXT_PRIMARY }),
            )
            .fill(if is_c { COLOR_SURFACE_CARD } else { Color32::TRANSPARENT });

            if ui.add(c_btn).clicked() {
                if let Some(path) = rfd::FileDialog::new()
                    .add_filter("C Header", &["h", "hpp", "c"])
                    .pick_file()
                {
                    let path_str = path.to_string_lossy().to_string();
                    self.dissector_schema = crate::dissect::DissectorSchema::CustomCHeader(path_str);
                    self.last_decoded_packet = crate::dissect::decode_packet(&self.hex_data, &self.dissector_schema);
                }
            }

            let is_proto = matches!(self.dissector_schema, crate::dissect::DissectorSchema::CustomProtobuf(_));
            let proto_btn = egui::Button::new(
                RichText::new("[Load Protobuf...]")
                    .color(if is_proto { COLOR_SIGNAL_TX } else { COLOR_TEXT_PRIMARY }),
            )
            .fill(if is_proto { COLOR_SURFACE_CARD } else { Color32::TRANSPARENT });

            if ui.add(proto_btn).clicked() {
                if let Some(path) = rfd::FileDialog::new()
                    .add_filter("Protobuf Schema", &["proto", "bin", "desc"])
                    .pick_file()
                {
                    let path_str = path.to_string_lossy().to_string();
                    self.dissector_schema = crate::dissect::DissectorSchema::CustomProtobuf(path_str);
                    self.last_decoded_packet = crate::dissect::decode_packet(&self.hex_data, &self.dissector_schema);
                }
            }
        });

        ui.add_space(4.0);

        ui.horizontal(|ui| {
            ui.label(RichText::new("Search Fields:").color(COLOR_TEXT_MUTED));
            ui.text_edit_singleline(&mut self.dissector_filter);
            ui.label(RichText::new(format!("Processed: {} pkts", self.dissector_packet_count)).color(COLOR_TEXT_MUTED));
        });

        ui.separator();

        if self.last_decoded_packet.is_none() && !self.hex_data.is_empty() {
            self.last_decoded_packet = crate::dissect::decode_packet(&self.hex_data, &self.dissector_schema);
        }

        let mut new_highlight = None;
        let mut new_selected = None;

        if let Some(ref packet) = self.last_decoded_packet {
            // Status Badges
            ui.horizontal(|ui| {
                ui.label(RichText::new(format!("Active: {}", packet.schema_name)).color(COLOR_TEXT_PRIMARY).strong());
                ui.separator();

                // Sync word badge
                if packet.sync_valid {
                    ui.label(RichText::new("[SYNC 0xBADE OK]").color(COLOR_SIGNAL_RX).strong());
                } else {
                    ui.label(RichText::new("[SYNC MISMATCH]").color(COLOR_SIGNAL_FAULT).strong());
                }

                ui.separator();

                // CRC verification badge
                if packet.crc_valid {
                    ui.label(RichText::new("[CRC32 OK]").color(COLOR_SIGNAL_RX).strong());
                } else {
                    ui.label(RichText::new("[CRC MISMATCH]").color(COLOR_SIGNAL_FAULT).strong());
                }

                ui.separator();
                ui.label(RichText::new(format!("[Payload: {} bytes]", packet.payload_len)).color(COLOR_TEXT_MUTED));
            });

            ui.separator();

            // Field Tree View
            egui::ScrollArea::vertical().show(ui, |ui| {
                for field in &packet.fields {
                    Self::render_dissector_field_node(
                        ui,
                        field,
                        &self.dissector_filter,
                        &mut new_highlight,
                        &mut new_selected,
                    );
                }
            });
        } else {
            ui.label(RichText::new("No packet decoded. Ensure bytes match schema format.").color(COLOR_TEXT_MUTED));
        }

        if new_highlight.is_some() {
            self.hex_highlight_range = new_highlight;
        }
        if new_selected.is_some() {
            self.hex_selected_offset = new_selected;
        }
    }

    /// Render Tab: HIL Bridge & Fault Injection.
    fn render_hil_bridge(&mut self, ui: &mut Ui) {
        let status = if self.hil.is_active { "BRIDGE ACTIVE" } else { "BYPASS IDLE" };
        let status_color = if self.hil.is_active { COLOR_SIGNAL_RX } else { COLOR_SIGNAL_TRIGGER };

        Self::render_header(ui, "[HIL-RIG]", "Hardware-In-The-Loop Bridge", status, status_color);

        self.hil.show(ui);
    }

    /// Render Tab: Dashboards & Gauges.
    fn render_dashboards(&mut self, ui: &mut Ui) {
        Self::render_header(
            ui,
            "[DASH]",
            "Dashboards & Instrument Gauges",
            "ONLINE",
            COLOR_SIGNAL_RX,
        );

        // Top toolbar
        ui.horizontal(|ui| {
            if ui.button("+ Add Gauge").clicked() {
                let count = self.dashboard.widgets.len() + 1;
                self.dashboard.add_widget(crate::dashboard::DashboardWidget {
                    id: format!("gauge_{}", count),
                    title: format!("Radial Gauge {}", count),
                    unit: "RPM".to_string(),
                    bound_signal: "rpm".to_string(),
                    widget_type: crate::dashboard::WidgetType::RadialGauge {
                        min: 0.0,
                        max: 12000.0,
                        warn: 9000.0,
                        crit: 10500.0,
                    },
                    current_value: 0.0,
                });
            }
            if ui.button("+ Add Meter").clicked() {
                let count = self.dashboard.widgets.len() + 1;
                self.dashboard.add_widget(crate::dashboard::DashboardWidget {
                    id: format!("meter_{}", count),
                    title: format!("Bar Meter {}", count),
                    unit: "%".to_string(),
                    bound_signal: "temp".to_string(),
                    widget_type: crate::dashboard::WidgetType::BarMeter {
                        min: 0.0,
                        max: 100.0,
                    },
                    current_value: 0.0,
                });
            }
            if ui.button("+ Add LED").clicked() {
                let count = self.dashboard.widgets.len() + 1;
                self.dashboard.add_widget(crate::dashboard::DashboardWidget {
                    id: format!("led_{}", count),
                    title: format!("Status LED {}", count),
                    unit: "".to_string(),
                    bound_signal: "sync".to_string(),
                    widget_type: crate::dashboard::WidgetType::StatusLed {
                        active_threshold: 0.5,
                    },
                    current_value: 0.0,
                });
            }
            if ui.button("+ Add Trend Chart").clicked() {
                let count = self.dashboard.widgets.len() + 1;
                self.dashboard.add_widget(crate::dashboard::DashboardWidget {
                    id: format!("chart_{}", count),
                    title: format!("Trend Chart {}", count),
                    unit: "g".to_string(),
                    bound_signal: "az".to_string(),
                    widget_type: crate::dashboard::WidgetType::RollingChart {
                        history: Vec::with_capacity(80),
                        max_points: 80,
                    },
                    current_value: 0.0,
                });
            }
            ui.separator();
            if ui.button("Reset Defaults").clicked() {
                self.dashboard = crate::dashboard::default_dashboard();
            }
        });

        ui.add_space(8.0);

        // Responsive wrapping grid of cards
        egui::ScrollArea::vertical().show(ui, |ui| {
            let avail_w = ui.available_width();
            let num_cols = if avail_w > 960.0 { 3 } else { 2 };
            let spacing = 8.0_f32;
            let card_w = ((avail_w - (num_cols - 1) as f32 * spacing) / num_cols as f32).max(180.0);

            let mut remove_idx = None;
            let widget_count = self.dashboard.widgets.len();

            for row_start in (0..widget_count).step_by(num_cols) {
                let row_end = (row_start + num_cols).min(widget_count);
                ui.horizontal(|ui| {
                    for idx in row_start..row_end {
                        ui.allocate_ui_with_layout(
                            Vec2::new(card_w, 0.0),
                            egui::Layout::top_down(egui::Align::Min),
                            |ui| {
                                ui.set_width(card_w);
                                let widget = &self.dashboard.widgets[idx];
                                if crate::dashboard::render_widget_card(ui, widget) {
                                    remove_idx = Some(idx);
                                }
                            },
                        );
                        if idx + 1 < row_end {
                            ui.add_space(spacing);
                        }
                    }
                });
                ui.add_space(spacing);
            }

            if let Some(idx) = remove_idx {
                self.dashboard.remove_widget(idx);
            }
        });
    }

    /// Render Tab: Vault Review & Scrubber.
    fn render_vault_scrubber(&mut self, ui: &mut Ui) {
        let status = if self.vault.is_recording { "RECORDING" } else { "INDEXED" };
        let status_color = if self.vault.is_recording { COLOR_SIGNAL_FAULT } else { COLOR_SIGNAL_TX };

        Self::render_header(
            ui,
            "[VAULT]",
            "Vault Review & Scrubber (.bflog)",
            status,
            status_color,
        );

        self.vault.show(ui);
    }

    /// Render Tab: Workspace Configuration.
    fn render_workspace_config(&mut self, ui: &mut Ui) {
        let is_loaded = self.workspace.file_path.is_some();
        let status = if is_loaded { "SYNCED" } else { "UNSAVED" };
        let status_color = if is_loaded { COLOR_SIGNAL_RX } else { COLOR_SIGNAL_TRIGGER };

        Self::render_header(
            ui,
            "[CONFIG]",
            "Workspace Configuration",
            status,
            status_color,
        );

        egui::ScrollArea::vertical().show(ui, |ui| {
            // Card 1: Active Workspace
            egui::Frame::NONE
                .fill(COLOR_SURFACE_CARD)
                .stroke(Stroke::new(1.0_f32, COLOR_BORDER_HAIRLINE))
                .corner_radius(CornerRadius::same(4))
                .inner_margin(Margin::same(12))
                .show(ui, |ui| {
                    ui.label(
                        RichText::new("ACTIVE WORKSPACE")
                            .color(COLOR_SIGNAL_TX)
                            .strong()
                            .monospace()
                            .small(),
                    );
                    ui.add_space(6.0);

                    ui.horizontal(|ui| {
                        ui.label(RichText::new("Workspace Name:").color(COLOR_TEXT_MUTED));
                        ui.text_edit_singleline(&mut self.workspace.name);
                    });

                    ui.horizontal(|ui| {
                        ui.label(RichText::new("File Path:").color(COLOR_TEXT_MUTED));
                        let path_str = self
                            .workspace
                            .file_path
                            .as_deref()
                            .unwrap_or("(unsaved workspace)");
                        ui.label(RichText::new(path_str).monospace().color(COLOR_TEXT_PRIMARY));
                    });

                    ui.add_space(8.0);
                    ui.horizontal(|ui| {
                        if ui.button("💾 Save .bforge.toml").clicked() {
                            if let Some(path_str) = self.workspace.file_path.clone() {
                                let path = std::path::Path::new(&path_str);
                                let _ = self.workspace.save_to_file(path);
                            } else if let Some(path) = rfd::FileDialog::new()
                                .add_filter("BaudForge Project", &["bforge.toml", "toml"])
                                .save_file()
                            {
                                if self.workspace.save_to_file(&path).is_ok() {
                                    self.workspace.file_path = Some(path.to_string_lossy().to_string());
                                }
                            }
                        }

                        if ui.button("💾 Save As...").clicked() {
                            if let Some(path) = rfd::FileDialog::new()
                                .add_filter("BaudForge Project", &["bforge.toml", "toml"])
                                .save_file()
                            {
                                if self.workspace.save_to_file(&path).is_ok() {
                                    self.workspace.file_path = Some(path.to_string_lossy().to_string());
                                }
                            }
                        }

                        if ui.button("📂 Open .bforge.toml").clicked() {
                            if let Some(path) = rfd::FileDialog::new()
                                .add_filter("BaudForge Project", &["bforge.toml", "toml"])
                                .pick_file()
                            {
                                if self.workspace.load_from_file(&path).is_ok() {
                                    if let Some(elf_str) = &self.workspace.elf_path {
                                        let elf_p = std::path::Path::new(elf_str);
                                        if let Ok(count) = self.elf_resolver.load(elf_p) {
                                            self.workspace.loaded_symbols_count = count;
                                        }
                                    }
                                }
                            }
                        }
                    });
                });

            ui.add_space(10.0);

            // Card 2: Hardware Port & Line Configuration
            egui::Frame::NONE
                .fill(COLOR_SURFACE_CARD)
                .stroke(Stroke::new(1.0_f32, COLOR_BORDER_HAIRLINE))
                .corner_radius(CornerRadius::same(4))
                .inner_margin(Margin::same(12))
                .show(ui, |ui| {
                    ui.label(
                        RichText::new("HARDWARE PORT & LINE CONFIGURATION")
                            .color(COLOR_SIGNAL_RX)
                            .strong()
                            .monospace()
                            .small(),
                    );
                    ui.add_space(6.0);

                    ui.horizontal(|ui| {
                        ui.label(RichText::new("Port Name:").color(COLOR_TEXT_MUTED));
                        egui::ComboBox::from_id_salt("ws_port_select")
                            .selected_text(if self.workspace.primary_port.is_empty() {
                                "Select Port..."
                            } else {
                                &self.workspace.primary_port
                            })
                            .show_ui(ui, |ui| {
                                for p in &self.available_ports {
                                    ui.selectable_value(
                                        &mut self.workspace.primary_port,
                                        p.port_name.clone(),
                                        &p.port_name,
                                    );
                                }
                            });
                        ui.text_edit_singleline(&mut self.workspace.primary_port);
                    });

                    ui.horizontal(|ui| {
                        ui.label(RichText::new("Baud Rate:").color(COLOR_TEXT_MUTED));
                        egui::ComboBox::from_id_salt("ws_baud_select")
                            .selected_text(format!("{}", self.workspace.baud_rate))
                            .show_ui(ui, |ui| {
                                ui.selectable_value(&mut self.workspace.baud_rate, 9600, "9600");
                                ui.selectable_value(&mut self.workspace.baud_rate, 57600, "57600");
                                ui.selectable_value(&mut self.workspace.baud_rate, 115200, "115200");
                                ui.selectable_value(&mut self.workspace.baud_rate, 230400, "230400");
                                ui.selectable_value(&mut self.workspace.baud_rate, 460800, "460800");
                                ui.selectable_value(&mut self.workspace.baud_rate, 921600, "921600");
                                ui.selectable_value(&mut self.workspace.baud_rate, 2000000, "2000000");
                                ui.selectable_value(&mut self.workspace.baud_rate, 3000000, "3000000");
                            });
                    });

                    ui.horizontal(|ui| {
                        ui.label(RichText::new("Framing Format:").color(COLOR_TEXT_MUTED));
                        egui::ComboBox::from_id_salt("ws_framing_select")
                            .selected_text(match self.workspace.framing.as_str() {
                                "delimiter" => "Line Delimiter (\\n)",
                                "cobs" => "COBS (Zero-delimited)",
                                "header_length" => "Header + Length",
                                "slip" => "SLIP (RFC 1055)",
                                "idle_gap" => "Idle Gap (Modbus)",
                                other => other,
                            })
                            .show_ui(ui, |ui| {
                                ui.selectable_value(
                                    &mut self.workspace.framing,
                                    "delimiter".to_string(),
                                    "Line Delimiter (\\n)",
                                );
                                ui.selectable_value(
                                    &mut self.workspace.framing,
                                    "cobs".to_string(),
                                    "COBS (Zero-delimited)",
                                );
                                ui.selectable_value(
                                    &mut self.workspace.framing,
                                    "header_length".to_string(),
                                    "Header + Length",
                                );
                                ui.selectable_value(
                                    &mut self.workspace.framing,
                                    "slip".to_string(),
                                    "SLIP (RFC 1055)",
                                );
                                ui.selectable_value(
                                    &mut self.workspace.framing,
                                    "idle_gap".to_string(),
                                    "Idle Gap (Modbus)",
                                );
                            });
                    });

                    ui.horizontal(|ui| {
                        ui.label(RichText::new("Dissector Schema:").color(COLOR_TEXT_MUTED));
                        let mut schema_str = self.workspace.dissector_path.clone().unwrap_or_default();
                        if ui.text_edit_singleline(&mut schema_str).changed() {
                            self.workspace.dissector_path = if schema_str.is_empty() {
                                None
                            } else {
                                Some(schema_str.clone())
                            };
                        }
                        if ui.button("Browse...").clicked() {
                            if let Some(path) = rfd::FileDialog::new()
                                .add_filter("Dissector Schemas", &["h", "proto", "ksc", "json"])
                                .pick_file()
                            {
                                self.workspace.dissector_path = Some(path.to_string_lossy().to_string());
                            }
                        }
                    });
                });

            ui.add_space(10.0);

            // Card 3: ELF Firmware Symbol Resolver
            egui::Frame::NONE
                .fill(COLOR_SURFACE_CARD)
                .stroke(Stroke::new(1.0_f32, COLOR_BORDER_HAIRLINE))
                .corner_radius(CornerRadius::same(4))
                .inner_margin(Margin::same(12))
                .show(ui, |ui| {
                    ui.horizontal(|ui| {
                        ui.label(
                            RichText::new("ELF FIRMWARE SYMBOL RESOLVER")
                                .color(COLOR_SIGNAL_TRIGGER)
                                .strong()
                                .monospace()
                                .small(),
                        );

                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            if self.elf_resolver.image.is_some() {
                                let count_display = format!("{} Symbols Loaded", self.workspace.loaded_symbols_count);
                                ui.label(
                                    RichText::new(format!("[{count_display}]"))
                                        .color(COLOR_SIGNAL_RX)
                                        .monospace()
                                        .strong(),
                                );
                            } else {
                                ui.label(RichText::new("[No ELF Loaded]").color(COLOR_TEXT_MUTED).monospace());
                            }
                        });
                    });
                    ui.add_space(6.0);

                    ui.horizontal(|ui| {
                        ui.label(RichText::new("ELF Binary Path:").color(COLOR_TEXT_MUTED));
                        let mut elf_str = self.workspace.elf_path.clone().unwrap_or_default();
                        if ui.text_edit_singleline(&mut elf_str).changed() {
                            self.workspace.elf_path = if elf_str.is_empty() {
                                None
                            } else {
                                Some(elf_str.clone())
                            };
                        }
                        if ui.button("Browse .elf...").clicked() {
                            if let Some(path) = rfd::FileDialog::new()
                                .add_filter("ELF Firmware Binary", &["elf", "bin", "axf", "out", "exe"])
                                .pick_file()
                            {
                                let p_str = path.to_string_lossy().to_string();
                                self.workspace.elf_path = Some(p_str.clone());
                                match self.elf_resolver.load(&path) {
                                    Ok(count) => {
                                        self.workspace.loaded_symbols_count = count;
                                    }
                                    Err(e) => {
                                        eprintln!("Failed to load ELF: {e}");
                                    }
                                }
                            }
                        }
                        if ui.button("Load / Reload").clicked() {
                            if let Some(ref path_str) = self.workspace.elf_path {
                                let path = std::path::Path::new(path_str);
                                match self.elf_resolver.load(path) {
                                    Ok(count) => {
                                        self.workspace.loaded_symbols_count = count;
                                    }
                                    Err(e) => {
                                        eprintln!("Failed to load ELF: {e}");
                                    }
                                }
                            }
                        }
                    });

                    ui.add_space(8.0);
                    ui.separator();
                    ui.add_space(4.0);

                    // Manual address lookup test box
                    ui.label(RichText::new("Manual Address Lookup Test:").color(COLOR_TEXT_PRIMARY).strong().small());
                    ui.horizontal(|ui| {
                        ui.label(RichText::new("Address:").color(COLOR_TEXT_MUTED));
                        ui.add(egui::TextEdit::singleline(&mut self.elf_lookup_addr).hint_text("e.g. 0x42001000"));

                        let clean_hex = self
                            .elf_lookup_addr
                            .trim()
                            .trim_start_matches("0x")
                            .trim_start_matches("0X");
                        if let Ok(addr) = u64::from_str_radix(clean_hex, 16) {
                            if let Some(loc) = self.elf_resolver.resolve_location(addr) {
                                let fn_name = if loc.function.is_empty() {
                                    "unknown"
                                } else {
                                    &loc.function
                                };
                                ui.label(
                                    RichText::new(format!("=> fn: {} @ {}:{}", fn_name, loc.file, loc.line))
                                        .color(COLOR_SIGNAL_RX)
                                        .monospace()
                                        .strong(),
                                );
                            } else if let Some(func) = self.elf_resolver.resolve(addr) {
                                ui.label(
                                    RichText::new(format!("=> fn: {} (size: {}B)", func.name, func.size))
                                        .color(COLOR_SIGNAL_RX)
                                        .monospace()
                                        .strong(),
                                );
                            } else if self.elf_resolver.image.is_some() {
                                ui.label(
                                    RichText::new("=> not found in symbol table")
                                        .color(COLOR_SIGNAL_FAULT)
                                        .monospace(),
                                );
                            } else {
                                ui.label(
                                    RichText::new("=> (load an ELF image above)")
                                        .color(COLOR_TEXT_MUTED)
                                        .monospace(),
                                );
                            }
                        } else if !self.elf_lookup_addr.is_empty() {
                            ui.label(
                                RichText::new("=> invalid hex address")
                                    .color(COLOR_SIGNAL_FAULT)
                                    .monospace(),
                            );
                        }
                    });
                });

            ui.add_space(12.0);
        });
    }
}

impl egui_dock::TabViewer for BaudForgeTabViewer {
    type Tab = TabId;

    fn title(&mut self, tab: &mut Self::Tab) -> egui::WidgetText {
        tab.title().into()
    }

    fn ui(&mut self, ui: &mut Ui, tab: &mut Self::Tab) {
        match tab {
            TabId::Welcome => self.render_welcome(ui),
            TabId::SerialMonitor => self.render_serial_monitor(ui),
            TabId::HexInspector => self.render_hex_inspector(ui),
            TabId::TxConsole => self.render_tx_console(ui),
            TabId::ProtocolDissector => self.render_protocol_dissector(ui),
            TabId::TelemetryScope => self.render_telemetry_scope(ui),
            TabId::Dashboards => self.render_dashboards(ui),
            TabId::HilBridge => self.render_hil_bridge(ui),
            TabId::VaultScrubber => self.render_vault_scrubber(ui),
            TabId::WorkspaceConfig => self.render_workspace_config(ui),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tab_viewer_default_state() {
        let viewer = BaudForgeTabViewer::default();

        assert_eq!(viewer.hex_data.len(), 48, "Sample packet should be 48 bytes");
        assert!(viewer.last_decoded_packet.is_some(), "Default packet should be decoded");

        let packet = viewer.last_decoded_packet.as_ref().unwrap();
        assert!(packet.sync_valid, "Sync word should be valid");
        assert!(packet.crc_valid, "CRC32 should be valid");
        assert_eq!(packet.payload_len, 48);
        assert_eq!(packet.fields.len(), 7);

        assert_eq!(viewer.dissector_schema, crate::dissect::DissectorSchema::BuiltinImu);
        assert_eq!(viewer.hex_selected_offset, Some(0));
        assert!(viewer.hex_highlight_range.is_none());
    }

    #[test]
    fn test_cross_highlight_range() {
        let mut viewer = BaudForgeTabViewer::default();
        let packet = viewer.last_decoded_packet.as_ref().unwrap();

        // Accel field is at offset 6..18
        let accel = &packet.fields[2];
        assert_eq!(accel.name, "accel");
        viewer.hex_highlight_range = Some(accel.byte_offset..accel.byte_offset + accel.byte_len);

        assert_eq!(viewer.hex_highlight_range, Some(6..18));
        assert!(viewer.hex_highlight_range.as_ref().unwrap().contains(&6));
        assert!(viewer.hex_highlight_range.as_ref().unwrap().contains(&17));
        assert!(!viewer.hex_highlight_range.as_ref().unwrap().contains(&18));
    }
}
