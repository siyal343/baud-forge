# Microcontroller User Experience (UX) Implementation Report

This report documents the implementation of the zero-config, device-first microcontroller workflow in BaudForge.

---

## 1. Overview & Resolved Friction

Prior to this work, BaudForge enforced a **file-first barrier**:
- New users were required to hand-craft a valid `.bforge.toml` configuration before launching the application.
- Physical serial ports were not visible in the desktop launcher.
- The console was read-only with no TX send prompt for interacting with firmware shells.
- Switching baud rates or framing modes required restarting the engine.
- External flashing tools failed because BaudForge held exclusive serial port locks.

This implementation delivers a **device-first, progressive disclosure experience** for embedded engineers (ESP32, STM32, RP2040, Arduino, bare-metal):
- **Time to First Byte:** Reduced from >10 minutes to <10 seconds.
- **Microcontroller Tooling Integration:** Port yielding allows firmware flashing without exiting the workbench.
- **Bidirectional Console:** Interactive TX send bar with history and line-termination modes.
- **Dynamic In-UI Configuration:** Live framing mode selection and one-click workspace export.

---

## 2. Implemented Architecture & Components

```
[Microcontroller via USB]
            │
            ▼
┌─────────────────────────────────────────────────────────────────┐
│ 1. DESKTOP LAUNCHER (ui/public/desktop.html)                   │
│   • Auto-enumerates ports via list_serial_ports / /api/devices  │
│   • Select COM port, Baud Rate (115200), Framing (delimiter)    │
│   • Click [Connect] ──► Spawns Ad-Hoc Session                   │
└────────────────────────────────┬────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│ 2. WORKBENCH INTERFACE (ui/src/)                                │
│   • Active hardware indicator: [COM3 @ 115200 8N1 · delimiter]  │
│   • Console Panel: Interactive TX Send Bar (CRLF, LF, HEX, ↑↓)  │
│   • Hardware Bay: "Yield 30s" button for external flashers      │
│   • Hardware Bay: Dynamic Framing Selector (COBS, SLIP, \n)     │
│   • Topbar: "💾 Save Workspace" (Ctrl+S) dumps active session    │
└────────────────────────────────┬────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│ 3. BACKEND ENGINE (crates/bforge-core & bforge-gui)             │
│   • GET /api/devices: Enumerate ports with USB VID:PID         │
│   • POST /api/quick-connect: Ad-hoc in-memory ProjectConfig     │
│   • POST /api/send: UTF-8 & Hex raw byte dispatch               │
│   • POST /api/yield: 30s serial handle release for flash tools  │
│   • POST /api/ports/:id/framing: Live framing mode updates      │
│   • POST /api/workspace/export: Serialize to .bforge.toml       │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. Component Details

### 3.1 Backend Engine & Native Host
- **Device Discovery (`crates/bforge-core/src/serve.rs`, [`crates/bforge-gui/src-tauri/src/main.rs`](file:///f:/Datapack/Personal/Programa/baud-forge/crates/bforge-gui/src-tauri/src/main.rs)):**
  - Added `GET /api/devices` returning JSON array of hardware devices with `device_path`, `vid_pid`, and `serial`.
  - Added Tauri command `list_serial_ports() -> Result<Vec<DeviceId>, String>`.
- **Ad-Hoc Session Launch:**
  - Added `POST /api/quick-connect` accepting `{ device, baud_rate, framing }`.
  - Added Tauri command `quick_connect()` generating an in-memory configuration, launching the session, and returning the server URL.
- **Port Yielding & TX Transmission:**
  - Standardized `POST /api/send` to accept raw byte buffers (`bytes: Option<Vec<u8>>`).
  - Standardized `POST /api/yield` to accept `duration_sec` and `seconds` aliases.
  - Added `POST /api/ports/{id}/framing` to update snapshot framing dynamically.
  - Added `POST /api/workspace/export` and `GET /api/workspace/export` to serialize the running session into `.bforge.toml`.

### 3.2 Desktop Launcher (`ui/public/desktop.html`)
- Added **Serial Device Quick Connect** card:
  - Dropdown populated automatically on load via `list_serial_ports` (native) or `/api/devices` (web).
  - Displays formatted names: e.g. `COM3 — USB Serial (10c4:ea60)`.
  - Refresh button (`#btn-refresh-devices`) for hot-plugged boards.
  - Baud rate selector: `115200` (default), `9600`, `19200`, `38400`, `57600`, `230400`, `460800`, `921600`.
  - Framing selector: `delimiter` (`\n`), `cobs`, `slip`, `raw`.
  - **Connect** button transitions the window immediately to the live workbench.

