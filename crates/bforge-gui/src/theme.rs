use egui::{epaint::CornerRadius, Color32, Margin, Stroke, Vec2, Visuals};

pub const COLOR_BG_DEEP: Color32 = Color32::from_rgb(13, 15, 18);
pub const COLOR_SURFACE_ELEVATED: Color32 = Color32::from_rgb(20, 24, 29);
pub const COLOR_SURFACE_CARD: Color32 = Color32::from_rgb(28, 33, 40);
pub const COLOR_BORDER_HAIRLINE: Color32 = Color32::from_rgb(34, 41, 51);
pub const COLOR_TEXT_PRIMARY: Color32 = Color32::from_rgb(241, 245, 249);
pub const COLOR_TEXT_MUTED: Color32 = Color32::from_rgb(100, 116, 139);
pub const COLOR_SIGNAL_RX: Color32 = Color32::from_rgb(16, 185, 129);
pub const COLOR_SIGNAL_TX: Color32 = Color32::from_rgb(6, 182, 212);
pub const COLOR_SIGNAL_FAULT: Color32 = Color32::from_rgb(244, 63, 94);
pub const COLOR_SIGNAL_TRIGGER: Color32 = Color32::from_rgb(245, 158, 11);

pub fn apply_theme(ctx: &egui::Context) {
    let mut visuals = Visuals::dark();
    visuals.panel_fill = COLOR_BG_DEEP;
    visuals.window_fill = COLOR_SURFACE_ELEVATED;
    visuals.extreme_bg_color = COLOR_BG_DEEP;
    visuals.faint_bg_color = COLOR_SURFACE_ELEVATED;
    visuals.code_bg_color = COLOR_SURFACE_ELEVATED;

    let hairline = Stroke::new(1.0_f32, COLOR_BORDER_HAIRLINE);
    let corner_4 = CornerRadius::same(4);

    visuals.window_stroke = hairline;
    visuals.window_corner_radius = corner_4;
    visuals.menu_corner_radius = corner_4;

    visuals.widgets.noninteractive.bg_fill = COLOR_SURFACE_CARD;
    visuals.widgets.noninteractive.bg_stroke = hairline;
    visuals.widgets.noninteractive.fg_stroke = Stroke::new(1.0_f32, COLOR_TEXT_PRIMARY);
    visuals.widgets.noninteractive.corner_radius = corner_4;

    visuals.widgets.inactive.bg_fill = COLOR_SURFACE_ELEVATED;
    visuals.widgets.inactive.bg_stroke = hairline;
    visuals.widgets.inactive.fg_stroke = Stroke::new(1.0_f32, COLOR_TEXT_MUTED);
    visuals.widgets.inactive.corner_radius = corner_4;

    visuals.widgets.hovered.bg_fill = COLOR_SURFACE_CARD;
    visuals.widgets.hovered.bg_stroke = Stroke::new(1.0_f32, COLOR_TEXT_MUTED);
    visuals.widgets.hovered.fg_stroke = Stroke::new(1.0_f32, COLOR_TEXT_PRIMARY);
    visuals.widgets.hovered.corner_radius = corner_4;

    visuals.widgets.active.bg_fill = COLOR_SURFACE_CARD;
    visuals.widgets.active.bg_stroke = Stroke::new(1.0_f32, COLOR_SIGNAL_TX);
    visuals.widgets.active.fg_stroke = Stroke::new(1.0_f32, COLOR_TEXT_PRIMARY);
    visuals.widgets.active.corner_radius = corner_4;

    visuals.widgets.open.bg_fill = COLOR_SURFACE_CARD;
    visuals.widgets.open.bg_stroke = hairline;
    visuals.widgets.open.fg_stroke = Stroke::new(1.0_f32, COLOR_TEXT_PRIMARY);
    visuals.widgets.open.corner_radius = corner_4;

    ctx.set_visuals(visuals);

    ctx.style_mut(|style| {
        style.spacing.item_spacing = Vec2::new(8.0_f32, 6.0_f32);
        style.spacing.button_padding = Vec2::new(6.0_f32, 4.0_f32);
        style.spacing.window_margin = Margin::same(8);
    });
}

pub fn dock_style(ctx: &egui::Context) -> egui_dock::Style {
    let mut style = egui_dock::Style::from_egui(&ctx.style());

    style.main_surface_border_stroke = Stroke::new(1.0_f32, COLOR_BORDER_HAIRLINE);
    style.main_surface_border_rounding = CornerRadius::same(4);

    // Separator line: 1.0px clean hairline
    style.separator.width = 1.0_f32;
    style.separator.color_idle = COLOR_BORDER_HAIRLINE;
    style.separator.color_hovered = COLOR_TEXT_MUTED;
    style.separator.color_dragged = COLOR_SIGNAL_TX;

    // Tab bar configuration
    style.tab_bar.bg_fill = COLOR_SURFACE_ELEVATED;
    style.tab_bar.hline_color = COLOR_BORDER_HAIRLINE;
    style.tab_bar.fill_tab_bar = true;

    // Tab interaction styles
    let corner_tab = CornerRadius {
        nw: 4,
        ne: 4,
        sw: 0,
        se: 0,
    };

    style.tab.hline_below_active_tab_name = true;
    style.tab.tab_body.bg_fill = COLOR_BG_DEEP;
    style.tab.tab_body.stroke = Stroke::new(1.0_f32, COLOR_BORDER_HAIRLINE);

    style.tab.active.bg_fill = COLOR_SURFACE_CARD;
    style.tab.active.text_color = COLOR_TEXT_PRIMARY;
    style.tab.active.outline_color = COLOR_BORDER_HAIRLINE;
    style.tab.active.corner_radius = corner_tab;

    style.tab.inactive.bg_fill = COLOR_SURFACE_ELEVATED;
    style.tab.inactive.text_color = COLOR_TEXT_MUTED;
    style.tab.inactive.outline_color = Color32::TRANSPARENT;
    style.tab.inactive.corner_radius = corner_tab;

    style.tab.focused.bg_fill = COLOR_SURFACE_CARD;
    style.tab.focused.text_color = COLOR_TEXT_PRIMARY;
    style.tab.focused.outline_color = COLOR_SIGNAL_TX;
    style.tab.focused.corner_radius = corner_tab;

    style.tab.hovered.bg_fill = COLOR_SURFACE_CARD;
    style.tab.hovered.text_color = COLOR_TEXT_PRIMARY;
    style.tab.hovered.outline_color = COLOR_BORDER_HAIRLINE;
    style.tab.hovered.corner_radius = corner_tab;

    // Close buttons configuration
    style.buttons.close_tab_color = COLOR_TEXT_MUTED;
    style.buttons.close_tab_active_color = COLOR_SIGNAL_FAULT;
    style.buttons.close_tab_bg_fill = Color32::TRANSPARENT;

    style
}
