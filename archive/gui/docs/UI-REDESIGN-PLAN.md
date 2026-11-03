# BaudForge UI Redesign Plan — Precision Engineering Workbench

**Status:** Implemented (2 November 2026, see `specs/0058-precision-workbench-ui.md`)  
**Design Philosophy:** Emil Kowalski Design Engineering (`/emil-design-eng`) + Modern Embedded Instrumentation (Saleae Logic 2, Foxglove Studio, Rerun.io, Linear)

---

## 1. Diagnosis: Why the Current UI Fails as an Engineering Tool

We do **not** use the current UI as a visual reference. A first-principles audit of `ui/src/App.tsx`, `ui/src/index.css`, and `ui/public/desktop.html` shows seven structural defects:

| Before (Current Implementation) | After (New Precision Workbench) | Why (`/emil-design-eng` & Engineering Ergonomics) |
| --- | --- | --- |
| `font: 12px/1.45 "JetBrains Mono"` applied globally on `:root` to all chrome, buttons, and headings | Dual-font system: `--font-sans` (`Inter` / system geometric sans) for UI chrome, controls, and labels; `--font-mono` (`JetBrains Mono`, `tabular-nums`) strictly for data, hex, timestamps, and metrics | When everything is monospace, nothing stands out. Separating UI chrome from data creates instant visual hierarchy and scannability. |
| `.ribbon` header dumps 15+ identical `border-radius: 999px` `.chip` pills; status indicators and action buttons look identical | Structured 3-zone **Instrument Topbar** (40px fixed height): Left = Workspace & Transport status LED + Segmented Mode Pill; Center = Global Transport / DVR Scrubber & Command Trigger (`Ctrl+K`); Right = Action Toolbar (`Yield`, `Diff`, `Export`) + Telemetry counters + Window Controls | Engineers must distinguish read-only hardware state from clickable actions in <100 ms without hunting through a wrapping row of pills. |
| Opening Session Diff (`showDiff`) injects `.diff-panel` inside `<header class="ribbon">`, pushing the entire app grid down | Dedicated **Slide-Over Drawer / Modal Sheet** anchored cleanly over the stage with `@starting-style` (`scale(0.97)`, `opacity: 0`, `180ms cubic-bezier(0.23, 1, 0.32, 1)`) | Layout shifts in a live telemetry monitor break eye tracking. Occasional overlays belong in an interruptible sheet, never expanding the titlebar. |
| Fixed `260px 1fr 340px` columns and a permanent `268px` bottom `.forge` band that consumes 30% of vertical height at all times | **Collapsible, Resizable Dock Architecture**: Left Hardware Rail (`240px`), Center Split Stage (Packet Stream + Oscilloscope Telemetry), Right Packet Dissector (`380px`), and a **Tabbed Bottom Console** (`Transmit Forge`, `Fault Matrix`, `Session Diff`, `Event Log`) that collapses to a 32px status bar when not transmitting | Maximize vertical space for the 10,000-row stream and multi-row oscilloscope. Keep transmit and fault tools one click or shortcut away without wasting screen real estate. |
| `.hex` renders flex-wrapped byte spans (`display: flex; flex-wrap: wrap; gap: 3px`) with no byte offsets and no ASCII column | **Canonical 3-Column Engineering Hex Inspector**: `Offset (0000)` \| `16 Hex Bytes (8 + 8 split)` \| `16-char ASCII Gutter`, with synchronized hover/selection highlighting across the Field Tree, Hex Bytes, and ASCII characters | Flex-wrapped bytes change row width when resized, making byte offset math impossible. Every embedded engineer expects canonical 16-byte rows with ASCII decoding. |
| Zero interactive feedback on buttons (`cursor: pointer` only; no `:active` transform, no custom easings, raw browser `<select>` and `<input type="range">`) | Tactile micro-interactions: `transform: scale(0.97)` on `:active` (`140ms var(--ease-out)`), custom styled segmented controls with `clip-path` / GPU `translateX` active pill, custom precision timeline scrubber, and gated `@media (hover: hover) and (pointer: fine)` states | Buttons and hardware toggles (`DTR`, `RTS`, `Pulse`, `Send`, `Arm`) must feel like physical instrument switches that acknowledge input immediately. |
| No stream filtering or search; finding a frame in a 10,000-frame buffer requires manual scrolling | **Instant Zero-Latency Stream Filter Bar** (filter by Port, Direction `RX`/`TX`, Protocol, Error-only, or hex/text substring) + **`Ctrl+K` Command Palette** (zero animation, instant open per `/emil-design-eng` 100+/day rule) | Navigating thousands of frames is a 100+/day action; it must be keyboard-first and instantaneous (`0ms` open delay). |

