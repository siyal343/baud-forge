# BaudForge Workstation Enhancement Plan & Record

Date: 2026-11-15  
Status: Implemented & Verified  
Scope: Workspace Loader (auto-reload devices, create workspace, standby recording + folder picker), Packet Stream <-> Canonical Hex & ASCII correlation, Command Forge payload input & global typography normalization.

---

## 1. Workspace Loader: Auto-Reload Connected Devices & Create New Workspace

### Root Causes
1. **No dynamic port refresh in Loader (`ui/src/components/Launcher.tsx`)**: `bforge_hal::uart::available()` (`crates/bforge-hal/src/uart.rs`) and `list_serial_ports` (`crates/bforge-desktop/src/main.rs`) already enumerate live OS serial ports on every call, but `Launcher.tsx` invoked `list_serial_ports` only once on mount (`useEffect(..., [])`) in two separate state instances (`ConfigureSession` and Quick Connect). Plugging in a device after opening the launcher required restarting the application.
2. **Missing "Create a new workspace" flow**: `Launcher.tsx` provided `OPEN WORKSPACE…` (existing `.toml` via `pick_workspace`) and hidden `%APPDATA%\BaudForge\profiles\` saves (`save_profile` / `start_configured`), with no native save-as flow to create a `.bforge.toml` workspace file in a user-chosen folder and launch it.

### Implemented Changes
- **Backend (`crates/bforge-desktop/src/main.rs`)**:
  - Added `create_workspace(app, config_text, suggest, vault) -> Result<Option<String>, String>` backed by `sanitize_workspace_suggest`, `ensure_toml_extension`, and `default_workspace_toml` (`version = "0.1"`, `tcp-server` on `127.0.0.1:0`, `115200` baud, `cobs` framing). Validates `bforge_core::ProjectConfig` (`from_str` + `validate()`) before writing to disk and calling `start()`.
  - Registered `create_workspace` in `tauri::generate_handler![]`.
  - Added unit tests: `ensure_toml_extension_preserves_toml_and_appends_bforge_toml`, `sanitize_workspace_suggest_normalizes_suffix_and_chars`, `default_workspace_toml_parses_and_validates`.
- **Frontend (`ui/src/components/Launcher.tsx`)**:
  - Added shared `useSerialPortScanner` hook polling `list_serial_ports` every `2000ms` while mounted, plus immediate rescans on `window` `focus` and `document` `visibilitychange` (deduplicated on `device_path|vid_pid|serial` signature).
  - Preserves active selections across polls, auto-selects `ports[0].device_path` when transitioning from zero/unplugged ports to available ports, and clears/falls back when an active port disconnects.
  - Added manual `RescanButton` (`RefreshCw`) in both `ConfigureSession` (`Serial port` card) and `Quick connect`.
  - Added `CREATE WORKSPACE…` buttons in `Quick open` (2-column grid alongside `OPEN WORKSPACE…`) and `ConfigureSession` (serializing the configured form via `buildConfigToml` into a new `.bforge.toml` file).

---

## 2. Recording Configuration: Inactive by Default & Loader Storage Control

### Root Causes
- `crates/bforge-desktop/src/main.rs` replaced `vault: Option<PathBuf> = None` with `default_vault()` (`%TEMP%\bforge-gui-<stamp>.bflog`) on every `start()` call (`start_workspace`, `start_configured`, `quick_connect`), forcing `Session::start` into active `record` mode immediately at boot.
- `buildVaultPath` in `ui/src/store/useSettingsStore.ts` hardcoded a relative `vaults/` prefix with no user-configurable storage directory setting.

### Implemented Changes
- **Backend (`crates/bforge-desktop/src/main.rs`)**:
  - Changed `Running.vault` to `Option<PathBuf>` and removed `default_vault()`.
  - Updated `start()` and Tauri commands (`start_workspace`, `start_configured`, `quick_connect`) to keep `vault: Option<PathBuf>` optional via `clean_vault_arg`, starting sessions in `STANDBY` (`vault = None`, creating no `.bflog` or sidecar file) unless recording is explicitly requested.
  - Added `pick_recording_folder() -> Option<String>` (native folder dialog) and `pick_existing_vault() -> Option<String>` (open dialog for `REVIEW A CAPTURE (.bflog)…`), registered in `tauri::generate_handler![]`.
  - Updated `export_vault` to return `"no active session vault to export"` when neither a custom path nor an active `Running.vault` exists.
  - Added unit test `clean_vault_arg_filters_empty_and_whitespace`.
- **Core Engine (`crates/bforge-core/src/serve.rs`)**:
  - Updated `RecordAction::Start(path)` in the pump loop to create missing `path.parent()` directories, register `VaultSource { path, ports }` into `shared.vault`, and write the `<vault>.bforge.toml` sidecar so `/api/vault`, `/api/vault/frames`, `/api/vault/export`, and `/api/diff` work seamlessly when recording starts mid-session.
  - Added integration test `mid_session_recording_registers_vault_and_endpoints`.
- **Frontend (`ui/src/store/useSettingsStore.ts`, `Launcher.tsx`, `SettingsModal.tsx`, `VaultExportModal.tsx`)**:
  - Added `recordingEnabled: false` and `recordingDir: ''` to `BfSettings` and `DEFAULT_SETTINGS` with validation in `mergeSettings`.
  - Updated `buildVaultPath(pattern, dir?)` to join `recordingDir` when configured or default to `vaults/`.
  - Added **Session recording** card in `Launcher.tsx` (`STANDBY (OFF)` / `RECORD ON START` toggle, directory input + `CHOOSE FOLDER…` + `RESET`, live target path preview) and forwarded `resolveLauncherVault()` to every launch command.
  - Exposed `Record Session on Startup:` and `Recording Storage Directory:` in `SettingsModal.tsx` (`DATA & EXPORT`) and `vaultPath` fallback in `VaultExportModal.tsx`.

---

## 3. Packet Stream & Canonical Hex + ASCII Correlation

### Root Causes
- Clicking a packet row in `PacketStreamView` left `autoScroll: true`, causing incoming live frames (35ms batches) to overwrite `selectedPacket` immediately.
- `HexInspector` displayed no packet identity (`#seqId`, direction, port, time, protocol), lacked reverse byte-to-dissector hover/click handlers, and sat separated diagonally from `PacketStreamView` across Dockview panes.

