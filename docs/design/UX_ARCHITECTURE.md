# BaudForge UX Architecture Specification

Document Version: 1.0.0  
Status: Authoritative Design Standard  
Target: BaudForge Desktop Application  
References: `docs/UI-UX-DESIGNER-HANDOVER.md`, `specs/ADR & SRS.md`, `crates/bforge-core/src/contract.rs`

---

## 1. Ergonomic Mental Model & Information Hierarchy

BaudForge is an integrated engineering instrument for embedded systems and aerospace validation.
It consolidates four core disciplines onto one screen without context switching:
1. **Raw Serial Monitoring:** Microsecond-precision byte streaming with hardware modem lines.
2. **Protocol Dissection:** Declarative extraction of structured fields from packed C structs, Protobuf, and aerospace frames.
3. **Continuous Waveform Telemetry:** 60 FPS oscilloscope traces, digital bit rails, and interval cursors.
4. **Hardware Validation & HIL Rig:** Safe fault injection, packet mutation, and flash-aware port yielding.

```text
+--------------------------------------------------------------------------------------------------------+
| GLOBAL RIBBON: Brand | Port Selector | Baud Chips | Connect | Flash Yield | Fault Arm | Sim Mode | Rec |
+-------------------------------------------------------------------+------------------------------------+
|                                                                   | PROTOCOL DISSECTOR                 |
| PACKET STREAM VIEWPORT                                            | Struct Tree (ImuPacket, APID, CRC) |
| Virtualized Table: Seq #, Delta Time, Direction, Port, Size, Data | Decoded values, units, enums       |
|                                                                   +------------------------------------+
|                                                                   | CANONICAL HEX & ASCII VIEW         |
|                                                                   | 16-byte grid with Cross-Highlight  |
+-------------------------------------------------------------------+------------------------------------+
| BOTTOM DOCK: TELEMETRY OSCILLOSCOPE & DVR SCRUBBER                                                     |
| Analog Waveform Traces (v_batt, gyro_z) | Digital Logic Rails (flags) | Cursors T1/T2 | Transport Bar  |
+--------------------------------------------------------------------------------------------------------+
| STATUS FOOTER: Port Link State | Modem Pins (CTS/DSR/DTR/RTS) | Ingested MB | Overruns | Throughput    |
+--------------------------------------------------------------------------------------------------------+
```

---

## 2. Workstation Panels & Functional Layout

### 2.1 Global Ribbon Toolbar (Top Surface, Height: 44px)
The top ribbon is the primary command strip. It provides rapid access to essential controls:
- **Application Identity:** `BAUDFORGE // WORKSTATION` brand marker with active link beacon.
- **Port Selector:** Dropdown displaying detected system ports, friendly device names, and USB VID:PID tags. Includes a refresh action button (`⟳`).
- **Baud Rate Quick Chips:** Segmented pills (`9600`, `115.2k`, `230.4k`, `921.6k`, `2.0M`, `12.0M`, `Custom`).
- **Primary Connection Trigger:** Emerald `CONNECT DEVICE` button switches to Crimson `DISCONNECT` when open.
- **Flash-Yield Control:** Amber button and countdown pill (`⚡ YIELD FOR FLASH`). Releases the serial COM handle for external programmers (`esptool.py`, OpenOCD).
- **HIL Fault Master Arm:** Safety interlock toggle (`FAULT: DISARMED` / `FAULT: ARMED`). High-visibility state indicator.
- **Hardware-less Simulation Toggle:** `● SIMULATED TARGET` button allows complete exploration without attached hardware.
- **Session Vault Recorder:** Red recording pill (`● REC` / `STANDBY`) showing current `.bflog` file size.

### 2.2 Packet Stream Viewport (Central Surface)
The primary packet inspection viewport displays interleaved frames with microsecond timestamps:
- Columns:
  1. `SEQ #`: Monotonically increasing sequence ID (`#0000001` to `#9999999`).
  2. `DELTA T`: Arrival delta from preceding packet in microseconds (`+000124 us`).
  3. `TIME`: Wall-clock UTC timestamp (`15:02:45.120488`).
  4. `DIR`: Color-coded direction badge (`RX` Emerald, `TX` Sky, `A->B` Amber, `FAULT` Crimson).
  5. `PORT`: Source hardware or virtual interface identifier (`obc`, `eps`, `COM8`).
  6. `LEN`: Payload byte count (`20 B`).
  7. `SUMMARY / PROTOCOL`: Protocol tag (`[TM] ImuPacket`) with decoded summary.
