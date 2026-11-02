use egui::{self, Color32, RichText, Stroke, StrokeKind, Ui, Vec2};
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

    // Serial Monitor State
    pub serial_filter: String,
    pub serial_paused: bool,
    pub serial_autoscroll: bool,
    pub serial_lines: Vec<String>,

    // TX Console State
    pub tx_hex_mode: bool,
    pub tx_input: String,
    pub tx_history: Vec<String>,

    // Hex Inspector State
    pub hex_data: Vec<u8>,
    pub hex_selected_offset: Option<usize>,

    // Telemetry Scope State
    pub scope_channels: [bool; 4],
    pub scope_timebase_ms: f32,
    pub scope_trigger_source: usize,
    pub scope_trigger_rising: bool,
    pub scope_trigger_threshold: f32,

    // Protocol Dissector State
    pub dissector_filter: String,
    pub dissector_packet_count: usize,

    // HIL Bridge State
    pub hil_port_a: String,
    pub hil_port_b: String,
    pub hil_ber_rate: f32,
    pub hil_drop_pct: f32,
    pub hil_jitter_ms: u32,
    pub hil_bridge_active: bool,

    // Dashboards State
    pub dash_rpm: f32,
    pub dash_temp_c: f32,
    pub dash_bus_volts: f32,
    pub dash_power_ok: bool,

    // Vault Scrubber State
    pub vault_progress: f32,
    pub vault_playing: bool,
    pub vault_frame_index: usize,
    pub vault_total_frames: usize,

    // Workspace Config State
    pub ws_path: String,
    pub ws_baud: u32,
    pub ws_framing: String,
}