---

## 2. Visual Direction & Design Tokens

### 2.1 Color System: "Carbon & Phosphor"
Instead of muddy navy (`#0b0e14` / `#111621`), the workbench uses a neutral, high-contrast carbon-zinc surface hierarchy with subtle top-edge specular highlights (`--border-subtle`) so panels read as machined aluminum/carbon enclosures, reserving saturated color strictly for **signal semantics**:

```css
:root {
  /* Surfaces — neutral carbon hierarchy */
  --bg-canvas:       #090a0d; /* Deepest ground (stream & scope canvas) */
  --bg-surface-1:    #101217; /* Primary panels (sidebar, inspector, topbar) */
  --bg-surface-2:    #161920; /* Elevated cards, inputs, port modules */
  --bg-surface-3:    #1e222b; /* Hover & active control surface */
  --bg-glass:        rgba(22, 25, 32, 0.88); /* Popovers & command palette */

  /* Hairlines & Specular Borders */
  --border-hairline: #1f2430;
  --border-strong:   #2d3446;
  --border-highlight:rgba(255, 255, 255, 0.06);

  /* Typography */
  --text-primary:    #edf0f7;
  --text-secondary:  #949eb2;
  --text-muted:      #5e677a;

  /* Signal & Hardware Semantics */
  --sig-rx:          #10b981; /* Emerald — valid RX / Nominal / Live */
  --sig-rx-dim:      rgba(16, 185, 129, 0.12);
  --sig-tx:          #06b6d4; /* Cyan — TX / Forwarded / Selected byte */
  --sig-tx-dim:      rgba(6, 182, 212, 0.14);
  --sig-warn:        #f59e0b; /* Amber — Yielded / Reconnecting / Paused / Divergence */
  --sig-warn-dim:    rgba(245, 158, 11, 0.14);
  --sig-fault:       #f43f5e; /* Crimson — CRC fault / Overrun / Armed Fault / Crash symbol */
  --sig-fault-dim:   rgba(244, 63, 94, 0.14);
  --sig-symbol:      #a855f7; /* Violet — DWARF ELF symbol / Tokenized log hit */

  /* Typography Stacks */
  --font-sans: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  --font-mono: "JetBrains Mono", "Cascadia Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;

  /* Emil Kowalski Custom Easing Curves */
  --ease-out:     cubic-bezier(0.23, 1, 0.32, 1);
  --ease-in-out:  cubic-bezier(0.77, 0, 0.175, 1);
  --ease-drawer:  cubic-bezier(0.32, 0.72, 0, 1);
}
```

### 2.2 Typography & Density Rules
- **UI Chrome (`--font-sans`):**
  - Section headers: `11px`, `font-weight: 600`, `letter-spacing: 0.08em`, uppercase, `--text-muted`.
  - Control labels, tabs, buttons: `12px`, `font-weight: 500`, `--text-primary`.
- **Engineering Data (`--font-mono`, `font-variant-numeric: tabular-nums`):**
  - Stream table cells, hex dump, byte offsets, timestamps (`0.0042 s`), Δt (`+142 µs`), baud rates, and oscilloscope readouts: `12px/1.4`.
  - Micro-badges (`@0+4`, `CRC-16`, `0x080012a4`): `11px`.

---

