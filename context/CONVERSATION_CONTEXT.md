# BaudForge: Complete Conversation & Engineering Context Dump

Date: 2026-11-04  
Status: Authoritative Engineering Workstation Context  
Project: BaudForge Hardware Engineering Workstation  
Repository Root: `f:\Datapack\Personal\Programa\baud-forge`  
Document Location: `context/CONVERSATION_CONTEXT.md`  

---

## 1. Executive Summary & Project Purpose

**BaudForge** is a high-performance desktop workstation designed for embedded firmware engineers, aerospace/robotics test rigs, and hardware-in-the-loop (HIL) validation. It consolidates four traditionally separate tools into a unified, high-density engineering environment:
1. **Serial Monitor & Logic Stream (like PuTTY + Saleae Logic):** Up to 12 Mbaud with sub-microsecond timestamps and modem line status (CTS, RTS, DTR, DSR, DCD, RI).
2. **Protocol Dissector Lab (like Wireshark):** Real-time wire-level decoding of binary payloads into structured C structs, Protobuf schemas, or MAVLink packets.
3. **Telemetry Oscilloscope (like Agilent / Keysight Scope):** Real-time waveform graticule, logic analyzer rails, dual per-channel time/voltage cursors, FFT spectral analysis, and differential math operations.
4. **Hardware Fault Rig & Pin Sequencer:** Timed GPIO manipulation, reset pulses, ROM bootloader strap macros, bit corruption fuzzing, and session recording.

### Technical Architecture
- **Desktop Host:** Rust with Tokio, SerialPort, and Webview windowing (`crates/bforge-desktop`).
- **Core Engine:** High-performance SPMC packet pipeline, circular buffers, CRC validation (`crates/bforge-core`).
- **User Interface:** React 19 + TypeScript + Vite + Tailwind CSS + Dockview (`ui/`).
- **State Management:** Zustand workstation store (`ui/src/store/useWorkstationStore.ts`).
- **Simulation Layer:** High-fidelity IMU aerospace telemetry generator (`ui/src/services/simulationEngine.ts`).

---

## 2. Chronological Log of User Requests & Delivered Milestones

### Milestone 1: Kickoff & Initial GUI Architecture
- Reviewed SRS, ADRs, Rust contracts, and archived GUI implementations.
- Designed modern dark-theme CAD design tokens: `#0A0D13` (obsidian canvas), `#10141D` (panel body), `#161C28` (headers), `#00E5FF` (cyan primary), `#FBBF24` (amber telemetry), `#10B981` (emerald logic/status), `#EF4444` (crimson faults).
- Created desktop dockview workstation hosting 11 engineering panels.

### Milestone 2: Hardware Control & Framing Refinements
- Replaced hardcoded firmware test buttons in Command Forge.
- Split Command Forge into two columns: Left column for User Defined Commands, Right column for Transmission Payload.
- Added popup entry form to create custom commands with custom labels, colors, icons, payload, and single vs periodic intervals.
- Enabled toggleable periodic execution for custom command buttons.
- Removed paced repeat buttons and redundant duration controls.

### Milestone 3: Interactive Usability & Layout Features
- Added draggable horizontal separator between User Commands and Transmission Payload with mouse drag tracking.
- Implemented fancy square box-styled byte cells editor with direct keyboard input and auto-advance.
- Removed inline ASCII/HEX toggle from modal; hover inspect adapts to main Command Forge format setting.
- Cleaned up redundant UI elements and separators showing through menus.
- Replaced clipping zoom implementation with scaled CSS viewport transformations (`setUiScale`).

### Milestone 4: Docking System & Window Popout Memory
- Implemented panel popout / detachment feature using browser windows and Dockview detachment.
- Resolved panel restoration bug: restored panels previously defaulted to Packet Stream group or appended to the end of the group.
- Implemented `detachedOrigins`, `CANONICAL_DECK_ORDERS`, and `calculateInsertionIndex` so panels return to their exact original tab slot within their home deck.