impl Default for BaudForgeTabViewer {
    fn default() -> Self {
        let sample_hex: Vec<u8> = vec![
            0xBA, 0xDE, 0x01, 0x00, 0x30, 0x00, 0x3F, 0x80,
            0x00, 0x00, 0xBF, 0x00, 0x00, 0x00, 0x3E, 0xAA,
            0xAB, 0xCD, 0x12, 0x34, 0x56, 0x78, 0x9A, 0xBC,
            0xDE, 0xF0, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66,
            0x77, 0x88, 0x99, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE,
            0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x7F, 0x83,
            0xA1, 0x2E, 0x55, 0xAA, 0xFF, 0x00, 0xAA, 0x55,
            0x01, 0x23, 0x45, 0x67, 0x89, 0xAB, 0xCD, 0xEF,
        ];

        Self {
            pending_action: None,

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
            tx_input: "AT+STATUS\r\n".to_string(),
            tx_history: vec![
                "TX -> AT+PING".to_string(),
                "RX <- OK:PONG".to_string(),
                "TX -> AT+CONFIG:STREAM=IMU_RAW,RATE=500".to_string(),
            ],

            hex_data: sample_hex,
            hex_selected_offset: Some(0),

            scope_channels: [true, true, false, false],
            scope_timebase_ms: 10.0,
            scope_trigger_source: 0,
            scope_trigger_rising: true,
            scope_trigger_threshold: 1.65,

            dissector_filter: String::new(),
            dissector_packet_count: 14820,

            hil_port_a: "COM3 (DUT Target)".to_string(),
            hil_port_b: "COM4 (HIL Loopback)".to_string(),
            hil_ber_rate: 0.0,
            hil_drop_pct: 0.0,
            hil_jitter_ms: 0,
            hil_bridge_active: true,

            dash_rpm: 4820.0,
            dash_temp_c: 42.6,
            dash_bus_volts: 24.1,
            dash_power_ok: true,

            vault_progress: 38.5,
            vault_playing: false,
            vault_frame_index: 4820,
            vault_total_frames: 12500,

            ws_path: "./workspaces/cubesat_imu.bforge.toml".to_string(),
            ws_baud: 921600,
            ws_framing: "COBS + CRC32-Castagnoli".to_string(),
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

    /// Render Tab: Welcome & Quick Start.
    fn render_welcome(&mut self, ui: &mut Ui) {
        Self::render_header(
            ui,
            "[WELCOME]",
            "Hardware Setup & Workflows",
            "STANDBY",
            COLOR_SIGNAL_TX,
        );

        ui.add_space(6.0);
        ui.label(
            RichText::new("BaudForge Native HIL Workbench")
                .size(16.0)
                .color(COLOR_TEXT_PRIMARY)
                .strong(),
        );
        ui.label(
            RichText::new("Real-time telemetry, serial protocol dissector, and hardware-in-the-loop bridge.")
                .color(COLOR_TEXT_MUTED),
        );

        ui.add_space(12.0);
        ui.label(RichText::new("QUICK ACTIONS").color(COLOR_SIGNAL_TX).small().strong());

        ui.horizontal_wrapped(|ui| {
            if ui.button(RichText::new("🔌 Quick Connect Hardware").strong()).clicked() {
                self.pending_action = Some(TabAction::QuickConnect);
            }
            if ui.button(RichText::new("🔄 Load IMU Loopback Demo").strong()).clicked() {
                self.pending_action = Some(TabAction::LoadImuDemo);
            }
            if ui.button(RichText::new("🔬 Open Protocol Lab").strong()).clicked() {
                self.pending_action = Some(TabAction::OpenProtocolLab);
            }
            if ui.button(RichText::new("📈 Open Telemetry Scope").strong()).clicked() {
                self.pending_action = Some(TabAction::OpenTelemetryScope);
            }
            if ui.button(RichText::new("📦 Load .bflog Vault").strong()).clicked() {
                self.pending_action = Some(TabAction::LoadVault);
            }
        });

        ui.add_space(16.0);
        ui.group(|ui| {
            ui.label(RichText::new("SYSTEM READINESS").color(COLOR_TEXT_PRIMARY).strong());
            ui.label("• Native Windows serial port subsystem: READY");
            ui.label("• Ring buffer backpressure engine: OPTIMAL");
            ui.label("• Vault write journal: IDLE");
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

                    ui.label(RichText::new(line).color(color).monospace());
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
                if !self.tx_input.trim().is_empty() {
                    self.tx_history.push(format!("TX -> {}", self.tx_input.trim()));
                    self.tx_input.clear();
                }
            }
        });

        ui.horizontal(|ui| {
            ui.label(RichText::new("Presets:").color(COLOR_TEXT_MUTED).small());
            if ui.small_button("AT+STATUS").clicked() {
                self.tx_input = "AT+STATUS\r\n".to_string();
            }
            if ui.small_button("AT+RESET").clicked() {
                self.tx_input = "AT+RESET\r\n".to_string();
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

                        let text = format!("{byte:02X}");
                        let mut rich = RichText::new(text).monospace();
                        if is_selected {
                            rich = rich.color(COLOR_SIGNAL_TX).strong();
                        } else if *byte == 0xBA || *byte == 0xDE {
                            rich = rich.color(COLOR_SIGNAL_TRIGGER);
                        } else {
                            rich = rich.color(COLOR_TEXT_PRIMARY);
                        }

                        if ui.selectable_label(is_selected, rich).clicked() {
                            self.hex_selected_offset = Some(byte_offset);
                        }
                    }

                    // Separator between Hex and ASCII
                    ui.label(RichText::new("|").color(COLOR_BORDER_HAIRLINE));

                    // ASCII representation
                    let mut ascii_repr = String::with_capacity(chunk.len());
                    for byte in chunk {
                        if *byte >= 32 && *byte <= 126 {
                            ascii_repr.push(*byte as char);
                        } else {
                            ascii_repr.push('.');
                        }
                    }
                    ui.label(RichText::new(ascii_repr).color(COLOR_TEXT_MUTED).monospace());
                });
            }
        });
    }

    /// Render Tab: Telemetry Oscilloscope.
    fn render_telemetry_scope(&mut self, ui: &mut Ui) {
        Self::render_header(
            ui,
            "[SCOPE]",
            "Telemetry Oscilloscope",
            "TRIGGER LOCKED",
            COLOR_SIGNAL_RX,
        );

        // Scope controls toolbar
        ui.horizontal(|ui| {
            ui.label(RichText::new("Channels:").color(COLOR_TEXT_MUTED));
            ui.checkbox(&mut self.scope_channels[0], RichText::new("CH1 (Roll)").color(COLOR_SIGNAL_TX));
            ui.checkbox(&mut self.scope_channels[1], RichText::new("CH2 (Pitch)").color(COLOR_SIGNAL_RX));
            ui.checkbox(&mut self.scope_channels[2], RichText::new("CH3 (Yaw)").color(COLOR_SIGNAL_TRIGGER));
            ui.checkbox(&mut self.scope_channels[3], RichText::new("CH4 (Accel Z)").color(COLOR_SIGNAL_FAULT));
        });

        ui.horizontal(|ui| {
            ui.label(RichText::new("Timebase:").color(COLOR_TEXT_MUTED));
            ui.add(egui::Slider::new(&mut self.scope_timebase_ms, 1.0..=100.0).suffix(" ms/div"));

            ui.separator();
            ui.label(RichText::new("Trigger:").color(COLOR_TEXT_MUTED));
            ui.radio_value(&mut self.scope_trigger_rising, true, "Rising");
            ui.radio_value(&mut self.scope_trigger_rising, false, "Falling");
        });

        ui.separator();

        // Waveform plot area (Mock visualization grid)
        let available_size = ui.available_size();
        let (rect, _response) = ui.allocate_exact_size(
            Vec2::new(available_size.x, (available_size.y - 10.0_f32).max(180.0_f32)),
            egui::Sense::hover(),
        );

        let painter = ui.painter_at(rect);
        painter.rect_filled(rect, 4.0_f32, COLOR_SURFACE_CARD);
        painter.rect_stroke(
            rect,
            4.0_f32,
            Stroke::new(1.0_f32, COLOR_BORDER_HAIRLINE),
            StrokeKind::Inside,
        );

        // Draw oscilloscope grid lines
        let divisions_x = 10;
        let divisions_y = 6;
        for i in 1..divisions_x {
            let x = rect.left() + (rect.width() / divisions_x as f32) * i as f32;
            painter.line_segment(
                [egui::pos2(x, rect.top()), egui::pos2(x, rect.bottom())],
                Stroke::new(0.5_f32, COLOR_BORDER_HAIRLINE),
            );
        }
        for i in 1..divisions_y {
            let y = rect.top() + (rect.height() / divisions_y as f32) * i as f32;
            painter.line_segment(
                [egui::pos2(rect.left(), y), egui::pos2(rect.right(), y)],
                Stroke::new(0.5_f32, COLOR_BORDER_HAIRLINE),
            );
        }

        // Draw mock waveform sine curves
        if self.scope_channels[0] {
            let points: Vec<egui::Pos2> = (0..100)
                .map(|i| {
                    let norm_x = i as f32 / 100.0_f32;
                    let x = rect.left() + norm_x * rect.width();
                    let wave = (norm_x * 12.0_f32).sin();
                    let y = rect.center().y + wave * 40.0_f32;
                    egui::pos2(x, y)
                })
                .collect();
            painter.line(points, Stroke::new(1.5_f32, COLOR_SIGNAL_TX));
        }

        if self.scope_channels[1] {
            let points: Vec<egui::Pos2> = (0..100)
                .map(|i| {
                    let norm_x = i as f32 / 100.0_f32;
                    let x = rect.left() + norm_x * rect.width();
                    let wave = (norm_x * 8.0_f32 + 1.2_f32).cos();
                    let y = rect.center().y + wave * 30.0_f32;
                    egui::pos2(x, y)
                })
                .collect();
            painter.line(points, Stroke::new(1.5_f32, COLOR_SIGNAL_RX));
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

        ui.horizontal(|ui| {
            ui.label(RichText::new("Search Fields:").color(COLOR_TEXT_MUTED));
            ui.text_edit_singleline(&mut self.dissector_filter);
            ui.label(RichText::new(format!("Processed: {} pkts", self.dissector_packet_count)).color(COLOR_TEXT_MUTED));
        });

        ui.separator();

        // Dissector packet field tree
        egui::ScrollArea::vertical().show(ui, |ui| {
            ui.collapsing("📦 Frame Header [Offset 0x00..0x06]", |ui| {
                ui.horizontal(|ui| {
                    ui.label(RichText::new("Sync Word:").color(COLOR_TEXT_MUTED));
                    ui.label(RichText::new("0xBAUD").color(COLOR_SIGNAL_TX).monospace());
                    ui.label("(type: u16, value: 0xBAUD [MATCH])");
                });
                ui.horizontal(|ui| {
                    ui.label(RichText::new("Packet ID:").color(COLOR_TEXT_MUTED));
                    ui.label(RichText::new("0x01").color(COLOR_TEXT_PRIMARY).monospace());
                    ui.label("(type: u8, descriptor: IMU_TELEMETRY)");
                });
                ui.horizontal(|ui| {
                    ui.label(RichText::new("Payload Length:").color(COLOR_TEXT_MUTED));
                    ui.label(RichText::new("48 bytes").color(COLOR_TEXT_PRIMARY).monospace());
                    ui.label("(type: u16)");
                });
            });

            ui.collapsing("📐 Payload Fields [Offset 0x06..0x36]", |ui| {
                ui.horizontal(|ui| {
                    ui.label(RichText::new("Quaternion [W, X, Y, Z]:").color(COLOR_TEXT_MUTED));
                    ui.label(RichText::new("[0.7071, 0.0000, 0.7071, 0.0000]").color(COLOR_SIGNAL_RX).monospace());
                    ui.label("(float32 x 4)");
                });
                ui.horizontal(|ui| {
                    ui.label(RichText::new("Gyro Angular Velocity:").color(COLOR_TEXT_MUTED));
                    ui.label(RichText::new("[+0.012, -0.045, +0.003] rad/s").color(COLOR_TEXT_PRIMARY).monospace());
                    ui.label("(float32 x 3)");
                });
                ui.horizontal(|ui| {
                    ui.label(RichText::new("Linear Acceleration:").color(COLOR_TEXT_MUTED));
                    ui.label(RichText::new("[+0.02, +0.01, +9.81] m/s²").color(COLOR_TEXT_PRIMARY).monospace());
                    ui.label("(float32 x 3)");
                });
            });

            ui.collapsing("🛡 Checksum & Trailer [Offset 0x36..0x3A]", |ui| {
                ui.horizontal(|ui| {
                    ui.label(RichText::new("CRC32-Castagnoli:").color(COLOR_TEXT_MUTED));
                    ui.label(RichText::new("0x7F83A12E").color(COLOR_SIGNAL_RX).monospace());
                    ui.label(RichText::new("[VALID]").color(COLOR_SIGNAL_RX).strong());
                });
            });
        });
    }

    /// Render Tab: HIL Bridge & Fault Injection.
    fn render_hil_bridge(&mut self, ui: &mut Ui) {
        let status = if self.hil_bridge_active { "BRIDGE ACTIVE" } else { "BYPASS IDLE" };
        let status_color = if self.hil_bridge_active { COLOR_SIGNAL_RX } else { COLOR_SIGNAL_TRIGGER };

        Self::render_header(ui, "[HIL-RIG]", "Hardware-In-The-Loop Bridge", status, status_color);

        ui.group(|ui| {
            ui.label(RichText::new("PORT ROUTING MATRIX").color(COLOR_TEXT_PRIMARY).strong());
            ui.horizontal(|ui| {
                ui.label(RichText::new("Primary Target (DUT):").color(COLOR_TEXT_MUTED));
                ui.label(RichText::new(&self.hil_port_a).color(COLOR_SIGNAL_TX).monospace());
            });
            ui.horizontal(|ui| {
                ui.label(RichText::new("Secondary Target (HIL):").color(COLOR_TEXT_MUTED));
                ui.label(RichText::new(&self.hil_port_b).color(COLOR_SIGNAL_RX).monospace());
            });

            let toggle_btn = if self.hil_bridge_active { "⏹ Disarm Bridge" } else { "⚡ Arm Bridge" };
            if ui.button(RichText::new(toggle_btn).strong()).clicked() {
                self.hil_bridge_active = !self.hil_bridge_active;
            }
        });

        ui.add_space(8.0);
        ui.group(|ui| {
            ui.label(RichText::new("REAL-TIME FAULT INJECTION").color(COLOR_SIGNAL_FAULT).strong());

            ui.horizontal(|ui| {
                ui.label("Bit Error Rate (BER):");
                ui.add(egui::Slider::new(&mut self.hil_ber_rate, 0.0..=5.0).suffix(" %"));
            });

            ui.horizontal(|ui| {
                ui.label("Packet Drop Rate:");
                ui.add(egui::Slider::new(&mut self.hil_drop_pct, 0.0..=100.0).suffix(" %"));
            });

            ui.horizontal(|ui| {
                ui.label("Transmission Jitter:");
                ui.add(egui::Slider::new(&mut self.hil_jitter_ms, 0..=500).suffix(" ms"));
            });
        });
    }

    /// Render Tab: Dashboards & Gauges.
    fn render_dashboards(&mut self, ui: &mut Ui) {
        Self::render_header(ui, "[DASH]", "Dashboards & Instrument Gauges", "ONLINE", COLOR_SIGNAL_RX);

        ui.horizontal(|ui| {
            // Card 1: Motor RPM
            ui.group(|ui| {
                ui.set_width(180.0);
                ui.label(RichText::new("SPIN RATE").color(COLOR_TEXT_MUTED).small());
                ui.label(
                    RichText::new(format!("{:.0} RPM", self.dash_rpm))
                        .size(22.0)
                        .color(COLOR_SIGNAL_TX)
                        .strong(),
                );
                let progress = (self.dash_rpm / 6000.0).clamp(0.0, 1.0);
                ui.add(egui::ProgressBar::new(progress).animate(true));
            });

            // Card 2: Temperature
            ui.group(|ui| {
                ui.set_width(180.0);
                ui.label(RichText::new("DUT CORE TEMP").color(COLOR_TEXT_MUTED).small());
                ui.label(
                    RichText::new(format!("{:.1} °C", self.dash_temp_c))
                        .size(22.0)
                        .color(COLOR_SIGNAL_RX)
                        .strong(),
                );
                ui.label(RichText::new("Status: NOMINAL").color(COLOR_SIGNAL_RX).small());
            });

            // Card 3: Bus Voltage
            ui.group(|ui| {
                ui.set_width(180.0);
                ui.label(RichText::new("BUS POWER").color(COLOR_TEXT_MUTED).small());
                ui.label(
                    RichText::new(format!("{:.1} V", self.dash_bus_volts))
                        .size(22.0)
                        .color(COLOR_SIGNAL_TRIGGER)
                        .strong(),
                );
                ui.label(RichText::new("Current: 1.42 A").color(COLOR_TEXT_MUTED).small());
            });
        });

        ui.add_space(10.0);
        ui.group(|ui| {
            ui.label(RichText::new("INDICATOR STATUS LEDS").color(COLOR_TEXT_PRIMARY).strong());
            ui.horizontal(|ui| {
                ui.label(RichText::new("● POWER").color(COLOR_SIGNAL_RX).strong());
                ui.label(RichText::new("● SYNC").color(COLOR_SIGNAL_RX).strong());
                ui.label(RichText::new("● LINK").color(COLOR_SIGNAL_TX).strong());
                ui.label(RichText::new("● HIL").color(COLOR_SIGNAL_RX).strong());
                ui.label(RichText::new("○ FAULT").color(COLOR_TEXT_MUTED));
            });
        });
    }

    /// Render Tab: Vault Review & Scrubber.
    fn render_vault_scrubber(&mut self, ui: &mut Ui) {
        Self::render_header(
            ui,
            "[VAULT]",
            "Vault Review & Scrubber (.bflog)",
            "INDEXED",
            COLOR_SIGNAL_TX,
        );

        ui.horizontal(|ui| {
            let play_label = if self.vault_playing { "⏸ Pause" } else { "▶ Play" };
            if ui.button(RichText::new(play_label).strong()).clicked() {
                self.vault_playing = !self.vault_playing;
            }

            if ui.button("⏮ First").clicked() {
                self.vault_progress = 0.0;
                self.vault_frame_index = 0;
            }

            if ui.button("◀ Step").clicked() {
                self.vault_frame_index = self.vault_frame_index.saturating_sub(1);
            }

            if ui.button("Step ▶").clicked() {
                self.vault_frame_index = (self.vault_frame_index + 1).min(self.vault_total_frames);
            }

            if ui.button("⏭ Last").clicked() {
                self.vault_progress = 100.0;
                self.vault_frame_index = self.vault_total_frames;
            }

            ui.label(
                RichText::new(format!(
                    "Frame: {} / {}",
                    self.vault_frame_index, self.vault_total_frames
                ))
                .monospace()
                .color(COLOR_TEXT_PRIMARY),
            );
        });

        ui.add_space(4.0);
        ui.horizontal(|ui| {
            ui.label(RichText::new("Timeline:").color(COLOR_TEXT_MUTED));
            ui.add(egui::Slider::new(&mut self.vault_progress, 0.0..=100.0).suffix(" %"));
        });

        ui.separator();
        ui.label(RichText::new("Vault File: ./vaults/2026-11-02_imu_session.bflog (24.8 MB, 12,500 records)").color(COLOR_TEXT_MUTED));
    }

    /// Render Tab: Workspace Configuration.
    fn render_workspace_config(&mut self, ui: &mut Ui) {
        Self::render_header(
            ui,
            "[CONFIG]",
            "Workspace Configuration",
            "SYNCED",
            COLOR_SIGNAL_RX,
        );

        ui.group(|ui| {
            ui.label(RichText::new("ACTIVE WORKSPACE TOML").color(COLOR_TEXT_PRIMARY).strong());
            ui.horizontal(|ui| {
                ui.label("Path:");
                ui.text_edit_singleline(&mut self.ws_path);
            });

            ui.horizontal(|ui| {
                ui.label("Baud Rate:");
                egui::ComboBox::from_id_salt("ws_baud_select")
                    .selected_text(format!("{}", self.ws_baud))
                    .show_ui(ui, |ui| {
                        ui.selectable_value(&mut self.ws_baud, 115200, "115200");
                        ui.selectable_value(&mut self.ws_baud, 230400, "230400");
                        ui.selectable_value(&mut self.ws_baud, 460800, "460800");
                        ui.selectable_value(&mut self.ws_baud, 921600, "921600");
                        ui.selectable_value(&mut self.ws_baud, 2000000, "2000000");
                        ui.selectable_value(&mut self.ws_baud, 3000000, "3000000");
                    });
            });

            ui.horizontal(|ui| {
                ui.label("Framing Format:");
                ui.label(RichText::new(&self.ws_framing).color(COLOR_SIGNAL_TX).monospace());
            });

            ui.add_space(8.0);
            if ui.button(RichText::new("💾 Export Configuration").strong()).clicked() {
                // Export action placeholder
            }
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
