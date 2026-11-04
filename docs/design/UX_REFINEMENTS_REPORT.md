# Workstation UX & Ergonomics Refinements

Status: implemented and verified (November 2026).
Covers UX improvements 0 through 7 requested by user review.

---

## 1. Tooltips Across All Workstation Surfaces (Item 0)
- Added contextual tooltips explaining functions, states, and safety implications across:
  - Connect / Disconnect states.
  - Hardware port selection and refresh.
  - Baud rate selector (standard 115.2k up to 12 Mbps).
  - Flash-Yield (`Ctrl+Shift+Y`): Explains serial handle surrender for external IDE/programmer.
  - HIL Fault Rig master interlock arming.
  - Physical vs Simulated mode toggle.
  - Session recording (`.bflog`) and Vault Exporter.
  - UI scaling zoom controls (`Ctrl +` / `Ctrl -` / `Ctrl 0`).

---

## 2. Layout Presets & Closed Panel Re-Opening (Items 1 & 2)
- Added a unified **LAYOUTS & PANELS** dropdown menu to the central ribbon:
  1. **Layout Presets**:
     - `Default CAD Workbench`: 4-surface layout (Stream, Dissector, Hex, Scope & subdeck).
     - `Dissector & Schemas Focus`: 50/50 split optimizing protocol analysis, schemas, and ELF inspection.
     - `Telemetry Oscilloscope Focus`: Maximized DSO (62% height) with packet stream and dissector.
     - `HIL & Hardware Rig Focus`: Stream beside HIL Fault Rig, Pin Sequencer, and File Transfers.
  2. **Re-Open Closed Panels**:
     - Direct catalog listing all 11 workstation panels.
     - Clicking any closed panel re-opens and focuses it in the dock.
  3. **Reset Action**:
     - Instant one-click "Reset to Default Layout" restoring the CAD workspace.

---

## 3. Window & Dockview Geometry Retention (Item 3)
- In [`crates/bforge-desktop/src/main.rs`](../../crates/bforge-desktop/src/main.rs):
  - Added `maximized: bool` to the serialized `Geometry` payload.
  - If the application was maximized when closed, it restores maximized state on start via `window.maximize()`.
  - Adjusted width/height clamping to `800..=3840` and `540..=2160` to support 1440p and 4K monitors without cropping, while ensuring windows do not open smaller than minimum usable bounds.
- In [`ui/src/components/WorkstationDock.tsx`](../../ui/src/components/WorkstationDock.tsx):
  - Subscribed to `api.onDidLayoutChange` to persist custom dock panel arrangements in `localStorage`.
  - Restores saved panel arrangements on launch.

---

## 4. Packet Stream Dedicated Search & Filter (Item 4)
- Removed search bar from the global ribbon.
- Placed dedicated stream filter directly inside [`ui/src/components/PacketStreamView.tsx`](../../ui/src/components/PacketStreamView.tsx) header toolbar.
- Added live match counter badge (`N MATCHES`).
- Real-time filtering across protocol tag, raw hex bytes, decoded summary text, and packet direction (`RX`, `TX`, `FAULT`).

---

## 5. Fault Rig Master Button Consolidation (Item 5)
- In [`ui/src/components/FaultRigView.tsx`](../../ui/src/components/FaultRigView.tsx):
  - Removed duplicate `DISARM ALL FAULTS` and `DEACTIVATE` buttons.
  - Consolidated into a single, high-contrast master interlock toggle:
    - `ARM FAULT RIG` (safe, dark surface with emerald border).
    - `DISARM ALL FAULTS` (warning active, illuminated red).

---

