# HIL Bridge, Fault Rig & Vault Scrubber Architecture

This document specifies the Phase 4 implementation of Hardware-In-The-Loop (HIL) bridging, real-time fault injection, and session vault playback.

## 1. Components

### 1.1 HIL Bridge State (`crates/bforge-gui/src/hil.rs`)
- **Port Routing Matrix**: Bridges bidirectional serial communications between Port A (DUT Target) and Port B (HIL Simulator).
- **Traffic Accounting**: Tracks packets bridged from A to B, B to A, and total byte throughput.
- **Fault Injection Engine**:
  - Bit Error Rate (BER) logarithmic injection.
  - Packet drop ratio (0.0 to 1.0).
  - Jitter latency simulation (0 ms to 500 ms).
  - Byte truncation (0 to 64 bytes).
  - CRC32 checksum inversion.
  - Arm/Disarm safety toggle.
- **Hardware Pin Telemetry**:
  - Assertable output pins: RTS (Request to Send) and DTR (Data Terminal Ready).
  - Detectable input pins: CTS, DSR, DCD, and RI with circular LED bulbs.

### 1.2 Vault Manager (`crates/bforge-gui/src/vault.rs`)
- **Live Recording**:
  - Streams captured frames to `.bflog` append-only files.
  - Records byte counters, frame counts, and elapsed session duration.
- **Interactive Timeline Scrubber**:
  - Frame-indexed scrubber with progress slider.
  - Playback controls: First, Step Back, Play/Pause, Step Forward, Last.
  - Variable speed selection (0.25x to 5.0x) and loop toggle.
  - Active frame byte inspection.
- **Session Diff Comparator**:
  - Dual `.bflog` comparator with baseline and comparison file selection.
  - Automatic divergence detection for checksum mismatches, timing jitter, sequence drops, and length truncations.

## 2. Integration & Verification

- Expose modules `pub mod hil;` and `pub mod vault;` in `crates/bforge-gui/src/lib.rs`.
- Delegate tab renders in `BaudForgeTabViewer` to `self.hil.show(ui)` and `self.vault.show(ui)`.
- Verified with unit test suites in `hil::tests` and `vault::tests`.