## 3. Spatial Architecture: 4-Zone Instrument Layout

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ [● LIVE] BaudForge  [Record ▾] │ ◀◀ [▶] 1x [══════●══] 14.2s │ [⚡Yield] [⇄Diff] [⤓Export] [─ □ ×]│ <- 40px Topbar
├─────────────────┬────────────────────────────────────────────────────┬───────────────────┤
│ HARDWARE BAY    │ PACKET STREAM                        [Filter / ⌘K] │ PACKET INSPECTOR  │
│                 │ [All Ports ▾] [All Dir ▾] [🔍 Search hex, text…]   │                   │
│ ┌─────────────┐ │ #     Time (s)   Δt (µs)  Port  Dir  Protocol  Payload │ Frame #412 · sim0 │
│ │ ● sim0  OPEN│ │ 0410  012.4012       124  sim0  RX   MAVLink   FE 09 … │ ───────────────── │
│ │ 115200 · 8N1│ │ 0411  012.4018       610  sim0  TX   CMD       AA 55 … │ FIELD DISSECTOR   │
│ │ RX 14.2 MB  │ │ 0412▶ 012.4021       305  sim1  RX   CCSDS     18 01 … │ ▾ header          │
│ │ [DTR] [RTS] │ │ 0413  012.4029       812  sim0  RX   FAULT     FE 09 … │   · packet_id  24 │
│ │ [Pulse][Seq]│ ├────────────────────────────────────────────────────┤   · seq      1042 │
│ └─────────────┘ │ TELEMETRY OSCILLOSCOPE   [Stacked] [+ Trace ▾] [GL]│ ▾ payload         │
│                 │  3.3V ┤      ╭──╮    ╭───╮                         │   · temp_c   24.8 │
│ BRIDGES & TAPS  │  0.0V ┼──────╯  ╰────╯   ╰──────────────────────── │ ───────────────── │
│ ┌─────────────┐ │  STATE ▤▤▤▤▤▤░░░░░▤▤▤▤▤▤▤▤░░░░░░░░░░░░░░░░░░░░░░░░ │ HEX & ASCII DUMP  │
│ │ sim0 ↔ sim1 │ ├────────────────────────────────────────────────────┤ 0000: 18 01 C0 00 │
│ │ 48.2 kB fwd │ │ [Transmit Forge] [Fault Injector ●] [Diff] [Events]│ 0010: 00 08 41 C6 │
│ └─────────────┘ │ [HEX│TYPED] [AA 55 03          ] [CRC16▾] [Pace] [Send] │                   │
├─────────────────┴────────────────────────────────────────────────────┴───────────────────┤
│ ● Vault: session.bflog (14.5 MB) · ELF: firmware.elf · 10,000 buffered / 68,410 rx   120 fps│ <- 26px Status
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

### Zone 1: Instrument Topbar (40px)
- **Left Group (Identity & Session State):**
  - Live pulsing status dot (`--sig-rx` when connected & recording, `--sig-warn` when scrubbed/paused or yielded, `--sig-fault` when disconnected).
  - App title + active mode badge (`RECORD`, `REVIEW`, `IDLE`) and port count (`2/2 OPEN`).
  - Desktop shell session controls (`Switch Workspace`, `Stop`).
- **Center Group (Integrated DVR Scrubber & Transport Pod):**
  - Instead of burying the timeline scrubber inside the Telemetry header, the time-travel DVR controls live in a machined center pod: `[▶/⏸]`, `[1x/2x/4x]`, high-precision range track with time readout (`12.400 s / 60.0 s`), and a one-click `[● LIVE]` return button.
- **Right Group (Hardware Actions & Window Chrome):**
  - `[⚡ Yield 30s]` (amber accent button with `Ctrl+Y` shortcut hint).
  - `[⇄ Diff]` (opens the Session Diff drawer/tab).
  - `[⤓ Export ▾]` (clean popover menu for CSV, JSONL, Saleae CSV, PCAPNG).
  - Frameless window controls (`–`, `□`, `×`).