## 6. Telemetry Oscilloscope DSO Controls, Zoom & Pan (Item 6)
- In [`ui/src/components/OscilloscopeView.tsx`](../../ui/src/components/OscilloscopeView.tsx):
  - **Horizontal Timebase (Time/Div)**: Cycles `10 ms`, `25 ms`, `50 ms`, `100 ms`, `250 ms`, `500 ms` per division.
  - **Vertical Voltage Scale (Volts/Div)**: Cycles `500 mV`, `1 V`, `2 V`, `5 V` per division.
  - **Trigger Controls**:
    - Mode: `AUTO` (free-run), `NORM` (wait for threshold), `SINGLE` (one-shot freeze).
    - Slope: `RISING ↗` or `FALLING ↘`.
    - Horizontal dashed trigger threshold line and right-edge marker arrow.
  - **Run Control**: `RUN` (emerald) / `STOPPED` (red freeze) toggle.
  - **Interactive Mouse Controls**:
    - **Mouse-Wheel Zoom**: Zooms timebase in/out (`0.2x` to `10.0x`).
    - **Click-and-Drag Pan**: Drags the waveform horizontally across time.
    - **Click**: Places `T1` / `T2` measurement cursors and seeks timeline.
    - **FIT Button**: Resets zoom to 1.0x and pan offset to 0.

---

## 7. Professional Domain Header Badges (Item 7)
- Replaced developer internal spec numbers with domain badges:
  - `specs/0044` → `CAPTURE EXPORT`
  - `specs/0056` → `X/YMODEM PROTOCOL`
  - `specs/0035 · specs/0055` → `DWARF & TOKENS`
  - `specs/0053 · specs/0054` → `RUNTIME SCHEMAS`
  - `specs/0050` → `SESSION COMPARISON`
  - `specs/0052` → `TIMED GPIO`
  - `specs/0022` → `HARDWARE IN THE LOOP`

---

## 8. Command Forge Ergonomics & Square Byte Boxes
- In [`ui/src/components/CommandForge.tsx`](../../ui/src/components/CommandForge.tsx):
  - **Removed Redundant Hover Inspector**: Deleted the bottom footer preview box per user request.
  - **Square Byte Boxes (`w-11 h-11`)**: Enlarged byte entry cells to square dimensions with large, crisp monospace cyan font (`text-sm font-bold`).
  - **Keyboard-First Editing**:
    - Focus auto-selects cell content (`onFocus={(e) => e.currentTarget.select()}`).
    - Direct typing immediately replaces the hex pair without requiring manual highlight.
    - Typing 2 hex characters auto-advances to the next byte box (and auto-appends when at the end).
    - **Space Key Progression**: Pressing `Space` advances to the next byte box; if already at the last byte box, pressing `Space` appends a new box and focuses it.
    - Backspace clears current byte or steps to previous byte and clears it.
    - Delete removes the byte cell.
    - Arrow keys (`ArrowLeft`, `ArrowRight`) navigate between byte boxes cleanly.
    - Enter key triggers immediate payload transmission.
  - **Draggable Splitter**: Added persistent column resizing divider.

---

## 9. Layouts & Panels Dropdown Isolation
- In [`ui/src/components/GlobalRibbon.tsx`](../../ui/src/components/GlobalRibbon.tsx):
  - Removed redundant top menu bar to reclaim vertical screen space.
  - Rendered `LAYOUTS & PANELS` dropdown menu via React Portal (`document.body`) with `z-index: 999999` and solid `#0E131F` background.
  - Eliminates visual bleed-through of underlying Dockview sashes, tabs, and panel separators.
  - Fully catalogs all 4 layout presets and all 11 panels.

---

## 10. Native Viewport Zoom Fix
- In [`ui/src/App.tsx`](../../ui/src/App.tsx):
  - Removed inverse scaling calculation (`width: 100/scaleFactor%`) which caused zoom-out to clip and zoom-in to shrink.
  - Applied zoom directly via `document.documentElement.style.zoom = String(uiScale)` to enable native browser-grade zooming across the entire viewport.

---

## 11. Panel Maximize & Detach Popout Feature
- In [`ui/src/components/WorkstationDock.tsx`](../../ui/src/components/WorkstationDock.tsx):
  - Implemented `rightHeaderActionsComponent` providing per-panel header buttons:
    - **Expand / Maximize**: Expands panel to fill the entire workbench viewport (`Maximize2`).
    - **Restore**: Restores panel back to its previous position in the dock (`Minimize2`).
    - **Detach / Popout**: Detaches panel into an external window (`popout.html`) or floating window with full drag/resize handles (`ExternalLink`).
    - **Re-dock**: Clicking the detach button while floating docks the panel back into the workbench grid.
  - Added [`ui/public/popout.html`](../../ui/public/popout.html) and custom CSS for floating overlay containers (`.dv-floating-overlay-host`).

