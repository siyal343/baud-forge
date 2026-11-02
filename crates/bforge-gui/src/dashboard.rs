use egui::{
    epaint::CornerRadius, Align2, Color32, FontId, Pos2, Rect, RichText, Sense, Stroke, StrokeKind,
    Vec2,
};
use std::collections::HashMap;

use crate::theme::{
    COLOR_BG_DEEP, COLOR_BORDER_HAIRLINE, COLOR_SIGNAL_FAULT, COLOR_SIGNAL_RX,
    COLOR_SIGNAL_TRIGGER, COLOR_SIGNAL_TX, COLOR_SURFACE_CARD, COLOR_SURFACE_ELEVATED,
    COLOR_TEXT_MUTED, COLOR_TEXT_PRIMARY,
};

/// Type and configuration parameters of a dashboard widget.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
pub enum WidgetType {
    RadialGauge {
        min: f32,
        max: f32,
        warn: f32,
        crit: f32,
    },
    BarMeter {
        min: f32,
        max: f32,
    },
    StatusLed {
        active_threshold: f32,
    },
    NumericCard,
    RollingChart {
        history: Vec<f32>,
        max_points: usize,
    },
}

/// An individual instrument or telemetry card displayed in the dashboard.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct DashboardWidget {
    pub id: String,
    pub title: String,
    pub unit: String,
    pub bound_signal: String,
    pub widget_type: WidgetType,
    pub current_value: f32,
}

/// Collection and controller of dashboard telemetry widgets.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct DashboardManager {
    pub widgets: Vec<DashboardWidget>,
}

impl Default for DashboardManager {
    fn default() -> Self {
        default_dashboard()
    }
}

impl DashboardManager {
    /// Create an empty dashboard manager.
    pub fn new() -> Self {
        Self {
            widgets: Vec::new(),
        }
    }

    /// Add a widget to the dashboard.
    pub fn add_widget(&mut self, widget: DashboardWidget) {
        self.widgets.push(widget);
    }

    /// Remove a widget by index if valid.
    pub fn remove_widget(&mut self, idx: usize) {
        if idx < self.widgets.len() {
            self.widgets.remove(idx);
        }
    }

    /// Update bound signals across all dashboard widgets.
    pub fn update_signals(&mut self, signals: &HashMap<String, f32>) {
        for widget in &mut self.widgets {
            let matched_val = signals
                .get(&widget.bound_signal)
                .or_else(|| signals.get(&widget.bound_signal.to_lowercase()))
                .copied();

            if let Some(val) = matched_val {
                widget.current_value = val;

                if let WidgetType::RollingChart {
                    ref mut history,
                    max_points,
                } = widget.widget_type
                {
                    history.push(val);
                    if history.len() > max_points {
                        let excess = history.len() - max_points;
                        history.drain(0..excess);
                    }
                }
            }
        }
    }
}