- Virtualized row rendering ensures zero dropped UI frames during high-throughput ingestion.
- Keyboard shortcuts: `/` focuses quick filter; `Space` pauses autoscroll; `Ctrl+L` clears view.

### 2.3 Protocol Dissector Tree (Upper Right Dock Panel)
The dissector breaks down binary packet payloads into structured fields:
- Displays container name, schema file (`imu_packet.h`), and packet size.
- Prominent CRC verification badge (`CRC VALID ✓` in Emerald or `CRC MISMATCH ⚠` in Crimson).
- Collapsible hierarchical tree grid:
  - Nested structs, bitfield flags, and fixed-size arrays.
  - Columns: Field Name, Data Type, Raw Hex, Decoded Engineering Value, Units.
- Interactive cross-highlight: Clicking or hovering a field node immediately highlights its corresponding bytes in the Hexadecimal Inspector.

### 2.4 Canonical Hexadecimal & ASCII Inspector (Lower Right Dock Panel)
- 16 bytes per line formatted with standard 4-byte grouping.
- Left gutter displays hexadecimal byte offsets (`00000000`, `00000010`).
- Center grid displays two-digit uppercase hexadecimal pairs (`AA 55 04 00 2C ...`).
- Right gutter displays printable ASCII characters, using subtle dots (`.`) for non-printable control codes.
- Highlighting support: Active field bytes illuminate in electric cyan (`#00E5FF`) with high-contrast text.

### 2.5 Bottom Dock: Telemetry Oscilloscope & DVR Timeline (Lower Dock Panel)
- **Continuous 60 FPS Waveform Viewer:**
  - Multi-channel analog plots (`v_batt_mv` in gold, `gyro_z` in cyan).
  - Multi-rail digital logic analyzer (`flags[0]`, `flags[1]`, `flags[2]`).
  - Subtle graticule lines with horizontal time tick labels.
  - Dual measurement cursors $T_1$ (cyan) and $T_2$ (amber) with floating delta HUD ($\Delta t$, $1/\Delta t$, $\Delta V$).
  - Anomaly synchronization: Clicking any point on the waveform jumps the packet stream and hex inspector to that exact microsecond.
- **DVR Scrubber & Playback Bar:**
  - Full-width scrubber slider spanning session frame history.
  - Play/Pause (`Space`), Step Backwards (`◀`), Step Forwards (`▶`).
  - Speed presets: `0.25x`, `0.5x`, `1.0x`, `2.0x`, `Live Snap`.
  - Prominent warning indicator when operating in historical pause mode.

### 2.6 Status & Hardware Modem Footer (Bottom Surface, Height: 26px)
- Hardware link state indicator: `TARGET CONNECTED [COM8 115200 8N1]`.
- Modem line LED status matrix: `CTS`, `DSR`, `DCD`, `RI`, `DTR`, `RTS`.
- Real-time ingestion counters: Total RX bytes, TX bytes, current packet rate, and throughput gauge.
- Buffer health indicator: `0 OVERRUNS` (Emerald) or `N OVERRUNS` (Crimson alarm).

---

## 3. Configurable Workspace Presets

The workstation dock system supports four dedicated operational layouts:
1. **Default Balanced Workstation:** Stream (left 60%), Dissector + Hex (right 40%), Oscilloscope (bottom 35%).
2. **Protocol Analysis Focus:** Stream (top 50%), Dissector (bottom left 50%), Hex (bottom right 50%). Oscilloscope minimized.
3. **Telemetry & Oscilloscope Focus:** Oscilloscope expanded to 70% height, Stream minimized to side log strip.
4. **HIL Bridge / MITM Inspection:** Split dual-stream view (Port A vs Port B) with middle fault injection controls.