---

## 12. Global Dark Tooltip Engine
- In [`ui/src/components/TooltipOverlay.tsx`](../../ui/src/components/TooltipOverlay.tsx):
  - Fixed event listener teardown and mouseout bubbling issues with descendant elements.
  - Renders tooltips in React Portal at `document.body` with `z-index: 1000000`.
  - Displays compact, high-contrast monospace tooltips across all panels, buttons, and controls.

---

## 13. Floating Window Clean Disposal & Re-Docking
- In [`ui/src/components/WorkstationDock.tsx`](../../ui/src/components/WorkstationDock.tsx):
  - Resolved issue where an empty floating window frame remained after detaching and restoring a panel.
  - Found root cause: `redockGroupToMainGrid` moved the group model to the main grid but did not dispose the floating overlay container registered in `_floatingGroupService`.
  - Added explicit teardown logic in `handleDetachOrRedock`:
    - Merges group back into the active grid.
    - Explicitly invokes `floatingGroup?.dispose()` to destroy the floating overlay element from the DOM.
    - Closes and disposes popout browser windows (`popoutEntry?.window?.close()`).
    - Added `closeEmptyGroups={true}` on `<DockviewReact>` to prevent lingering empty frames.

---

## 14. Serial Port Delimiter & UART Framing Configuration (Item a)
- Added [`ui/src/components/UartConfigModal.tsx`](../../ui/src/components/UartConfigModal.tsx), accessible from both the **Global Ribbon** (beside Baud selector) and the **Packet Stream** panel toolbar:
  - **UART Line Framing**:
    - Data bits: `8` (Standard), `7`, `6`, `5`.
    - Parity: `None (N)`, `Even (E)`, `Odd (O)`, `Mark (M)`, `Space (S)`.
    - Stop bits: `1`, `1.5`, `2`.
    - Live shorthand indicator (e.g., `8-N-1`, `7-E-1`).
  - **Frame Delimiter & Slicing Mode**:
    - `COBS`: Consistent Overhead Byte Stuffing (0x00 delimiter + COBS decode).
    - `LF`: Standard newline delimiter (`\n`, `0x0A`).
    - `CRLF`: Standard Windows / AT command delimiter (`\r\n`, `0x0D 0x0A`).
    - `NULL`: Raw zero byte boundary (`0x00`).
    - `SLIP`: Serial Line IP framing (RFC 1055, `0xC0`).
    - `RAW STREAM`: Continuous stream pass-through with no boundary slicing.
    - `CUSTOM`: User-defined hex byte (e.g. `0x7E`, `0xAA`).
  - **State Retention**:
    - Persisted in `localStorage` under `bforge_uart_config` across application restarts.
    - Displayed in Status Footer (`[{selectedPort} {baudRate} {dataBits}{parity}{stopBits} / {framing}]`).

---

## 15. Packet Stream Table Ergonomics & Draggable Column Widths (Item b)
- In [`ui/src/components/PacketStreamView.tsx`](../../ui/src/components/PacketStreamView.tsx):
  - **Centered Column Headers**: All 8 column headers (`SEQ`, `DELTA T`, `TIME`, `DIR`, `PORT`, `LEN`, `PROTOCOL`, `DECODED SUMMARY / RAW PAYLOAD`) are now centered with `text-center`.
  - **Visible Column Separators**: Added vertical column dividers (`border-r border-[#222D3D]` in header, `border-r border-[#1E293B]/40` in data rows).
  - **Draggable Column Widths**:
    - Right edge of every column header features an interactive resize sash (`cursor-col-resize`).
    - Click-and-drag dynamically resizes column width with smooth live preview and minimum width clamping.
    - Double-clicking any separator resets that column to its default width.
  - **Synchronized Horizontal Scrolling**: Synchronized scroll position between the sticky header and the virtualized packet row list (`headerRef.scrollLeft = containerRef.scrollLeft`).
  - **Centered Content Cells**: Centered data cells for `seq`, `delta`, `time`, `dir`, `port`, `len`, and `protocol` for clean visual alignment.
  - **Persistent Column Widths**: Automatically persists column width changes to `localStorage` under `bforge_stream_col_widths` and restores them on subsequent application launches.

