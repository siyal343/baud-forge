use egui::{epaint::CornerRadius, Color32, Margin, RichText, Stroke, Ui, Vec2};
use crate::theme::{
    COLOR_BORDER_HAIRLINE, COLOR_SIGNAL_FAULT, COLOR_SIGNAL_RX, COLOR_SIGNAL_TRIGGER,
    COLOR_SIGNAL_TX, COLOR_SURFACE_CARD, COLOR_TEXT_MUTED, COLOR_TEXT_PRIMARY,
};

/// Hardware-In-The-Loop (HIL) bridge and live fault injection rig state.
#[derive(Debug, Clone)]
pub struct HilBridgeState {
    pub port_a: String,
    pub port_b: String,
    pub is_active: bool,
    pub packets_bridged_a_to_b: u64,
    pub packets_bridged_b_to_a: u64,
    pub bytes_bridged: u64,

    // Fault injection settings
    pub ber_rate: f64,
    pub drop_ratio: f32,
    pub jitter_ms: u32,
    pub truncate_bytes: usize,
    pub corrupt_crc: bool,
    pub fault_engine_armed: bool,

    // Hardware pin states
    pub rts_asserted: bool,
    pub dtr_asserted: bool,
    pub cts_detected: bool,
    pub dsr_detected: bool,
    pub dcd_detected: bool,
    pub ri_detected: bool,
}

impl Default for HilBridgeState {
    fn default() -> Self {
        Self {
            port_a: "COM3 (DUT Target)".to_string(),
            port_b: "COM4 (HIL Loopback)".to_string(),
            is_active: true,
            packets_bridged_a_to_b: 1420,
            packets_bridged_b_to_a: 1418,
            bytes_bridged: 136224,

            ber_rate: 0.0,
            drop_ratio: 0.0,
            jitter_ms: 0,
            truncate_bytes: 0,
            corrupt_crc: false,
            fault_engine_armed: false,

            rts_asserted: true,
            dtr_asserted: true,
            cts_detected: true,
            dsr_detected: true,
            dcd_detected: false,
            ri_detected: false,
        }
    }
}

impl HilBridgeState {
    /// Injects configured faults into a data packet if fault engine is armed.
    /// Returns `None` if the packet is dropped.
    pub fn inject_fault(&self, data: &[u8]) -> Option<Vec<u8>> {
        if !self.fault_engine_armed {
            return Some(data.to_vec());
        }

        // 1. Packet drop check
        if self.drop_ratio >= 1.0 {
            return None;
        }

        let mut output = data.to_vec();

        // 2. Truncation fault
        if self.truncate_bytes > 0 && self.truncate_bytes < output.len() {
            output.truncate(output.len().saturating_sub(self.truncate_bytes));
        }

        // 3. Corrupt CRC check
        if self.corrupt_crc && output.len() >= 4 {
            let last_idx = output.len() - 1;
            output[last_idx] ^= 0xFF;
        }

        // 4. Bit error rate (BER)
        if self.ber_rate > 0.0 && !output.is_empty() {
            // Flip the lowest bit of the first byte as deterministic fault
            output[0] ^= 0x01;
        }

        Some(output)
    }

    /// Bridge packet from Port A to Port B.
    pub fn bridge_a_to_b(&mut self, data: &[u8]) -> Option<Vec<u8>> {
        if !self.is_active {
            return None;
        }
        self.packets_bridged_a_to_b += 1;
        self.bytes_bridged += data.len() as u64;
        self.inject_fault(data)
    }

    /// Bridge packet from Port B to Port A.
    pub fn bridge_b_to_a(&mut self, data: &[u8]) -> Option<Vec<u8>> {
        if !self.is_active {
            return None;
        }
        self.packets_bridged_b_to_a += 1;
        self.bytes_bridged += data.len() as u64;
        self.inject_fault(data)
    }

    /// Helper rendering a glowing circular LED status bulb.
    fn render_led(ui: &mut Ui, label: &str, asserted: bool) {
        ui.horizontal(|ui| {
            let (rect, _response) = ui.allocate_exact_size(Vec2::splat(14.0), egui::Sense::hover());
            let painter = ui.painter_at(rect);
            let center = rect.center();
            let radius = 5.0;

            if asserted {
                painter.circle_filled(
                    center,
                    radius + 2.0,
                    Color32::from_rgba_unmultiplied(16, 185, 129, 70),
                );
                painter.circle_filled(center, radius, COLOR_SIGNAL_RX);
            } else {
                painter.circle_filled(center, radius, Color32::from_rgb(34, 41, 51));
                painter.circle_stroke(
                    center,
                    radius,
                    Stroke::new(1.0_f32, COLOR_BORDER_HAIRLINE),
                );
            }

            let text_color = if asserted {
                COLOR_TEXT_PRIMARY
            } else {
                COLOR_TEXT_MUTED
            };
            ui.label(RichText::new(label).color(text_color).strong().monospace());
        });
    }