/// Construct the default telemetry dashboard with 7 lab instruments.
pub fn default_dashboard() -> DashboardManager {
    let mut initial_az = Vec::with_capacity(80);
    for _ in 0..20 {
        initial_az.push(0.98);
    }

    let widgets = vec![
        // 1. Radial Gauge: "Motor Speed" bound to "rpm" (0..12000 RPM, warn 9000, crit 10500)
        DashboardWidget {
            id: "gauge_motor_speed".to_string(),
            title: "Motor Speed".to_string(),
            unit: "RPM".to_string(),
            bound_signal: "rpm".to_string(),
            widget_type: WidgetType::RadialGauge {
                min: 0.0,
                max: 12000.0,
                warn: 9000.0,
                crit: 10500.0,
            },
            current_value: 7200.0,
        },
        // 2. Bar Meter: "Core Temperature" bound to "temp" (-20..100 °C)
        DashboardWidget {
            id: "meter_core_temp".to_string(),
            title: "Core Temperature".to_string(),
            unit: "°C".to_string(),
            bound_signal: "temp".to_string(),
            widget_type: WidgetType::BarMeter {
                min: -20.0,
                max: 100.0,
            },
            current_value: 42.6,
        },
        // 3. Bar Meter: "Bus Voltage" bound to "volts" (0..36 V)
        DashboardWidget {
            id: "meter_bus_volts".to_string(),
            title: "Bus Voltage".to_string(),
            unit: "V".to_string(),
            bound_signal: "volts".to_string(),
            widget_type: WidgetType::BarMeter {
                min: 0.0,
                max: 36.0,
            },
            current_value: 24.1,
        },
        // 4. Status LED: "Sync Lock" bound to "sync" (threshold 0.5)
        DashboardWidget {
            id: "led_sync_lock".to_string(),
            title: "Sync Lock".to_string(),
            unit: "".to_string(),
            bound_signal: "sync".to_string(),
            widget_type: WidgetType::StatusLed {
                active_threshold: 0.5,
            },
            current_value: 1.0,
        },
        // 5. Status LED: "Fault Trigger" bound to "fault" (threshold 0.5)
        DashboardWidget {
            id: "led_fault_trigger".to_string(),
            title: "Fault Trigger".to_string(),
            unit: "".to_string(),
            bound_signal: "fault".to_string(),
            widget_type: WidgetType::StatusLed {
                active_threshold: 0.5,
            },
            current_value: 0.0,
        },
        // 6. Rolling Chart: "Z-Axis Acceleration" bound to "az" (history 80 points)
        DashboardWidget {
            id: "chart_az_accel".to_string(),
            title: "Z-Axis Acceleration".to_string(),
            unit: "g".to_string(),
            bound_signal: "az".to_string(),
            widget_type: WidgetType::RollingChart {
                history: initial_az,
                max_points: 80,
            },
            current_value: 0.98,
        },
        // 7. Numeric Card: "Stream Throughput" bound to "rate" (packets/sec)
        DashboardWidget {
            id: "card_throughput".to_string(),
            title: "Stream Throughput".to_string(),
            unit: "pkt/s".to_string(),
            bound_signal: "rate".to_string(),
            widget_type: WidgetType::NumericCard,
            current_value: 120.0,
        },
    ];

    DashboardManager { widgets }
}

/// Render an arc polyline on the painter between two angles with radius r and stroke.
fn draw_arc(
    painter: &egui::Painter,
    center: Pos2,
    radius: f32,
    start_angle: f32,
    end_angle: f32,
    stroke: Stroke,
) {
    if start_angle >= end_angle {
        return;
    }
    let steps = 28;
    for i in 0..steps {
        let t0 = i as f32 / steps as f32;
        let t1 = (i + 1) as f32 / steps as f32;
        let a0 = start_angle + t0 * (end_angle - start_angle);
        let a1 = start_angle + t1 * (end_angle - start_angle);
        let p0 = Pos2::new(center.x + a0.cos() * radius, center.y + a0.sin() * radius);
        let p1 = Pos2::new(center.x + a1.cos() * radius, center.y + a1.sin() * radius);
        painter.line_segment([p0, p1], stroke);
    }
}

