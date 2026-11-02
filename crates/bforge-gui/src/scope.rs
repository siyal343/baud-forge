use std::collections::HashMap;
use egui::{self, Color32, Margin, RichText, Stroke, Ui, Vec2};
use egui_plot::{HLine, Line, LineStyle, Plot, PlotPoints, VLine};
use crate::theme::{
    COLOR_BORDER_HAIRLINE, COLOR_SIGNAL_FAULT, COLOR_SIGNAL_RX, COLOR_SIGNAL_TRIGGER,
    COLOR_SIGNAL_TX, COLOR_SURFACE_CARD, COLOR_TEXT_MUTED, COLOR_TEXT_PRIMARY,
};

/// A single scope input channel configuration and time-series sample buffer.
#[derive(Debug, Clone)]
pub struct ScopeChannel {
    pub name: String,
    pub bound_signal: String,
    pub color: egui::Color32,
    pub enabled: bool,
    pub scale: f32,
    pub offset: f32,
    pub points: Vec<[f64; 2]>,
}

impl ScopeChannel {
    pub fn new(name: impl Into<String>, bound_signal: impl Into<String>, color: Color32, enabled: bool) -> Self {
        Self {
            name: name.into(),
            bound_signal: bound_signal.into(),
            color,
            enabled,
            scale: 1.0_f32,
            offset: 0.0_f32,
            points: Vec::with_capacity(5000),
        }
    }
}

/// Trigger acquisition modes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TriggerMode {
    Auto,
    Normal,
    Single,
}

/// Trigger edge detection polarity.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TriggerEdge {
    Rising,
    Falling,
}

/// Hardware-like scope trigger settings and state.
#[derive(Debug, Clone)]
pub struct ScopeTrigger {
    pub source_channel: usize,
    pub mode: TriggerMode,
    pub edge: TriggerEdge,
    pub threshold: f64,
    pub is_triggered: bool,
}

impl Default for ScopeTrigger {
    fn default() -> Self {
        Self {
            source_channel: 0,
            mode: TriggerMode::Auto,
            edge: TriggerEdge::Rising,
            threshold: 0.0,
            is_triggered: false,
        }
    }
}

/// Computed electrical and statistical measurements for a channel buffer.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ScopeMeasurements {
    pub min: f64,
    pub max: f64,
    pub vpp: f64,
    pub mean: f64,
    pub vrms: f64,
    pub freq_hz: f64,
}

/// Real-time oscilloscope manager powering multi-channel signal plotting.
pub struct ScopeManager {
    pub channels: [ScopeChannel; 4],
    pub max_points: usize,
    pub timebase_sec: f64,
    pub paused: bool,
    pub trigger: ScopeTrigger,
    pub measurements: [Option<ScopeMeasurements>; 4],
    pub cursors_enabled: bool,
    pub cursor_x1: f64,
    pub cursor_x2: f64,
    pub cursor_y1: f64,
    pub cursor_y2: f64,
    pub auto_fit_requested: bool,
    last_source_val: Option<f64>,
}

impl Default for ScopeManager {
    fn default() -> Self {
        Self {
            channels: [
                ScopeChannel::new("Accel X", "ax", COLOR_SIGNAL_TX, true),
                ScopeChannel::new("Accel Y", "ay", COLOR_SIGNAL_RX, true),
                ScopeChannel::new("Accel Z", "az", COLOR_SIGNAL_TRIGGER, false),
                ScopeChannel::new("Gyro Z", "gz", COLOR_SIGNAL_FAULT, false),
            ],
            max_points: 5000,
            timebase_sec: 5.0,
            paused: false,
            trigger: ScopeTrigger::default(),
            measurements: [None, None, None, None],
            cursors_enabled: false,
            cursor_x1: 0.0,
            cursor_x2: 1.0,
            cursor_y1: -1.0,
            cursor_y2: 1.0,
            auto_fit_requested: true,
            last_source_val: None,
        }
    }
}

