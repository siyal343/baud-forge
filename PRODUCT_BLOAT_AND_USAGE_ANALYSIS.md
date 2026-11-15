# BaudForge Product Fit, Feature Utilization & Bloat Analysis

**Date:** 2026-11-16  
**Scope:** Full repository architecture & UI surface audit (`crates/`, `ui/src/`, `ui/dist/` / CI artifacts)  
**Measurement Note:** Line counts below were measured with PowerShell `Get-Content <file> | Measure-Object -Line` (non-empty lines; physical line count in `WorkstationDock.tsx`, for comparison, is `853` lines vs `757` measured lines). Byte sizes are exact on-disk file lengths. Workflow usage frequencies in §4 are engineering estimates contrasted against measured code/UI footprint.

---

## 1. Measured Codebase & Surface Area Footprint

| Layer / Crate / Module | Measured Files | Measured LOC (`Measure-Object -Line`) | Share / Exact Binary Size | Role |
| :--- | ---: | ---: | ---: | :--- |
| **Rust Workspace Total (`crates/`)** | **88** | **37,334** | — | Native engine, dissectors, Lua VM, HAL, storage, desktop shell |
| `bforge-core` | 39 | 17,584 | 47.1% of Rust | Session pump, SPMC pipelines, bridges, fault injector, HTTP/SSE server, telemetry |
| `bforge-dissect` | 12 | 5,930 | 15.9% of Rust | C-header, Protobuf, Kaitai/MAVLink compilers, IR VM, field encoder |
| `bforge-script` | 4 | 5,283 | 14.2% of Rust | Embedded Lua 5.4 (`mlua`), `LuaFrame` `UserData`, timers/pins/plot/assert, xmodem |
| `bforge-storage` | 8 | 1,695 | 4.5% of Rust | Binary `.bflog` vault writer/reader, index, PCAPNG/CSV/JSONL/Saleae export |
| `bforge-cli` | 4 | 1,611 | 4.3% of Rust | Headless CLI (`serve`, `record`, `replay`, `diff`, `assert`, `repair`, `tail`) |
| `bforge-elf` | 6 | 1,583 | 4.2% of Rust | ELF/DWARF parser & address symbolizer (`addr2line`) |
| `bforge-framer` | 8 | 1,474 | 4.0% of Rust | COBS, SLIP, delimiter, fixed-length framers, CRC-8/16/32 |
| `bforge-hal` | 5 | 1,141 | 3.1% of Rust | Serial port enumeration, modem lines (`DTR`/`RTS`/`CTS`), TCP/UDP transports |
| `bforge-desktop` | 2 | 1,033 | 2.8% of Rust | Tauri desktop wrapper & native launcher commands |
| **UI Source Total (`ui/src/`, `.ts`/`.tsx`/`.css`)** | — | **30,657** | — | React 19 + Dockview workbench, WebGL/2D plotters, offline simulators |
| **Combined Codebase (`crates/` + `ui/src/`)** | — | **67,991** | — | — |
| **Shipped Windows Desktop Binary (`bforge-desktop.exe`)** | 1 | — | `13,241,344` B (`12.63 MiB`) | Compiled desktop binary |
| **Shipped Windows CLI Binary (`bforge-windows-x86_64.exe`)** | 1 | — | `4,813,312` B (`4.59 MiB`) | Standalone headless CLI |
| **Shipped UI JS Bundle (`index-DHpNpOy1.js`)** | 1 | — | `1,247,679` B (`1.19 MiB`) | Single Vite bundle (`2114` modules) |
| **Shipped UI CSS Bundle (`index-DbwjnwII.css`)** | 1 | — | `209,603` B (`204.7 KiB`) | Compiled Tailwind + Dockview styles |

### Top UI Components & Support Modules (Measured LOC)

