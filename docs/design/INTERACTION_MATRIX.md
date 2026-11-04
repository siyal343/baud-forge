# BaudForge Interaction Matrix & Signature Workflows

Document Version: 1.0.0  
Status: Authoritative Interaction Specification  
Target: BaudForge Desktop Application  
References: `docs/UI-UX-DESIGNER-HANDOVER.md`, `specs/ADR & SRS.md`

---

## 1. Interaction Overview

The interaction architecture of BaudForge ensures that complex technical operations remain predictable, safe, and synchronized across all four operational instruments.

---

## 2. Signature Workflows

### 2.1 Workflow A: The Dissector-to-Hex Cross-Highlight
* **Objective:** Enable instant visual correlation between structured protocol fields and physical payload bytes.
* **Actor:** Embedded Firmware or Protocol Engineer.
* **Trigger Event:** User clicks or hovers over a field node in the **Protocol Dissector Tree** (e.g. `gyro_z = -0.042`).
* **System Execution Sequence:**
  1. The Dissector Tree records the selected field's byte offset range (e.g. `Offset: 10..14 (4 bytes)`).
  2. The **Canonical Hex Inspector** receives the active range event.
  3. The 4 corresponding hexadecimal byte pairs in the 16-byte grid illuminate with an electric cyan background (`#00E5FF33`) and a solid 1px cyan outline.
  4. The ASCII representation gutter reflects the highlighted character positions.
  5. A subtle tooltip displays next to the cursor: `Offset: 0x0A..0x0D (4 bytes) | Type: float32_le | Value: -0.042 rad/s`.
  6. Context menu action provides: `📈 Plot gyro_z in Telemetry Oscilloscope`.

### 2.2 Workflow B: Oscilloscope-to-Frame DVR Synchronization
* **Objective:** Trace an electrical or telemetry waveform anomaly directly back to the software packet and raw bytes that caused it.
* **Actor:** Hardware Test / Validation Engineer.
* **Trigger Event:** User clicks on an anomaly spike or edge on the **Telemetry Oscilloscope** canvas.
* **System Execution Sequence:**
  1. The primary measurement cursor ($T_1$) snaps to the exact timestamp of the clicked sample.
  2. The timestamp is converted into a microsecond lookup index.
  3. The **Packet Stream Viewport** automatically scrolls to the exact frame received at that timestamp.
  4. The matching frame row pulses with an amber focus border (`#F59E0B`).
  5. The **Hex Inspector** and **Protocol Dissector** update their views to display that frame's payload.
  6. The **DVR Scrubber** pauses live playback and updates its indicator to: `PAUSED AT T - 00:04.120s`.

### 2.3 Workflow C: Flash-Aware Port Yielding
* **Objective:** Surrender access to the physical USB-UART COM port so an external tool (`esptool.py`, OpenOCD, IDE) can flash new firmware without closing BaudForge.
* **Actor:** Microcontroller Firmware Developer.
* **Trigger Event:** User presses `Ctrl+Shift+Y` or clicks the `⚡ Yield for Flash` button in the ribbon.
* **System Execution Sequence:**
  1. The frontend dispatches `POST /api/yield { port: "COM8", seconds: 30 }`.
  2. The Rust engine halts reader thread polling and drops the OS serial handle.
  3. The ribbon button transforms into a high-visibility amber striped countdown banner: `FLASH YIELD ACTIVE (29s remaining)`.
  4. An action button `Reclaim Port Immediately` is surfaced in the banner.
  5. While yielded, the terminal indicates: `Port surrendered for external programmer. Ingestion suspended.`
  6. When the external tool completes or the countdown reaches 0:
     - The engine re-opens the COM port within $< 10\text{ ms}$.
     - The banner briefly turns emerald: `PORT RECLAIMED SUCCESSFULLY`.
     - Live data streaming resumes automatically.

### 2.4 Workflow D: Hardware-in-the-Loop (HIL) Fault Injection
* **Objective:** Verify receiver device resilience by safely mutating live data frames (bit-flips, corrupted CRCs, packet drops) without accidental runaway testing.
* **Actor:** HIL Validation Engineer.
* **Trigger Event:** User flips the master safety switch `Fault Profile` to `ARMED`.
* **System Execution Sequence:**
  1. The ribbon gains a glowing red-striped perimeter outline, indicating active fault injection.
  2. The status text updates: `⚠️ FAULT INJECTION ACTIVE - CORRUPTING 1 IN 5 PACKETS`.
  3. A persistent, prominent `DISARM ALL FAULTS` panic button remains pinned in the ribbon.
  4. Injected or mutated frames appear in the packet table with a high-contrast Crimson `FAULT` badge.
  5. In the Dissector Tree, corrupted fields are displayed in high-contrast red with original baseline values shown as strikethrough (e.g. `CRC: ~0x9F2A~ 0x0000`).
  6. Clicking `DISARM ALL FAULTS` immediately dispatches `POST /api/fault { profile: null }` and restores clean passthrough.

### 2.5 Workflow E: Zero-Hardware Onboarding & Simulation
* **Objective:** Allow engineers to evaluate BaudForge and test custom protocol headers without requiring physical microcontrollers or hardware test fixtures.
* **Actor:** First-time user, Evaluator, or Off-site Developer.
* **Trigger Event:** User clicks `⚡ Launch Simulated Target` on the initial welcome screen or ribbon.
* **System Execution Sequence:**
  1. The application activates internal simulated loopback telemetry without needing real USB devices.
  2. A mock sensor stream (IMU Packet with sine-wave battery voltage, gyro rotation, and animated bit flags) starts streaming at 20 packets/second.
  3. The top ribbon clearly displays the status: `● SIMULATED TARGET (LOOPBACK)`.
  4. The Dissector Tree automatically loads the bundled `ImuPacket.h` schema.
  5. The Oscilloscope immediately displays real-time animated waveforms for `v_batt_mv` and `gyro_z`.
  6. The user can interact with cursors, pause playback, inspect hex bytes, and transmit test commands in a safe, fully functional environment.
