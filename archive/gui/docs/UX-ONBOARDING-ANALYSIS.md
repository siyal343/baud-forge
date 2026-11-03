# Microcontroller Onboarding and User Experience (UX) Analysis

This document analyzes the user experience (UX) friction in BaudForge for microcontroller developers and specifies the target device-first workflow.

---

## 1. Executive Summary: The "File-First" UX Barrier

BaudForge contains a powerful hardware-in-the-loop (HIL) engine:
- Multi-transport serial port drivers with USB VID:PID discovery ([`crates/bforge-hal/src/uart.rs`](file:///f:/Datapack/Personal/Programa/baud-forge/crates/bforge-hal/src/uart.rs))
- Zero-copy framing and CRC validation ([`crates/bforge-framer/src/lib.rs`](file:///f:/Datapack/Personal/Programa/baud-forge/crates/bforge-framer/src/lib.rs))
- Interactive pin controls (`DTR`, `RTS`, `pulse`, `boot seq`) ([`crates/bforge-core/src/serve.rs`](file:///f:/Datapack/Personal/Programa/baud-forge/crates/bforge-core/src/serve.rs))
- Port yielding for external firmware flash tools (`POST /api/yield`)
- Full bidirectional transmission (`POST /api/send`)

However, the user interface enforces a **file-first workflow**. The GUI assumes the user already authored a valid `.bforge.toml` workspace specification file before launching the tool.

For a new microcontroller engineer (ESP32, STM32, RP2040, Arduino, or custom bare-metal target), this design creates severe friction:
- **Time to First Byte (Current):** >10 minutes (user must study the TOML schema, find their COM port, create the file manually, and resolve configuration errors).
- **Time to First Byte (Target):** <10 seconds (plug in board, click discovered COM port, click Connect).

---

## 2. Current Workflow vs. Target Workflow

```
CURRENT WORKFLOW (HIGH FRICTION)
[Connect USB] 
       │
       ▼
[Launch BaudForge] ──► [Locked Out: "Open Workspace (.bforge.toml)"]
       │
       ▼ (Manual context switch to VS Code / Notepad)
[Find COM port in Device Manager]
       │
       ▼
[Hand-write .bforge.toml schema]
       │
       ▼
[Load .bforge.toml in BaudForge] ──► [Console is Read-Only: No TX Send Bar]
                                 ──► [Cannot change Baud Rate in UI]
                                 ──► [Cannot change Framing in UI]

────────────────────────────────────────────────────────────────────────────

TARGET WORKFLOW (DEVICE-FIRST, ZERO-CONFIG)
[Connect USB]
       │
       ▼
[Launch BaudForge]
       │
       ▼
[Live Port Discovered: "COM3 - Silicon Labs CP2102 (10c4:ea60)"]
       │
       ▼
[Click "Quick Connect" (115200 Baud, Line-delimited)]
       │
       ▼ (Instant gratification in <10 seconds)
[Live Console Output Scrolling] ◄──► [Type Commands in TX Send Bar]
       │
       ▼ (Progressive disclosure: user needs structured telemetry)
[Click "Set Framing" -> Choose COBS / SLIP / Delimiter]
       │
       ▼
[Attach C Header / Kaitai Struct -> Dissect Fields into Columns]
       │
       ▼
[Click "Save as Workspace (.bforge.toml)"]
```

---

## 3. The 5-Stage Progressive Disclosure Journey

A modern engineering tool must guide the user from simple raw communication to deep protocol analysis without cognitive overload.

### Stage 1: Zero-Config Discovery & 1-Click Connect (0–10 Seconds)
1. User connects board via USB.
2. User opens BaudForge desktop application.
3. The launcher screen automatically enumerates available serial ports using `bforge_hal::uart::available()`.
4. The launcher displays detected devices with hardware descriptions:
   - Example: `COM3 — Silicon Labs CP2102 USB to UART Bridge (VID 10c4:ea60)`
   - Example: `COM4 — STMicroelectronics STLink Virtual COM Port (VID 0483:374b)`
5. The user selects a port, keeps the default baud rate (`115200`), and clicks **Quick Connect**.
6. The engine starts an in-memory ad-hoc session immediately without requiring an on-disk TOML file.

### Stage 2: Interactive Terminal & Firmware Reset (10–30 Seconds)
1. The workbench opens directly into the stream and console view.
2. The user sees microcontroller boot logs scrolling immediately (`ESP-ROM:esp32c3...`).
3. An interactive **TX Send Bar** at the bottom of the Console allows sending text or hex:
   - Line ending selector: `CRLF (\r\n)`, `LF (\n)`, `CR (\r)`, `None`, `HEX bytes`.
   - Command history navigation with `Up` and `Down` arrow keys.
4. Pin controls in the Hardware Bay provide hardware convenience:
   - **Reset Board:** Click `pulse` (100 ms DTR low).
   - **Bootloader Mode:** Click `boot seq` (ESP32/STM32 GPIO0/BOOT sequence).
   - **Flash Firmware:** Click `Yield Port` to release the serial handle for 30 s so tools like `esptool.py`, `probe-rs`, or `st-flash` can upload code without closing BaudForge.

### Stage 3: In-UI Framing Configuration (30–90 Seconds)
When the firmware switches from raw ASCII text to structured packet streams:
1. The user clicks **Framing** on the active port card in the Hardware Bay.
2. A configuration popup offers standard framing presets:
   - **Line Delimited:** Split on `\n` or `\r\n` (default for ASCII logs).
   - **COBS (Consistent Overhead Byte Stuffing):** Split on `0x00`, auto-decode.
   - **SLIP:** RFC 1055 serial framing with `0xC0` delimiter.
   - **Length-Prefixed Header:** Sync word + length field + payload.
   - **Intel HEX / Binary Records.**
3. The stream table updates dynamically from character chunks to discrete frame rows.

### Stage 4: Live Schema Dissection (90–150 Seconds)
1. The user selects a frame row.
2. In the Inspector panel, the user clicks **Attach Dissector**:
   - Option A: Select C header file (`.h`) and pick the root struct name.
   - Option B: Select Kaitai Struct (`.ksy`).
   - Option C: Select MAVLink XML dialect (`.xml`).
3. The stream table immediately renders decoded fields into configurable columns.
4. The hex inspector highlights decoded field boundaries with color bands.

### Stage 5: Telemetry, Dashboards & Workspace Export
1. User right-clicks any decoded field -> **Add to Plot** to open a real-time oscilloscope trace.
2. User switches to the **Dashboards** panel to monitor live gauges.
3. User clicks **Save Workspace As...** in the topbar (`Ctrl+S`).
4. The engine serializes the active session into a clean, reproducible `.bforge.toml` file saved in the project repository. Next time, the user opens the file in one click.

---

## 4. Required Technical Implementation Plan

To implement this workflow, the following components must be extended:

### 4.1 Backend Engine & API Extensions

| API Endpoint / Command | Type | Description |
| :--- | :--- | :--- |
| `GET /api/devices` | HTTP GET | Return list of attached serial ports from `bforge_hal::uart::available()`. |
| `POST /api/quick-connect` | HTTP POST | Start an in-memory session from `{ device, baud_rate, framing }` without an on-disk file. |
| `POST /api/send` | HTTP POST | Already implemented in engine; route UI TX input to this endpoint. |
| `POST /api/ports/:id/config` | HTTP POST | Dynamically update baud rate, line settings, or framing mode without restarting session. |
| `POST /api/workspace/export` | HTTP POST | Serialize current in-memory session into valid `.bforge.toml` text. |
| `list_serial_ports` | Tauri Invoke | Expose hardware discovery directly to the native desktop shell. |
| `quick_connect` | Tauri Invoke | Native desktop command to launch ad-hoc session and transition window. |

### 4.2 Frontend UI Enhancements

1. **Desktop Launcher (`ui/public/desktop.html`):**
   - Add a "Quick Connect" panel above "Open Workspace".
   - Include auto-refreshing serial port dropdown with USB device descriptions.
   - Include baud rate dropdown (`115200`, `9600`, `921600`, `230400`, `57600`).
   - Include single "Connect" action button.

2. **Console Panel (`ui/src/components/panels/ConsolePanel.tsx`):**
   - Add TX command input bar at the panel bottom.
   - Provide send button, input history buffer, and line-ending selector.

3. **Hardware Bay Panel (`ui/src/components/panels/HardwareBayPanel.tsx`):**
   - Add "Scan / Connect Port" button.
   - Add interactive baud rate selector dropdown on active port card.
   - Add framing mode selector button.

4. **Topbar & Persistence (`ui/src/App.tsx`):**
   - Add "Save Workspace As..." button when running in an ad-hoc session.
   - Show active connection badge (`COM3 @ 115200 8N1`).