/// Semicircular needle gauge with arc background (`COLOR_SURFACE_CARD`),
/// warning arc in amber, critical arc in rose, tick marks, needle pointer drawn
/// from center pivot to arc edge with `COLOR_SIGNAL_TX` (cyan), and digital readout in center.
pub fn render_radial_gauge(ui: &mut egui::Ui, widget: &DashboardWidget) {
    let (min, max, warn, crit) = match widget.widget_type {
        WidgetType::RadialGauge {
            min,
            max,
            warn,
            crit,
        } => (min, max, warn, crit),
        _ => (0.0, 100.0, 75.0, 90.0),
    };

    let gauge_height = 110.0;
    let (rect, _) = ui.allocate_exact_size(Vec2::new(ui.available_width(), gauge_height), Sense::hover());
    let painter = ui.painter();

    let pivot = Pos2::new(rect.center().x, rect.max.y - 12.0);
    let radius = (rect.height() - 24.0)
        .min(rect.width() / 2.0 - 18.0)
        .clamp(35.0, 76.0);

    let angle_start = std::f32::consts::PI;
    let angle_end = 2.0 * std::f32::consts::PI;

    // 1. Arc background track
    draw_arc(
        painter,
        pivot,
        radius,
        angle_start,
        angle_end,
        Stroke::new(6.0_f32, COLOR_BORDER_HAIRLINE),
    );

    // 2. Warning arc (amber)
    let range = (max - min).max(0.001);
    let warn_frac = ((warn - min) / range).clamp(0.0, 1.0);
    let crit_frac = ((crit - min) / range).clamp(0.0, 1.0);

    let angle_warn = angle_start + warn_frac * std::f32::consts::PI;
    let angle_crit = angle_start + crit_frac * std::f32::consts::PI;

    if warn_frac < crit_frac {
        draw_arc(
            painter,
            pivot,
            radius,
            angle_warn,
            angle_crit,
            Stroke::new(6.0_f32, COLOR_SIGNAL_TRIGGER),
        );
    }

    // 3. Critical arc (rose)
    if crit_frac < 1.0 {
        draw_arc(
            painter,
            pivot,
            radius,
            angle_crit,
            angle_end,
            Stroke::new(6.0_f32, COLOR_SIGNAL_FAULT),
        );
    }

    // 4. Tick marks (9 ticks: 0%, 12.5%, 25%, ..., 100%)
    for i in 0..=8 {
        let f = i as f32 / 8.0;
        let is_major = i % 2 == 0;
        let angle = angle_start + f * std::f32::consts::PI;
        let inner_r = if is_major { radius - 9.0 } else { radius - 6.0 };
        let outer_r = if is_major { radius + 4.0 } else { radius + 2.0 };

        let p_inner = Pos2::new(pivot.x + angle.cos() * inner_r, pivot.y + angle.sin() * inner_r);
        let p_outer = Pos2::new(pivot.x + angle.cos() * outer_r, pivot.y + angle.sin() * outer_r);

        let tick_stroke = if is_major {
            Stroke::new(1.5_f32, COLOR_TEXT_MUTED)
        } else {
            Stroke::new(1.0_f32, Color32::from_rgb(60, 72, 88))
        };
        painter.line_segment([p_inner, p_outer], tick_stroke);
    }

    // 5. Needle pointer drawn from center pivot to arc edge with COLOR_SIGNAL_TX (cyan)
    let val_frac = ((widget.current_value - min) / range).clamp(0.0, 1.0);
    let needle_angle = angle_start + val_frac * std::f32::consts::PI;
    let tip_radius = radius - 3.0;
    let needle_tip = Pos2::new(
        pivot.x + needle_angle.cos() * tip_radius,
        pivot.y + needle_angle.sin() * tip_radius,
    );

    painter.line_segment([pivot, needle_tip], Stroke::new(2.5_f32, COLOR_SIGNAL_TX));
    painter.circle_filled(pivot, 4.5, COLOR_SIGNAL_TX);
    painter.circle_filled(pivot, 2.0, COLOR_BG_DEEP);

    // 6. Digital readout in center
    let readout_pos = Pos2::new(pivot.x, pivot.y - radius * 0.44);
    painter.text(
        readout_pos,
        Align2::CENTER_CENTER,
        format!("{:.0} {}", widget.current_value, widget.unit),
        FontId::monospace(13.0),
        COLOR_TEXT_PRIMARY,
    );

    // Range labels at left and right edges
    painter.text(
        Pos2::new(pivot.x - radius, pivot.y + 2.0),
        Align2::LEFT_TOP,
        format!("{:.0}", min),
        FontId::monospace(9.0),
        COLOR_TEXT_MUTED,
    );
    painter.text(
        Pos2::new(pivot.x + radius, pivot.y + 2.0),
        Align2::RIGHT_TOP,
        format!("{:.0}", max),
        FontId::monospace(9.0),
        COLOR_TEXT_MUTED,
    );
}

