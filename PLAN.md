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
