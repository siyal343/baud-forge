# BaudForge GUI Archive

This directory contains all previously developed graphical user interface implementations and associated documentation for BaudForge.

Archived on: 2026-11-03  
Reason: Decoupling and archiving legacy/native UI codebases to present a clean, headless core engine for external UI design and integration.

---

## 1. Directory Contents

### 1.1 Source Code (`crates/` and `ui/`)
* **`crates/bforge-gui/`**:
  * Native desktop application built using Rust `eframe`, `egui`, `egui_dock`, and `egui_plot`.
  * Included 10 hardware-in-the-loop workbenches:
    1. Hardware Setup & Welcome
    2. Serial Monitor & Hex Inspector
    3. Protocol Dissector Lab
    4. Declarative Dashboard
    5. Telemetry Oscilloscope
    6. HIL Bridge & MITM Rig
    7. Fault Injection Rig
    8. Session Vault Scrubber
    9. Firmware Symbol & Struct Inspector
    10. Terminal Console & Command Runner
* **`crates/bforge-gui-legacy/`**:
  * Earlier desktop prototype based on Tauri v2 (`src-tauri`).
* **`ui/`**:
  * SolidJS / TypeScript / Tailwind / Vite web interface previously hosted inside Tauri.

### 1.2 Test Scripts (`scripts/`)
* **`scripts/test_gui_release.py`**:
  * Subprocess lifecycle and smoke test runner for `bforge-gui.exe`.

### 1.3 Documentation (`docs/`)
* Comprehensive collection of GUI architectural plans, implementation reports, panel specifications, and usability evaluations:
  * `ALL-WORKBENCHES-ONBOARDING-IMPLEMENTATION.md`
  * `ALL-WORKBENCHES-ONBOARDING-PLAN.md`
  * `APPEARANCE-SETTINGS.md`
  * `CONSOLE-TX-IMPLEMENTATION.md`
  * `DOCK-ENGINE.md`
  * `GUI-PANEL-1-POLISH-REPORT.md`
  * `GUI-SETUP.md`
  * `IN-UI-FRAMING-AND-WORKSPACE-EXPORT.md`
  * `MICROCONTROLLER-UX-IMPLEMENTATION.md`
  * `NATIVE-GUI-PHASE-1-IMPLEMENTATION.md` through `NATIVE-GUI-PHASE-5-IMPLEMENTATION.md`
  * `NEW-WINDOWS-GUI-PLAN.md`
  * `RECONFIGURABLE-UI-PLAN.md`
  * `UI-FUNCTIONAL-SEPARATION.md`
  * `UI-REDESIGN-PLAN.md`
  * `UX-ONBOARDING-ANALYSIS.md`
  * `WINDOW-AND-LAUNCHER-FIXES.md`
  * `screenshots/`: Visual captures of the GUI workbenches.

---

## 2. Restoration & Revival

To restore the native GUI into the active workspace:
1. Move `archive/gui/crates/bforge-gui` back to `crates/bforge-gui`.
2. Re-add `"crates/bforge-gui"` to `members` in the root `Cargo.toml`.
3. Run `cargo build -p bforge-gui`.
