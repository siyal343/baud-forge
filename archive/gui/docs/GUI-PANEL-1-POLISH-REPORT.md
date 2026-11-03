# Panel 1: Hardware Setup & Welcome Polish Report

Date: 2026-11-02  
Status: Completed & Verified  
Target Binary: `target/release/bforge-gui.exe` (v0.8.0)

---

## 1. Executive Summary

This report documents the UX, ergonomic, and architectural polish applied to **Panel 1: Hardware Setup & Welcome** in `crates/bforge-gui`. The update addresses asymmetric display dead space, removes redundant headers, adds physical microcontroller line controls (`DTR`, `RTS`, UART framing), and establishes a balanced two-column embedded workstation layout.

---

## 2. Layout & Ergonomic Improvements

### 2.1 Spatial Grid & Dead Space Resolution
* **Layout Structure:** Replaced single-column vertical stack with a balanced two-column grid using `ui.columns(2, ...)`.
* **Left Column (Physical Hardware Target):** Hosts serial port discovery, baud selection, UART framing (8N1), modem line control, and hardware session launch.
* **Right Column (Simulation & Session Vault):**
  * **Top Card:** Simulation & loopback demonstration rigs with a signal dataflow block diagram:
    `[Mock IMU] ──▶ [FIFO Loopback] ──▶ [Dissector]`
  * **Bottom Card:** Recent session vault files (`.bflog`) with file size, packet timestamp, one-click replay loader, and `Open Vault Directory` button.

### 2.2 Microcontroller Modem Line Controls (DTR / RTS)
* Added explicit toggle controls for `DTR (High)` and `RTS (High)`.
* **Rationale:** USB-to-UART bridges on targets such as the ESP32-C3 pull `CHIP_PU` and `GPIO9` during unmanaged DTR/RTS state transitions, forcing involuntary resets into download bootloader mode (`rst:0x15`). Explicit control protects running target firmware.

### 2.3 UART Framing Parameters
* Added selectors for:
  * **Data Bits:** 8, 7, 6, 5
  * **Parity:** None, Even, Odd, Mark, Space
  * **Stop Bits:** 1, 2
* Passed through `serialport::DataBits`, `serialport::Parity`, and `serialport::StopBits` in `SessionController::start_hardware`.

### 2.4 Streamlined Baud Selection
* Standard baud presets (`9600`, `115.2k`, `230.4k`, `460.8k`, `921.6k`, `2.0M`) render as quick-fill chips.
* Added a dedicated `Custom...` toggle button that exposes a numeric input field only when required, eliminating visual clutter.

### 2.5 Header & Workspace Deduplication
* Removed the redundant internal sub-header `[SETUP] HARDWARE ONBOARDING & SETUP` and isolated `STANDBY` pill. Panel tab title `Hardware Setup & Welcome` establishes context.
* Removed the bottom `QUICK JUMP WORKSPACES` card, as workspace presets already reside in the top navigation bar.

### 2.6 Component Refinements
* **Unified Port Selection Bar:** Placed a compact `⟳` refresh icon button directly beside the port `ComboBox`.
* **Device ID Badge:** Added monospace subtle text showing detected `VID:PID` (`303A:1001`) and manufacturer string.
* **Warning & Diagnostic Banner:** Enclosed auto-probe failure and success outputs inside styled `egui::Frame` containers with 1px border and amber/emerald color tokens.
* **Action Button Weights:** Configured `🔌 CONNECT DEVICE` with solid emerald fill and dark text; configured `🔍 Auto-Detect` with an outlined ghost style.

---

## 3. Verification & Measurements

| Metric | Measured Value | Status |
| :--- | :--- | :--- |
| Unit Test Suite | 45 passed; 0 failed | Pass (0.14 s measured) |
| Dev Check | Completed without warnings | Pass (1.77 s measured) |
| Release Build | Optimized `bforge-gui.exe` produced | Pass (108 s measured) |
| ESP32-C3 Target Response (`COM8`) | Active USB JTAG/Serial probed | Verified |
| Process Cleanup | Background test PID terminated | Clean |

---

## 4. Affected Source Files

* [`crates/bforge-gui/src/session.rs`](file:///f:/Datapack/Personal/Programa/baud-forge/crates/bforge-gui/src/session.rs): Added UART framing and DTR/RTS pin assertion to `start_hardware`.
* [`crates/bforge-gui/src/app.rs`](file:///f:/Datapack/Personal/Programa/baud-forge/crates/bforge-gui/src/app.rs): Bound tab viewer UART parameters to session launcher.
* [`crates/bforge-gui/src/tabs/mod.rs`](file:///f:/Datapack/Personal/Programa/baud-forge/crates/bforge-gui/src/tabs/mod.rs): Implemented 2-column layout, line controls, framing selectors, baud chips, and styled diagnostic frames.