### Milestone 5: Serial Monitor (Packet Stream) & Framing Modal
- Added dedicated UART framing modal (`UartConfigModal.tsx`):
  - Baud rate selector (standard rates up to 12 Mbaud).
  - Data bits (5, 6, 7, 8).
  - Parity (None, Even, Odd, Mark, Space).
  - Stop bits (1, 1.5, 2).
  - Delimiter / packet slicer configuration (`COBS`, `\n` LF, `\r\n` CRLF, `NULL`, `SLIP`, `RAW`, or custom hex delimiter).
- Packet Stream content table:
  - Centered column headers.
  - Draggable column width resizers with vertical divider styling.
  - Column dimensions persisted in `localStorage` (`bforge_packet_stream_col_widths`).

### Milestone 6: Telemetry Oscilloscope Math & Draggable HUD
- Integrated real-time Math channel (`MATH ON / OFF`):
  - Operations: `CH1 - CH2` (differential), `CH1 + CH2`, `CH1 * CH2`, `INV CH1`, and `FFT` (discrete Fourier spectral analyzer with peak frequency detection).
  - Plotted in Neon Magenta (`#D946EF`) with configurable multiplier (`0.5x`, `1.0x`, `2.0x`).
- Added floating measurement HUD:
  - Fully draggable across canvas via header handle.
  - Clamped within visible display bounds.
  - Position persisted to `localStorage` (`bforge_scope_hud_pos`).
  - Readout displays $\Delta t$, $1/\Delta t$ frequency, $\Delta V$, slew rates, and peak-to-peak statistics.

### Milestone 7: Oscilloscope Fixes & Pin Sequencer Tooltips
- **Run/Stop Fix:** Resolved acquisition freezing using `frozenSnapshot` holding immutable samples and time span. Display shows `RUNNING` (emerald) vs `STOPPED` (crimson).
- **Channel Sourcing:** Added explicit channel sources for Timebase, Vertical Scales (`CH1: 1V/div`, `CH2: 0.5 r/s/div`), Trigger (`TRIG: CH1 | CH2`), and Cursors (`Y SRC: CH1 | CH2 | MATH`).
- **Cursor Overlap Bug Fix:** Resolved cursor jumping when dragging `X2`. Root cause was `seekToTimestamp` mutating `cursorT1Us: tUs`. Removed cursor mutation from `seekToTimestamp`, decoupled drag handlers, and suppressed click handlers on drag release.
- **Pin Sequencer Tooltips:** Added comprehensive monospace `data-tooltip` attributes across all Pin Sequencer buttons, toggles, preset macros, and table headers.

### Milestone 8: Oscilloscope 2-Row Layout, Channel Time Skew, & Layout Save
- Converted Oscilloscope top controls into a structured **2-row ribbon**:
  - **Row 1:** Run/Stop, Single Shot, Horizontal Timebase (stepper & editable input), Per-Channel Stems (CH1, CH2, MATH, LOGIC) with scales and channel horizontal time skew (`Δt`).
  - **Row 2:** Trigger Engine (Mode, Source, Level, Slope), Independent Cursors Per Channel (`CH1`, `CH2`, `MATH`), Display Zoom & HUD toggle.
- **Channel Horizontal Timebase Skew:** Added independent delay offsets (`ch1TimeOffsetMs`, `ch2TimeOffsetMs`, `mathTimeOffsetMs`) allowing trace alignment.
- **Independent Cursors Per Channel:** Each channel maintains its own independent `X1`, `X2`, `Y1`, `Y2` cursor coordinates, colors, and HUD metrics.
- **Scale Steppers & Editable Inputs:** Steppers cycle standard 1-2-5 decade presets; clicking values allows direct numeric entry.
- **Tooltip Viewport Clamping:** Rewrote `TooltipOverlay.tsx` with dynamic DOM measurement and strict boundary clamping (`margin = 8px`), preventing off-screen clipping.
- **Layout Save & Set to Default:** Added `Save Current Layout`, `Restore Saved Layout`, and `Set to Default Layout` in `GlobalRibbon.tsx` and `WorkstationDock.tsx`.

---

## 3. Comprehensive Inventory of System Components

