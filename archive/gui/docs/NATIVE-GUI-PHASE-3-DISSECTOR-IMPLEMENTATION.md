# Native Windows GUI (bforge-gui) Phase 3 Implementation Record: Protocol Dissector Lab & Cross-Highlighting

## 1. Executive Summary

Phase 3 implements the Protocol Dissector Lab and Bidirectional Cross-Highlighting engine for the native Windows BaudForge GUI (`crates/bforge-gui`). It connects the structured framing decoder to the memory-mapped Hex Inspector, enabling real-time packet inspection, schema selection, CRC verification, and byte-range synchronization.

## 2. Implemented Subsystems

1. **Hardware Vendor/Product Recognition (`crates/bforge-gui/src/hardware.rs`):**
   - Implemented `identify_usb_device(vid, pid) -> Option<&'static str>` supporting:
     - `0x303A:0x1001` -> "Espressif ESP32-C3 USB JTAG/Serial"
     - `0x303A:0x1002` -> "Espressif ESP32-S3 USB JTAG/Serial"
     - `0x303A:*` -> "Espressif Device"
     - `0x0483:*` -> "STMicroelectronics STM32"
     - `0x10C4:*` -> "Silicon Labs CP210x"
     - `0x0403:*` -> "FTDI USB Serial"
     - `0x1A86:*` -> "WCH CH340/CH341"
     - `0x2E8A:*` -> "Raspberry Pi RP2040/RP2350"
     - `0x2341:*` -> "Arduino"
   - Enhanced `scan_available_ports()` to format clean display strings with identified chipset and `(VID:PID)` tags.
   - Enhanced `BaudForgeTabViewer::default()` to automatically select physical USB serial hardware when detected (`vid_pid.is_some()`).

2. **Protocol Dissector Engine (`crates/bforge-gui/src/dissect.rs`):**
   - Data structures:
     - `DecodedField`: Recursive node with `name`, `type_name`, `value_str`, `byte_offset`, `byte_len`, `children`.
     - `DecodedPacket`: Contains `schema_name`, `sync_valid`, `crc_valid`, `payload_len`, `fields`.
     - `DissectorSchema`: `BuiltinImu`, `CustomCHeader(String)`, `CustomProtobuf(String)`.
   - Built-in IMU 48-byte schema decoder:
     - Offset 0..2: `sync` (uint16_t, 0xBADE)
     - Offset 2..6: `seq` (uint32_t)
     - Offset 6..18: `accel` (struct Vec3f { float x, float y, float z })
     - Offset 18..30: `gyro` (struct Vec3f { float p, float q, float r })
     - Offset 30..42: `quat` (struct Quat4f { float w, float x, float y, float z })
     - Offset 42..44: `temp_raw` (int16_t / 100.0)
     - Offset 44..48: `crc32` (uint32_t, verified with CRC-32/Castagnoli or IEEE)
   - Custom C Header decoder:
     - Full AST compilation via `bforge-dissect` and sequential primitive parser fallback (`uint8`, `uint16`, `uint32`, `int8`, `int16`, `int32`, `float`, `double`).
   - Custom Protobuf wire decoder:
     - Varint, 32-bit float, 64-bit double, and length-delimited payload parser.

3. **Dissector Lab UI (`crates/bforge-gui/src/tabs/mod.rs`):**
   - Top bar schema buttons (`[Built-in IMU 9-DoF]`, `[Load C Header .h...]`, `[Load Protobuf...]`) integrated with native `rfd::FileDialog`.
   - Real-time status badges:
     - Sync word badge (`[SYNC 0xBADE OK]` in emerald or `[SYNC MISMATCH]` in rose).
     - CRC verification badge (`[CRC32 OK]` in `#10b981` emerald or `[CRC MISMATCH]` in `#f43f5e` rose).
     - Payload length badge.
   - Interactive recursive tree view:
     - Type names in muted slate, field names in bold text, values in `#06b6d4` cyan, byte offsets in monospace.
     - Hovering or clicking any field row dynamically updates `hex_highlight_range`.

4. **Memory-Mapped Hex Inspector Synchronization (`crates/bforge-gui/src/tabs/mod.rs`):**
   - 16-byte hex grid and ASCII column both support highlight ranges:
     - Highlighted bytes render with elevated background (`COLOR_SURFACE_CARD`), cyan border (`COLOR_SIGNAL_TX`), and bright text (`COLOR_TEXT_PRIMARY`).
   - Interactive byte selection:
     - Displays comprehensive byte inspection card: offset, hex, dec (u8 & i8), bin (8-bit), ascii, and decoded LE float32 / uint16 / uint32 values.

5. **Live Event Pump Integration (`crates/bforge-gui/src/app.rs`):**
   - Inbound `RxEvent::Bytes` updates `hex_data`, triggers packet decoding into `last_decoded_packet`, and increments packet counter.

## 3. Verification

- `cargo check -p bforge-gui`: Succeeded with 0 errors and 0 warnings.
- `cargo test -p bforge-gui`: 24/24 unit tests passed (including dissector tests and cross-highlight tests).
- `cargo test --workspace`: 100% test pass across all workspace crates.