/// Horizontal filled bar with percentage fill, tick marks at 25/50/75/100%, and value readout.
pub fn render_bar_meter(ui: &mut egui::Ui, widget: &DashboardWidget) {
    let (min, max) = match widget.widget_type {
        WidgetType::BarMeter { min, max } => (min, max),
        _ => (0.0, 100.0),
    };

    let range = (max - min).max(0.001);
    let norm = ((widget.current_value - min) / range).clamp(0.0, 1.0);
    let pct = norm * 100.0;

    // Digital readout header
    ui.horizontal(|ui| {
        ui.label(
            RichText::new(format!("{:.1} {}", widget.current_value, widget.unit))
                .monospace()
                .strong()
                .size(15.0)
                .color(COLOR_SIGNAL_TX),
        );
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            ui.label(
                RichText::new(format!("{:.0}%", pct))
                    .monospace()
                    .small()
                    .color(COLOR_TEXT_MUTED),
            );
        });
    });

    ui.add_space(2.0);

    // Meter bar canvas
    let (rect, _) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 16.0), Sense::hover());
    let painter = ui.painter();

    // Bar background
    painter.rect_filled(rect, CornerRadius::same(3), COLOR_SURFACE_ELEVATED);
    painter.rect_stroke(
        rect,
        CornerRadius::same(3),
        Stroke::new(1.0_f32, COLOR_BORDER_HAIRLINE),
        StrokeKind::Inside,
    );

    // Filled portion
    let fill_w = rect.width() * norm;
    if fill_w > 1.0 {
        let fill_rect = Rect::from_min_size(rect.min, Vec2::new(fill_w, rect.height()));
        painter.rect_filled(fill_rect, CornerRadius::same(3), COLOR_SIGNAL_RX);
    }

    // Tick marks at 25/50/75/100%
    for &tick in &[0.25, 0.50, 0.75, 1.0] {
        let x = rect.min.x + rect.width() * tick;
        painter.line_segment(
            [Pos2::new(x, rect.min.y), Pos2::new(x, rect.max.y)],
            Stroke::new(1.0_f32, COLOR_BORDER_HAIRLINE),
        );
    }

    // Sub-bar min/max labels
    ui.horizontal(|ui| {
        ui.label(RichText::new(format!("{:.0}", min)).small().color(COLOR_TEXT_MUTED));
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            ui.label(RichText::new(format!("{:.0}", max)).small().color(COLOR_TEXT_MUTED));
        });
    });
}

/// Circular LED bulb (14px diameter) with glowing fill (`COLOR_SIGNAL_RX` green when active,
/// dark grey `#222933` when inactive), hairline bezel, and title label.
pub fn render_status_led(ui: &mut egui::Ui, widget: &DashboardWidget) {
    let active_threshold = match widget.widget_type {
        WidgetType::StatusLed { active_threshold } => active_threshold,
        _ => 0.5,
    };

    let is_active = widget.current_value >= active_threshold;

    ui.horizontal(|ui| {
        let (rect, _) = ui.allocate_exact_size(Vec2::new(24.0, 24.0), Sense::hover());
        let painter = ui.painter();
        let center = rect.center();
        let radius = 7.0; // 14px diameter

        if is_active {
            // Glowing halo
            painter.circle_filled(
                center,
                radius + 3.0,
                Color32::from_rgba_unmultiplied(16, 185, 129, 65),
            );
            // Glowing active fill
            painter.circle_filled(center, radius, COLOR_SIGNAL_RX);
            // Specular reflection highlight
            painter.circle_filled(
                Pos2::new(center.x - 2.2, center.y - 2.2),
                1.8,
                Color32::from_rgba_unmultiplied(255, 255, 255, 190),
            );
        } else {
            // Inactive dark grey #222933
            painter.circle_filled(center, radius, Color32::from_rgb(0x22, 0x29, 0x33));
        }

        // Hairline bezel
        painter.circle_stroke(center, radius, Stroke::new(1.0_f32, COLOR_BORDER_HAIRLINE));

        ui.add_space(4.0);
        ui.vertical(|ui| {
            let (status_text, status_color) = if is_active {
                ("ACTIVE / LOCKED", COLOR_SIGNAL_RX)
            } else {
                ("INACTIVE / OFF", COLOR_TEXT_MUTED)
            };
            ui.label(
                RichText::new(status_text)
                    .monospace()
                    .strong()
                    .small()
                    .color(status_color),
            );
            ui.label(
                RichText::new(format!(
                    "Level: {:.2} (Threshold: {:.2})",
                    widget.current_value, active_threshold
                ))
                .small()
                .color(COLOR_TEXT_MUTED),
            );
        });
    });
}

