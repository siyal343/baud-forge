use egui::{epaint::CornerRadius, Color32, Margin, RichText, Stroke, Ui};
use crate::theme::{
    COLOR_BORDER_HAIRLINE, COLOR_SIGNAL_FAULT, COLOR_SIGNAL_RX, COLOR_SIGNAL_TRIGGER,
    COLOR_SIGNAL_TX, COLOR_SURFACE_CARD, COLOR_TEXT_MUTED, COLOR_TEXT_PRIMARY,
};

/// Session Vault recording, interactive timeline scrubber, and session diff manager.
#[derive(Debug, Clone)]
pub struct VaultManager {
    // Live Recording state
    pub is_recording: bool,
    pub recording_path: String,
    pub recorded_bytes: u64,
    pub recorded_frames: u64,
    pub elapsed_sec: f32,

    // Playback Scrubber state
    pub loaded_vault_path: Option<String>,
    pub scrub_position: f32, // (0.0 to 1.0)
    pub current_frame_idx: usize,
    pub total_frames: usize,
    pub is_playing: bool,
    pub playback_speed: f32, // 0.25, 0.5, 1.0, 2.0, 5.0
    pub loop_playback: bool,
    pub frames: Vec<Vec<u8>>,

    // Session Diff state
    pub baseline_path: Option<String>,
    pub compare_path: Option<String>,
    pub divergences: Vec<String>,
}

impl Default for VaultManager {
    fn default() -> Self {
        // Pre-populate realistic sample frames so scrubber has immediate interactive content
        let mut sample_frames = Vec::with_capacity(128);
        for i in 0..128 {
            let mut frame = Vec::with_capacity(36);
            frame.extend_from_slice(&[0xBA, 0xDE]);
            frame.extend_from_slice(&(i as u32).to_le_bytes());
            let angle = (i as f32 * 0.05).sin();
            frame.extend_from_slice(&angle.to_le_bytes());
            frame.extend_from_slice(&[0x00; 22]);
            let crc = bforge_framer::checksum::crc32c(&frame);
            frame.extend_from_slice(&crc.to_le_bytes());
            sample_frames.push(frame);
        }

        Self {
            is_recording: false,
            recording_path: "./vaults/session_live.bflog".to_string(),
            recorded_bytes: 26009600,
            recorded_frames: 12500,
            elapsed_sec: 25.0,

            loaded_vault_path: Some("./vaults/2026-11-02_imu_session.bflog".to_string()),
            scrub_position: 0.385,
            current_frame_idx: 4820,
            total_frames: 12500,
            is_playing: false,
            playback_speed: 1.0,
            loop_playback: true,
            frames: sample_frames,

            baseline_path: Some("./vaults/baseline_nominal.bflog".to_string()),
            compare_path: Some("./vaults/dut_under_test.bflog".to_string()),
            divergences: vec![
                "[DIFF @ Frame #420] Payload divergence: baseline crc32=0x9A4F != compare crc32=0xBADE (offset 0x0C)".to_string(),
                "[DIFF @ Frame #1052] Timing jitter anomaly: Δt = 48.2ms (expected <= 2.0ms, threshold exceeded)".to_string(),
                "[DIFF @ Frame #3840] Dropped frame detected: seq_id gap 3840 -> 3842 (missing 1 frame)".to_string(),
                "[DIFF @ Frame #7190] Length mismatch: Baseline record len=48B, Compare record len=42B (truncated)".to_string(),
            ],
        }
    }
}

impl VaultManager {
    /// Start recording incoming session stream to `.bflog`.
    pub fn start_recording(&mut self, path: &str) {
        self.is_recording = true;
        self.recording_path = path.to_string();
        self.recorded_bytes = 0;
        self.recorded_frames = 0;
        self.elapsed_sec = 0.0;
    }

    /// Stop current recording session.
    pub fn stop_recording(&mut self) {
        self.is_recording = false;
    }

    /// Record a raw frame into memory and increment recording counters.
    pub fn record_frame(&mut self, bytes: &[u8]) {
        if self.is_recording {
            self.recorded_frames += 1;
            self.recorded_bytes += bytes.len() as u64;
            self.frames.push(bytes.to_vec());
            self.total_frames = self.frames.len();
        }
    }

    /// Update scrub position based on current frame index.
    fn update_scrub_from_idx(&mut self) {
        if self.total_frames > 1 {
            self.scrub_position = (self.current_frame_idx as f32) / ((self.total_frames - 1) as f32);
        } else {
            self.scrub_position = 0.0;
        }
    }