impl ScopeManager {
    /// Ingest a live telemetry sample point into active signal buffers.
    pub fn push_sample(&mut self, timestamp: f64, signals: &HashMap<String, f32>) {
        if self.paused {
            return;
        }

        // Trigger condition evaluation from source channel
        if self.trigger.source_channel < self.channels.len() {
            let source_sig = &self.channels[self.trigger.source_channel].bound_signal;
            if let Some(&raw) = signals.get(source_sig) {
                let scale = self.channels[self.trigger.source_channel].scale;
                let offset = self.channels[self.trigger.source_channel].offset;
                let val = (raw * scale + offset) as f64;

                if let Some(prev) = self.last_source_val {
                    let crossed = match self.trigger.edge {
                        TriggerEdge::Rising => prev < self.trigger.threshold && val >= self.trigger.threshold,
                        TriggerEdge::Falling => prev > self.trigger.threshold && val <= self.trigger.threshold,
                    };

                    if crossed {
                        self.trigger.is_triggered = true;
                        if self.trigger.mode == TriggerMode::Single {
                            // Capture this final sample before freezing
                            self.append_sample_to_channels(timestamp, signals);
                            self.last_source_val = Some(val);
                            self.paused = true;
                            self.recompute_measurements();
                            return;
                        }
                    }
                }
                self.last_source_val = Some(val);
            }
        }

        self.append_sample_to_channels(timestamp, signals);
        self.recompute_measurements();
    }

    fn append_sample_to_channels(&mut self, timestamp: f64, signals: &HashMap<String, f32>) {
        for ch in &mut self.channels {
            if let Some(&raw_val) = signals.get(&ch.bound_signal) {
                let val = (raw_val * ch.scale + ch.offset) as f64;
                ch.points.push([timestamp, val]);
                if ch.points.len() > self.max_points {
                    let excess = ch.points.len() - self.max_points;
                    ch.points.drain(0..excess);
                }
            }
        }
    }

    /// Recalculate statistical and frequency telemetry measurements for all channels.
    pub fn recompute_measurements(&mut self) {
        for (i, ch) in self.channels.iter().enumerate() {
            if ch.points.is_empty() {
                self.measurements[i] = None;
                continue;
            }

            let mut min = f64::INFINITY;
            let mut max = f64::NEG_INFINITY;
            let mut sum = 0.0;
            let mut sum_sq = 0.0;
            let n = ch.points.len() as f64;

            for pt in &ch.points {
                let y = pt[1];
                if y < min {
                    min = y;
                }
                if y > max {
                    max = y;
                }
                sum += y;
                sum_sq += y * y;
            }

            let vpp = (max - min).max(0.0);
            let mean = sum / n;
            let vrms = (sum_sq / n).sqrt();

            // Calculate estimated frequency from rising edge mean crossings
            let mut freq_hz = 0.0;
            if ch.points.len() >= 4 && vpp > 1e-6 {
                let mut crossings = Vec::new();
                for window in ch.points.windows(2) {
                    let p0 = window[0];
                    let p1 = window[1];
                    if p0[1] < mean && p1[1] >= mean && (p1[1] - p0[1]).abs() > 1e-9 {
                        let frac = (mean - p0[1]) / (p1[1] - p0[1]);
                        let t_cross = p0[0] + frac * (p1[0] - p0[0]);
                        crossings.push(t_cross);
                    }
                }
                if crossings.len() >= 2 {
                    let total_time = crossings.last().unwrap() - crossings.first().unwrap();
                    let num_cycles = (crossings.len() - 1) as f64;
                    if total_time > 0.0 {
                        freq_hz = num_cycles / total_time;
                    }
                }
            }

            self.measurements[i] = Some(ScopeMeasurements {
                min,
                max,
                vpp,
                mean,
                vrms,
                freq_hz,
            });
        }
    }

    /// Automatically adjust plot scale to fit active waveform samples.
    pub fn auto_fit(&mut self) {
        self.auto_fit_requested = true;
        for ch in &mut self.channels {
            ch.scale = 1.0_f32;
            ch.offset = 0.0_f32;
        }

        let mut min_t = f64::INFINITY;
        let mut max_t = f64::NEG_INFINITY;
        let mut min_y = f64::INFINITY;
        let mut max_y = f64::NEG_INFINITY;

        for ch in &self.channels {
            if ch.enabled && !ch.points.is_empty() {
                if let Some(first) = ch.points.first() {
                    if first[0] < min_t {
                        min_t = first[0];
                    }
                }
                if let Some(last) = ch.points.last() {
                    if last[0] > max_t {
                        max_t = last[0];
                    }
                }
                for pt in &ch.points {
                    if pt[1] < min_y {
                        min_y = pt[1];
                    }
                    if pt[1] > max_y {
                        max_y = pt[1];
                    }
                }
            }
        }

        if min_t.is_finite() && max_t.is_finite() && max_t > min_t {
            self.cursor_x1 = min_t + (max_t - min_t) * 0.25;
            self.cursor_x2 = min_t + (max_t - min_t) * 0.75;
        }
        if min_y.is_finite() && max_y.is_finite() && max_y > min_y {
            self.cursor_y1 = min_y + (max_y - min_y) * 0.25;
            self.cursor_y2 = min_y + (max_y - min_y) * 0.75;
        }
    }