---

## 16. Panel Origin Memory & Intelligent Deck Re-Docking
- In [`ui/src/components/WorkstationDock.tsx`](../../ui/src/components/WorkstationDock.tsx):
  - **Identified Root Cause of Misplacement**:
    - Previously, restoring a panel called `groups.find((g) => g.model.location.type === 'grid')`.
    - In Dockview's internal array, `groups[0]` is always the top-left group hosting `Packet Stream`.
    - Consequently, every restored panel was merged into `packetStream`'s group as an adjacent tab.
  - **Origin Memory Tracking**:
    - Implemented `detachedOrigins` map tracking the sibling panel ID and group context at detachment.
    - When detaching `Command Forge` from the bottom deck, it records its sibling `oscilloscope` (or `pinSequencer`).
  - **Natural Deck Fallback Hierarchy**:
    - Defined `PANEL_ORIGIN_HOMES` and `findPreferredTarget` mapping every panel to its natural workbench deck:
      - Bottom subdeck panels (`Command Forge`, `Pin Sequencer`, `HIL Fault Rig`, `File Transfer`): Re-docks into the subdeck group with `Oscilloscope` (or splits below `Packet Stream`).
      - Right dissector panels (`Protocol Dissector`, `ELF Symbols`, `Schema Dialects`): Re-docks into the top-right column.
      - Bottom-right panels (`Hex Inspector`, `Session Diff`): Re-docks into the bottom-right deck.
  - **Original Tab Index Restoration**:
    - Previously, `moveGroupOrPanel` omitted `options.from.panelId` and `options.to.index`, which caused Dockview to append restored panels to the end of the tab group.
    - Added `originalIndex` and `siblingOrder` recording at detachment.
    - Implemented `calculateInsertionIndex` and `CANONICAL_DECK_ORDERS`:
      - Identifies the closest following sibling currently in the destination group.
      - If no following sibling exists, places the panel directly after the closest preceding sibling.
      - Dispatches `moveGroupOrPanel({ from: { groupId, panelId }, to: { group, position, index: insertionIndex } })`.
  - **Result**: Restored panels now return to their exact original tab slot within their deck (e.g. `Command Forge` returns to slot 1 between `Oscilloscope` and `Pin Sequencer`), rather than appending at the end.

---

## 17. Telemetry Oscilloscope Cursors, Math Engine & Movable HUD
- In [`ui/src/components/OscilloscopeView.tsx`](../../ui/src/components/OscilloscopeView.tsx):
  - **Interactive Cursor & Marker System**:
    - **Dual Time (X) Cursors**: `X1` (Cyan `#00E5FF`) and `X2` (Amber `#FBBF24`) markers with draggable top tabs.
    - **Dual Voltage (Y) Cursors**: `Y1` (Emerald `#10B981`) and `Y2` (Purple `#A855F7`) markers with draggable side tabs.
    - **Cursor Modes**: `OFF`, `TIME (X)`, `VOLT (Y)`, and `DUAL (X+Y)`.
    - **Direct Screen Dragging**: Hovering near any cursor line or tag shows `col-resize` or `row-resize` and illuminates the line. Clicking and dragging moves that marker smoothly in real time.
    - **Quick Cursor Actions**:
      - `CTR` (Center): Automatically centers cursors at 30% and 70% of the active visible window.
      - `SNAP`: Snaps voltage cursors to the waveform's minimum and maximum signal peaks.
      - Click on empty canvas places the currently active cursor.
  - **Oscilloscope Math Channel (`MATH`)**:
    - Toggle button `MATH ON / OFF` in the oscilloscope ribbon.
    - Selectable mathematical operators:
      - `CH1 - CH2`: Differential signal comparison (`v_batt` vs `gyro_z`).
      - `CH1 + CH2`: Algebraic signal sum.
      - `CH1 * CH2`: Cross-product power modulation.
      - `FFT`: Real-time discrete Fourier transform spectral magnitude analyzer with dominant frequency peak detection.
      - `INV CH1`: Inverted Channel 1.
    - Plotted on canvas in vibrant Neon Magenta (`#D946EF`) with scale multiplier adjustment (`0.5x`, `1.0x`, `2.0x`).
  - **Draggable Measurement Readout HUD**:
    - The floating measurement card is now **fully movable and draggable** across the entire scope display via its header handle.
    - Clamped within canvas boundaries to prevent off-screen clipping.
    - Remembers coordinates in `localStorage` under `bforge_scope_hud_pos`.
    - Collapsible to a compact status pill via minimize toggle.
    - Live engineering readouts:
      - Time: `X1`, `X2`, `Δt (|X2 - X1|)` in µs, `1/Δt` frequency in Hz.
      - Voltage: `Y1`, `Y2`, `ΔV (|Y2 - Y1|)` in mV, `Slew (ΔV/Δt)` in V/s.
      - Waveform Metrics: `Vpp`, `Vmax`, `Vmin`, `Vmean`, `Vrms`, Gyro Pk-Pk, and FFT Peak.

