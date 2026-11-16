# BaudForge Feature User-Flow Diagrams (Brainstorm)

**Date:** 2026-11-16  
**Source:** Panel catalog in [`ui/src/components/GlobalRibbon.tsx`](ui/src/components/GlobalRibbon.tsx#L40-L56) (`PANEL_CATALOG`, 15 panels across 3 tiers) + Launcher / DVR / Flash Yield.

This document maps how a user actually enters, operates, and exits each BaudForge feature so we can spot friction, redundant steps, and onboarding gaps.

---

## 0. Master Entry & Session Lifecycle (Launcher, Flash Yield, DVR, Vaults)

```mermaid
flowchart LR
    A["Open BaudForge (Launcher)"] --> B{"Target Mode?"}
    B -->|"Hardware Port"| C["Select Serial Port + Baud/8N1"]
    B -->|"No Hardware"| D["Start Simulated Mode"]
    B -->|"Replay File"| E["Open .bflog Vault"]
    C --> F["Connect -> Core 4-Panel Workbench"]
    D --> F
    E --> G["Scrub DVR Timeline & Inspect"]

    F --> H{"Need to Flash MCU?"}
    H -->|"Yes"| I["Click Flash Yield (Release Port)"]
    I --> J["Run External Programmer"]
    J --> K["Re-Attach Port (Keep Logs & Layout)"]

    F --> L["Toggle REC -> Write .bflog Vault"]
    L --> M["Export (PCAPNG / CSV / JSONL / Saleae)"]
```

---

## 1. Core Daily Workbench (Tier 1)

### 1.1 Packet Stream (`packetStream`)
```mermaid
flowchart LR
    A["Live RX/TX Bytes"] --> B["Framer (COBS / SLIP / Delimiter / Fixed)"]
    B --> C["Virtualized Packet List"]
    C --> D["Filter by Port / Direction / Search"]
    C --> E["Click Packet Row"]
    E --> F["Updates Protocol Dissector"]
    E --> G["Toggle HEX PANE (Inline Hex+ASCII)"]
    G -->|"Optional"| H["Pop Out to Hex Inspector Tab"]
```

### 1.2 Protocol Dissector (`protocolDissector`)
```mermaid
flowchart LR
    A["Select Packet in Packet Stream"] --> B{"Schema Loaded?"}
    B -->|"No"| C["Open Schema Dialects (.h / .proto / MAVLink)"]
    C --> D["Decoded Field Tree"]
    B -->|"Yes"| D
    D --> E["Inspect Field Values & Bitfields"]
    D --> F["Click Plot / Bind on Numeric Field"]
    F --> G["Streams Field to Oscilloscope / Plot Forge"]
```

### 1.3 Telemetry Oscilloscope (`oscilloscope`)
```mermaid
flowchart LR
    A["Bind Numeric Fields or script:series"] --> B["Live Time-Domain Waveform"]
    B --> C["Set Edge Trigger / Timebase / Pause"]
    C --> D["Inspect Glitch or Step Response"]
    D -->|"Need FFT / XY / Math"| E["Click PLOT STUDIO (Switch to Plot Forge)"]
```

### 1.4 Command Forge (`commandForge`)
```mermaid
flowchart LR
    A["Choose Input Mode"] --> B["Preset Macro Button"]
    A --> C["Raw ASCII / Spaced Hex"]
    A --> D["Struct-Aware Field Form"]
    B --> E["Optional Checksum / Delimiter Append"]
    C --> E
    D --> E
    E --> F["Send TX (Single or Repeat Interval)"]
    F --> G["Appears in Packet Stream & .bflog"]
```

---

## 2. Telemetry, Hex & Symbols (Tier 2)

### 2.1 Plot Forge (`plotForge`)
```mermaid
flowchart LR
    A["Add Channels (Dissected Fields / script:series)"] --> B["Choose Chart Type (Time / FFT / XY / Histogram)"]
    B --> C["Write Math Expression (e.g. v * i / 1e6)"]
    C --> D["Inspect Multi-Chart Cursor & Spectrum"]
    D -->|"Need Live DSO Trigger"| E["Click DSO SCOPE (Switch to Oscilloscope)"]
```

### 2.2 Canonical Hex & ASCII (`hexInspector`)
```mermaid
flowchart LR
    A["Select Packet (or Pop Out from Packet Stream)"] --> B["View 16-Byte Canonical Hex + ASCII"]
    B --> C["Click Byte Offset"]
    C --> D["Inspect Endian Interpretations (u8/u16/u32/f32)"]
```

### 2.3 Schema Dialects (`schemaDialects`)
```mermaid
flowchart LR
    A["Open Schema Dialects"] --> B["Select Dialect (.h C-Struct / .proto / MAVLink / Kaitai)"]
    B --> C["Load or Paste Schema Definition"]
    C --> D["Compile Schema to Dissector IR"]
    D --> E["Auto-Decodes Packet Stream, Dissector & Lua frame:get()"]
```

### 2.4 ELF Symbol & Crash Trace (`elfSymbols`)
```mermaid
flowchart LR
    A["Load Firmware .elf File"] --> B["Parse Symbol Table & DWARF Lines"]
    B --> C["Paste Hex Crash PC / Backtrace Address"]
    C --> D["Resolve Function Name + Source File:Line"]
```

### 2.5 Session Diff & Comparison (`sessionDiff`)
```mermaid
flowchart LR
    A["Select Golden Baseline .bflog"] --> B["Select Candidate .bflog"]
    B --> C["Run Diff"]
    C --> D["Compare Frame Count, Payload Diffs & Timing Jitter"]
```

---

## 3. HIL, Scripting & Specialist (Tier 3)

### 3.1 Lua 5.4 Script Lab (`scriptLab`)
```mermaid
flowchart LR
    A["Pick Template/Tutorial or Load .lua"] --> B["Read Summary Strip (Hook + Purpose)"]
    B --> C["Select Target (Packet Stream Row or Custom Hex)"]
    C --> D["Click DRY-RUN PACKET (Ctrl+Enter)"]
    D --> E["Inspect Verdict, Byte Diff Grid, Field Diff & VM Cost"]
    E -->|"Logic Wrong"| A
    E -->|"Looks Good"| F["Open VM & FILE (Policy: Fail-Open/Closed, Seed)"]
    F --> G["Click ARM ON LIVE BUS"]
    G --> H["Monitor LIVE VM & WATCH (Counters, Metrics, Assertions, Logs)"]
    H --> I["Click DISARM when Done"]
```

### 3.2 HIL Fault Injection Rig (`faultRig`)
```mermaid
flowchart LR
    A["Flip Master Safety Interlock (SAFE -> ARMED)"] --> B["Pick Fault Profile (Bit Flip / Drop / Corrupt CRC / Truncate / Delay)"]
    B --> C["Click Apply Live Mutation"]
    C --> D["All Outgoing TX / Bridge Frames Corrupted"]
    D --> E["Observe DUT Recovery in Packet Stream"]
    E --> F["Disarm Faults to Restore Clean Link"]
```

### 3.3 Pin Sequencer & Modem Lines (`pinSequencer`)
```mermaid
flowchart LR
    A["Open Pin Sequencer"] --> B{"Quick Action or Custom?"}
    B -->|"Quick"| C["Click Reset or Bootloader Macro (DTR/RTS)"]
    B -->|"Custom"| D["Build Timed Pin Sequence (DTR/RTS + Hold ms)"]
    C --> E["Hardware Lines Pulsed on Serial Adapter"]
    D --> E
```

### 3.4 X/YMODEM File Transfer (`fileTransfer`)
```mermaid
flowchart LR
    A["Put Target MCU in Bootloader Mode (via Pin Sequencer)"] --> B["Select Firmware Binary (.bin)"]
    B --> C["Choose Protocol (XMODEM / YMODEM)"]
    C --> D["Start Transfer -> Watch Block Progress & Retries"]
    D --> E["Transfer Complete -> Reset MCU"]
```

### 3.5 MITM Bridge & Relay (`bridge`)
```mermaid
flowchart LR
    A["Connect Port A (Host/Controller) & Port B (Device/Sensor)"] --> B["Enable Dual-Port MITM Bridge"]
    B --> C["Frames Forward A <-> B Live"]
    C -->|"Optional"| D["Attach Lua on_mitm_frame or Fault Rig"]
    D --> E["Mutate / Delay / Drop In-Flight Frames"]
```

### 3.6 Activity Log (`activityLog`)
```mermaid
flowchart LR
    A["Engine / UI / Script / Fault Events Occur"] --> B["Appended to Structured Event Stream"]
    B --> C["Filter by Severity or Source"]
    C --> D["Diagnose Port Disconnects, Script Errors or Fault Triggers"]
```

---

## 4. Placement & Overlap Analysis

### 4.1 Where These Diagrams Benefit Most
- **Best Primary Home — Docs Site (`docs/src/workflows.md` -> `docs/site/workflows.html`):**
  - The docs site currently documents each of the 20+ panels in isolation, but new users need **task-based end-to-end flows** (*"Which panels do I use together to flash an MCU, debug a binary struct, or test fault recovery?"*).
  - Linking `workflows.html` from `index.html` and from individual panel pages gives users the big picture without adding weight to the desktop app.
- **Keep the App UI Lightweight:**
  - Avoid embedding a heavy diagram viewer inside the dockable workbench (which was already streamlined from 13 panels down to 4 in `PRODUCT_BLOAT_AND_USAGE_ANALYSIS.md`).
  - Instead, keep **in-app guidance local and minimal**: concise `HOW IT WORKS` strips inside complex panels (like `ScriptLabView.tsx`) plus a `? Docs` link to the docs site.

### 4.2 Observed Flow Overlaps & Concrete Suggestions
1. **`Oscilloscope` (`3,588` LOC) vs `Plot Forge` (`2,926` LOC):**
   - *Overlap:* Both start with *"Bind Dissected Fields or `script:series` -> Inspect Graph"* and share `PlotEngine`.
   - *Suggestion:* Long-term, merge into one **Plotter** panel with mode tabs (`Live Scope` | `FFT / XY / Math`) to remove "which plotter?" ambiguity and cut ~2,500+ UI LOC. Short-term, keep the `PLOT STUDIO` / `DSO SCOPE` toggle buttons prominent.
2. **`HIL Fault Rig` (`360` LOC) vs `Lua Script Lab` (`1,126` LOC):**
   - *Overlap:* Both inject bit-flips, drops, CRC errors, and delays.
   - *Suggestion:* Position `Fault Rig` as **No-Code TX Faults** and `Script Lab` as **Programmable RX/TX/MITM Logic**. Either demote `QUICK FAULTS` in `ScriptLabView` to a simple `Fault Rig ↗` link or label it clearly as non-Lua TX shortcuts.
3. **`Hex Inspector` (`482` LOC) standalone vs `Packet Stream` inline `HEX PANE`:**
   - *Overlap:* Users almost always enter hex inspection by clicking a row in `Packet Stream`.
   - *Suggestion:* Keep `Hex Inspector` as a pop-out target from `Packet Stream` rather than a primary workflow entry.
4. **Add 3 Goal-Oriented "Recipe Flows" to Docs & Layout Presets:**
   - **Recipe A — Bring-Up & Flash:** `Pin Sequencer` (Bootloader) -> `X/YMODEM` or `Flash Yield` -> `Pin Sequencer` (Reset) -> `Packet Stream`.
   - **Recipe B — Binary Telemetry Debug:** `Schema Dialects` (`.h`) -> `Packet Stream` + `Protocol Dissector` -> `Oscilloscope` / `Plot Forge`.
   - **Recipe C — Fault & Crash Triage:** `Fault Rig` / `Script Lab` + `MITM Bridge` -> `Packet Stream` -> `ELF Symbols` (resolve crash PC).