### Implemented Changes
- **Store (`ui/src/store/useWorkstationStore.ts`, `useWorkstationStore.test.ts`)**:
  - Added `hoveredByteOffset`, `selectedByteOffset`, `setHoveredByteOffset`, `setSelectedByteOffset`, resetting both on `selectPacket`, `seekToTimestamp`, `stepFrame`, `clearStream`, `loadSampleCapture`, and `restartReplayTimer`.
  - Updated `stepFrame` to set `autoScroll: false`.
- **Canonical Hex & ASCII (`ui/src/components/HexInspector.tsx`)**:
  - Added `{ embedded?: boolean; onClose?: () => void }` props and exported shared helpers (`toAsciiChar`, `bytesToAscii`, `findFieldAtOffset`, `DirectionBadge`).
  - Added **Packet Identity Header Bar** (`#seqId`, direction badge, port, timestamp, protocol, byte length, `◀`/`▶` frame steppers, `LIVE`/`PINNED` toggle, optional `×` close button).
  - Wired bidirectional hover & click correlation across both Hex cells and ASCII gutter spans (`setHoveredByteOffset`, `setHoveredField`, `setSelectedByteOffset`, `selectField`), keeping the sticky ruler at `h-[22px]`.
  - Added **Live Byte Decoder Footer Bar** (`OFFSET`, `HEX`, `U8 | I8`, `U16LE`, `BIN`, `ASCII`, active field summary).
