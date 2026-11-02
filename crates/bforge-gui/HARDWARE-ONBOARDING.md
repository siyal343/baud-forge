# Hardware Scanner & Onboarding Wizard

## Summary

This document describes the Phase 2 hardware scanner and onboarding wizard for the native Windows BaudForge GUI.

## Components Implemented

### 1. Hardware Detection (`crates/bforge-gui/src/hardware.rs`)
- **`SerialPortInfo`**: Stores `port_name`, `display_name`, `manufacturer`, `product`, and formatted `vid_pid`.
- **`scan_available_ports()`**: Queries the host operating system with `serialport::available_ports()`. Extracts USB descriptors (VID, PID, manufacturer, product). Provides fallback to `COM-LOOPBACK` virtual HIL simulator when no physical hardware is connected.
- **`sniff_port_baud_and_framing(port_name)`**: Sequentially probes candidate baud rates (`[115200, 9600, 921600, 460800, 230400, 57600]`) with a 100 ms timeout. Reads up to 256 bytes and classifies framing format:
  - Line-Delimited (`\n` or `\r\n`)
  - COBS (`0x00` frame boundaries)
  - Raw Stream (binary payload)

### 2. Onboarding Wizard UI (`crates/bforge-gui/src/tabs/mod.rs`)
- Added state to `BaudForgeTabViewer`:
  - `available_ports`: Enumerated list of serial devices.
  - `selected_port_idx`: Active combo box selection index.
  - `selected_baud` & `custom_baud_str`: Configured baud rate with fast-select presets (`9600` to `2000000`) and custom numerical input.
  - `selected_framing`: Dropdown selector for framing conventions (`Line-Delimited`, `COBS`, `Length-Prefixed`, `Raw Binary Stream`).
  - `is_sniffing` & `sniff_result`: Background sniffer thread state with non-blocking crossbeam channel notifications.
- Integrated three UI cards with hairline borders and 4px corner rounding:
  - **Hardware Connection Card**: Port selection, baud grid, framing dropdown, primary connect button (`TabAction::StartHardwareSession`), and auto-detect sniffer trigger.
  - **Simulator & Demos Card**: One-click launch for simulated IMU loopback demo (`TabAction::LoadImuDemo`).
  - **Quick Jump Workspaces**: Preset activation for Protocol Lab, Scope, HIL Rig, and Diff & Vault.

### 3. Application Integration (`crates/bforge-gui/src/app.rs`)
- Added handler for `TabAction::StartHardwareSession` in `handle_tab_actions()`.
- Updates `session_status`, active `port_name`, `baud_rate`, and `framing_format` upon connection.

## Verification
- Unit tests: 8 passed (`hardware::tests::*`, `layout::tests::*`, `session::tests::*`).
- Compiler checks: `cargo check -p bforge-gui` completed with 0 errors and 0 warnings.
