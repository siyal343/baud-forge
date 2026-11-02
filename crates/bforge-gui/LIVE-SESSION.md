# BaudForge Live Session Pump & Real-Time Streaming Architecture

## 1. Overview
This document specifies the background pump architecture and real-time streaming pump for the BaudForge native Windows GUI (`crates/bforge-gui`).

## 2. Session Controller (`crates/bforge-gui/src/session.rs`)
The session controller isolates serial hardware communication and real-time synthesis from the egui render thread.

### Channels & Synchronization
- `tx_sender: crossbeam_channel::Sender<TxCommand>`: Enqueues outbound commands from GUI tabs.
- `rx_receiver: crossbeam_channel::Receiver<RxEvent>`: Receives inbound telemetry lines, raw byte chunks, telemetry statistics, and status events.
- `stop_flag: Arc<AtomicBool>`: Cooperative cancellation signal checked every loop iteration.
- `thread_handle: Option<JoinHandle<()>>`: Clean thread join during explicit stop or struct drop.

### Data Types
- `LineEnding`: None, LF (`\n`), CR (`\r`), CRLF (`\r\n`).
- `TxCommand`:
  - `Ascii(String, LineEnding)`: Encodes ASCII text with chosen line ending.
  - `Hex(Vec<u8>)`: Transmits raw byte sequence.
- `RxEvent`:
  - `Line(String)`: Formatted telemetry or command response string.
  - `Bytes(Vec<u8>)`: Sliced frame or raw chunk for hex inspector.
  - `Stats { rx_bytes, tx_bytes, packets_per_sec }`: Rolling telemetry throughput.
  - `Connected { port, baud }`: Connection acknowledgement.
  - `Disconnected(String)`: Disconnect lifecycle event.
  - `Error(String)`: Hardware or I/O error notification.

## 3. Streaming Engines

### 3.1 Serial Hardware Pump (`SessionController::start_hardware`)
- Opens native Windows serial port with 50ms timeout.
- Polls incoming bytes into an accumulator buffer.
- Slices payloads according to configured framing:
  - Line-delimited: extracts on `\n`, strips carriage returns.
  - COBS: extracts on `0x00` delimiter byte.
  - Length-prefix: reads 2-byte big-endian header and payload length.
  - Raw stream: slices contiguous 64-byte chunks.
- Writes queued `TxCommand` payloads and flushes immediately.
- Calculates and emits rolling packets/sec and byte counters.

### 3.2 Synthetic 9-DoF IMU Loopback Generator (`SessionController::start_imu_demo`)
- Runs a 50Hz (20ms) loop generating synthetic aerospace IMU telemetry.
- Synthesizes 3-axis accelerometer (`ax, ay, az`), 3-axis gyroscope (`gx, gy, gz`), 4-element quaternion (`qw, qx, qy, qz`), and temperature (`temp`).
- Emits formatted telemetry line:
  `"[HH:MM:SS.mmm] [IMU] ax=... ay=... az=... gx=... gy=... gz=... temp=...C"`.
- Assembles 58-byte binary packets with sync word `0xBA 0xDE` and Castagnoli CRC32 (`bforge_framer::checksum::crc32c`).
- Responds to interactive AT commands:
  - `AT+PING` -> `OK:PONG`
  - `AT+STATUS` -> `IMU_ONLINE: BNO085 9-DoF 50Hz CALIBRATED`
  - `AT+RESET` -> soft-reset acknowledgment.

## 4. UI Integration (`crates/bforge-gui/src/app.rs` & `tabs/mod.rs`)
- `BaudForgeApp::update`:
  - Drains `poll_events()` non-blockingly each frame.
  - Caps serial monitor log buffer at 5,000 entries with automatic scroll.
  - Updates hex inspector data with latest byte packets.
  - Updates telemetry status counters and status pill in top and bottom panels.
  - Drains `pending_tx` from `TxConsole` and pushes to active session.
  - Requests continuous frame repaint (16ms) while session is active.
- Top bar and bottom bar include `⏹ Disconnect` controls to safely terminate threads.
- `TxConsole` supports ASCII with configurable EOL (CRLF, LF, CR, None) and HEX byte entry with syntax validation.

## 5. Verification
- All 12 unit tests in `bforge-gui` pass:
  - `session::tests::test_line_ending_bytes`
  - `session::tests::test_tx_command_serialization`
  - `session::tests::test_imu_demo_session_lifecycle`
  - `session::tests::test_process_rx_buffer_line`
  - `session::tests::test_process_rx_buffer_cobs`
  - `session::tests::test_process_rx_buffer_len_prefix`
  - `session::tests::test_start_hardware_invalid_port`
