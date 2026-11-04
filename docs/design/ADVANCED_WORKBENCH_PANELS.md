# BaudForge Workstation — Advanced Engineering Panels

This document describes the three advanced engineering panels added to the BaudForge workstation:
1. **Semantic Session Diff Panel** (`SessionDiffView`)
2. **Timed Pin Sequencer Panel** (`PinSequencerView`)
3. **Hardware-in-the-Loop Fault Rig Panel** (`FaultRigView`)

All three tools integrate directly into the Dockview workspace shell and bind to backend contracts in `crates/bforge-core/src/serve.rs`.

---

## 1. Semantic Session Diff Panel (`specs/0050`, `specs/0057`)

### Purpose
Compares two binary `.bflog` session vault recordings (a golden baseline capture versus an anomalous test run) to identify regressions, diverged fields, and dropped frames.

### Frontend Component
- File: [`ui/src/components/SessionDiffView.tsx`](file:///f:/Datapack/Personal/Programa/baud-forge/ui/src/components/SessionDiffView.tsx)
- Location: Tabbed inside the lower-right inspector pane alongside `Canonical Hex & ASCII`.

### Features
- **File Selectors & Presets:** Quick-select fields for Vault A and Vault B with instant buttons for demo comparisons (e.g., `imu-assert.bflog` vs `s6-COM8.bflog`).
- **Summary Metrics Tiles:** Displays record count, frame count, missing frames, and first divergence index.
- **First Divergence Alert:** Callout banner identifying the exact record number, reason, and field where the two sessions diverged.
- **Changed Fields Table:** Shows field name, occurrence count, sample value in baseline (A), and sample value in test (B).
- **Backend Seam:** Binds to `GET /api/diff?a=<path>&b=<path>`, backed by `crate::diff::diff_vaults`.

---

## 2. Timed Pin Sequencer Panel (`specs/0052`, `specs/0057`)

### Purpose
Controls hardware modem lines (DTR and RTS) and executes timed pulse transitions with millisecond and microsecond accuracy on the engine reader thread.

### Frontend Component
- File: [`ui/src/components/PinSequencerView.tsx`](file:///f:/Datapack/Personal/Programa/baud-forge/ui/src/components/PinSequencerView.tsx)
- Location: Tabbed inside the bottom workstation strip alongside `Telemetry Oscilloscope` and `Command Forge`.

### Features
- **Direct Tactile Toggles:** Independent manual assert and deassert switches for DTR and RTS lines.
- **One-Click Reset Pulse:** Triggers a 100 ms hardware reset pulse.
- **Preset Hardware Macros:**
  - *ESP32 ROM Bootloader:* `DTR=0, RTS=1 (50ms) -> DTR=1, RTS=0 (50ms) -> DTR=1, RTS=1 (20ms)`.
  - *STM32 NRST Reset:* `DTR=1, RTS=1 (100ms) -> DTR=1, RTS=0 (50ms)`.
- **Custom Sequence Step Table:** Allows users to add, edit, reorder, or delete custom `(DTR, RTS, wait_ms)` sequence steps and dispatch them in one atomic execution.
- **Backend Seam:** Binds to `POST /api/pins`, backed by `session.run_pin_sequence`.

---

## 3. Hardware-in-the-Loop Fault Rig Panel (`specs/0022`)

### Purpose
Controls live synthetic hardware mutation, line noise injection, packet drops, checksum corruption, and bus delay.

### Frontend Component
- File: [`ui/src/components/FaultRigView.tsx`](file:///f:/Datapack/Personal/Programa/baud-forge/ui/src/components/FaultRigView.tsx)
- Location: Tabbed inside the bottom workstation strip.

### Features
- **Master Safety Interlock:** High-visibility pulsing hazard banner. Faults cannot be transmitted unless explicitly armed.
- **Emergency Disarm Button:** Immediate "DISARM ALL FAULTS" button to instantly restore a clean communication link.
- **Primitive Controls:**
  - *Bit Flip (BER):* Adjustable Bit Error Rate slider ($10^{-3}$ to $10^{-9}$).
  - *Packet Drop:* Configurable frame drop ratio stepper ($1 \text{ in } N$ frames).
  - *Corrupt CRC:* Inverts checksum bytes to verify receiver rejection logic.
  - *Truncate:* Cuts off frame tails after $N$ bytes to test parser timeouts.
  - *Bus Delay & Jitter:* Sliders for base synthetic delay ($0$ to $1000$ ms) and timing jitter ($\pm 200$ ms).
- **One-Shot Firmware Triggers:** Dispatches firmware-level fault bursts directly to the connected ESP32-C3 microcontroller.
- **Backend Seam:** Binds to `POST /api/fault`, backed by `session.arm_fault` and `session.disarm_fault`.