| File (`ui/src/...`) | Measured LOC | Bytes | Category |
| :--- | ---: | ---: | :--- |
| `components/OscilloscopeView.tsx` | 3,588 | 150,750 | Real-time DSO waveform/logic plotter |
| `services/luaSandboxFallback.ts` | 3,524 | — | Custom TypeScript Lua 5.4 interpreter & 20 templates (browser offline fallback) |
| `components/PlotForgeView.tsx` | 2,926 | 119,388 | Second multi-chart plotting workbench (FFT/XY/Histogram/Expressions) |
| `store/useWorkstationStore.ts` | 1,268 | — | Global workstation state store |
| `components/CommandForge.tsx` | 1,224 | 54,592 | Command button grid, raw hex/ASCII & struct TX payload builder |
| `components/ScriptLabView.tsx` | 1,126 | 51,745 | Lua 5.4 Script Lab editor, dry-run diff & metrics panel |
| `services/engineApi.ts` | 1,019 | — | HTTP/SSE engine API client + offline fallback routing |
| `components/Launcher.tsx` | 959 | 39,790 | Workspace launcher, port hotplug scanner & recording folder setup |
| `plot/engine.ts` | 855 | — | Unified plot sample ingestion, expression & FFT cache |
| `components/PacketStreamView.tsx` | 765 | 33,562 | Virtualized packet stream + inline `<HexInspector embedded />` split |
| `components/WorkstationDock.tsx` | 757 *(853 raw)* | 30,449 | Dockview manager, presets (`Default`, `Dissector`, `Scope`, `HIL`) |
| `components/GlobalRibbon.tsx` | 705 | 32,680 | Top bar (`PANEL_CATALOG` lists **15** panels) |
| `store/usePlotStore.ts` | 637 | — | Multi-chart state & persistence |
| `components/SettingsModal.tsx` | 532 | 24,047 | Settings modal |
| `components/HexInspector.tsx` | 482 | 22,115 | Standalone/embedded canonical 16-byte hex + ASCII inspector |
| `components/FileTransferView.tsx` | 430 | 19,654 | X/YMODEM firmware upload manager |
| `components/ElfSymbolView.tsx` | 385 | 16,589 | ELF symbol table & crash PC-to-symbol resolver |
| `components/FaultRigView.tsx` | 360 | 16,645 | Static HIL fault injection controls |
| `components/SchemaDialectView.tsx` | 336 | 14,697 | Schema loader (`.h`, `.proto`, MAVLink/Kaitai) |
| `components/PinSequencerView.tsx` | 319 | 15,555 | Timed DTR/RTS GPIO sequencer & bootloader strap macros |
| `components/SessionDiffView.tsx` | 240 | 11,363 | Golden `.bflog` vault comparison & jitter diff |
| `components/ActivityLogView.tsx` | 197 | 9,067 | Engine/UI/Script structured event log |
| `components/ProtocolDissector.tsx` | 197 | 9,289 | Tree field decoder with Plot Forge & Scope channel binding |
| `components/BridgePanel.tsx` | 194 | 8,982 | Dual-port MITM bridge status & frame counters |
| `components/DvrTimelineBar.tsx` | 180 | 7,025 | DVR live pause, buffer scrub & replay bar |

---

## 2. Where BaudForge Might Be Used

BaudForge is not competing with simple serial terminals (`PuTTY`, `Tera Term`, `minicom`, VS Code Serial Monitor). It targets workflows where **binary protocols, hardware timing, repeatability, and automated fault testing** converge on one desk:

### High-Fit Target Domains
1. **Aerospace, CubeSat & Avionics Subsystem Integration (Best Fit):**
   - Testing OBDH/EPS/ADCS UART/RS-422/CAN buses with C-struct or XTCE/MAVLink telemetry, COBS framing, CRC-8/16/32 checks, **MITM Bridge + Lua SEU bit-flip/delay injection**, and **Flash Yield** (releasing the COM port temporarily so an external programmer can flash the flight MCU without losing logs or layout).
2. **Robotics, Drones, Gimbal & Motor Control Tuning:**
   - Streaming high-rate (`115.2 kbaud`–`12 Mbaud`) fixed-point/float IMU & FOC telemetry, decoding C structs live in `ProtocolDissector`, plotting `OscilloscopeView` (DSO edge trigger) or `PlotForgeView` (FFT resonance/expressions like power `v * i / 1e6`), and scrubbing **DVR Timeline** back to the exact millisecond an oscillation began.
3. **Hardware-in-the-Loop (HIL) & Automated Regression CI Benches:**
   - Using headless `bforge` CLI + Lua 5.4 (`on_rx_frame`, `on_timer`, `bforge.send` virtual responder, `bforge.assert`, `bforge.pulse_pin`, `.bflog` golden vaults, `bforge diff` / `bforge assert`) in automated test racks or overnight stress rigs.