/// Mini graph canvas drawing line segments between historical points with fill under curve
/// and current value tag.
pub fn render_rolling_chart(ui: &mut egui::Ui, widget: &DashboardWidget) {
    let empty_history = Vec::new();
    let history = match &widget.widget_type {
        WidgetType::RollingChart { history, .. } => history,
        _ => &empty_history,
    };

    ui.horizontal(|ui| {
        ui.label(
            RichText::new(format!("{:.2} {}", widget.current_value, widget.unit))
                .monospace()
                .strong()
                .size(16.0)
                .color(COLOR_SIGNAL_TX),
        );
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            ui.label(
                RichText::new(format!("{} pts", history.len()))
                    .small()
                    .color(COLOR_TEXT_MUTED),
            );
        });
    });

    ui.add_space(2.0);

    let (rect, _) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 70.0), Sense::hover());
    let painter = ui.painter();

    // Background & border
    painter.rect_filled(rect, CornerRadius::same(3), COLOR_SURFACE_ELEVATED);
    painter.rect_stroke(
        rect,
        CornerRadius::same(3),
        Stroke::new(1.0_f32, COLOR_BORDER_HAIRLINE),
        StrokeKind::Inside,
    );

    // Horizontal grid lines
    for frac in &[0.25, 0.50, 0.75] {
        let y = rect.min.y + rect.height() * frac;
        painter.line_segment(
            [Pos2::new(rect.min.x, y), Pos2::new(rect.max.x, y)],
            Stroke::new(1.0_f32, Color32::from_rgba_unmultiplied(34, 41, 51, 140)),
        );
    }

    if history.len() >= 2 {
        let mut min_val = history[0];
        let mut max_val = history[0];
        for &v in history.iter() {
            if v < min_val {
                min_val = v;
            }
            if v > max_val {
                max_val = v;
            }
        }
        let range = if (max_val - min_val).abs() < 0.001 {
            1.0
        } else {
            max_val - min_val
        };
        let pad_y = 6.0;
        let usable_h = rect.height() - 2.0 * pad_y;

        let points: Vec<Pos2> = history
            .iter()
            .enumerate()
            .map(|(i, &v)| {
                let x = rect.min.x + (i as f32 / (history.len() - 1) as f32) * rect.width();
                let norm_y = (v - min_val) / range;
                let y = rect.max.y - pad_y - norm_y * usable_h;
                Pos2::new(x, y)
            })
            .collect();

        // Fill under curve via convex trapezoids
        let fill_color = Color32::from_rgba_unmultiplied(6, 182, 212, 35);
        for i in 0..points.len() - 1 {
            let p0 = points[i];
            let p1 = points[i + 1];
            let b0 = Pos2::new(p0.x, rect.max.y - 1.0);
            let b1 = Pos2::new(p1.x, rect.max.y - 1.0);
            painter.add(egui::Shape::convex_polygon(
                vec![b0, p0, p1, b1],
                fill_color,
                Stroke::NONE,
            ));
        }

        // Line segments
        for i in 0..points.len() - 1 {
            painter.line_segment([points[i], points[i + 1]], Stroke::new(1.5_f32, COLOR_SIGNAL_TX));
        }

        // Current value tag point
        if let Some(&last_p) = points.last() {
            painter.circle_filled(last_p, 3.0, COLOR_SIGNAL_TX);
        }

        // Range readouts
        painter.text(
            Pos2::new(rect.min.x + 4.0, rect.min.y + 2.0),
            Align2::LEFT_TOP,
            format!("MAX: {:.2}", max_val),
            FontId::monospace(9.0),
            COLOR_TEXT_MUTED,
        );
        painter.text(
            Pos2::new(rect.min.x + 4.0, rect.max.y - 2.0),
            Align2::LEFT_BOTTOM,
            format!("MIN: {:.2}", min_val),
            FontId::monospace(9.0),
            COLOR_TEXT_MUTED,
        );
    }
}

