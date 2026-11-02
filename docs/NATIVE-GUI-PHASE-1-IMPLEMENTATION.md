# Native Windows GUI (bforge-gui) Phase 1 Implementation Record

## 1. Executive Summary

We developed the initial native Windows GUI crate (`crates/bforge-gui`) from the ground up, completely independent of the legacy Tauri/webview architecture. The application is built on `eframe` (0.31), `egui` (0.31), `egui_dock` (0.16), `egui_plot` (0.31), and DirectX 12 / Vulkan (`wgpu`).

## 2. Implemented Subsystems

1. **Theme & Visual System (`crates/bforge-gui/src/theme.rs`):**
   - Implemented dark technical palette based on `/emil-design-eng`:
     - Deep Obsidian Background: `#0d0f12`
     - Elevated Surface: `#14181d`
     - Card / Panel Surface: `#1c2128`
     - Hairline Border: `#222933` (1.0px stroke)
     - Text Primary: `#f1f5f9`, Text Muted: `#64748b`
     - Signals: RX `#10b981`, TX `#06b6d4`, Fault `#f43f5e`, Trigger `#f59e0b`
   - Configured `egui_dock::Style` with 1px separator lines, styled tab headers, and close buttons.

2. **Reconfigurable Layout Engine (`crates/bforge-gui/src/layout.rs`):**
   - Defined `TabId` enum with 10 distinct workbench panels:
     - `Welcome` (Onboarding, hardware auto-detect, quick connect)
     - `SerialMonitor` (Virtualized stream, search/filter, autoscroll)
     - `HexInspector` (16-byte memory grid, byte offsets, ASCII preview)
     - `TxConsole` (ASCII/HEX mode, command history, macros)
     - `ProtocolDissector` (Packet tree hierarchy, types, field decoders)
     - `TelemetryScope` (Real-time waveforms, timebase, trigger modes)
     - `Dashboards` (Dials, gauges, status LEDs, strip charts)
     - `HilBridge` (Dual-port routing, bit flip, drop, jitter injection)
     - `VaultScrubber` (Timeline playback, frame stepping)
     - `WorkspaceConfig` (Workspace TOML path, baud rate, export)
   - Layout preset constructors:
     - `default_tree()`: Microcontroller bring-up layout.
     - `protocol_lab_tree()`: Dissector & Hex inspector layout.
     - `telemetry_scope_tree()`: Real-time oscilloscope & dashboard layout.
     - `hil_rig_tree()`: HIL bridge & fault injection layout.
     - `comprehensive_tree()`: Full multi-pane workbench.
   - Persistence helpers targeting `%APPDATA%/BaudForge/dock_layout.json`.

3. **Tab Rendering System (`crates/bforge-gui/src/tabs/mod.rs`):**
   - Implemented `BaudForgeTabViewer` implementing `egui_dock::TabViewer<Tab = TabId>`.
   - Built full engineering panels for all 10 workbench tabs.

4. **Application Shell & Window Entry Point (`crates/bforge-gui/src/app.rs` & `main.rs`):**
   - `BaudForgeApp` implementing `eframe::App`.
   - Top Bar: Pulsing status LED, title, preset switch buttons, layout save/reset.
   - Bottom Bar: COM port indicator, baud rate, framing, RX/TX byte counters, vault status.
   - Central Panel: High-performance `egui_dock::DockArea`.
   - Native Windows window configuration (1280x800 default, 800x540 min, native borders, resizable).

## 3. Verification

- `cargo test -p bforge-gui`: 100% pass (2 unit tests).
- `cargo test --workspace`: 100% pass (0 failures across all crates).
- `cargo build -p bforge-gui`: Compiled native binary `target/debug/bforge-gui.exe`.
- Process execution test: Launched `target/debug/bforge-gui.exe`, verified running state, cleanly terminated by PID.
