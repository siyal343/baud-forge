# Native Windows GUI (bforge-gui) Phase 4 Implementation Record

## 1. Executive Summary

Phase 4 implements the deep engineering workbenches for the native Windows GUI (`crates/bforge-gui`):
- **Real-Time Telemetry Oscilloscope (`egui_plot`):** 4-channel live waveforms, hardware triggers, and live delta-T / delta-V cursor measurements.
- **Hardware-in-the-Loop (HIL) Bridge & Fault Injection Rig:** Dual-port bridge routing, bit error rate (BER), packet drop ratio, latency jitter, byte truncation, CRC corruption, and hardware RTS/DTR/CTS pin controls.
- **Vault Scrubber, Playback & Session Diff:** 1-click recording to `.bflog` binary capture files, interactive timeline scrubber with speed multiplier, and side-by-side session diff comparator.

## 2. Implemented Subsystems

1. **Telemetry Oscilloscope Engine (`crates/bforge-gui/src/scope.rs`):**
   - 4 independent channels with custom colors:
     - `CH1`: Accel X (`COLOR_SIGNAL_TX` cyan, bound to `ax`)
     - `CH2`: Accel Y (`COLOR_SIGNAL_RX` emerald, bound to `ay`)
     - `CH3`: Accel Z (`COLOR_SIGNAL_TRIGGER` amber, bound to `az`)
     - `CH4`: Gyro Z (`COLOR_SIGNAL_FAULT` rose, bound to `gz`)
   - High-throughput 5,000-point rolling buffers per channel.
   - Hardware trigger engine: Auto, Normal, Single modes; Rising/Falling edge detection; adjustable threshold level with visual dashed marker line.
   - Live automated measurements: $V_{pp}$, $V_{rms}$, min, max, mean, and frequency ($f$) estimation.
   - Integrated cursor markers: Vertical ($X_1, X_2$) and horizontal ($Y_1, Y_2$) cursor measurement readouts ($\Delta t$, $\Delta V$, $1/\Delta t$).
   - Right-side telemetry readout panel (180px) displaying real-time signal statistics.

2. **HIL Bridge & Fault Injection Rig (`crates/bforge-gui/src/hil.rs`):**
   - Dual-Port Bridge routing card: Select Port A and Port B, toggle bridge state, live bridged packet and byte counters.
   - Live Fault Injection Rig card:
     - Bit Error Rate (BER) slider with logarithmic scaling ($10^{-6}$ to $10^{-1}$).
     - Packet Drop ratio percentage slider ($0\%$ to $100\%$).
     - Latency Jitter slider ($0\text{ ms}$ to $500\text{ ms}$).
     - Byte truncation slider and CRC corruption checkbox.
     - Arm/Disarm toggle with visual indicator.
   - Hardware Pin Controls card:
     - Output pins: Toggle buttons for `RTS` (Request to Send) and `DTR` (Data Terminal Ready).
     - Input status pins: Glowing circular LED indicators for `CTS`, `DSR`, `DCD`, and `RI`.

3. **Vault Recorder, Scrubber & Session Diff (`crates/bforge-gui/src/vault.rs`):**
   - Recording card: Start/Stop recording toggle, live capture file size, frame counter, and elapsed time.
   - Playback Scrubber card:
     - Timeline slider scrubbing from frame 0 to total frames.
     - Play, Pause, Step Forward, Step Backward, Loop, and playback speed multiplier ($0.5\times$, $1.0\times$, $2.0\times$).
   - Session Diff Comparator card:
     - Compare baseline `.bflog` against target `.bflog`.
     - Anomaly detection table listing timestamp jitter, field value divergences, and dropped frames.

4. **Workbench Integration (`crates/bforge-gui/src/tabs/mod.rs` & `app.rs`):**
   - Delegated `render_telemetry_scope` to `ScopeManager::show`.
   - Delegated `render_hil_bridge` to `HilBridgeState::show`.
   - Delegated `render_vault_scrubber` to `VaultManager::show`.
   - Connected live telemetry streams in `BaudForgeApp::update` to push data into `ScopeManager` at 60/144 FPS.

## 3. Verification

- `cargo test -p bforge-gui`: 41/41 unit tests passed.
- `cargo check --workspace`: 100% pass across all workspace crates.
- `cargo build -p bforge-gui`: Compiled native binary `target/debug/bforge-gui.exe`.
- Process launch test: Ran `target/debug/bforge-gui.exe` (PID 14076) and confirmed clean startup and termination.
