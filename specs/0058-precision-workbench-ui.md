# 0058 — Carbon & Phosphor Precision Engineering Workbench Redesign

Status: implemented (2 November 2026).

## Problem

The initial workbench (`ui/src/App.tsx`, `ui/src/index.css`, `ui/public/desktop.html`) applied a single 12 px monospace font to every UI label and heading, grouped 15+ status badges and action buttons into identical pill chips inside a wrapping `<header>`, injected the Session Diff view directly inside the topbar (pushing the layout down), rendered raw hex bytes as flex-wrapped spans without byte offsets or an ASCII column, lacked stream filtering or keyboard command search, and permanently consumed 268 px of vertical height for the bottom forms.

## Design

Redesigned from first principles using the `/emil-design-eng` interaction framework and a **Carbon & Phosphor** industrial instrumentation palette (`docs/UI-REDESIGN-PLAN.md`):

1. **Dual-Font Typography & Carbon Surface Hierarchy (`ui/src/index.css`):**
   - Neutral carbon surfaces (`#090a0d` canvas, `#101217` primary panels, `#161920` elevated cards, `#1e222b` active controls) with `1px` hairlines (`#1f2430`) and subtle specular highlights (`rgba(255, 255, 255, 0.06)`).
   - `--font-sans` (`Inter` / geometric system sans) for UI chrome, headers, tabs, and controls; `--font-mono` (`JetBrains Mono`, `tabular-nums`) strictly for timestamps, hex dumps, byte offsets, and telemetry metrics.
   - Semantic signal colors reserved for hardware and protocol state: `--sig-rx` (`#10b981`), `--sig-tx` (`#06b6d4`), `--sig-warn` (`#f59e0b`), `--sig-fault` (`#f43f5e`), and `--sig-symbol` (`#a855f7`).

2. **`/emil-design-eng` Motion & Tactile Rules:**
   - **100+ times/day actions (`0ms` animation):** `Ctrl+K` Command Palette (`ui/src/components/CommandPalette.tsx`), stream filtering (`/`), and `↑`/`↓` frame row navigation execute instantaneously with zero transition delay.
   - **Tactile press response (`140ms cubic-bezier(0.23, 1, 0.32, 1)`):** Pressable controls apply `transform: scale(0.97)` on `:active:not(:disabled)`.
   - **Pointer guard & reduced motion:** Hover transitions are gated behind `@media (hover: hover) and (pointer: fine)` and disabled under `@media (prefers-reduced-motion: reduce)`.

3. **4-Zone Instrument Architecture (`ui/src/App.tsx`):**
   - **Zone 1 — 40 px Instrument Topbar:** Left status LED + session/port badges + armed fault indicator; Center machined DVR Scrubber & Transport Pod (`▶/⏸`, `1x/2x/4x`, range slider, time readout, `● live` snap); Right action toolbar (`⌘K`, `yield`, `diff`, `export`) + telemetry counters + SVG `<WindowControls />`.
   - **Zone 2 — Left Hardware Bay:** Port cards with a 2×2 KPI micro-grid (`Baud / Frame`, `Traffic`, `Chunks`, `Overruns / Stall`), live input line LEDs (`CTS`, `DSR`, `DCD`, `RI`, `BRK`, `FRM`, `PAR`), tactile pin switches (`dtr`, `rts`, `pulse`, `boot seq`, custom sequence drawer), and Bridge/Tap cards.
   - **Zone 3 — Center Stage (Filtered Virtualized Stream + Oscilloscope):**
     - Instant stream filter toolbar (Port selector, `all`/`rx`/`tx` direction filter, `all`/`errors`/`symbols` kind filter, and `/` substring search across hex, text, protocol, and field names).
     - Upgraded oscilloscope overlay (`ui/src/components/Telemetry.tsx`) with 8-division dashed time graticule, logic analyzer `bits`/`lane` gutter labels, and a multi-trace floating cursor readout HUD.
   - **Zone 4 — Right Packet Dissector & Canonical 16-Byte Hex/ASCII Inspector (`ui/src/components/InspectorPane.tsx`):**
     - Frame metadata summary card, decode error banner, and DWARF symbol callout.
     - Hierarchical protocol field tree with one-click oscilloscope plotting.
     - Canonical 3-column engineering hex dump (`Offset 0000` | `16 Hex Bytes (8+8 split)` | `16-char ASCII Gutter`) paged in 512-byte windows, with bi-directional hover highlighting and a live byte inspector bar (`Offset · Hex · Dec · Bin · ASCII`).
   - **Zone 5 — Collapsible Tabbed Bottom Console:**
     - Tabs for `Command Forge & Faults` (side-by-side Transmit Forge with target port selector + 1-click `↻` TX replay and Fault Injector with `Disarm`), `Session Diff`, and `Events`, plus a collapse toggle (`▼ collapse` / `▲ expand`) that shrinks the bottom row to `32px`.

4. **Desktop Instrument Launcher (`ui/public/desktop.html`):**
   - Redesigned to match the Carbon & Phosphor aesthetic with a 24 px CAD grid backdrop, 40 px frameless titlebar, 3 tactile action tiles (`Open Workspace`, `Launch Live Demo`, `Inspect Vault`), recording target bar, and `.bforge.toml` recent workspace cards.

## Verification

- `npm --prefix ui run build` (`tsc -b && vite build`) compiles cleanly with zero TypeScript or bundler warnings.
- `cargo test --workspace --exclude bforge-gui` passes all 330 workspace tests.
