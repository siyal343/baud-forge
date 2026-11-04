# BaudForge UI — Visual & Functional Audit Report

Date: 2026-11-04
Method: Live black-box GUI testing (in-app browser, 1920×1080, Vite dev server @ localhost:5173, simulation engine) + two static code audits (code-quality, feature-completeness vs specs).
Evidence: `.zcode/audit-shots/t01…t19.png` (19 viewed captures)

## Environment preparation (disclosed)
- Started Vite dev server (`pnpm run dev`, port 5173). No code was modified. Simulation engine provides the data stream; the Rust engine bridge was NOT running (this shaped several findings below).

---

## 1. Interactive walkthrough results

### PASS — verified working

| # | Test | Evidence |
|---|---|---|
| T1 | App boot: ribbon, 4 dock groups, stream flowing (ImuPacket decode, CRC OK), footer modem LEDs | ![initial](file:///F:/Datapack/Personal/Programa/baud-forge/.zcode/audit-shots/t01_initial_workstation.png) |
| T2 | Scope: 2-row ribbon, CH1/CH2/MATH/LOGIC stems, live canvas | ![scope](file:///F:/Datapack/Personal/Programa/baud-forge/.zcode/audit-shots/t02_scope_running.png) |
| T3 | RUN→STOP freeze: STOPPED badge (crimson), waveform frozen, stream keeps flowing (correct separation) | ![stopped](file:///F:/Datapack/Personal/Programa/baud-forge/.zcode/audit-shots/t03_scope_stopped.png) |
| T4 | MATH channel cycle to FFT: magenta spectrum, Dominant Peak 0.3 Hz | ![fft](file:///F:/Datapack/Personal/Programa/baud-forge/.zcode/audit-shots/t04_scope_math_fft.png) |
| T5 | Cursor placement via SET X1/X2 + canvas click: Δt 199,647 µs, 1/Δt 5.0 Hz (matches geometry math) | ![cursors](file:///F:/Datapack/Personal/Programa/baud-forge/.zcode/audit-shots/t09_cursors_placed.png) |
| T6 | **X2 drag regression (historic bug): X1 held position, Δt updated 199,647→273,852 µs, 3.7 Hz. No overlap jump.** | ![regression](file:///F:/Datapack/Personal/Programa/baud-forge/.zcode/audit-shots/t10_x2_drag_regression.png) |
| T7 | Command Forge ADD COMMAND modal: fields/colors/icons/modes render; saved chip appears, counter (4)→(5) | ![modal](file:///F:/Datapack/Personal/Programa/baud-forge/.zcode/audit-shots/t12_add_command_modal.png) ![saved](file:///F:/Datapack/Personal/Programa/baud-forge/.zcode/audit-shots/t13_command_saved.png) |
| T8 | Pin Sequencer: DTR toggle syncs footer DTR:1→0; ESP32 ROM bootloader macro loads 3-step strap sequence with confirmation | ![pins](file:///F:/Datapack/Personal/Programa/baud-forge/.zcode/audit-shots/t14_pin_sequencer.png) |
| T9 | UART modal: all 7 delimiter modes; LF apply propagates to ribbon badge, stream header, footer (`8N1 · lf`, `[COM8 115200 8N1 / LF]`) | ![uart](file:///F:/Datapack/Personal/Programa/baud-forge/.zcode/audit-shots/t15_uart_modal.png) ![applied](file:///F:/Datapack/Personal/Programa/baud-forge/.zcode/audit-shots/t16_uart_applied_lf.png) |
| T10 | FAULT arm + HIL Fault Rig panel: interlock banner, 5 primitives, BER slider, one-shot triggers render | ![fault](file:///F:/Datapack/Personal/Programa/baud-forge/.zcode/audit-shots/t18_burst_bad_crc.png) |
| T11 | LAYOUTS & PANELS: 4 presets, re-open closed panel list, save/restore/factory reset | ![layouts](file:///F:/Datapack/Personal/Programa/baud-forge/.zcode/audit-shots/t19_layouts_menu.png) |

### FAIL — observed live, root-caused in code

| # | Symptom | Root cause (code audit) |
|---|---|---|
| F1 | **TRANSMIT PAYLOAD silent no-op**: no TX row, footer TX counter frozen at 15.1 KB, no error (t11) | `CommandForge.tsx:302` discards `sendBytes` result; `engineApi.ts:98-113` swallows all errors, fetch has no timeout; **no toast/notification system exists in the entire UI**; `txBytes` is initialized once and no action ever writes it (`store:195`) — the footer TX counter can never move; `packetRate` is hardcoded 20 |
| F2 | **BURST 3 BAD CRC FRAMES produced zero bad rows** (t18) | `FaultRigView.tsx:54-68` fire-and-forget, discards result, then fabricates success message "Dispatched one-shot CRC corruption…" |
| F3 | **"CRC16: 0x0102" is not a CRC** — it is a byte sum (0xAA+0x55+0x01+0x02=0x0102). True CRC-16/CCITT-FALSE of that payload is 0xB4B8 | `CommandForge.tsx:266-275` implements sum for both "CRC-16-CCITT" and "CRC-32C" options; checksum is also never appended on send |
| F4 | Scope ribbon buttons time out under automated clicking (high re-render churn) | All 15 components subscribe selector-less to the store; sim ticks 20 Hz → whole tree re-renders 20×/s; OscilloscopeView rebuilds its rAF loop every tick |

### Cosmetic finding
- Panel tab title stays "PACKET STREAM (COBS)" after switching framing to LF (t16) — ribbon/footer update, tab title doesn't.
- Capture artifact noted: clipped screenshots show duplicated content (compositor stitch under CSS zoom); full-frame captures prove single rendering. Tooling caveat, not an app bug.

---

## 2. Code-quality audit (severity-ordered, all file:line verified)

### P1 — visible malfunctions
1. **TX path is an always-lie path** — result discarded, no timeout, no error surface; TX row appended locally regardless; footer TX counter structurally frozen (`CommandForge.tsx:302,317-332`; `engineApi.ts:98-113`; `store:195,418,446`; `StatusFooter.tsx:92`).
2. **Fault one-shots & pin sequences fabricate success** (`FaultRigView.tsx:54-68,18-43`; `PinSequencerView.tsx:72-90`).
3. **Fake CRC algorithms labeled CRC-16-CCITT / CRC-32C** — modular sums (`CommandForge.tsx:262-275`). Trust hazard for a serial tool.
4. **FileTransferView interval leaks past unmount** — closing the tab mid-transfer keeps spamming 5-byte frames to the port every 120 ms; post-unmount setTimeout can start a new interval (`FileTransferView.tsx:96-157,76-87`).
5. **SessionDiffView substitutes fabricated diff results when engine unreachable** — presented as real analysis (`SessionDiffView.tsx:44-68`). Same pattern: ElfSymbolView (hardcoded backtrace resolution, fake "3,842 DWARF Symbols"), SchemaDialectView (DECODE WIRE HEX ignores user input, returns canned arrays).
6. **20 Hz full-app re-render churn** — selector-less `useWorkstationStore()` in all 15 components; per-tick 10k-element array copies in `addPacket` (`store:404-422`); DvrTimelineBar O(n) `findIndex` per tick; global `setHoveredField` on every row hover.

### P2 — degradation (top items)
- `triggerFlashYield` can stack intervals (double-decrement, double-reclaim) (`store:351-362`).
- EventSource: no reconnect, no error surface, StrictMode double-subscribe race (`App.tsx:37-124`, `engineApi.ts:40-96`).
- CommandForge column-resize persists **pre-drag** width (stale closure) (`CommandForge.tsx:234-242`); periodic loops capture stale `handleSend` (port/format changes ignored) (`:346-351`).
- SeqId collisions (same-ms frames → duplicate React keys, wrong DVR stepping) (`App.tsx:88`, `CommandForge.tsx:318`).
- Timestamp epoch mix (epoch-ns vs boot-ns) leaks into CSV/JSONL exports (`engineApi.ts:251-290`).
- CSV export not comma-safe; Saleae export hardcodes 115.2k bit period (`engineApi.ts:250-269`).
- `onWheel` preventDefault is a React-passive no-op (`OscilloscopeView.tsx:822-826`).
- Space key hijacks button activation globally (a11y) (`App.tsx:162-170`).
- Dead store weight: `txBytes`, `packetRate`, `pausedTimestampUs`, `playbackSpeed`, `bitFlip/corruptCrc/dropRate`, `setFraming`, `setCursorT1/T2` — written-but-never-effective or never-called.
- Popout windows: drag handlers bind to main window (broken in popouts); `bforge_dock_layout` last-writer-wins race.

### Architecture health
Bones are sound (single Zustand store, clean packet contract, bounded buffers, real PCAP-NG writer). But the state layer is used pathologically: selector-less subscriptions + 20 Hz mutation = permanent full-tree re-render; and there is **no error/feedback channel anywhere** — every engine failure silently "succeeds". Three panels are facades over hardcoded data.

---

## 3. Feature completeness vs specs (handover + design docs)

**Verdict: 4 COMPLETE / 10 PARTIAL / 3 MISSING (+1 cross-cutting missing) — 1×P0, ~20×P1, ~40×P2**

- **P0 — hardware connection control plane absent**: connect/disconnect are local booleans; no rescan (`GlobalRibbon.tsx:156-161` dead button), no custom baud entry (spec 110–12 M free input), UART config never reaches the engine.
- **P1 highlights**: REC pill is a no-op (label renders `REC` in both states, `GlobalRibbon.tsx:499`); Flash Yield never calls `engineApi.yieldPort`; DVR historical replay doesn't exist (speed chips dead by consequence); stream direction/kind/port filters missing (spec 2.3); dissector "Plot in Oscilloscope" dead (`ProtocolDissector.tsx:116-123`); scope is hard-wired to CH1/CH2 with **synthetic data even in HW mode** (`simulationEngine.ts:212-228` called from `store:410,433-434` — a correctness hazard for a measurement instrument); Workflow B (scope click → stream/hex sync) not implemented; checksum never appended; Struct-Form TX mode missing; MITM/bridge tooling absent product-wide; UART BREAK + auto-baud-detect absent.
- **Facades**: FileTransferView (interval animation, no file I/O, "SPEED (EST.)" hardcoded "11.5 KB/s"), ElfSymbolView (2 hardcoded addresses), SchemaDialectView (APPLY = 3-second toast only).
- **Fully real**: WorkstationDock (presets/save/restore/popouts), TooltipOverlay, HexInspector, PinSequencer.
- No TODO/FIXME markers exist anywhere — none of this is flagged in-code.
- localStorage: symmetric except `bforge_cmd_col_width` stale-closure bug.

---

## 4. Priority fix list

1. **Feedback channel first**: global toast fed by checked `engineApi` results; add fetch timeout/AbortController. (Fixes the entire "silent no-op" class.)
2. **Selector-based Zustand subscriptions** (or transient updates for stream data) — kills the 20 Hz full-tree churn, the Playwright flakiness, and most perf risk.
3. **Real CRC implementations** (CRC-16/CCITT-FALSE, CRC-32C, add CRC-8/MODBUS) + append-on-send per spec.
4. **FileTransferView interval cleanup on unmount** (ghost port traffic today).
5. **Wire the control plane**: connect/disconnect/rescan/yield/REC → engine endpoints; scope data from decoded payloads (never fabricate in HW mode).
6. Kill fabricated-data fallbacks (SessionDiff/Elf/Schema) — show explicit "engine unreachable" states instead.
