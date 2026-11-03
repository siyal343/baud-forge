# Native Windows GUI (bforge-gui) Phase 3 Implementation Record

## 1. Executive Summary

Phase 3 introduces the **Protocol Dissector Lab**, **Bidirectional Hex Cross-Highlighting**, and **Dynamic Declarative Dashboards** to the native Windows BaudForge GUI (`crates/bforge-gui`). It also enhances the hardware scanner with USB vendor recognition (automatically identifying and pre-selecting the user's connected **Espressif ESP32-C3** on `COM8`).

## 2. Implemented Subsystems

1. **Hardware Recognition for ESP32-C3 (`crates/bforge-gui/src/hardware.rs`):**
   - Added `identify_usb_device()` to map USB VID/PID pairs to chip family names:
     - `0x303A:0x1001` -> **Espressif ESP32-C3 USB JTAG/Serial**
     - `0x303A:0x1002` -> **Espressif ESP32-S3 USB JTAG/Serial**
     - `0x0483:*` -> **STMicroelectronics STM32**
     - `0x10C4:*` -> **Silicon Labs CP210x**
     - `0x0403:*` -> **FTDI USB Serial**
     - `0x1A86:*` -> **WCH CH340/CH341**
     - `0x2E8A:*` -> **Raspberry Pi RP2040/RP2350**
   - In `BaudForgeTabViewer::default()`, automatically selects the connected physical USB port (`COM8`) instead of passive Bluetooth virtual ports.

2. **Protocol Dissector Lab Engine (`crates/bforge-gui/src/dissect.rs`):**
   - Data structures: `DecodedField`, `DecodedPacket`, and `DissectorSchema` (`BuiltinImu`, `CustomCHeader`, `CustomProtobuf`).
   - Built-in 48-byte IMU schema: Decodes sync word (`0xBADE`), sequence counter, 3-axis accelerometer (`ax`, `ay`, `az`), 3-axis gyroscope (`gx`, `gy`, `gz`), 4D quaternion orientation (`qw`, `qx`, `qy`, `qz`), raw temperature (`temp_raw`), and CRC32 (Castagnoli / IEEE verification).
   - Custom C Header parser: Parses external `.h` struct files via `bforge-dissect` and decodes primitive types (`uint8`..`uint32`, `int8`..`int32`, `float`, `double`).
   - Protobuf wire decoder: Decodes varints, 32-bit floats, 64-bit doubles, and length-delimited payloads.

3. **Synchronized Cross-Highlighting (`crates/bforge-gui/src/tabs/mod.rs`):**
   - In `render_protocol_dissector`:
     - Schema selector buttons (`[Built-in IMU 9-DoF]`, `[Load C Header .h...]`, `[Load Protobuf...]`) with file picker.
     - Live CRC verification badge (`[CRC32 OK]` in emerald `#10b981` or `[CRC MISMATCH]` in rose `#f43f5e`).
     - Collapsible recursive tree view showing field name, type, byte offset range, and decoded value.
     - Hovering or clicking any field row sets `hex_highlight_range`.
   - In `render_hex_inspector`:
     - Highlighted byte spans render with an elevated card background, cyan border (`COLOR_SIGNAL_TX`), and bright text in both the 16-byte hex matrix and ASCII column.
     - Clicking a byte shows detailed inspect metrics (offset, hex, decimal, binary, ascii, float).

4. **Dynamic Declarative Dashboard Engine (`crates/bforge-gui/src/dashboard.rs`):**
   - `DashboardManager` with 7 pre-configured instruments:
     1. **Motor Speed:** Radial needle gauge (0..12000 RPM, warn 9000, crit 10500).
     2. **Core Temperature:** Linear bar meter (-20..100 °C).
     3. **Bus Voltage:** Linear bar meter (0..36 V).
     4. **Sync Lock:** Circular LED indicator.
     5. **Fault Trigger:** Circular LED indicator.
     6. **Z-Axis Acceleration:** Rolling trend chart (80 points history).
     7. **Stream Throughput:** Large numeric value card (packets/sec).
   - Custom `egui::Painter` renderers for needle dials with danger arcs, percentage bar fills, LED bulbs with bezel glow, and smooth line strip charts.
   - Dynamic binding: Binds widget values to telemetry signals (`ax`, `ay`, `az`, `temp`, `volts`, `rpm`, `rate`).
   - Interactive UI: Buttons to add widgets (`[+ Add Gauge]`, `[+ Add Meter]`, `[+ Add LED]`, `[+ Add Trend Chart]`), individual delete `[×]` buttons, and reset layout.

## 3. Verification

- `cargo test -p bforge-gui`: 24/24 unit tests passed.
- `cargo check --workspace`: 100% pass across all workspace crates.
- `cargo build -p bforge-gui`: Succeeded in 4.67s.
- `target/debug/bforge-gui.exe`: Verified clean process startup (PID 16380) and termination.
- Physical Hardware: Verified USB vendor detection recognizes user's ESP32-C3 on `COM8` (`VID 303A, PID 1001`).