---

## 18. Oscilloscope Acquisition Freeze, Channel Sourcing, Decoupled Cursors & Pin Sequencer Tooltips
- In [`ui/src/components/OscilloscopeView.tsx`](../../ui/src/components/OscilloscopeView.tsx):
  - **Deterministic Run/Stop Acquisition Freezing**:
    - Added `frozenSnapshot` state capturing an immutable clone of `scopeSamples` and coordinate span (`tMin`, `tMax`) at the exact freeze instant.
    - When `STOPPED`:
      - Disables rolling buffer shifts on canvas.
      - Retains full pan/zoom capabilities over the captured waveform.
      - Displays prominent red `■ STOPPED` status badge on graticule and ribbon.
    - When `RUNNING`:
      - Clears snapshot and resumes live rolling telemetry streaming.
  - **Explicit Channel Sourcing & Independent Scaling**:
    - **Timebase**: `TIME: 50 ms/div` now dynamically computes the horizontal window (`10 * timeDivMs * 1000 / zoomLevel`).
    - **Per-Channel Vertical Scales**:
      - `CH1: 1 V/div` (Amber `#FBBF24`, cycles `200 mV`, `500 mV`, `1 V`, `2 V`, `5 V/div`). Controls vertical scale for Channel 1 (`v_batt_mv`).
      - `CH2: 0.5 r/s/div` (Cyan `#00E5FF`, cycles `0.1`, `0.25`, `0.5`, `1.0`, `2.0 rad/s/div`). Controls vertical scale for Channel 2 (`gyro_z`).
    - **Trigger Sourcing**:
      - `TRIG SRC: CH1 | CH2`: Toggle trigger channel source.
      - Level adjustments dynamically map to the selected channel (`mV` for CH1, `rad/s` for CH2).
      - Trigger line and marker arrow update on canvas in corresponding channel color.
    - **Signal/Voltage Cursor Sourcing**:
      - Added `Y SRC: CH1 | CH2 | MATH`: Selects which channel signal the horizontal cursors measure.
      - Readout HUD dynamically reports values in native channel units (`V/mV` for CH1, `rad/s` and `rad/s²` for CH2, unitless for MATH).
  - **Cursor X2/X1 Decoupling & Jump Prevention**:
    - Fixed regression in [`ui/src/store/useWorkstationStore.ts`](../../ui/src/store/useWorkstationStore.ts): removed side-effecting `cursorT1Us: tUs` assignment from `seekToTimestamp`.
    - Fully decoupled cursor dragging in `handleMouseMove` and `handleMouseUp`: dragging `X2` strictly mutates `cursorT2Us`; dragging `X1` strictly mutates `cursorT1Us`.
    - Drag release suppresses canvas placement click, preventing marker collisions.