### 3.1 Global & Workbench Shell
| Component | Source File | Responsibilities |
| :--- | :--- | :--- |
| `App.tsx` | [`ui/src/App.tsx`](../ui/src/App.tsx) | Main workstation layout, simulation loop, global hotkeys (Space, Zoom, Yield), and window scale transform. |
| `GlobalRibbon.tsx` | [`ui/src/components/GlobalRibbon.tsx`](../ui/src/components/GlobalRibbon.tsx) | Connection status, port & baud picker, flash-yield trigger, layout manager, and global action triggers. |
| `WorkstationDock.tsx` | [`ui/src/components/WorkstationDock.tsx`](../ui/src/components/WorkstationDock.tsx) | Dockview docking engine, deck layouts, popout windows, canonical order memory, layout save/restore. |
| `TooltipOverlay.tsx` | [`ui/src/components/TooltipOverlay.tsx`](../ui/src/components/TooltipOverlay.tsx) | Portal tooltip engine with screen boundary clamping, dynamic height measurement, and keyboard shortcut badges. |
| `UartConfigModal.tsx` | [`ui/src/components/UartConfigModal.tsx`](../ui/src/components/UartConfigModal.tsx) | Popover configuration dialog for UART framing bits, parity, stop bits, and packet slicing delimiters. |
| `DvrTimelineBar.tsx` | [`ui/src/components/DvrTimelineBar.tsx`](../ui/src/components/DvrTimelineBar.tsx) | Transport scrubber, playback speed controls, packet scrubbing slider, and frame stepping. |

### 3.2 Hardware & Protocol Workbenches
| Panel Component | Source File | Key Features & Implementation Details |
| :--- | :--- | :--- |
| `PacketStreamView.tsx` | [`ui/src/components/PacketStreamView.tsx`](../ui/src/components/PacketStreamView.tsx) | High-speed tabular stream, centered headers, draggable column width resizing with `localStorage` persistence, auto-scroll toggle, packet detail inspector. |
| `ProtocolDissector.tsx` | [`ui/src/components/ProtocolDissector.tsx`](../ui/src/components/ProtocolDissector.tsx) | Tree-structured packet field dissection, bitfield offset gutters, hex byte highlighting, live decode summary. |
| `OscilloscopeView.tsx` | [`ui/src/components/OscilloscopeView.tsx`](../ui/src/components/OscilloscopeView.tsx) | 2-row ribbon controls, 60 FPS Canvas DSO, per-channel vertical scales (1-2-5 presets), per-channel horizontal time skews, independent channel cursors, differential math, FFT spectrum, draggable HUD. |
| `CommandForge.tsx` | [`ui/src/components/CommandForge.tsx`](../ui/src/components/CommandForge.tsx) | User-defined command buttons (single & toggle periodic), fancy square byte-box payload editor with auto-advance, resizable split columns, hover inspector. |
| `PinSequencerView.tsx` | [`ui/src/components/PinSequencerView.tsx`](../ui/src/components/PinSequencerView.tsx) | Timed GPIO transition sequences, direct DTR/RTS toggles, 100ms reset pulse, ESP32 and STM32 bootloader macros, dark monospace tooltips. |
| `HexInspector.tsx` | [`ui/src/components/HexInspector.tsx`](../ui/src/components/HexInspector.tsx) | Canonical 16-byte hex dump grid with 4-byte grouping, ASCII text gutter, and bi-directional field highlight synchronization. |
| `SessionDiffView.tsx` | [`ui/src/components/SessionDiffView.tsx`](../ui/src/components/SessionDiffView.tsx) | Semantic diff comparison between anomalous sessions and golden `.bflog` vaults, timing jitter analysis, corruption highlighting. |
| `FaultRigView.tsx` | [`ui/src/components/FaultRigView.tsx`](../ui/src/components/FaultRigView.tsx) | Hardware-in-the-loop fault injection, CRC corruption simulation, frame drop emulation, and packet fuzzing triggers. |
| `FileTransferView.tsx` | [`ui/src/components/FileTransferView.tsx`](../ui/src/components/FileTransferView.tsx) | XMODEM-CRC / YMODEM-1K firmware upload manager with block progress bars and transfer statistics. |
| `ElfSymbolView.tsx` | [`ui/src/components/ElfSymbolView.tsx`](../ui/src/components/ElfSymbolView.tsx) | ELF symbol table parser, struct memory layout inspector, crash backtrace PC-to-symbol resolution. |
| `SchemaDialectView.tsx`| [`ui/src/components/SchemaDialectView.tsx`](../ui/src/components/SchemaDialectView.tsx) | Schema loader for Protobuf (`.proto`), MAVLink XML dialects, and C header structs (`.h`). |