4. **Industrial Fieldbus & Legacy Bootloader Bringing-Up:**
   - Intercepting RS-485/Modbus RTU (`crc16_modbus`) traffic via dual adapters (`BridgePanel` + Lua script), debugging framing glitches (`COBS`/`SLIP`), toggling ESP32/STM32 `DTR`/`RTS` bootloader straps (`PinSequencerView`), and pushing firmware over `X/YMODEM` (`FileTransferView`).

### Poor-Fit / Overkill Scenarios
- **Plain-text `printf` debugging / AT-command bring-up / Linux serial console:** An engineer only reading ASCII log lines needs a `< 5 MB` lightweight serial monitor (`tio`, `picocom`, VS Code Serial Monitor), not a 15-panel workstation with two WebGL/Canvas plotters, a Lua VM, and a DVR binary vault.

---

## 3. Why It Currently Feels Bloated (4 Measured Root Causes)

1. **Everything Opens at Once (`WorkstationDock.tsx:396-511`):**  
   `PANEL_CATALOG` in `GlobalRibbon.tsx:32-48` registers **15 panels**, and `buildDefaultLayout` mounts **13 of those 15 panels simultaneously** on first launch across 4 Dockview tab groups (`packetStream` | `protocolDissector` + `elfSymbols` + `schemaDialects` | `hexInspector` + `sessionDiff` | `oscilloscope` + `plotForge` + `commandForge` + `pinSequencer` + `faultRig` + `scriptLab` + `fileTransfer`). Seeing 13 tabs, top ribbon (`GlobalRibbon.tsx`), DVR bar (`DvrTimelineBar.tsx`), and status footer (`StatusFooter.tsx`) immediately signals clutter even before pressing a button.
2. **Three Overlapping Feature Pairs:**
   - **Two Full Plotters (`OscilloscopeView.tsx` 3,588 LOC + `PlotForgeView.tsx` 2,926 LOC = 6,514 LOC):** Both consume `PlotEngine` (`855` LOC) and plot decoded packet fields/script series. Together they represent **`21.2%` of all `ui/src` code** (`6,514 / 30,657`).
   - **Two Fault Injectors (`FaultRigView.tsx` 360 LOC + `ScriptLabView.tsx` 1,126 LOC):** Both handle CRC corruption, bit-flips, drops, and delays—one via static UI toggles, one via programmable Lua.
   - **Two Hex Inspectors (`HexInspector.tsx` 482 LOC standalone tab + inline `HEX PANE` inside `PacketStreamView.tsx` 765 LOC):** `PacketStreamView` already embeds `<HexInspector embedded />` and supports `DECODED | HEX+ASCII | BOTH` payload modes, making a separate default `hexInspector` dock tab redundant for most workflows.
3. **Browser-Side Re-Implementation of Backend Engines (`3,960` LOC):**
   - `ui/src/services/luaSandboxFallback.ts` (`3,524` LOC, **11.5% of all `ui/src` code**) re-implements a full Lua 5.4 tokenizer/interpreter in TypeScript alongside `bforge-script` (`5,283` LOC in Rust).
   - `ui/src/services/cStructParser.ts` (`225` LOC) + `simulationEngine.ts` (`211` LOC) duplicate struct parsing/telemetry generation in the browser alongside `bforge-dissect` (`5,930` LOC in Rust).
   - Because Vite compiles everything into a single chunk (`index-DHpNpOy1.js` = `1,247,679` B), every user loads the offline Lua VM and both plotters on boot.
4. **Persona Mixing Without Progressive Disclosure:**
   Everyday serial tasks (`connect`, `send command`, `view hex/struct`) share primary screen real estate with specialist aerospace/HIL verification tools (`Session Diff`, `MITM Bridge`, `X/YMODEM`, `ELF Crash Trace`, `Fault Rig`, `Script Lab`).

---

## 4. How Much Does a Regular Embedded Engineer Actually Use?

Considering a "regular embedded engineer" (MCU firmware bring-up on STM32/ESP32/nRF/RP2040, driver debugging, sensor integration, occasional protocol/telemetry work):