    /// Render HIL Bridge, Fault Rig, and Hardware Pin controls inside modern cards.
    pub fn show(&mut self, ui: &mut Ui) {
        let candidate_ports = [
            "COM1 (Standard Serial)",
            "COM2 (Standard Serial)",
            "COM3 (DUT Target)",
            "COM4 (HIL Loopback)",
            "COM5 (Auxiliary Sniffer)",
            "VIRTUAL-A (Pipe)",
            "VIRTUAL-B (Pipe)",
        ];

        egui::ScrollArea::vertical().show(ui, |ui| {
            // Card 1: Dual-Port Bridge Routing
            egui::Frame::NONE
                .fill(COLOR_SURFACE_CARD)
                .stroke(Stroke::new(1.0_f32, COLOR_BORDER_HAIRLINE))
                .corner_radius(CornerRadius::same(4))
                .inner_margin(Margin::same(12))
                .show(ui, |ui| {
                    ui.horizontal(|ui| {
                        ui.label(
                            RichText::new("DUAL-PORT BRIDGE ROUTING")
                                .color(COLOR_SIGNAL_TX)
                                .strong()
                                .monospace()
                                .small(),
                        );
                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            let (badge_text, badge_color) = if self.is_active {
                                ("● BRIDGE ACTIVE", COLOR_SIGNAL_RX)
                            } else {
                                ("○ BRIDGE IDLE", COLOR_SIGNAL_TRIGGER)
                            };
                            ui.label(RichText::new(badge_text).color(badge_color).small().monospace());
                        });
                    });

                    ui.add_space(8.0);

                    ui.horizontal(|ui| {
                        ui.label(RichText::new("Port A (DUT):").color(COLOR_TEXT_PRIMARY).strong());
                        egui::ComboBox::from_id_salt("hil_port_a_select")
                            .selected_text(RichText::new(&self.port_a).color(COLOR_SIGNAL_TX))
                            .width(220.0)
                            .show_ui(ui, |ui| {
                                for &port in &candidate_ports {
                                    ui.selectable_value(&mut self.port_a, port.to_string(), port);
                                }
                            });

                        ui.add_space(12.0);

                        ui.label(RichText::new("Port B (HIL):").color(COLOR_TEXT_PRIMARY).strong());
                        egui::ComboBox::from_id_salt("hil_port_b_select")
                            .selected_text(RichText::new(&self.port_b).color(COLOR_SIGNAL_RX))
                            .width(220.0)
                            .show_ui(ui, |ui| {
                                for &port in &candidate_ports {
                                    ui.selectable_value(&mut self.port_b, port.to_string(), port);
                                }
                            });
                    });

                    ui.add_space(8.0);

                    ui.horizontal(|ui| {
                        let btn_text = if self.is_active {
                            "⏹ Disarm Bridge"
                        } else {
                            "⚡ Arm Bridge"
                        };
                        let btn_color = if self.is_active {
                            COLOR_SIGNAL_TRIGGER
                        } else {
                            COLOR_SIGNAL_RX
                        };

                        if ui.button(RichText::new(btn_text).color(btn_color).strong()).clicked() {
                            self.is_active = !self.is_active;
                        }

                        ui.separator();

                        ui.label(RichText::new("Packets A→B:").color(COLOR_TEXT_MUTED).small());
                        ui.label(
                            RichText::new(format!("{}", self.packets_bridged_a_to_b))
                                .color(COLOR_SIGNAL_TX)
                                .monospace(),
                        );

                        ui.label(RichText::new("Packets B→A:").color(COLOR_TEXT_MUTED).small());
                        ui.label(
                            RichText::new(format!("{}", self.packets_bridged_b_to_a))
                                .color(COLOR_SIGNAL_RX)
                                .monospace(),
                        );

                        ui.label(RichText::new("Bridged:").color(COLOR_TEXT_MUTED).small());
                        ui.label(
                            RichText::new(format!("{:.1} KB", self.bytes_bridged as f64 / 1024.0))
                                .color(COLOR_TEXT_PRIMARY)
                                .monospace(),
                        );
                    });
                });

            ui.add_space(10.0);

            // Card 2: Live Fault Injection Rig
            egui::Frame::NONE
                .fill(COLOR_SURFACE_CARD)
                .stroke(Stroke::new(1.0_f32, COLOR_BORDER_HAIRLINE))
                .corner_radius(CornerRadius::same(4))
                .inner_margin(Margin::same(12))
                .show(ui, |ui| {
                    ui.horizontal(|ui| {
                        ui.label(
                            RichText::new("LIVE FAULT INJECTION RIG")
                                .color(COLOR_SIGNAL_FAULT)
                                .strong()
                                .monospace()
                                .small(),
                        );
                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            let (badge_text, badge_color) = if self.fault_engine_armed {
                                ("⚡ FAULT ENGINE ARMED", COLOR_SIGNAL_FAULT)
                            } else {
                                ("PASS-THROUGH (CLEAN)", COLOR_TEXT_MUTED)
                            };
                            ui.label(RichText::new(badge_text).color(badge_color).small().monospace());
                        });
                    });

                    ui.add_space(8.0);

                    // Sliders
                    ui.horizontal(|ui| {
                        ui.label("Bit Error Rate (BER):");
                        let ber_slider = egui::Slider::new(&mut self.ber_rate, 0.0..=0.01)
                            .logarithmic(true)
                            .custom_formatter(|v, _| {
                                if v <= 0.0 {
                                    "0.0 (Clean)".to_string()
                                } else {
                                    format!("{:.1e}", v)
                                }
                            });
                        ui.add(ber_slider);

                        ui.separator();

                        ui.label("Packet Drop:");
                        let drop_slider = egui::Slider::new(&mut self.drop_ratio, 0.0..=1.0)
                            .custom_formatter(|v, _| format!("{:.1}%", v * 100.0));
                        ui.add(drop_slider);
                    });

                    ui.add_space(6.0);

                    ui.horizontal(|ui| {
                        ui.label("Jitter Latency:");
                        ui.add(egui::Slider::new(&mut self.jitter_ms, 0..=500).suffix(" ms"));

                        ui.separator();

                        ui.label("Truncate Bytes:");
                        ui.add(egui::Slider::new(&mut self.truncate_bytes, 0..=64).suffix(" B"));

                        ui.separator();

                        ui.checkbox(&mut self.corrupt_crc, "Corrupt CRC32 / Checksum");
                    });

                    ui.add_space(10.0);

                    // Primary Arm / Disarm toggle button
                    let (toggle_label, fill_color, text_color) = if self.fault_engine_armed {
                        (
                            "⚡ Disarm Fault Rig (Restore Clean Channel)",
                            COLOR_SIGNAL_FAULT,
                            Color32::BLACK,
                        )
                    } else {
                        (
                            "⚠ Arm Fault Engine Rig",
                            Color32::from_rgb(60, 24, 30),
                            COLOR_SIGNAL_FAULT,
                        )
                    };

                    let arm_btn = egui::Button::new(
                        RichText::new(toggle_label)
                            .color(text_color)
                            .strong(),
                    )
                    .fill(fill_color);

                    if ui.add(arm_btn).clicked() {
                        self.fault_engine_armed = !self.fault_engine_armed;
                    }
                });

            ui.add_space(10.0);

            // Card 3: Hardware Pin Controls
            egui::Frame::NONE
                .fill(COLOR_SURFACE_CARD)
                .stroke(Stroke::new(1.0_f32, COLOR_BORDER_HAIRLINE))
                .corner_radius(CornerRadius::same(4))
                .inner_margin(Margin::same(12))
                .show(ui, |ui| {
                    ui.label(
                        RichText::new("HARDWARE PIN CONTROLS & STATUS")
                            .color(COLOR_SIGNAL_TRIGGER)
                            .strong()
                            .monospace()
                            .small(),
                    );

                    ui.add_space(8.0);

                    // Output pin toggle controls
                    ui.horizontal(|ui| {
                        ui.label(RichText::new("Output Control Pins:").color(COLOR_TEXT_PRIMARY).strong());

                        let rts_color = if self.rts_asserted {
                            COLOR_SIGNAL_TX
                        } else {
                            COLOR_TEXT_MUTED
                        };
                        let rts_btn = egui::Button::new(
                            RichText::new(if self.rts_asserted {
                                "✔ RTS Asserted (Active LOW)"
                            } else {
                                "✖ RTS Deasserted (+3.3V)"
                            })
                            .color(rts_color)
                            .strong(),
                        );
                        if ui.add(rts_btn).clicked() {
                            self.rts_asserted = !self.rts_asserted;
                        }

                        let dtr_color = if self.dtr_asserted {
                            COLOR_SIGNAL_TX
                        } else {
                            COLOR_TEXT_MUTED
                        };
                        let dtr_btn = egui::Button::new(
                            RichText::new(if self.dtr_asserted {
                                "✔ DTR Asserted (Active LOW)"
                            } else {
                                "✖ DTR Deasserted (+3.3V)"
                            })
                            .color(dtr_color)
                            .strong(),
                        );
                        if ui.add(dtr_btn).clicked() {
                            self.dtr_asserted = !self.dtr_asserted;
                        }
                    });

                    ui.add_space(10.0);

                    // Input status pins with glowing circular LED bulbs
                    ui.horizontal(|ui| {
                        ui.label(RichText::new("Input Status Pins:").color(COLOR_TEXT_PRIMARY).strong());

                        Self::render_led(ui, "CTS", self.cts_detected);
                        ui.add_space(8.0);
                        Self::render_led(ui, "DSR", self.dsr_detected);
                        ui.add_space(8.0);
                        Self::render_led(ui, "DCD", self.dcd_detected);
                        ui.add_space(8.0);
                        Self::render_led(ui, "RI", self.ri_detected);
                    });
                });
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_hil_default_state() {
        let hil = HilBridgeState::default();
        assert_eq!(hil.port_a, "COM3 (DUT Target)");
        assert_eq!(hil.port_b, "COM4 (HIL Loopback)");
        assert!(hil.is_active);
        assert_eq!(hil.packets_bridged_a_to_b, 1420);
        assert_eq!(hil.packets_bridged_b_to_a, 1418);
        assert!(!hil.fault_engine_armed);
        assert_eq!(hil.ber_rate, 0.0);
        assert_eq!(hil.drop_ratio, 0.0);
        assert_eq!(hil.jitter_ms, 0);
        assert_eq!(hil.truncate_bytes, 0);
        assert!(!hil.corrupt_crc);
        assert!(hil.rts_asserted);
        assert!(hil.dtr_asserted);
        assert!(hil.cts_detected);
        assert!(hil.dsr_detected);
        assert!(!hil.dcd_detected);
        assert!(!hil.ri_detected);
    }

    #[test]
    fn test_fault_injection_clean_when_disarmed() {
        let mut hil = HilBridgeState::default();
        hil.fault_engine_armed = false;
        hil.corrupt_crc = true;
        hil.truncate_bytes = 4;
        hil.drop_ratio = 1.0;

        let packet = vec![0xBA, 0xDE, 0x01, 0x02, 0xAA, 0xBB, 0xCC, 0xDD];
        let bridged = hil.inject_fault(&packet);
        assert_eq!(bridged, Some(packet), "Disarmed fault engine must not mutate packet");
    }

    #[test]
    fn test_fault_injection_crc_corruption() {
        let mut hil = HilBridgeState::default();
        hil.fault_engine_armed = true;
        hil.corrupt_crc = true;

        let packet = vec![0xBA, 0xDE, 0x01, 0x02, 0xAA, 0xBB, 0xCC, 0xDD];
        let corrupted = hil.inject_fault(&packet).expect("Packet should not be dropped");
        assert_eq!(corrupted.len(), packet.len());
        assert_ne!(corrupted.last(), packet.last(), "Last CRC byte should be inverted");
    }

    #[test]
    fn test_fault_injection_truncation() {
        let mut hil = HilBridgeState::default();
        hil.fault_engine_armed = true;
        hil.truncate_bytes = 3;

        let packet = vec![0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08];
        let truncated = hil.inject_fault(&packet).expect("Packet should not be dropped");
        assert_eq!(truncated.len(), 5);
        assert_eq!(truncated, vec![0x01, 0x02, 0x03, 0x04, 0x05]);
    }

    #[test]
    fn test_fault_injection_drop() {
        let mut hil = HilBridgeState::default();
        hil.fault_engine_armed = true;
        hil.drop_ratio = 1.0;

        let packet = vec![0x01, 0x02, 0x03];
        let result = hil.inject_fault(&packet);
        assert!(result.is_none(), "100% drop ratio must return None");
    }

    #[test]
    fn test_bridge_packet_counters() {
        let mut hil = HilBridgeState::default();
        let initial_a_to_b = hil.packets_bridged_a_to_b;
        let initial_bytes = hil.bytes_bridged;

        let packet = vec![0x01, 0x02, 0x03, 0x04];
        let res = hil.bridge_a_to_b(&packet);
        assert_eq!(res, Some(packet.clone()));
        assert_eq!(hil.packets_bridged_a_to_b, initial_a_to_b + 1);
        assert_eq!(hil.bytes_bridged, initial_bytes + 4);

        let initial_b_to_a = hil.packets_bridged_b_to_a;
        let res2 = hil.bridge_b_to_a(&packet);
        assert_eq!(res2, Some(packet));
        assert_eq!(hil.packets_bridged_b_to_a, initial_b_to_a + 1);
        assert_eq!(hil.bytes_bridged, initial_bytes + 8);
    }
}