### 3.3 Interactive Console & TX Send Bar (`ui/src/components/panels/ConsolePanel.tsx`)
- Pinned `.console-tx-bar` at the bottom of the console:
  - Command input box with placeholder: `Type command to transmit... (Enter to send, ↑↓ history)`.
  - Multi-port selector when more than one port is active.
  - Line termination dropdown:
    - `CRLF (\r\n)` [Default]
    - `LF (\n)`
    - `CR (\r)`
    - `None` (raw string bytes)
    - `HEX` (e.g. `AA 55 01 02`)
  - Command history ring navigated via `ArrowUp` and `ArrowDown`.
  - Transmission status indicator (`TX 24 B`).

### 3.4 Hardware Bay Controls (`ui/src/components/panels/HardwareBayPanel.tsx`)
- **Flasher Yield Button:**
  - Added `<button class="pin yield">yield 30s</button>` on each port card.
  - Dispatches `POST /api/yield` releasing the serial handle so tools like `esptool.py`, `probe-rs`, or `st-flash` can flash firmware.
- **Dynamic Framing Badge & Popover:**
  - Under `Baud / Frame`, users can click `Framing ▾` to switch between `delimiter`, `cobs`, `slip`, `header-length`, and `intel-hex` without restarting.

### 3.5 Topbar & Workspace Export (`ui/src/App.tsx`, `ui/src/lib/workspace.ts`)
- Added **Save Workspace Button** (`💾 Save Workspace`) and `Ctrl+S` / `Cmd+S` global shortcut.
- Generates a valid `.bforge.toml` from the active runtime state and triggers browser download or file save.
- Added live active hardware status badge: `[<device> @ <baud> 8N1 · <framing>]` with green indicator LED.

---

## 4. Verification & Health

| Check | Target | Result |
| :--- | :--- | :--- |
| **UI Build** | `npm --prefix ui run build` | **Passed** (48 modules, 0 TypeScript errors, 1.96 s) |
| **Backend Unit & Integration Tests** | `cargo test --workspace --exclude bforge-gui` | **Passed** (332 passed, 0 failed, 24.2 s) |
| **Quick-Connect & Export Test** | `tests/serve.rs: devices_and_quick_connect_and_export` | **Passed** |
| **Workspace Compilation** | `cargo build --workspace` | **Passed** (`bforge.exe`, `bforge-gui.exe`) |

---

## 5. Walkthrough: Microcontroller First-Time User Experience

1. **Connect Board:** User plugs an ESP32-C3 development board into USB.
2. **Launch Application:** User runs `bforge-gui.exe`.
3. **Quick Connect:**
   - The launcher displays: `COM3 — USB Serial (10c4:ea60)`.
   - User verifies `115200` baud and clicks **Connect**.
4. **Interactive Monitoring:**
   - The workbench opens. Boot logs scroll in the stream and console.
   - User types `help` in the TX send bar and presses `Enter`. The firmware shell responds.
5. **Flash New Firmware:**
   - User edits firmware code and needs to re-flash.
   - User clicks `yield 30s` in the Hardware Bay. BaudForge yields `COM3`.
   - User runs `idf.py flash` or `cargo flash` in terminal. Flashing completes successfully.
   - After 30 seconds (or upon session resumption), BaudForge automatically reclaims `COM3` and resumes monitoring.
6. **Save Workspace:**
   - User presses `Ctrl+S` or clicks **💾 Save Workspace**.
   - BaudForge downloads `baudforge-workspace.bforge.toml` into the project repository.