- **Daily Core:** **~30–35%** of panels (`4–5` of `15` panels)
- **Daily + Weekly Regular Toolbox:** **~55–60%** of panels (`8–9` of `15` panels, counting only **1** plotter and **1** hex view)
- **Specialist / HIL / Rarely Touched:** **~40–45%** of panels (`6–7` of `15` panels + the heavyweight Lua VM & second plotter UI)

| Tier & Estimated Usage Frequency | Panel / Feature | Measured LOC (`UI` + `Rust`) | Regular Embedded Engineer Reality |
| :--- | :--- | :--- | :--- |
| **Tier 1: Daily** *(80–90% of sessions)* | Port Connect / Hotplug / UART Framing / **Flash Yield** | `Launcher.tsx` `959`, `UartConfigModal.tsx` `286`, `bforge-hal` `1,141` | **Used constantly.** Flashing without closing the serial terminal (`Flash Yield`) solves an everyday embedded annoyance. |
| **Tier 1: Daily** *(80–90% of sessions)* | `PacketStreamView` (with inline `HexInspector`) | `PacketStreamView.tsx` `765`, `HexInspector.tsx` `482`, `bforge-framer` `1,474` | **Core daily driver.** Mixed ASCII + binary/COBS framing and click-to-inspect hex beat raw terminal hex dumps. |
| **Tier 1: Daily** *(80–90% of sessions)* | `CommandForge` (Preset buttons, Hex/ASCII/Struct TX) | `CommandForge.tsx` `1,224` | **Used every day.** Custom one-click buttons and struct-aware payload packing replace brittle Python quick-scripts. |
| **Tier 1: Daily** *(60–80% of sessions)* | Basic `DTR`/`RTS` Reset (`PinSequencerView` macros) | `PinSequencerView.tsx` `319` | **Frequent** during board bring-up / bootloader strapping, though usually just 2 buttons (`Reset`, `Bootloader`) rather than full multi-step timing tables. |
| **Tier 2: Weekly** *(20–40% of sessions)* | `ProtocolDissector` + `.h` C-Struct Schema (`SchemaDialectView`) | `ProtocolDissector.tsx` `197`, `SchemaDialectView.tsx` `336`, `bforge-dissect` `5,930` | **High value** whenever debugging a custom binary packet protocol; C-header import fits normal firmware codebases directly. *(Protobuf/Kaitai dialects are used much less often.)* |
| **Tier 2: Weekly** *(20–40% of sessions)* | **One** Plotter (`OscilloscopeView` **or** `PlotForgeView`) | `OscilloscopeView.tsx` `3,588` **or** `PlotForgeView.tsx` `2,926` + `plot/` `2,038` | Used for PID/ADC/IMU tuning (`20%–30%` of weeks). **Nobody needs two 3,000-LOC plotters open side-by-side** for ordinary work. |
| **Tier 2: Weekly** *(15–30% of sessions)* | DVR Pause/Scrub (`DvrTimelineBar`) + Vault Recording/Export | `DvrTimelineBar.tsx` `180`, `VaultExportModal.tsx` `338`, `bforge-storage` `1,695` | Used when catching intermittent glitches or exporting a CSV/PCAPNG capture for a bug ticket. *(Recording is already inactive by default.)* |
| **Tier 3: Monthly** *(5–15% of sessions)* | `ElfSymbolView` (Crash Trace Resolver) | `ElfSymbolView.tsx` `385`, `bforge-elf` `1,583` | Niche but handy when an MCU outputs hex fault/PC addresses without an attached SWD/JTAG debugger. |
| **Tier 3: Monthly** *(5–15% of sessions)* | `ScriptLabView` (Virtual Responder / Auto-ACK / Filter) | `ScriptLabView.tsx` `1,126`, `luaSandboxFallback.ts` `3,524`, `bforge-script` `5,283` | Extremely useful during **host-less sensor/device bring-up** or regression tests; untouched during routine firmware printf/command work. |
| **Tier 4: Specialist HIL** *(<5% of regular sessions)* | `FaultRigView`, `BridgePanel` (Dual-UART MITM), `SessionDiffView`, `FileTransferView` (X/YMODEM), Lua SEU/Glitch | `FaultRigView` `360`, `BridgePanel` `194`, `SessionDiffView` `240`, `FileTransferView` `430` | Built for **aerospace/safety HIL validation, legacy factory bootloaders, and automated CI fault injection**—rarely used on a standard embedded desk. |