### Zone 2: Left Hardware Bay (`240px`, collapsible)
- **Port Modules:** Each port is a compact hardware card with:
  - Header: Port ID (`sim0`), device path badge (`COM8` or `mock:0`), and semantic state pill (`OPEN`, `YIELDED`, `RECONNECTING`, `CLOSED`).
  - 2×2 KPI micro-grid: `Baud / Framing` (`115200 · cobs`), `Throughput / Bytes` (`14.2 MB`), `Chunks` (`3,225`), and `Health` (`0 overruns · 0.0 ms stall`, turning `--sig-fault` only when non-zero).
  - **Pin Control Strip:** Tactile hardware switches for `DTR` and `RTS` (with LED indicator dots showing live pin state), `Pulse`, `Bootloader Seq`, and an expandable inline drawer for custom `PinStep` sequences (`DTR=0,RTS=1,50ms -> ...`).
  - **Input Line Status LEDs:** Compact indicator row for `CTS`, `DSR`, `DCD`, `RI`, `BRK`, `FRM`, `PAR` when active.
- **Bridges & Taps Section:** Visual bus cards showing `A ↔ B` directionality, forwarded byte counter, and drop indicator.

### Zone 3: Center Stage (Split Packet Stream + Oscilloscope + Bottom Console)
1. **Virtualized Packet Stream (Top Center):**
   - **Filter & Search Toolbar:**
     - Port filter pill (`All Ports` or per-port quick toggle).
     - Direction filter (`All`, `RX`, `TX`).
     - Status/Protocol filter (`All`, `Errors Only`, `Symbols Only`, or text/hex search input `/`).
     - Row counter (`1–28 of 10,000`) and `[● Follow Live]` button that highlights in amber when scrolled back.
   - **High-Density Data Grid (`ROW_HEIGHT = 26px`):**
     - Columns: `# (Seq)` | `Time (s)` | `Δt (µs)` | `Port` | `Dir` (`RX`/`TX` semantic badge) | `Len` | `Protocol / Summary` | `Payload (Hex or Decoded Preview)` | `ELF Symbol / Error Badge`.
     - Keyboard navigation: `↑` / `↓` / `PageUp` / `PageDown` / `Home` / `End` moves selection immediately with **0ms animation** (per `/emil-design-eng`).
2. **GPU Telemetry Oscilloscope (Middle Center, resizable/collapsible):**
   - Clean header bar with trace chips (color swatch + field name + `line`/`lane`/`bits` mode pill + `×`), `[Stacked / Overlay]` toggle, `[+ Add Trace ▾]` selector, and `WebGL2` / `Canvas2D` engine badge.
   - **Upgraded Canvas Overlay (`Telemetry.tsx`):**
     - Refined dark oscilloscope graticule with subtle dashed sub-divisions.
     - Crosshair readout box showing exact sample index and formatted values for every active trace at the cursor position.
     - Crisp digital logic analyzer lanes and bit rails below the analog waveforms.
3. **Tabbed Bottom Workbench Console (`Transmit Forge` | `Fault Injector` | `Session Diff` | `Events`):**
   - Can be collapsed to maximize stream/scope height or switched via tabs (`Ctrl+4`, `Ctrl+5`):
   - **Tab 1 — Command Forge (`Transmit`):**
     - Segmented mode toggle (`RAW HEX` vs `SCHEMA TYPED`) using GPU-accelerated active pill indicator.
     - Target port selector (allows sending to *any* open port, not only `ports()[0]`).
     - Hex editor input with live byte counter + CRC appendix selector (`None`, `CRC-8`, `CRC-16`, `CRC-32C`) + Paced Send controls (`Chunk B`, `Pace ms`) + primary `Send` button (`Enter`).
     - Recent TX history strip with one-click **Replay (`↻`)** button on every past transmission.
   - **Tab 2 — Fault Injector (`MITM / HIL`):**
     - Target port selector + Fault mode cards/pills (`Off`, `Bit Flip BER`, `Drop Nth`, `Truncate`, `Corrupt CRC`, `Latency / Jitter`) + parameter input + `Arm Fault` / `Disarm` button with active red hazard indicator in the topbar when armed.
   - **Tab 3 — Session Diff (`Compare Vaults`):**
     - Full-width comparison bar (`Vault A` vs `Vault B` + `Compare`), divergence summary banner, and virtualized/scrollable field-diff table where clicking a diverged frame seeks the timeline.
   - **Tab 4 — System Events (`Audit Log`):**
     - Timestamped session events, port state transitions, yield/export notifications, and script counters.