- **Dissector & Stream (`ui/src/components/ProtocolDissector.tsx`, `PacketStreamView.tsx`)**:
  - `ProtocolDissector`: added distinct `hoveredField` highlight synced with `HexInspector` byte hover and reset `selectedByteOffset` on field click.
  - `PacketStreamView`: pins selection on row click (`setAutoScroll(false)`), guards programmatic scroll-sync (`programmaticScrollRef`), syncs scroll viewport when `selectedPacket` changes externally, adds `DECODED | HEX+ASCII | BOTH` payload column modes, and integrates a resizable `HEX PANE` (`Off | Bottom | Right`) master-detail split embedding `<HexInspector embedded />`.

---

## 4. Command Forge Payload Input & Application-Wide Typography Normalization

### Root Cause (Measured)
- `ui/src/index.css` set `html { font-size: 11px; }`. Because Tailwind v4 defines `text-xs` (`0.75rem`) and `text-sm` (`0.875rem`) in `rem`, `text-xs` computed to **`8.25px`** (`11 * 0.75`) and `text-sm` computed to **`9.625px`** (`11 * 0.875`), inverting size hierarchy relative to `text-[10px]` and shrinking Command Forge's Raw Hex and ASCII `<textarea>` (`text-xs`) to `8.25px`.

### Implemented Changes
- **Global Tokens (`ui/src/index.css`)**:
  - Preserved `html { font-size: 11px; }` layout spacing while locking `@theme` font tokens to pixel values: `--text-xs: 12px` (`1.45`), `--text-sm: 13px` (`1.45`), `--text-base: 14px` (`1.5`), `--text-lg: 16px` (`1.5`).
  - Updated `.dockview-tab` and `.bf-tooltip` `font-size` to `11px`.
- **Command Forge (`ui/src/components/CommandForge.tsx`)**:
  - Upgraded Raw Hex & ASCII `<textarea>` from `text-xs` (`8.25px` computed) to `text-[13px] leading-relaxed`.
  - Upgraded Hex `BYTE CELLS` (`w-[42px] h-[38px] text-[13px]`), ASCII previews (`text-[11px]`), byte offsets & `+ BYTE` (`text-[10px]`), C-struct `<textarea>` (`text-[12px]`), and modal/dropdown controls (`11px`–`12px`).
- **All Remaining UI Components (`ui/src/components/*.tsx`)**:
  - Normalized typography across all 24 UI component files to a 4-tier floor (`10px` micro badges/hints, `11px` labels/controls/headers, `12px` primary data/monospace rows/inputs with `PacketStreamView` `ROW_HEIGHT = 24`, `13px`–`14px` headings).
  - Upgraded Canvas 2D fonts in `OscilloscopeView.tsx` and `PlotForgeView.tsx` to `10px`–`12px`, and applied inline `pointerEvents: 'none'/'auto'` on the `OscilloscopeView` floating HUD so waveform clicks pass through the metrics body while preserving drag/collapse on the HUD header.

---

## 5. Verification Results (Observed After Edits)

- **Frontend Unit Tests (`vitest run`)**: `13` test files passed, `131` tests passed (`0` failed).
- **TypeScript & Production Bundle (`tsc && vite build`)**: passed with `0` errors; verified `--text-xs:12px` in `ui/dist/assets/index-*.css` and synced `ui/dist` to `target/release/ui`.
- **Rust Formatting, Lint & Tests**:
  - `cargo fmt --all --check`: passed (exit `0`).
  - `cargo clippy --workspace --all-targets --locked -- -D warnings`: passed (`0` warnings).
  - `cargo test --workspace --locked`: all `26` test targets passed (`371` tests total, `0` failed).