/// Large high-contrast technical font value readout with unit and title.
pub fn render_numeric_card(ui: &mut egui::Ui, widget: &DashboardWidget) {
    ui.vertical(|ui| {
        ui.add_space(4.0);
        ui.horizontal(|ui| {
            ui.label(
                RichText::new(format!("{:.1}", widget.current_value))
                    .monospace()
                    .size(28.0)
                    .strong()
                    .color(COLOR_TEXT_PRIMARY),
            );
            ui.vertical(|ui| {
                ui.add_space(8.0);
                ui.label(
                    RichText::new(&widget.unit)
                        .monospace()
                        .strong()
                        .size(13.0)
                        .color(COLOR_SIGNAL_TX),
                );
            });
        });
        ui.add_space(4.0);
        ui.label(
            RichText::new("TELEMETRY CHANNEL NOMINAL")
                .monospace()
                .small()
                .color(COLOR_SIGNAL_RX),
        );
    });
}

/// Dispatch rendering for an individual widget content area.
pub fn render_widget(ui: &mut egui::Ui, widget: &DashboardWidget) {
    match widget.widget_type {
        WidgetType::RadialGauge { .. } => render_radial_gauge(ui, widget),
        WidgetType::BarMeter { .. } => render_bar_meter(ui, widget),
        WidgetType::StatusLed { .. } => render_status_led(ui, widget),
        WidgetType::RollingChart { .. } => render_rolling_chart(ui, widget),
        WidgetType::NumericCard => render_numeric_card(ui, widget),
    }
}

/// Render a single widget inside an enclosed card container with header and subtle delete button.
/// Returns `true` if the delete button was clicked.
pub fn render_widget_card(ui: &mut egui::Ui, widget: &DashboardWidget) -> bool {
    let mut delete_clicked = false;
    egui::Frame::NONE
        .fill(COLOR_SURFACE_CARD)
        .stroke(Stroke::new(1.0_f32, COLOR_BORDER_HAIRLINE))
        .corner_radius(CornerRadius::same(4))
        .inner_margin(egui::Margin::same(10))
        .show(ui, |ui| {
            ui.horizontal(|ui| {
                ui.label(
                    RichText::new(&widget.title)
                        .strong()
                        .color(COLOR_TEXT_PRIMARY),
                );
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if ui
                        .small_button(RichText::new("×").strong().color(COLOR_TEXT_MUTED))
                        .clicked()
                    {
                        delete_clicked = true;
                    }
                    ui.label(
                        RichText::new(format!("[{}]", widget.bound_signal))
                            .monospace()
                            .small()
                            .color(COLOR_TEXT_MUTED),
                    );
                });
            });
            ui.add_space(6.0);
            render_widget(ui, widget);
        });
    delete_clicked
}