    /// Clear all channel sample points and measurement buffers.
    pub fn clear(&mut self) {
        for ch in &mut self.channels {
            ch.points.clear();
        }
        self.measurements = [None, None, None, None];
        self.trigger.is_triggered = false;
        self.last_source_val = None;
    }

    /// Render oscilloscope view inside egui UI.
    pub fn show(&mut self, ui: &mut Ui) {
        // 1. Top Control Toolbar
        ui.horizontal_wrapped(|ui| {
            // Channel checkboxes
            ui.label(RichText::new("CH:").color(COLOR_TEXT_MUTED).strong());
            for (idx, ch) in self.channels.iter_mut().enumerate() {
                let label = format!("CH{}", idx + 1);
                ui.checkbox(&mut ch.enabled, RichText::new(label).color(ch.color).strong());
            }

            ui.separator();

            // Run / Pause button
            if self.paused {
                if ui
                    .button(RichText::new("▶ Run").color(COLOR_SIGNAL_RX).strong())
                    .on_hover_text("Resume acquisition")
                    .clicked()
                {
                    self.paused = false;
                    self.trigger.is_triggered = false;
                }
            } else {
                if ui
                    .button(RichText::new("⏸ Pause").color(COLOR_SIGNAL_FAULT).strong())
                    .on_hover_text("Pause oscilloscope stream")
                    .clicked()
                {
                    self.paused = true;
                }
            }

            // Auto-Fit button
            if ui.button("⛶ Auto-Fit").on_hover_text("Reset bounds to fit signals").clicked() {
                self.auto_fit();
            }

            // Clear button
            if ui.button("🗑 Clear").on_hover_text("Clear all waveforms").clicked() {
                self.clear();
            }

            ui.separator();

            // Trigger Mode ComboBox
            ui.label(RichText::new("Trig:").color(COLOR_TEXT_MUTED));
            egui::ComboBox::from_id_salt("scope_trigger_mode")
                .selected_text(format!("{:?}", self.trigger.mode))
                .width(70.0)
                .show_ui(ui, |ui| {
                    ui.selectable_value(&mut self.trigger.mode, TriggerMode::Auto, "Auto");
                    ui.selectable_value(&mut self.trigger.mode, TriggerMode::Normal, "Normal");
                    ui.selectable_value(&mut self.trigger.mode, TriggerMode::Single, "Single");
                });

            // Trigger Source ComboBox
            egui::ComboBox::from_id_salt("scope_trigger_source")
                .selected_text(format!("CH{}", self.trigger.source_channel + 1))
                .width(60.0)
                .show_ui(ui, |ui| {
                    for idx in 0..self.channels.len() {
                        ui.selectable_value(
                            &mut self.trigger.source_channel,
                            idx,
                            format!("CH{}: {}", idx + 1, self.channels[idx].name),
                        );
                    }
                });

            // Trigger Edge button
            let edge_label = match self.trigger.edge {
                TriggerEdge::Rising => "↗ Rise",
                TriggerEdge::Falling => "↘ Fall",
            };
            if ui.button(edge_label).on_hover_text("Toggle trigger edge polarity").clicked() {
                self.trigger.edge = match self.trigger.edge {
                    TriggerEdge::Rising => TriggerEdge::Falling,
                    TriggerEdge::Falling => TriggerEdge::Rising,
                };
            }

            // Trigger Threshold Slider
            ui.add(
                egui::Slider::new(&mut self.trigger.threshold, -5.0..=5.0)
                    .prefix("Lvl: ")
                    .step_by(0.05),
            );

            // Trigger Status Indicator
            if self.trigger.is_triggered {
                ui.label(RichText::new("● TRIG").color(COLOR_SIGNAL_RX).strong().small());
            } else {
                ui.label(RichText::new("○ WAIT").color(COLOR_TEXT_MUTED).small());
            }

            ui.separator();

            // Cursors toggle
            ui.toggle_value(&mut self.cursors_enabled, "Cursors");
        });

        ui.add_space(4.0);

        // 2. Main Area: Center Plot + Right Side Measurements Panel (180px)
        let total_available = ui.available_size();
        let right_panel_w = 180.0_f32;
        let plot_w = (total_available.x - right_panel_w - 12.0_f32).max(180.0_f32);
        let content_h = total_available.y.max(220.0_f32);

        ui.horizontal(|ui| {
            // Center Plot
            ui.allocate_ui_with_layout(
                Vec2::new(plot_w, content_h),
                egui::Layout::top_down(egui::Align::Min),
                |ui| {
                    let mut plot = Plot::new("scope_plot")
                        .legend(egui_plot::Legend::default())
                        .show_axes([true, true])
                        .show_grid([true, true])
                        .allow_drag(true)
                        .allow_zoom(true)
                        .allow_scroll(true);

                    if self.auto_fit_requested {
                        plot = plot.auto_bounds(egui::Vec2b::new(true, true));
                        self.auto_fit_requested = false;
                    }

                    plot.show(ui, |plot_ui| {
                        // Channel lines
                        for ch in &self.channels {
                            if ch.enabled && !ch.points.is_empty() {
                                plot_ui.line(
                                    Line::new(PlotPoints::new(ch.points.clone()))
                                        .color(ch.color)
                                        .name(&ch.name)
                                        .width(1.5_f32),
                                );
                            }
                        }

                        // Trigger threshold line
                        plot_ui.hline(
                            HLine::new(self.trigger.threshold)
                                .color(COLOR_TEXT_MUTED)
                                .style(LineStyle::Dashed { length: 4.0_f32 })
                                .name("Trigger Level"),
                        );

                        // Horizontal & vertical cursor lines
                        if self.cursors_enabled {
                            plot_ui.vline(
                                VLine::new(self.cursor_x1)
                                    .color(COLOR_SIGNAL_TX)
                                    .style(LineStyle::Dashed { length: 4.0_f32 })
                                    .name("Cursor X1"),
                            );
                            plot_ui.vline(
                                VLine::new(self.cursor_x2)
                                    .color(COLOR_SIGNAL_TX)
                                    .style(LineStyle::Dashed { length: 4.0_f32 })
                                    .name("Cursor X2"),
                            );
                            plot_ui.hline(
                                HLine::new(self.cursor_y1)
                                    .color(COLOR_SIGNAL_RX)
                                    .style(LineStyle::Dashed { length: 4.0_f32 })
                                    .name("Cursor Y1"),
                            );
                            plot_ui.hline(
                                HLine::new(self.cursor_y2)
                                    .color(COLOR_SIGNAL_RX)
                                    .style(LineStyle::Dashed { length: 4.0_f32 })
                                    .name("Cursor Y2"),
                            );
                        }
                    });
                },
            );

            ui.separator();

            // Right Side Panel (width 180px)
            ui.allocate_ui_with_layout(
                Vec2::new(right_panel_w, content_h),
                egui::Layout::top_down(egui::Align::Min),
                |ui| {
                    egui::Frame::NONE
                        .fill(COLOR_SURFACE_CARD)
                        .stroke(Stroke::new(1.0_f32, COLOR_BORDER_HAIRLINE))
                        .inner_margin(Margin::same(8))
                        .show(ui, |ui| {
                            egui::ScrollArea::vertical().show(ui, |ui| {
                                ui.label(
                                    RichText::new("MEASUREMENTS")
                                        .color(COLOR_TEXT_PRIMARY)
                                        .strong()
                                        .small(),
                                );
                                ui.add_space(4.0);

                                // Cursor live delta section
                                if self.cursors_enabled {
                                    let dt = (self.cursor_x2 - self.cursor_x1).abs();
                                    let dt_ms = dt * 1000.0;
                                    let freq = if dt > 1e-9 { 1.0 / dt } else { 0.0 };
                                    let dv = (self.cursor_y2 - self.cursor_y1).abs();

                                    ui.label(
                                        RichText::new("CURSORS")
                                            .color(COLOR_SIGNAL_TRIGGER)
                                            .small()
                                            .strong(),
                                    );
                                    ui.label(format!("Δt:   {:.2} ms", dt_ms));
                                    ui.label(format!("Freq: {:.2} Hz", freq));
                                    ui.label(format!("ΔV:   {:.3}", dv));

                                    ui.add_space(2.0);
                                    ui.add(
                                        egui::DragValue::new(&mut self.cursor_x1)
                                            .speed(0.01)
                                            .prefix("X1: "),
                                    );
                                    ui.add(
                                        egui::DragValue::new(&mut self.cursor_x2)
                                            .speed(0.01)
                                            .prefix("X2: "),
                                    );
                                    ui.add(
                                        egui::DragValue::new(&mut self.cursor_y1)
                                            .speed(0.01)
                                            .prefix("Y1: "),
                                    );
                                    ui.add(
                                        egui::DragValue::new(&mut self.cursor_y2)
                                            .speed(0.01)
                                            .prefix("Y2: "),
                                    );
                                } else {
                                    ui.label(
                                        RichText::new("Cursors: Disabled")
                                            .color(COLOR_TEXT_MUTED)
                                            .small(),
                                    );
                                }

                                ui.add_space(6.0);
                                ui.separator();
                                ui.add_space(4.0);

                                // Channel Telemetry Stats Table
                                ui.label(
                                    RichText::new("CHANNEL STATS")
                                        .color(COLOR_TEXT_PRIMARY)
                                        .small()
                                        .strong(),
                                );
                                ui.add_space(4.0);

                                for (i, ch) in self.channels.iter().enumerate() {
                                    if !ch.enabled {
                                        continue;
                                    }

                                    ui.horizontal(|ui| {
                                        ui.label(
                                            RichText::new(format!("CH{}", i + 1))
                                                .color(ch.color)
                                                .strong()
                                                .small(),
                                        );
                                        ui.label(
                                            RichText::new(&ch.name)
                                                .color(COLOR_TEXT_PRIMARY)
                                                .small(),
                                        );
                                    });

                                    if let Some(m) = self.measurements[i] {
                                        ui.label(
                                            RichText::new(format!("Vpp:  {:.3}", m.vpp))
                                                .monospace()
                                                .small(),
                                        );
                                        ui.label(
                                            RichText::new(format!("Vrms: {:.3}", m.vrms))
                                                .monospace()
                                                .small(),
                                        );
                                        ui.label(
                                            RichText::new(format!("Min:  {:.3}", m.min))
                                                .monospace()
                                                .small(),
                                        );
                                        ui.label(
                                            RichText::new(format!("Max:  {:.3}", m.max))
                                                .monospace()
                                                .small(),
                                        );
                                        ui.label(
                                            RichText::new(format!("Mean: {:.3}", m.mean))
                                                .monospace()
                                                .small(),
                                        );
                                        if m.freq_hz > 0.0 {
                                            ui.label(
                                                RichText::new(format!("Freq: {:.1} Hz", m.freq_hz))
                                                    .monospace()
                                                    .small(),
                                            );
                                        }
                                    } else {
                                        ui.label(
                                            RichText::new("No signal data")
                                                .color(COLOR_TEXT_MUTED)
                                                .small(),
                                        );
                                    }

                                    ui.add_space(4.0);
                                }
                            });
                        });
                },
            );
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_scope_initialization() {
        let scope = ScopeManager::default();
        assert_eq!(scope.channels.len(), 4);
        assert_eq!(scope.channels[0].name, "Accel X");
        assert_eq!(scope.channels[0].bound_signal, "ax");
        assert!(scope.channels[0].enabled);

        assert_eq!(scope.channels[1].name, "Accel Y");
        assert_eq!(scope.channels[1].bound_signal, "ay");
        assert!(scope.channels[1].enabled);

        assert_eq!(scope.channels[2].name, "Accel Z");
        assert_eq!(scope.channels[2].bound_signal, "az");
        assert!(!scope.channels[2].enabled);

        assert_eq!(scope.channels[3].name, "Gyro Z");
        assert_eq!(scope.channels[3].bound_signal, "gz");
        assert!(!scope.channels[3].enabled);

        assert_eq!(scope.max_points, 5000);
        assert!(!scope.paused);
        assert_eq!(scope.trigger.mode, TriggerMode::Auto);
        assert_eq!(scope.trigger.edge, TriggerEdge::Rising);
        assert_eq!(scope.trigger.threshold, 0.0);
        assert!(!scope.trigger.is_triggered);
    }

    #[test]
    fn test_push_sample_and_rolling_buffer() {
        let mut scope = ScopeManager::default();
        scope.max_points = 50;

        for i in 0..100 {
            let mut signals = HashMap::new();
            signals.insert("ax".to_string(), i as f32);
            signals.insert("ay".to_string(), (i * 2) as f32);
            scope.push_sample(i as f64 * 0.01, &signals);
        }

        assert_eq!(scope.channels[0].points.len(), 50);
        assert_eq!(scope.channels[1].points.len(), 50);
        // Accel Z had no data pushed
        assert_eq!(scope.channels[2].points.len(), 0);

        // Verify ring buffer retained newest samples (50..100)
        let last_pt = scope.channels[0].points.last().unwrap();
        assert_eq!(last_pt[1], 99.0);
        let first_pt = scope.channels[0].points.first().unwrap();
        assert_eq!(first_pt[1], 50.0);
    }

    #[test]
    fn test_trigger_detection_rising() {
        let mut scope = ScopeManager::default();
        scope.trigger.source_channel = 0;
        scope.trigger.edge = TriggerEdge::Rising;
        scope.trigger.threshold = 1.0;
        assert!(!scope.trigger.is_triggered);

        let mut sigs = HashMap::new();
        sigs.insert("ax".to_string(), 0.5);
        scope.push_sample(0.1, &sigs);
        assert!(!scope.trigger.is_triggered);

        sigs.insert("ax".to_string(), 1.5);
        scope.push_sample(0.2, &sigs);
        assert!(scope.trigger.is_triggered);
    }

    #[test]
    fn test_trigger_detection_falling() {
        let mut scope = ScopeManager::default();
        scope.trigger.source_channel = 1;
        scope.trigger.edge = TriggerEdge::Falling;
        scope.trigger.threshold = 2.0;

        let mut sigs = HashMap::new();
        sigs.insert("ay".to_string(), 2.5);
        scope.push_sample(0.1, &sigs);
        assert!(!scope.trigger.is_triggered);

        sigs.insert("ay".to_string(), 1.8);
        scope.push_sample(0.2, &sigs);
        assert!(scope.trigger.is_triggered);
    }

    #[test]
    fn test_trigger_single_mode_freezes() {
        let mut scope = ScopeManager::default();
        scope.trigger.source_channel = 0;
        scope.trigger.mode = TriggerMode::Single;
        scope.trigger.edge = TriggerEdge::Rising;
        scope.trigger.threshold = 0.0;

        let mut sigs = HashMap::new();
        sigs.insert("ax".to_string(), -1.0);
        scope.push_sample(0.1, &sigs);
        assert!(!scope.paused);

        sigs.insert("ax".to_string(), 1.0);
        scope.push_sample(0.2, &sigs);
        assert!(scope.trigger.is_triggered);
        assert!(scope.paused);

        // Next sample should be ignored because paused
        let count_before = scope.channels[0].points.len();
        sigs.insert("ax".to_string(), 2.0);
        scope.push_sample(0.3, &sigs);
        assert_eq!(scope.channels[0].points.len(), count_before);
    }

    #[test]
    fn test_measurements_calculation() {
        let mut scope = ScopeManager::default();
        // 10 Hz sine wave with amplitude 2.0 (vpp = 4.0, vrms ~ 1.414)
        // 1000 samples per second, 1000 samples total = 1.0 second (10 cycles, 100 samples/cycle)
        for i in 0..1000 {
            let t = i as f64 * 0.001;
            let val = 2.0 * (2.0 * std::f64::consts::PI * 10.0 * t).sin();
            let mut sigs = HashMap::new();
            sigs.insert("ax".to_string(), val as f32);
            scope.push_sample(t, &sigs);
        }

        let m = scope.measurements[0].expect("Measurements should be computed");
        assert!((m.min - (-2.0)).abs() < 0.05, "Min expected ~ -2.0, got {}", m.min);
        assert!((m.max - 2.0).abs() < 0.05, "Max expected ~ 2.0, got {}", m.max);
        assert!((m.vpp - 4.0).abs() < 0.1, "Vpp expected ~ 4.0, got {}", m.vpp);
        assert!(m.mean.abs() < 0.05, "Mean expected ~ 0.0, got {}", m.mean);
        assert!((m.vrms - std::f64::consts::SQRT_2).abs() < 0.05, "Vrms expected ~ 1.414, got {}", m.vrms);
        assert!((m.freq_hz - 10.0).abs() < 0.5, "Freq expected ~ 10 Hz, got {}", m.freq_hz);
    }

    #[test]
    fn test_clear_and_auto_fit() {
        let mut scope = ScopeManager::default();
        let mut sigs = HashMap::new();
        sigs.insert("ax".to_string(), 5.0);
        scope.push_sample(1.0, &sigs);

        assert!(!scope.channels[0].points.is_empty());
        assert!(scope.measurements[0].is_some());

        scope.auto_fit();
        assert!(scope.auto_fit_requested);

        scope.clear();
        assert!(scope.channels[0].points.is_empty());
        assert!(scope.measurements[0].is_none());
        assert!(!scope.trigger.is_triggered);
    }
}