### Zone 4: Right Packet Dissector & Hex Inspector (`380px`)
- **Selected Frame Header:** Shows `Port`, `Direction`, `Timestamp`, `Payload Length`, and `Protocol` badge (or `Decode Error` banner in `--sig-fault-dim`).
- **DWARF Symbol / Token Callout:** When a frame hits an ELF address or `defmt`/`pw_tokenizer` token, renders a high-visibility purple/crimson source card (`function_name` at `file.rs:line` + `0xADDRESS`).
- **Interactive Protocol Field Tree (Top Half):**
  - Hierarchical tree with expand/collapse twisties, field name, formatted value (`--sig-rx`), byte range pill (`@offset+len`), and a one-click `[+ Plot]` action button on numeric fields.
  - Hovering any field node highlights its exact byte range in the Hex & ASCII Inspector below.
- **Canonical 16-Byte Hex & ASCII Inspector (Bottom Half):**
  - Paged in 512-byte windows for O(1) DOM cost, rendered in rows of 16 bytes:
    - Left gutter: hex offset (`0000`, `0010`, `0020`…).
    - Center grid: 16 hex bytes with an 8-byte visual split (`00 01 02 03 04 05 06 07  08 09 0A 0B 0C 0D 0E 0F`).
    - Right gutter: 16 printable ASCII characters (`.` for non-printable `0x00..0x1F` and `0x7F..0xFF`).
  - Bi-directional hover: hovering a field in the tree highlights the corresponding bytes and ASCII characters in cyan (`--sig-tx`); hovering a byte in the hex dump shows its offset, hex, decimal, and binary (`0b10100101`) tooltip.

---

## 4. `/emil-design-eng` Motion & Interaction Specification

Every animation decision follows Emil Kowalski's frequency and purpose rules:

| Interaction | Frequency | Motion Decision | Curve & Timing |
| --- | --- | --- | --- |
| Keyboard zone focus (`Ctrl+1..5`), stream row selection (`↑`/`↓`/click), filter typing, `Ctrl+K` palette open | 100+ times/day | **No animation (`0ms`).** Instant state change. | N/A |
| Button press (`Send`, `Yield`, `DTR`/`RTS`, `Pulse`, `Boot Seq`, `Compare`, `Arm`) | Tens of times/day | Tactile scale-down on `:active` (`transform: scale(0.97)`). | `transition: transform 140ms cubic-bezier(0.23, 1, 0.32, 1)` |
| Segmented control switch (`HEX` ↔ `TYPED`, Bottom Console Tabs, `Stacked` ↔ `Overlay`) | Tens of times/day | GPU-accelerated sliding pill indicator (`transform: translateX(...)`). | `transition: transform 180ms cubic-bezier(0.23, 1, 0.32, 1)` |
| Hover states on rows, buttons, hex bytes, and trace chips | Continuous | Subtle background/border shift gated behind `@media (hover: hover) and (pointer: fine)`. | `transition: background-color 120ms ease, border-color 120ms ease` |
| Popovers & Drawers (Custom Pin Sequence editor, Export menu) | Occasional | Origin-aware scale + opacity (`transform-origin: top left`, `scale(0.96)` -> `scale(1)`). | `transition: transform 160ms var(--ease-out), opacity 160ms var(--ease-out)` with `@starting-style` |
| Toast / Status Pill notifications (`yieldNote`, `exportNote`, `pinNote`) | Occasional | Slide + fade in from top-right (`translateY(-8px)` -> `0`, `opacity: 0` -> `1`), interruptible CSS transition. | `transition: transform 200ms var(--ease-out), opacity 200ms var(--ease-out)` |
| Reduced motion (`prefers-reduced-motion: reduce`) | Accessibility | Disable all `transform` transitions; preserve `opacity` and color changes (`120ms ease`). | `@media (prefers-reduced-motion: reduce)` |