/// Parse IMU telemetry key-value tokens from a line e.g. `[IMU] ax=+0.12 ay=-0.05 az=+0.98 ... temp=36.5C`.
pub fn parse_imu_line(line: &str, signals: &mut HashMap<String, f32>) {
    for part in line.split_whitespace() {
        if let Some((k, v)) = part.split_once('=') {
            let key = k.trim().to_lowercase();
            let clean_v = v.trim_end_matches(|c: char| {
                c == 'C' || c == 'c' || c == 'V' || c == 'v' || c == 'g' || c == 'G' || c == ','
            });
            if let Ok(val) = clean_v.parse::<f32>() {
                signals.insert(key, val);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_dashboard_structure() {
        let dash = default_dashboard();
        assert_eq!(dash.widgets.len(), 7);

        // Check specific instruments
        assert_eq!(dash.widgets[0].title, "Motor Speed");
        assert_eq!(dash.widgets[0].bound_signal, "rpm");
        assert_eq!(dash.widgets[0].unit, "RPM");

        assert_eq!(dash.widgets[1].title, "Core Temperature");
        assert_eq!(dash.widgets[1].bound_signal, "temp");
        assert_eq!(dash.widgets[1].unit, "°C");

        assert_eq!(dash.widgets[2].title, "Bus Voltage");
        assert_eq!(dash.widgets[2].bound_signal, "volts");

        assert_eq!(dash.widgets[3].title, "Sync Lock");
        assert_eq!(dash.widgets[3].bound_signal, "sync");

        assert_eq!(dash.widgets[4].title, "Fault Trigger");
        assert_eq!(dash.widgets[4].bound_signal, "fault");

        assert_eq!(dash.widgets[5].title, "Z-Axis Acceleration");
        assert_eq!(dash.widgets[5].bound_signal, "az");

        assert_eq!(dash.widgets[6].title, "Stream Throughput");
        assert_eq!(dash.widgets[6].bound_signal, "rate");
    }

    #[test]
    fn test_update_signals() {
        let mut dash = default_dashboard();
        let mut signals = HashMap::new();
        signals.insert("rpm".to_string(), 8500.0);
        signals.insert("temp".to_string(), 48.2);
        signals.insert("volts".to_string(), 28.5);
        signals.insert("sync".to_string(), 0.0);
        signals.insert("az".to_string(), 1.05);

        dash.update_signals(&signals);

        assert_eq!(dash.widgets[0].current_value, 8500.0);
        assert_eq!(dash.widgets[1].current_value, 48.2);
        assert_eq!(dash.widgets[2].current_value, 28.5);
        assert_eq!(dash.widgets[3].current_value, 0.0);
        assert_eq!(dash.widgets[5].current_value, 1.05);

        // Check RollingChart history append
        if let WidgetType::RollingChart { ref history, .. } = dash.widgets[5].widget_type {
            assert_eq!(*history.last().unwrap(), 1.05);
        } else {
            panic!("Expected RollingChart widget type");
        }
    }

    #[test]
    fn test_rolling_chart_max_points_limit() {
        let mut dash = DashboardManager::new();
        dash.add_widget(DashboardWidget {
            id: "chart_test".to_string(),
            title: "Test Chart".to_string(),
            unit: "".to_string(),
            bound_signal: "val".to_string(),
            widget_type: WidgetType::RollingChart {
                history: Vec::new(),
                max_points: 5,
            },
            current_value: 0.0,
        });

        for i in 1..=10 {
            let mut signals = HashMap::new();
            signals.insert("val".to_string(), i as f32);
            dash.update_signals(&signals);
        }

        if let WidgetType::RollingChart { ref history, max_points } = dash.widgets[0].widget_type {
            assert_eq!(history.len(), 5);
            assert_eq!(max_points, 5);
            assert_eq!(history, &[6.0, 7.0, 8.0, 9.0, 10.0]);
        } else {
            panic!("Expected RollingChart");
        }
    }

    #[test]
    fn test_add_and_remove_widget() {
        let mut dash = default_dashboard();
        let initial_count = dash.widgets.len();

        let new_w = DashboardWidget {
            id: "custom_meter".to_string(),
            title: "Custom Meter".to_string(),
            unit: "mA".to_string(),
            bound_signal: "current".to_string(),
            widget_type: WidgetType::BarMeter { min: 0.0, max: 500.0 },
            current_value: 120.0,
        };
        dash.add_widget(new_w);
        assert_eq!(dash.widgets.len(), initial_count + 1);

        dash.remove_widget(initial_count);
        assert_eq!(dash.widgets.len(), initial_count);

        // Safe out of bounds remove
        dash.remove_widget(999);
        assert_eq!(dash.widgets.len(), initial_count);
    }

    #[test]
    fn test_parse_imu_line() {
        let line = "[12:34:56.789] [IMU] ax=+0.12 ay=-0.05 az=+0.98 gx=+1.23 gy=-2.34 gz=+0.01 temp=36.5C";
        let mut signals = HashMap::new();
        parse_imu_line(line, &mut signals);

        assert_eq!(signals.get("ax"), Some(&0.12));
        assert_eq!(signals.get("ay"), Some(&-0.05));
        assert_eq!(signals.get("az"), Some(&0.98));
        assert_eq!(signals.get("gx"), Some(&1.23));
        assert_eq!(signals.get("gy"), Some(&-2.34));
        assert_eq!(signals.get("gz"), Some(&0.01));
        assert_eq!(signals.get("temp"), Some(&36.5));
    }

    #[test]
    fn test_serde_dashboard() {
        let dash = default_dashboard();
        let json = serde_json::to_string(&dash).expect("Serialization failed");
        let deserialized: DashboardManager = serde_json::from_str(&json).expect("Deserialization failed");
        assert_eq!(dash, deserialized);
    }
}