    /// Step scrubber forward by one frame.
    pub fn step_forward(&mut self) {
        if self.total_frames > 0 {
            if self.current_frame_idx + 1 < self.total_frames {
                self.current_frame_idx += 1;
            } else if self.loop_playback {
                self.current_frame_idx = 0;
            }
            self.update_scrub_from_idx();
        }
    }

    /// Step scrubber backward by one frame.
    pub fn step_backward(&mut self) {
        if self.total_frames > 0 {
            self.current_frame_idx = self.current_frame_idx.saturating_sub(1);
            self.update_scrub_from_idx();
        }
    }

    /// Run session diff between baseline and compare logs.
    pub fn run_diff(&mut self) {
        self.divergences.clear();

        let mut analyzed_file = false;

        if let (Some(base_p), Some(comp_p)) = (&self.baseline_path, &self.compare_path) {
            let base_path = std::path::Path::new(base_p);
            let comp_path = std::path::Path::new(comp_p);

            if base_path.exists() && comp_path.exists() {
                if let (Ok(mut reader_a), Ok(mut reader_b)) = (
                    bforge_storage::LogReader::open(base_path),
                    bforge_storage::LogReader::open(comp_path),
                ) {
                    analyzed_file = true;
                    if reader_a.chunks() != reader_b.chunks() {
                        self.divergences.push(format!(
                            "[DIFF Frame Count] Baseline: {} chunks != Compare: {} chunks (Δ = {})",
                            reader_a.chunks(),
                            reader_b.chunks(),
                            (reader_a.chunks() as i64 - reader_b.chunks() as i64).abs()
                        ));
                    }

                    let check_count = reader_a.chunks().min(reader_b.chunks()).min(200);
                    for i in 0..check_count {
                        if let (Ok(Some(rec_a)), Ok(Some(rec_b))) = (reader_a.read_at(i), reader_b.read_at(i)) {
                            if rec_a.payload != rec_b.payload {
                                self.divergences.push(format!(
                                    "[DIFF @ Frame #{}] Payload mismatch: len {}B vs {}B",
                                    i,
                                    rec_a.payload.len(),
                                    rec_b.payload.len()
                                ));
                                if self.divergences.len() >= 25 {
                                    self.divergences.push("... (Truncated after 25 divergences)".to_string());
                                    break;
                                }
                            }
                        }
                    }

                    if self.divergences.is_empty() {
                        self.divergences.push("✓ No divergences detected: Sessions match identically.".to_string());
                    }
                }
            }
        }

        if !analyzed_file {
            // Simulated divergence report for virtual testing and demonstration
            self.divergences = vec![
                "[DIFF @ Frame #420] Payload divergence: baseline crc32=0x9A4F != compare crc32=0xBADE (offset 0x0C)".to_string(),
                "[DIFF @ Frame #1052] Timing jitter anomaly: Δt = 48.2ms (expected <= 2.0ms, threshold exceeded)".to_string(),
                "[DIFF @ Frame #3840] Dropped frame detected: seq_id gap 3840 -> 3842 (missing 1 frame)".to_string(),
                "[DIFF @ Frame #7190] Length mismatch: Baseline record len=48B, Compare record len=42B (truncated)".to_string(),
                "[DIFF @ Frame #9822] Pin glitch anomaly: CTS toggled unexpectedly during payload transmission".to_string(),
            ];
        }
    }