---

## 5. Desktop Launcher (`ui/public/desktop.html`) Redesign

The standalone Tauri launcher (`desktop.html`) will be redesigned to match the workbench's "Carbon & Phosphor" industrial aesthetic:
- Frameless 40px instrument header with SVG window controls.
- Hero workspace card with three primary action tiles (**Open Workspace `.bforge.toml`**, **Launch Live Hardware/Socket Demo**, **Inspect Recorded `.bflog` Vault**).
- Recording destination selector bar (temporary vs chosen `.bflog` path) with clear visual state.
- Recent Workspaces list styled as clickable engineering project rows with path breadcrumb, `.bforge.toml` badge, and keyboard focus support.

---

## 6. Implementation & Verification Plan

### Phase 1: Design System & Token Foundation (`ui/src/index.css`)
1. Replace the legacy stylesheet with the new Carbon & Phosphor token system, dual-font typography (`--font-sans` + `--font-mono`), custom easing curves (`--ease-out`, `--ease-in-out`, `--ease-drawer`), tactile button states (`:active` `scale(0.97)`), `@media (hover: hover) and (pointer: fine)` guards, and `@media (prefers-reduced-motion: reduce)` rules.

### Phase 2: Workbench Component Architecture (`ui/src/App.tsx` & `ui/src/components/`)
1. **Topbar & DVR Pod:** Build the 3-zone instrument header with live status LED, DVR playback/scrubber pod, armed-fault warning badge, and action toolbar (`Yield`, `Diff`, `Export`, `WindowControls`).
2. **Left Hardware Bay:** Upgrade port cards with 2×2 KPI metrics, tactile `DTR`/`RTS`/`Pulse`/`Boot Seq` switches, input line-state indicators, and bridge/tap bus cards.
3. **Virtualized Stream + Instant Filter Bar:** Add Port, Direction (`RX`/`TX`), Protocol/Error filter controls and instant search above the 10,000-row virtualized table, plus `Ctrl+K` quick filter/command focus.
4. **Canonical 16-Byte Hex & ASCII Inspector:** Upgrade `HexDump` to render 16-byte rows (`Offset | 8+8 Hex | 16 ASCII`) with synchronized hover highlighting from `FieldNodeRow` and byte-level inspection tooltips (`Hex / Dec / Bin`).
5. **Tabbed Bottom Console:** Organize `Command Forge` (with target port selector and one-click TX replay), `Fault Injector`, `Session Diff`, and `Event Log` into a clean, collapsible bottom console while preserving all URL query parameters (`?typed=1`, `?plot=...`, `?at=...`, `?rows=stack`, `?play=1`, `?export=...`, `?review=1`, `?bridge=...`) and `data-zone` keyboard shortcuts (`Ctrl+1..5`, `Ctrl+Y`).

### Phase 3: Oscilloscope & Desktop Launcher Polish (`Telemetry.tsx`, `WindowControls.tsx`, `desktop.html`)
1. Update `Telemetry.tsx` overlay palette and crosshair readout to match the Carbon & Phosphor design tokens and render crisp SVG icons in `WindowControls.tsx`.
2. Redesign `ui/public/desktop.html` to share the exact same visual language.

### Phase 4: Build & Automated Verification
1. Run `npm run build` (`tsc -b && vite build`) in `ui/` and verify zero TypeScript or bundler warnings.
2. Run `cargo test --workspace --exclude bforge-gui` to verify all backend/UI contract tests pass.
3. Launch `bforge serve` and inspect the live rendered workbench across desktop and narrow viewports.