- In [`ui/src/components/PinSequencerView.tsx`](../../ui/src/components/PinSequencerView.tsx):
  - Added comprehensive `data-tooltip` attributes across all elements:
    - Manual DTR and RTS line toggle buttons.
    - 100ms reset pulse action button.
    - ROM bootloader preset macros (ESP32 ROM Bootloader, STM32 NRST Reset).
    - Table column headers: Step, DTR State, RTS State, Wait Time, Description, Del.
    - Step pattern toggles, step dwell inputs, and step delete buttons.
    - Add Step and Execute Timed Sequence buttons.

---

## 19. 2-Row Oscilloscope Ribbon, Independent Channel Cursors, Clamped Tooltips & Layout Save/Restore
- In [`ui/src/components/OscilloscopeView.tsx`](../../ui/src/components/OscilloscopeView.tsx):
  - **Structured 2-Row Ribbon Architecture**:
    - **Row 1 (Acquisition & Channel Stems)**:
      - `RUN / STOP` toggle + `SINGLE` trigger shot.
      - **Horizontal Timebase (`TIME`)**:
        - Stepper controls (`-` / `+`) cycling standard 1-2-5 decade presets (`1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000 ms/div`).
        - Direct click-to-edit input field for arbitrary numeric values.
        - Total window span readout (e.g. `(500ms)`).
      - **Per-Channel Stems with Scales & Time Offsets**:
        - **CH1**: Visibility (`CH1`), Volts/Div scale stepper & presets (`50mV` to `10V/div`), Horizontal Skew (`Δt: -5ms / +5ms`).
        - **CH2**: Visibility (`CH2`), rad/s/Div scale stepper & presets (`0.02` to `5.0 r/s/div`), Horizontal Skew (`Δt: -5ms / +5ms`).
        - **MATH**: Visibility (`MATH`), Operator cycle, Amplitude scale (`0.25x` to `5.0x`), Horizontal Skew (`Δt`).
        - **LOGIC**: Digital rails visibility toggle (`LOGIC`).
    - **Row 2 (Trigger Engine, Independent Cursors, Zoom & View)**:
      - **Trigger Engine**: Mode (`AUTO`, `NORM`, `SINGLE`), Source (`CH1`, `CH2`), Threshold Stepper, Slope (`RISING`, `FALLING`).
      - **Independent Marker Cursors Per Channel**:
        - Channel Selector: `CURSORS FOR: [CH1] [CH2] [MATH]`.
        - Each channel maintains its own independent `X1`, `X2`, `Y1`, `Y2` coordinates.
        - Displayed with channel-specific color tags (`CH1:X1`, `CH2:X1`, `M:X1`).
        - Actions for selected channel: `CTR` (Center), `SNAP` (Snap to peaks), `CLR` (Reset).
      - **Display View**: Zoom stepper (`-` / `+` and `FIT`), HUD on/off toggle.
- In [`ui/src/components/TooltipOverlay.tsx`](../../ui/src/components/TooltipOverlay.tsx):
  - Rewrote positioning engine with dynamic DOM measurement via `useLayoutEffect`.
  - Enforced viewport boundaries clamping (`margin = 8px`):
    - Horizontally clamped to `[margin, window.innerWidth - ttWidth - margin]`.
    - Vertically clamped to `[margin, window.innerHeight - ttHeight - margin]`.
    - Automatically flips above target when bottom space is insufficient.
  - Added text wrapping (`max-w-[420px] whitespace-normal break-words`).
- In [`ui/src/store/useWorkstationStore.ts`](../../ui/src/store/useWorkstationStore.ts) & [`ui/src/components/GlobalRibbon.tsx`](../../ui/src/components/GlobalRibbon.tsx) & [`ui/src/components/WorkstationDock.tsx`](../../ui/src/components/WorkstationDock.tsx):
  - Implemented **"Save Current Layout"**: Persists custom docking topology, split ratios, and tab decks to `localStorage`.
  - Implemented **"Restore Saved Layout"**: Loads previously saved layout profile.
  - Implemented **"Set to Default Layout"**: Clears custom configurations and rebuilds standard canonical workbench.