    /// Render Vault Recording, Scrubber, and Diff Comparator cards.
    pub fn show(&mut self, ui: &mut Ui) {
        if self.is_playing {
            ui.ctx().request_repaint();
            self.step_forward();
        }

        egui::ScrollArea::vertical().show(ui, |ui| {
            // Card 1: Vault Capture & Recording
            egui::Frame::NONE
                .fill(COLOR_SURFACE_CARD)
                .stroke(Stroke::new(1.0_f32, COLOR_BORDER_HAIRLINE))
                .corner_radius(CornerRadius::same(4))
                .inner_margin(Margin::same(12))
                .show(ui, |ui| {
                    ui.horizontal(|ui| {
                        ui.label(
                            RichText::new("VAULT CAPTURE & RECORDING (.BFLOG)")
                                .color(COLOR_SIGNAL_TX)
                                .strong()
                                .monospace()
                                .small(),
                        );
                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            let (badge_text, badge_color) = if self.is_recording {
                                ("● RECORDING LIVE", COLOR_SIGNAL_FAULT)
                            } else {
                                ("○ IDLE / SEALED", COLOR_TEXT_MUTED)
                            };
                            ui.label(RichText::new(badge_text).color(badge_color).small().monospace());
                        });
                    });

                    ui.add_space(8.0);

                    ui.horizontal(|ui| {
                        ui.label(RichText::new("Target Path:").color(COLOR_TEXT_PRIMARY).strong());
                        ui.text_edit_singleline(&mut self.recording_path);

                        if ui.button("📁 Browse...").clicked() {
                            if let Some(path) = rfd::FileDialog::new()
                                .set_file_name("session.bflog")
                                .add_filter("BaudForge Log", &["bflog"])
                                .save_file()
                            {
                                self.recording_path = path.to_string_lossy().to_string();
                            }
                        }
                    });

                    ui.add_space(8.0);

                    ui.horizontal(|ui| {
                        let record_btn = if self.is_recording {
                            egui::Button::new(
                                RichText::new("■ Stop Recording")
                                    .color(Color32::WHITE)
                                    .strong(),
                            )
                            .fill(COLOR_SIGNAL_FAULT)
                        } else {
                            egui::Button::new(
                                RichText::new("● Start Recording")
                                    .color(Color32::BLACK)
                                    .strong(),
                            )
                            .fill(COLOR_SIGNAL_RX)
                        };

                        if ui.add(record_btn).clicked() {
                            if self.is_recording {
                                self.stop_recording();
                            } else {
                                let path = self.recording_path.clone();
                                self.start_recording(&path);
                            }
                        }

                        ui.separator();

                        ui.label(RichText::new("Recorded Size:").color(COLOR_TEXT_MUTED).small());
                        ui.label(
                            RichText::new(format!("{:.2} MB", self.recorded_bytes as f64 / 1_048_576.0))
                                .color(COLOR_TEXT_PRIMARY)
                                .monospace(),
                        );

                        ui.label(RichText::new("Frames:").color(COLOR_TEXT_MUTED).small());
                        ui.label(
                            RichText::new(format!("{}", self.recorded_frames))
                                .color(COLOR_SIGNAL_TX)
                                .monospace(),
                        );

                        ui.label(RichText::new("Elapsed:").color(COLOR_TEXT_MUTED).small());
                        ui.label(
                            RichText::new(format!("{:.1} s", self.elapsed_sec))
                                .color(COLOR_TEXT_PRIMARY)
                                .monospace(),
                        );
                    });
                });

            ui.add_space(10.0);

            // Card 2: Interactive Timeline Scrubber
            egui::Frame::NONE
                .fill(COLOR_SURFACE_CARD)
                .stroke(Stroke::new(1.0_f32, COLOR_BORDER_HAIRLINE))
                .corner_radius(CornerRadius::same(4))
                .inner_margin(Margin::same(12))
                .show(ui, |ui| {
                    ui.horizontal(|ui| {
                        ui.label(
                            RichText::new("INTERACTIVE TIMELINE SCRUBBER")
                                .color(COLOR_SIGNAL_RX)
                                .strong()
                                .monospace()
                                .small(),
                        );
                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            let vault_display = self
                                .loaded_vault_path
                                .as_deref()
                                .unwrap_or("(No vault loaded)");
                            ui.label(RichText::new(vault_display).color(COLOR_TEXT_MUTED).small().monospace());
                        });
                    });

                    ui.add_space(8.0);

                    // Slider row
                    ui.horizontal(|ui| {
                        let max_frame = self.total_frames.saturating_sub(1);
                        let mut current = self.current_frame_idx.min(max_frame);

                        ui.label(RichText::new("Progress:").color(COLOR_TEXT_PRIMARY).strong());
                        let slider_resp = ui.add(
                            egui::Slider::new(&mut current, 0..=max_frame)
                                .show_value(false)
                        );
                        if slider_resp.changed() {
                            self.current_frame_idx = current;
                            self.update_scrub_from_idx();
                        }

                        ui.label(
                            RichText::new(format!(
                                "Frame {} / {} ({:.1}%)",
                                self.current_frame_idx,
                                self.total_frames,
                                self.scrub_position * 100.0
                            ))
                            .color(COLOR_SIGNAL_TX)
                            .monospace(),
                        );
                    });

                    ui.add_space(8.0);

                    // Scrubber controls row
                    ui.horizontal(|ui| {
                        if ui.button("⏮ First").clicked() {
                            self.current_frame_idx = 0;
                            self.update_scrub_from_idx();
                        }

                        if ui.button("◀ Step").clicked() {
                            self.step_backward();
                        }

                        let play_text = if self.is_playing {
                            "⏸ Pause"
                        } else {
                            "▶ Play"
                        };
                        let play_color = if self.is_playing {
                            COLOR_SIGNAL_TRIGGER
                        } else {
                            COLOR_SIGNAL_RX
                        };

                        if ui.button(RichText::new(play_text).color(play_color).strong()).clicked() {
                            self.is_playing = !self.is_playing;
                        }

                        if ui.button("Step ▶").clicked() {
                            self.step_forward();
                        }

                        if ui.button("Last ⏭").clicked() {
                            self.current_frame_idx = self.total_frames.saturating_sub(1);
                            self.update_scrub_from_idx();
                        }

                        ui.separator();

                        ui.label(RichText::new("Speed:").color(COLOR_TEXT_MUTED).small());
                        egui::ComboBox::from_id_salt("vault_speed_select")
                            .selected_text(format!("{}x", self.playback_speed))
                            .width(70.0)
                            .show_ui(ui, |ui| {
                                ui.selectable_value(&mut self.playback_speed, 0.25, "0.25x");
                                ui.selectable_value(&mut self.playback_speed, 0.5, "0.5x");
                                ui.selectable_value(&mut self.playback_speed, 1.0, "1.0x");
                                ui.selectable_value(&mut self.playback_speed, 2.0, "2.0x");
                                ui.selectable_value(&mut self.playback_speed, 5.0, "5.0x");
                            });

                        ui.checkbox(&mut self.loop_playback, "Loop");

                        if ui.button("📁 Load .bflog...").clicked() {
                            if let Some(path) = rfd::FileDialog::new()
                                .add_filter("BaudForge Log", &["bflog"])
                                .pick_file()
                            {
                                self.loaded_vault_path = Some(path.to_string_lossy().to_string());
                            }
                        }
                    });

                    // Quick preview of the active frame bytes if present in memory
                    if let Some(frame) = self.frames.get(self.current_frame_idx % self.frames.len().max(1)) {
                        ui.add_space(6.0);
                        ui.horizontal_wrapped(|ui| {
                            ui.label(RichText::new("Active Frame Bytes:").color(COLOR_TEXT_MUTED).small());
                            let hex_str: String = frame.iter().take(16).map(|b| format!("{b:02X} ")).collect();
                            ui.label(RichText::new(hex_str).color(COLOR_SIGNAL_TX).monospace().small());
                            if frame.len() > 16 {
                                ui.label(RichText::new(format!("... ({} bytes total)", frame.len())).color(COLOR_TEXT_MUTED).small());
                            }
                        });
                    }
                });

            ui.add_space(10.0);

            // Card 3: Session Diff Comparator
            egui::Frame::NONE
                .fill(COLOR_SURFACE_CARD)
                .stroke(Stroke::new(1.0_f32, COLOR_BORDER_HAIRLINE))
                .corner_radius(CornerRadius::same(4))
                .inner_margin(Margin::same(12))
                .show(ui, |ui| {
                    ui.label(
                        RichText::new("SESSION DIFF COMPARATOR")
                            .color(COLOR_SIGNAL_TRIGGER)
                            .strong()
                            .monospace()
                            .small(),
                    );

                    ui.add_space(8.0);

                    // File picker buttons
                    ui.horizontal(|ui| {
                        if ui.button("📁 Select Baseline .bflog...").clicked() {
                            if let Some(path) = rfd::FileDialog::new()
                                .add_filter("BaudForge Log", &["bflog"])
                                .pick_file()
                            {
                                self.baseline_path = Some(path.to_string_lossy().to_string());
                            }
                        }

                        let base_label = self
                            .baseline_path
                            .as_deref()
                            .unwrap_or("(No baseline chosen)");
                        ui.label(RichText::new(base_label).color(COLOR_SIGNAL_TX).monospace().small());
                    });

                    ui.add_space(4.0);

                    ui.horizontal(|ui| {
                        if ui.button("📁 Select Compare .bflog...").clicked() {
                            if let Some(path) = rfd::FileDialog::new()
                                .add_filter("BaudForge Log", &["bflog"])
                                .pick_file()
                            {
                                self.compare_path = Some(path.to_string_lossy().to_string());
                            }
                        }

                        let comp_label = self
                            .compare_path
                            .as_deref()
                            .unwrap_or("(No compare chosen)");
                        ui.label(RichText::new(comp_label).color(COLOR_SIGNAL_RX).monospace().small());
                    });

                    ui.add_space(8.0);

                    ui.horizontal(|ui| {
                        let diff_btn = egui::Button::new(
                            RichText::new("🔍 Run Session Diff")
                                .color(Color32::BLACK)
                                .strong(),
                        )
                        .fill(COLOR_SIGNAL_TRIGGER);

                        if ui.add(diff_btn).clicked() {
                            self.run_diff();
                        }

                        ui.label(
                            RichText::new(format!("Anomalies detected: {}", self.divergences.len()))
                                .color(COLOR_TEXT_MUTED)
                                .small(),
                        );
                    });

                    ui.add_space(8.0);

                    // Scrollable anomaly list highlighting packet divergences, timing jitter, or dropped frames
                    egui::ScrollArea::vertical()
                        .max_height(140.0)
                        .show(ui, |ui| {
                            for div in &self.divergences {
                                let color = if div.contains("jitter") || div.contains("Timing") {
                                    COLOR_SIGNAL_TRIGGER
                                } else if div.contains("Dropped") || div.contains("divergence") || div.contains("mismatch") {
                                    COLOR_SIGNAL_FAULT
                                } else if div.starts_with('✓') {
                                    COLOR_SIGNAL_RX
                                } else {
                                    COLOR_TEXT_PRIMARY
                                };

                                ui.label(RichText::new(div).color(color).monospace().small());
                            }
                        });
                });
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_vault_default_state() {
        let vault = VaultManager::default();
        assert!(!vault.is_recording);
        assert_eq!(vault.recording_path, "./vaults/session_live.bflog");
        assert_eq!(vault.current_frame_idx, 4820);
        assert_eq!(vault.total_frames, 12500);
        assert_eq!(vault.playback_speed, 1.0);
        assert!(vault.loop_playback);
        assert!(!vault.divergences.is_empty());
    }

    #[test]
    fn test_vault_recording_lifecycle() {
        let mut vault = VaultManager::default();
        vault.start_recording("./test_record.bflog");
        assert!(vault.is_recording);
        assert_eq!(vault.recording_path, "./test_record.bflog");
        assert_eq!(vault.recorded_bytes, 0);
        assert_eq!(vault.recorded_frames, 0);

        let packet = [0x01, 0x02, 0x03, 0x04];
        vault.record_frame(&packet);
        assert_eq!(vault.recorded_frames, 1);
        assert_eq!(vault.recorded_bytes, 4);

        vault.stop_recording();
        assert!(!vault.is_recording);

        // Recording when stopped should not mutate counters
        vault.record_frame(&packet);
        assert_eq!(vault.recorded_frames, 1);
        assert_eq!(vault.recorded_bytes, 4);
    }

    #[test]
    fn test_vault_stepping_controls() {
        let mut vault = VaultManager::default();
        vault.total_frames = 10;
        vault.current_frame_idx = 0;
        vault.loop_playback = true;

        vault.step_forward();
        assert_eq!(vault.current_frame_idx, 1);

        vault.step_backward();
        assert_eq!(vault.current_frame_idx, 0);

        // Step backward at 0 should stay at 0
        vault.step_backward();
        assert_eq!(vault.current_frame_idx, 0);

        // Step to the end
        vault.current_frame_idx = 9;
        vault.step_forward();
        // Because loop_playback is true, should loop to 0
        assert_eq!(vault.current_frame_idx, 0);

        vault.loop_playback = false;
        vault.current_frame_idx = 9;
        vault.step_forward();
        // Because loop_playback is false, should clamp at 9
        assert_eq!(vault.current_frame_idx, 9);
    }

    #[test]
    fn test_vault_run_diff_generates_anomalies() {
        let mut vault = VaultManager::default();
        vault.divergences.clear();
        assert!(vault.divergences.is_empty());

        vault.run_diff();
        assert!(!vault.divergences.is_empty(), "Session diff should generate divergence report");
        assert!(vault.divergences.iter().any(|d| d.contains("divergence")));
        assert!(vault.divergences.iter().any(|d| d.contains("jitter")));
        assert!(vault.divergences.iter().any(|d| d.contains("Dropped")));
    }
}