---

## 5. How to Make BaudForge Feel Lean Again (3 Concrete Options)

1. **Level 1 — Layout & Progressive Disclosure (Zero Feature Loss, Fastest Win):**
   - Change `buildDefaultLayout` (`WorkstationDock.tsx:396-511`) from **13 open panels** down to **4 panels**:
     - Left: `PacketStreamView` (with inline `HexInspector` available via its `HEX PANE` toggle)
     - Right: `ProtocolDissector`
     - Bottom: `CommandForge` + `OscilloscopeView` *(or unified Plotter)*
   - Move `FaultRig`, `ScriptLab`, `BridgePanel`, `FileTransfer`, `ElfSymbols`, `SessionDiff`, `SchemaDialects`, `ActivityLog` out of the default startup layout and keep them one click away under top-bar **Workbenches / Add Panel** (`PANEL_CATALOG`) or task presets (`Serial Monitor` / `Telemetry & Debug` / `HIL Fault Bench`).
2. **Level 2 — Merge Redundant UI Workbenches (~4,000+ UI LOC Saved):**
   - Merge `OscilloscopeView.tsx` (`3,588` LOC) and `PlotForgeView.tsx` (`2,926` LOC) into **one plotting panel** with mode tabs (`Waveform / DSO Trigger`, `FFT Spectrum`, `XY / Histogram`), eliminating ~`2,500–3,500` LOC of duplicate canvas/toolbar state.
   - Fold `FaultRigView.tsx` (`360` LOC) one-click presets directly into a compact preset strip inside `ScriptLabView` (or vice versa), removing two competing fault UIs.
   - Treat `PacketStreamView`'s embedded `<HexInspector embedded />` as the primary hex view rather than opening `HexInspector` as a separate dock tab by default.
3. **Level 3 — Code-Split Heavy Specialist Panels:**
   - Lazy-load (`React.lazy`) `ScriptLabView` (+ `luaSandboxFallback.ts` `3,524` LOC), `PlotForgeView`, `ElfSymbolView`, and `FileTransferView` in `WorkstationDock.tsx` so the initial workbench JS payload (`1.25 MB`) does not parse ~`8,000+` LOC of specialist code when the user only wants to open a serial port.

---

## 6. Executed De-Bloating Results (Measured)

**Backup Restore Point:** `81a2f3f` (`81a2f3fc9974ada88dd5895c1412888a1086e7e6`, `"chore: backup restore point before workbench de-bloating [skip ci]"`) and Git tag `backup/pre-debloat` pushed to `origin` before any structural edits.

### Implemented Changes
1. **Default Layout Diet & Progressive Disclosure (`WorkstationDock.tsx`, `GlobalRibbon.tsx`, `useWorkstationStore.ts`):**
   - Shrunk `buildDefaultLayout` from **13** simultaneous panels down to **4** core daily panels: `packetStream` (`56% × 54%`, with inline `HEX PANE`), `protocolDissector` (right), `oscilloscope` (bottom-left), and `commandForge` (bottom-right).
   - Preserved the full **13**-panel workstation layout as `buildFullCadLayout` under the new `'full'` (`Full 13-Panel CAD Layout`) preset alongside `'default'` (`Core Workbench (4 Panels)`).
   - Grouped `PANEL_CATALOG` in `GlobalRibbon.tsx` into 3 progressive-disclosure tiers (`Core Daily Workbench`, `Telemetry, Hex & Symbols`, `HIL, Scripting & Specialist`).
2. **Cross-Linking Overlapping Workbenches (`OscilloscopeView.tsx`, `PlotForgeView.tsx`, `ScriptLabView.tsx`, `PacketStreamView.tsx`):**
   - Added `PLOT STUDIO` (`[data-testid="scope-open-plotforge-btn"]`) in `OscilloscopeView.tsx` and `DSO SCOPE` (`[data-testid="plotforge-open-scope-btn"]`) in `PlotForgeView.tsx` for one-click switching between live scope and multi-chart analysis.
   - Added collapsible inline `QUICK FAULTS` bar (`[data-testid="script-quick-faults-toggle"]`, `[data-testid="script-quick-fault-bar"]`) inside `ScriptLabView.tsx` (primitive selector, `APPLY FAULT`, `DISARM ALL`, 1-shot bad-CRC/drop helpers, and `FULL FAULT RIG ↗`).
   - Added a `Tab ↗` pop-out action inside `PacketStreamView.tsx`'s inline `HEX PANE` header (`requestOpenPanel('hexInspector')`).