---

## 4. Key Bug Investigations & Technical Resolutions

1. **Oscilloscope Cursor Drag Overlap Jump:**
   - *Symptom:* Dragging cursor `X2` caused cursor `X1` to jump and overlap `X2`.
   - *Root Cause:* `seekToTimestamp(tUs)` in `useWorkstationStore.ts` had a side effect: `cursorT1Us: tUs`. `OscilloscopeView` called `seekToTimestamp` when dragging `X2` or clicking canvas, which forcibly set `cursorT1Us = X2`.
   - *Resolution:* Removed `cursorT1Us: tUs` from `seekToTimestamp`. Strictly decoupled mouse drag handlers so dragging `X2` only calls `setCursorT2`. Suppressed canvas placement click events upon drag release.

2. **Oscilloscope Run/Stop Freezing:**
   - *Symptom:* Clicking RUN/STOP toggled the button state, but the waveform did not reliably freeze on canvas.
   - *Root Cause:* Time window bounds were derived purely from the rolling buffer timestamps (`lastSample - firstSample`). New samples pushed by the store continuously shifted the window.
   - *Resolution:* Implemented `frozenSnapshot: { samples, tMin, tMax }`. When STOP is clicked, an immutable snapshot freezes coordinates and sample arrays. When RUN is clicked, live streaming resumes.

3. **Restored Panel Tab Slot Positioning:**
   - *Symptom:* Restoring a detached panel appended it to the end of the tab group or docked it adjacent to Packet Stream.
   - *Root Cause:* `moveGroupOrPanel` omitted `from.panelId` and `to.index`, defaulting to group append.
   - *Resolution:* Created `detachedOrigins` recording `originalIndex` and `siblingOrder`. Added `calculateInsertionIndex` and `CANONICAL_DECK_ORDERS` to find the exact adjacent sibling, restoring panels to their original tab order.

4. **Tooltip Viewport Clipping:**
   - *Symptom:* Long tooltips near the edges of the window clipped outside the viewport.
   - *Root Cause:* Position calculations used `transform: translate(-50%, 0)` with fixed width assumptions and lacked element measurement.
   - *Resolution:* Rewrote `TooltipOverlay.tsx` using `useLayoutEffect` to dynamically measure element bounding rects and clamp coordinates between `8px` and `window.innerWidth - width - 8px`. Added automatic top-flip when bottom margin is exceeded.

---

## 5. Verification & Build Commands

### Frontend Build
```powershell
cd ui
pnpm run build
```
Output:
- Output directory: `ui/dist`
- Minified assets: `ui/dist/assets/index-*.js`, `ui/dist/assets/index-*.css`
- Verified: Zero TypeScript (`tsc`) compilation errors.

### Asset Synchronization
```powershell
Copy-Item -Path 'ui\dist\*' -Destination 'target\release\ui' -Recurse -Force
```

### Desktop Binary Build (Release Profile)
```powershell
& "$env:USERPROFILE\.cargo\bin\cargo.exe" build -p bforge-desktop --release
```
Output:
- Executable: `target/release/bforge-desktop.exe`
- Verification: Compiled and optimized without warnings or linker errors.

---

## 6. Durable Documentation References

- [`docs/design/UX_REFINEMENTS_REPORT.md`](file:///f:/Datapack/Personal/Programa/baud-forge/docs/design/UX_REFINEMENTS_REPORT.md): Comprehensive log of all 19 UX design iterations, fixes, and architecture choices.
- [`docs/UI-UX-DESIGNER-HANDOVER.md`](file:///f:/Datapack/Personal/Programa/baud-forge/docs/UI-UX-DESIGNER-HANDOVER.md): Authoritative product requirements and functional specifications.
- [`specs/ADR & SRS.md`](file:///f:/Datapack/Personal/Programa/baud-forge/specs/ADR%20&%20SRS.md): Architecture Decision Records and System Requirements Specification.
