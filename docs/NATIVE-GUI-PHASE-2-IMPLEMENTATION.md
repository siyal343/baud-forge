# Native Windows GUI (bforge-gui) Phase 2 Implementation Record

## 1. Executive Summary

Phase 2 connects the new native Windows GUI (`crates/bforge-gui`) directly to hardware COM ports, background streaming threads, and the live serial data pump. It introduces zero-state onboarding for new microcontroller users, auto-baud and framing detection, live virtualized serial logging, packet byte inspector integration, and bidirectional command transmission.

## 2. Implemented Subsystems

1. **Hardware COM Port Discovery & Auto-Sniffer (`crates/bforge-gui/src/hardware.rs`):**
   - Enumerates physical Windows COM ports using `serialport::available_ports()`.
   - Extracts USB hardware identity: Vendor ID (VID), Product ID (PID), serial number, manufacturer (e.g. STMicroelectronics, FTDI, Silicon Labs), and product description.
   - Provides virtual loopback simulator fallback when no physical hardware is plugged in.
   - Implemented `sniff_port_baud_and_framing()`:
     - Probes candidate baud rates (`[115200, 9600, 921600, 460800, 230400, 57600]`) with 100ms timeouts.
     - Automatically classifies payload framing into Line-Delimited (`\n`), COBS (`0x00`), or Raw Stream.

2. **Onboarding & Welcome Hub (`crates/bforge-gui/src/tabs/mod.rs`):**
   - Three structured engineering cards:
     - **Hardware Connection Card:** Port ComboBox with manufacturer chip names, scan refresh button, baud rate button grid (`[9600]`, `[115200]`, `[230400]`, `[460800]`, `[921600]`, `[2000000]`, and custom entry), framing selector, green "Connect Microcontroller" action, and "Auto-Detect (Sniff)" button.
     - **Simulator & Demos Card:** 1-click launch of the synthetic 9-DoF IMU loopback simulator with workspace preset selection.
     - **Quick Jump Cards:** Direct links to Protocol Dissector Lab, Telemetry Oscilloscope, HIL Rig, and Vault Scrubber.

3. **Background Serial Streaming & Pump (`crates/bforge-gui/src/session.rs`):**
   - `SessionController` runs background pumping threads isolated from the UI:
     - **Hardware Mode:** Opens COM port with 50ms read timeout, parses incoming stream into framed lines and raw byte chunks, and computes rolling throughput statistics.
     - **IMU Demo Mode:** Simulates a 9-DoF IMU telemetry generator at 50Hz (accelerometer, gyroscope, quaternion, temperature, Castagnoli CRC32, `0xBA 0xDE` sync word). Responds to simulated TX commands (`AT+PING`, `AT+STATUS`, `AT+RESET`).
   - Crossbeam event loop dispatching `RxEvent` (`Line`, `Bytes`, `Stats`, `Connected`, `Disconnected`, `Error`) to GUI.
   - Capped 5,000-line memory ring for `SerialMonitor` with pause and autoscroll lock.
   - Updates `HexInspector` with live byte chunks and highlights.

4. **Bidirectional Command Console (`crates/bforge-gui/src/tabs/mod.rs` & `session.rs`):**
   - Transmit Console sends commands via background channel.
   - Supports ASCII mode with customizable line endings (None, LF, CR, CRLF) and raw HEX byte array mode with byte validation.
   - Command history and macro quick-send buttons.

5. **Top & Bottom Status Bars (`crates/bforge-gui/src/app.rs`):**
   - Live hardware status indicator: Connected port name, baud rate, framing format, RX/TX byte counters, and packets per second ticker.
   - Disconnect buttons in both top panel and bottom status bar.

## 3. Verification

- `cargo test -p bforge-gui`: 12/12 unit tests passed.
- `cargo check --workspace`: 100% pass across all workspace crates.
- `cargo build -p bforge-gui`: Succeeded in 4.12s.
- `target/debug/bforge-gui.exe`: Verified clean process startup, runtime execution, and clean termination by PID.