- **Browser Smoke Gate (`node scripts/smoke-gate.mjs` via `chrome-headless-shell`)**: `40/40` checks passed (`0` failed), confirming `REC pill reads STANDBY`, `recordingEnabled: false` factory defaults, `Workflow B`, `HexInspector`, and `hex bytes/row`.
- **GitHub Actions CI & Windows Artifacts**:
  - Committed all implementation changes in `c51a249` (`c51a249b6d0678ad0fec220be5f4e8608141f3ab`) and pushed to `origin/main`.
  - CI run [`43662215003`](https://github.com/siyal343/baud-forge/actions/runs/43662215003) passed all `10/10` jobs (`build (windows desktop shell)`, `test (windows-x86_64)`, `test (windows-aarch64)`, `test (linux-x86_64)`, `test (linux-aarch64)`, `build (macos-x86_64)`, `test (macos-aarch64)`, `format and lints`, `ui unit, build and headless smoke`, `e2e bridge, REC and X/YMODEM`).
  - Downloaded Windows CI artifacts from run `43662215003`:
    - Desktop bundle (`bforge-desktop-windows-x86_64`): `F:\Datapack\Personal\Programa\baud-forge-ci\desktop-x86_64\bforge-desktop.exe` (`12,238,336` bytes) + `ui/` (`index-D0CY0GKl.js`, `index-DLZKu67-.css`), also synced to `target\release\bforge-desktop.exe` and `target\release\ui\`.
    - CLI (`bforge-windows-x86_64`): `F:\Datapack\Personal\Programa\baud-forge-ci\cli-x86_64\bforge-windows-x86_64.exe` (`3,859,968` bytes), verified locally (`bforge 0.8.0`).
- **Not run**: live hardware USB hotplug test (no physical serial adapter attached; verified via unit tests and `useSerialPortScanner` polling/focus listeners) and launching the GUI `bforge-desktop.exe` window directly.

---

## 6. High-Speed & Flexible Plotting Architecture Refactor (2026-11-15)

Full technical design, bottleneck measurements, and symbol record: [`PLOTTING_ARCHITECTURE.md`](./PLOTTING_ARCHITECTURE.md).

- **Rust Telemetry (`crates/bforge-core/src/telemetry.rs`)**: Added `find_trigger_crossing` (with sub-sample linear interpolation and holdoff), `decimate_min_max`, and `WindowStats` (`8/8` tests passing).
- **Zero-Allocation Plot Core (`ui/src/plot/`)**: Added L1 64-sample mipmap `SampleRing.statsInRange` + `resize` (`rings.ts`), branchless zero-alloc `decimateMinMaxInto` (`decimate.ts`), memoized Hann/twiddle radix-2 FFT (`fft.ts`), specialized `expr.ts` closures + `PI`/`E`/`TAU`/`atan2`/`hypot`/`deg`/`rad`/`clamp`, DSO `findTriggerCrossing` (`trigger.ts`), offscreen `renderWaveformsWebGL` with relative `Float64` subtraction (`webglRenderer.ts`), cached `palette.ts`, and unified single-pass `O(F + C)` `PlotEngine` (`getSeriesScratch`, `getCachedSpectrum`, `getAlignedXy`, array/bitfield extraction, `expr` backfill, `meta:rate` fix).
- **Stores & Panels (`useWorkstationStore.ts`, `usePlotStore.ts`, `ProtocolDissector.tsx`, `OscilloscopeView.tsx`, `PlotForgeView.tsx`)**: Added single-slice ring helpers, real logic flag extraction, multi-chart layouts (`TAB`/`STACK`/`GRID`), `GPU`/`2D` renderer toggle, working `AUTO`/`NORM`/`SINGLE`/`ROLL` triggering, `CH1`/`CH2` field binding + vertical center + `AUTOSET`, `OVERLAY`/`STACKED` scope lanes, `Y1`/`Y2` cursors + `v(X)` readouts, `FFT`/`XY`/`HIST` crosshairs, workstation `seekToTimestamp` cross-probing, dirty-flag `rAF` loops, and stabilized DOM listeners.
- **Verification**: `vitest run` (`14` files, `160` tests), `tsc --noEmit && vite build`, `scripts/smoke-gate.mjs` (`40/40`), `cargo fmt --all --check`, `cargo clippy --workspace --all-targets --locked -- -D warnings`, and `cargo test --workspace --locked` (`26` targets, `379` tests) all passed.
- **GitHub Actions CI & Windows Artifacts**:
  - Committed in `24ad7b8` (`24ad7b8688aa1a1ae981ca4a67ff235bfee2a0ee`) and pushed to `origin/main`.
  - CI run [`43697860561`](https://github.com/siyal343/baud-forge/actions/runs/43697860561) passed all `10/10` jobs (`build (windows desktop shell)`, `test (windows-x86_64)`, `test (windows-aarch64)`, `test (linux-x86_64)`, `test (linux-aarch64)`, `build (macos-x86_64)`, `test (macos-aarch64)`, `format and lints`, `ui unit, build and headless smoke`, `e2e bridge, REC and X/YMODEM`).
  - Downloaded Windows CI artifacts from run `43697860561`:
    - Desktop bundle (`bforge-desktop-windows-x86_64`): `F:\Datapack\Personal\Programa\baud-forge-ci\desktop-x86_64\bforge-desktop.exe` (`12,261,376` bytes) + `ui/` (`index-D8uCM96Q.js`, `index-CO3PSjpH.css`), also synced to `target\release\bforge-desktop.exe` and `target\release\ui\`.
    - CLI (`bforge-windows-x86_64`): `F:\Datapack\Personal\Programa\baud-forge-ci\cli-x86_64\bforge-windows-x86_64.exe` (`3,859,968` bytes), verified locally (`bforge 0.8.0`).
- **Not run**: Launching the GUI `bforge-desktop.exe` window directly on desktop hardware.

---

## 7. Plugin & Extension System Architecture (`RFC-001`, 2026-11-15)

Full technical design, codebase seam audit, `plugin.toml` manifest schema, WIT contracts, sidecar protocol, security bounds, and 4-wave implementation roadmap: [`PLUGIN_ARCHITECTURE.md`](./PLUGIN_ARCHITECTURE.md).

- **Architecture ("Right Runtime for the Right Plane")**:
  - **Tier 1 (Declarative Schemas & CRC Packs)**: `DissectorIr` extensions (C headers, Protobuf, MAVLink, wiring `SchemaSource::Kaitai` and CAN `.dbc`) plus Rocksoft parameterized CRC tables.
  - **Tier 2 (Embedded Lua 5.4 in `crates/bforge-script`)**: Harden existing `mlua 0.10` runtime with `lua.set_memory_limit(4 MiB)`, rate-limited logging, multi-hook `on_rx_frame`/`on_tx_frame`/`on_mitm_frame`/`on_timer`/`on_alert`, and multi-schema `frame:dissect(tag)` to resolve `D-94`.
  - **Tier 3 (WebAssembly Component Model via `wasmtime` + WIT `bforge:plugin@0.1.0`)**: High-speed (`1.2x–1.8x` native), zero-syscall, memory/fuel/epoch-bounded plugins implementing `ByteMachine`, `Decoder`, and streaming exporters (`parquet`, etc.) in Rust/C/C++/Zig/TinyGo with SHA-256 `.cwasm` AOT cache.
  - **Tier 4 (Out-of-Process Hardware Sidecars in `crates/bforge-hal`)**: `SidecarTransport` (`impl TransportDriver`) over length-prefixed binary + JSON-RPC 2.0 (`bforge-hal-rpc/v1`) for vendor SDKs (J-Link RTT, SocketCAN, Saleae, VISA, BLE GATT) with OS process crash isolation and reconnect supervision.
  - **Tier 5 (Workbench UI & DSP Extensions in `ui/`)**: Unified dynamic `usePluginStore` registry (replacing duplicated 14-panel maps in `WorkstationDock.tsx` and `GlobalRibbon.tsx`), sandboxed `<iframe sandbox="allow-scripts">` panels via `MessageChannel` + `Transferable` `Float64Array`, custom Plot Forge DSP workers (`expr.ts`), and Command Forge encoders.
- **4-Wave Roadmap**: Wave 1 (Manifest/Registry + Lua hardening + Dynamic Dock Panels) $\rightarrow$ Wave 2 (`wasmtime` WIT host for framers/dissectors/exporters) $\rightarrow$ Wave 3 (`SidecarTransport` HAL drivers + device discovery) $\rightarrow$ Wave 4 (Kaitai/DBC/CRC packs + Parquet exporter + Plot DSP workers + Plugin Manager UI).

---

## 8. Lua 5.4 HIL & Protocol Scripting Engine Architecture (2026-11-15)

Full audit, hook pipeline, `LuaFrame` `UserData` design, `bforge.*` sandbox standard library, safety bounds, `/api/script` control plane, **Script Lab** UI spec, and 3-wave roadmap: [`LUA_SCRIPTING_ENGINE.md`](./LUA_SCRIPTING_ENGINE.md).

- **Audit Summary (`crates/bforge-script` & `crates/bforge-core`)**: Existing `mlua 0.10` (`lua54`) runtime enforces `INSTRUCTION_BUDGET = 200_000`, `StdLib::{TABLE, STRING, MATH, UTF8}`, and TX/raw-RX single-hook execution (`bforge.on_frame`), but lacks a VM memory limit (`lua.set_memory_limit`), runs `rx_script` on unframed slabs before `stream.feed`, leaves `Session::forward` MITM bridges and `ScriptHook::{OnMitmFrame, OnAlert}` unwired, hits the `D-94` single-schema limit, allocates per-frame closures/strings + re-decodes on every `frame:get`, writes `bforge.log` to `eprintln!` rather than `LogRing`, and has no HTTP `/api/script` or UI workbench.
- **Target Architecture**:
  - **5 Unified Roles**: Post-framer inline packet/MITM interceptor (`Pass | Send | Delay | Drop | Burst`), autonomous virtual responder (`bforge.send` with non-reentrant `Origin::Script`), closed-loop HIL test sequencer (`on_init`, `on_timer`, `on_alert`, `pulse_pin`, `assert`), derived live telemetry emitter (`bforge.plot`, `bforge.metric`), and rapid prototype dissector/command builder (`on_dissect`, `on_command`).
  - **Zero-Alloc Hot Path**: `LuaFrame` `mlua::UserData` with lazy `frame.hex`, single-pass lazy decode cache (`frame:get`/`fields`), zero-offset binary accessors (`u8..f64`, `set_*`, `xor_bit`, `string.pack` interop), multi-schema `frame:dissect(tag)` map (`D-94` fix), and deterministic `now_us` / seeded PRNG + 4 MiB memory cap + 50 msg/s `LogRing` limiter.
  - **UI & Control Plane**: `POST /api/script` (`compile`, `test_frame` dry-run diff, `arm`, `disarm`, `reset_stats`) + `UiSnapshot.script`, powering **Script Lab** in the desktop workbench.
- **3-Wave Roadmap**: Wave 1 (`bforge-script` `LuaFrame` `UserData`, memory cap, multi-hooks, dry-run harness) $\rightarrow$ Wave 2 (`bforge-core` post-framer/MITM wiring, multi-schema `D-94` fix, outbox/pins/plots/logs, `/api/script`) $\rightarrow$ Wave 3 (`ui/` **Script Lab** editor, templates, selected-packet dry-run diff, and live metrics/assertions).
- **Status — Implemented, Committed (`d1c0122`) & CI-Verified (`43721247956`, 2026-11-15)**:
  - **Design Choices**: Standalone Dockview panel `scriptLab` (`ui/src/components/ScriptLabView.tsx`, title `LUA SCRIPT LAB`) in Bottom Subdeck + `OPEN IN SCRIPT LAB →` buttons in `FaultRigView.tsx` and `BridgePanel.tsx`; default `FaultPolicy::FailOpen` across `TX`, `RX`, and `MITM` hooks with UI selector for `FailClosed`.
  - **Wave 1 (`crates/bforge-script/`)**: Implemented `LuaFrame` `UserData` and `FrameState` (`src/frame.rs`), sandbox limits/multi-hooks/timers/pins/plots/assertions/`dry_run` + multi-form API compatibility (`(frame, dir)`, 1/2-arg `bforge.log`, both `bforge.assert` orders, 2/3-arg `set_pins`/`pulse_pin`, numeric/table `send`) (`src/runtime.rs`), public exports (`src/lib.rs`), and `all_fifteen_tutorial_scripts_compile_and_execute_cleanly`.
  - **Wave 2 (`crates/bforge-core/`)**: Added `ScriptStatusView` + dry-run contract types (`src/contract.rs`), `SeriesSet::push_custom` (`src/series.rs`), `TailRow.raw` + `Stream::redecode_row` (`src/tail.rs`), `rebuild_schema_map` (`D-94` fix), pre/post-framer + `MITM` + `TX` hook execution + wildcard `"*"` port resolution (`src/session.rs`), `/api/script` endpoints + log draining (`src/serve.rs`), and integration tests (`tests/serve.rs`, `tests/session.rs`).
  - **Wave 3 (`ui/`) & Tutorial Series**: Built `ScriptLabView.tsx` (grouped Starter Templates + Tutorial Series `01–15` selector), `luaSandboxFallback.ts` (`SCRIPT_TEMPLATES` including `tutorial_01`–`tutorial_15`, network/5xx-only offline sandbox fallback), `utils/checksums.ts` (`crc16Xmodem`), `engineApi.ts` + `useWorkstationStore.ts` + `plot/engine.ts` (`pushScriptMetric`) wiring, `WorkstationDock.tsx`/`GlobalRibbon.tsx` registration, quick-launch links in `FaultRigView.tsx`/`BridgePanel.tsx`, and smoke test `T15` in `ui/scripts/ui-smoke.mjs`. Created 15 standalone tutorials ([`01_packet_filter_and_metadata.lua`](./examples/tutorials/01_packet_filter_and_metadata.lua)–[`15_fail_closed_safety_interlock_and_budget.lua`](./examples/tutorials/15_fail_closed_safety_interlock_and_budget.lua)) and [`docs/LUA_SCRIPTING_TUTORIAL.md`](./docs/LUA_SCRIPTING_TUTORIAL.md).
  - **Measured Verification, CI & Windows Artifacts**: Local `vitest` (`16/16` files, `187/187` tests), `tsc --noEmit` + `vite build` (`2114` modules), `node scripts/smoke-gate.mjs` (`41/41` checks), `cargo fmt --all --check`, `cargo clippy --workspace --all-targets --locked -- -D warnings` (`0` warnings), and `cargo test --workspace --locked` (`33` targets, `401` passed, `0` failed) all passed. GitHub Actions CI run `43721247956` passed `10/10` jobs; downloaded `bforge-desktop.exe` (`13,241,344` bytes + `ui/`) to `F:\Datapack\Personal\Programa\baud-forge-ci\desktop-x86_64\` + `target\release\` and `bforge-windows-x86_64.exe` (`4,813,312` bytes, `bforge 0.8.0`) to `F:\Datapack\Personal\Programa\baud-forge-ci\cli-x86_64\`. Live desktop WebView2 (`bforge-desktop.exe`) + physical USB hardware execution was not tested.
  - **Language Trade-Off Analysis (2026-11-16)**: Scope, VM/sandbox trade-offs, and hybrid vs. full-replacement estimate for swapping Lua 5.4 to Python (`RustPython` vs `PyO3`/CPython vs Tier 4 SDK): [`docs/PYTHON_VS_LUA_ANALYSIS.md`](./docs/PYTHON_VS_LUA_ANALYSIS.md).

---

## 9. Workbench De-Bloating, Progressive Disclosure & Code-Splitting (2026-11-16)

Full bloat audit & before/after measurements: [`PRODUCT_BLOAT_AND_USAGE_ANALYSIS.md`](./PRODUCT_BLOAT_AND_USAGE_ANALYSIS.md).

- **Backup Restore Point**: Pushed restore commit `81a2f3f` and tag `backup/pre-debloat` to `origin` before edits.
- **Part 1 — Default Layout Diet & Progressive Disclosure (`WorkstationDock.tsx`, `GlobalRibbon.tsx`, `useWorkstationStore.ts`)**: Reduced default startup panels from `13` to `4` (`packetStream`, `protocolDissector`, `oscilloscope`, `commandForge`), preserved the `13`-panel workspace under the new `'full'` (`Full 13-Panel CAD Layout`) preset (`buildFullCadLayout`), and categorized `PANEL_CATALOG` into 3 tiers (`Core Daily Workbench`, `Telemetry, Hex & Symbols`, `HIL, Scripting & Specialist`).
- **Part 2 — Overlapping Workbench Consolidation**: Cross-linked `OscilloscopeView.tsx` (`PLOT STUDIO`) ↔ `PlotForgeView.tsx` (`DSO SCOPE`), embedded collapsible `QUICK FAULTS` controls inside `ScriptLabView.tsx`, and added a `Tab ↗` pop-out trigger inside `PacketStreamView.tsx`'s inline `HEX PANE`.
- **Part 3 — Code-Splitting, Lazy Loading & UI Overlay Fix (`ui/vite.config.ts`, `WorkstationDock.tsx`, `ToastHost.tsx`)**: Split `vendor`, `lua-sandbox`, and `plot-engine` via `manualChunks`, deferred all `10` specialist panels into dynamic `import()` chunks via `createLazyPanel` (avoiding the 8.5–10.9 s React 19 Concurrent `<Suspense>` commit delay under live simulation load), and fixed `ToastHost.tsx` pointer-event pass-through over bottom-right controls. Reduced main entry bundle `index-*.js` from `1,247,679` B to `297,689` B (`vendor` `688,842` B, `lua-sandbox` `75,003` B, `plot-engine` `31,628` B, and `10` lazy panel chunks `164,841` B combined).
- **Verification**: `tsc --noEmit` (`0` errors), `vitest run` (`16` files / `187` tests passed), `vite build` (`2115` modules, synced to `target/release/ui`), `node scripts/smoke-gate.mjs` (`42/42` checks passed), and `cargo test --workspace --locked` (`33` targets / `401` tests passed, `0` failed).
- **GitHub Actions CI & Windows Desktop Artifact**: Committed as `cef7b13` and pushed to `origin/main`. CI run [`43738532103`](https://github.com/siyal343/baud-forge/actions/runs/43738532103) passed all `10/10` jobs (`build (windows desktop shell)`, `test (windows-x86_64)`, `test (windows-aarch64)`, `test (linux-x86_64)`, `test (linux-aarch64)`, `build (macos-x86_64)`, `test (macos-aarch64)`, `format and lints`, `ui unit, build and headless smoke`, `e2e bridge, REC and X/YMODEM`). Downloaded `bforge-desktop-windows-x86_64` to `F:\Datapack\Personal\Programa\baud-forge-ci\desktop-x86_64\bforge-desktop.exe` (`13,259,776` bytes + `ui/`) and synced to `target\release\bforge-desktop.exe` and `target\release\ui\`. Not tested interactively: launching the GUI desktop window against live USB hardware.