3. **Code-Splitting, Lazy Panel Loader & Toast Overlay Fix (`ui/vite.config.ts`, `WorkstationDock.tsx`, `ToastHost.tsx`):**
   - Added `manualChunks` in `ui/vite.config.ts` splitting `lua-sandbox`, `plot-engine`, and `vendor`.
   - Split all 10 non-default specialist panels (`SessionDiffView`, `PinSequencerView`, `FaultRigView`, `BridgePanel`, `FileTransferView`, `ElfSymbolView`, `SchemaDialectView`, `ActivityLogView`, `PlotForgeView`, `ScriptLabView`) into dynamic `import()` chunks via `createLazyPanel` (a `useState` + `useEffect` + module-cache loader that avoids an 8.5–10.9 s React 19 Concurrent `<Suspense>` commit delay observed in headless smoke testing under 20 Hz simulation + WebGL frames).
   - Fixed `ToastHost.tsx` click interception over bottom-right `CommandForge` (`pointer-events-none` on `ToastRow`, `pointer-events-auto` on the Dismiss button).

### Measured Before vs. After Bundle Footprint (`vite build`, `2115` modules)

| Asset / Chunk | Before (`index-DHpNpOy1.js`) | After (Measured Bytes) | Gzip Size | Notes |
| :--- | ---: | ---: | ---: | :--- |
| Main Entry (`index-Cds8c90t.js`) | `1,247,679` B *(single monolithic JS)* | **`297,689` B** (`297.69 kB`) | `83.10 kB` | **-76.1%** entry JS (`4` core panels + shell) |
| Shared Dependencies (`vendor-CufUCl0L.js`) | *(included in entry)* | `688,842` B (`688.84 kB`) | `177.94 kB` | Long-cache React/Dockview/Lucide chunk |
| Lua Sandbox (`lua-sandbox-BJhSpe1k.js`) | *(included in entry)* | `75,003` B (`75.00 kB`) | `22.35 kB` | Isolated `luaSandboxFallback.ts` chunk |
| Plot Core (`plot-engine-CaK4Qjlf.js`) | *(included in entry)* | `31,628` B (`31.63 kB`) | `11.31 kB` | Shared DSP / FFT / WebGL plot core |
| 10 Lazy Specialist Panel Chunks | *(included in entry)* | **`164,841` B** combined (`5,510`–`60,248` B each) | `47.37 kB` sum | `PlotForgeView` `60,248` B, `ScriptLabView` `33,592` B, `FileTransferView` `11,646` B, `FaultRigView` `10,537` B, `ElfSymbolView` `10,403` B, `PinSequencerView` `9,800` B, `SchemaDialectView` `9,505` B, `SessionDiffView` `7,826` B, `BridgePanel` `5,774` B, `ActivityLogView` `5,510` B |
| CSS (`index-Cx4DLiTz.css`) | `209,603` B | `209,631` B (`209.63 kB`) | `23.57 kB` | Tailwind + Dockview theme tokens |

### Measured Verification Results
- `pnpm exec tsc --noEmit` + `vite build`: passed (`0` errors, `2115` modules transformed), `ui/dist` synced to `target/release/ui`.
- `pnpm test` (`vitest run`): **`16/16` test files passed, `187/187` tests passed** (`0` failed).
- `node scripts/smoke-gate.mjs` (`chrome-headless-shell`): **`42/42` checks passed** (`0` failed), including Script Lab dry-run + `QUICK FAULTS` inline toggle, Plot Forge live streaming, Toast non-interference on Command Forge TX (`T8b`), lazy panel mounting (`T8c`/`T10`/`T14`/`T15`), and layout persistence (`T12`/`T13`).
- `cargo test --workspace --locked`: **`33` test targets, `401` passed, `0` failed, `0` ignored**.
