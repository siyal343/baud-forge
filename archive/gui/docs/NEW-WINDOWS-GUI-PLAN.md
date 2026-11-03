# BaudForge Native Windows GUI: Ground-Up Architecture and Implementation Plan

## 1. Executive Summary and Architecture

The legacy GUI (`bforge-gui-legacy`, based on Tauri v2 and a web frontend) is archived.
We will build a new, native desktop GUI for Microsoft Windows from the ground up: **`crates/bforge-gui`**.

### Core Architecture: Pure Native Windows Rust
- **Foundation:** Rust + `eframe` (0.31) + `egui` (0.31) + DirectX 12 / Vulkan (`wgpu`).
- **Docking Engine:** `egui_dock` (0.16) for flexible, user-reconfigurable multi-pane workspaces.
- **Plotting Engine:** `egui_plot` (0.31) for real-time, hardware-triggered telemetry oscilloscopes.
- **Direct Engine Integration:** Runs in-process with `bforge-core`. No webview, no HTTP servers, no WebSockets, no IPC serialization. Direct memory access to ring buffers, packet decoders, and fault injection pipelines.
- **Single Native Windows Executable:** Compiles directly to `target/debug/bforge-gui.exe` (or `target/release/bforge-gui.exe`). Immediate startup, ~20 MB memory footprint, 60/144 Hz rendering.

```
+---------------------------------------------------------------------------------+
|                                 BaudForge GUI                                   |
|   (Native Windows Win32 / DirectX 12 via eframe / winit / wgpu / egui)          |
+---------------------------------------------------------------------------------+
| Top Bar: Session Status | Hardware Quick-Connect | Presets | Layout Save/Reset   |
+---------------------------------------------------------------------------------+
|                                egui_dock Tree                                   |
|  +---------------------------+-----------------------------------------------+  |
|  | Dissector / Packet Tree   | Telemetry Oscilloscope (egui_plot)            |  |
|  | - Protocol fields         | - Real-time rolling wave (500k samples)       |  |
|  | - Bitfields & Enums       | - Trigger lines (rising, falling, threshold)  |  |
|  +---------------------------+-----------------------------------------------+  |
|  | Hex Dump & Inspector      | Live Serial Monitor Log & TX Console          |  |
|  | - Byte-level colors       | - Virtualized high-throughput log table       |  |
|  | - Offset cross-reference  | - Hex / ASCII command transmitter             |  |
|  +---------------------------+-----------------------------------------------+  |
|  | HIL Fault Injection Rig   | Declarative Instruments & Gauges              |  |
|  | - Bit flip, drop, jitter  | - Real-time dials, LEDs, strip charts         |  |
+---------------------------------------------------------------------------------+
| Bottom Bar: Port Status | Baud Rate | RX/TX Counters | Vault .bflog Recording   |
+---------------------------------------------------------------------------------+
```

---

## 2. User Reconfigurability System (`egui_dock`)

Every engineer has a different bench workflow. BaudForge will give the user complete control over layout:
1. **Dynamic Split & Docking:**
   - Drag tabs into horizontal or vertical splits, tab groups, or collapsible sidebars.
   - Pop out any tab into a standalone floating Windows desktop window (e.g., Oscilloscope on a secondary monitor).
   - Close tabs not needed for the current task; reopen them from the `View -> Panels` menu.
2. **Layout Presets:**
   - **Default / Microcontroller Bring-Up:** Serial Monitor, Hex Inspector, TX Console, Port Quick-Connect.
   - **Protocol Lab:** Dissector Tree, Hex Inspector, Filtered Packet Stream, Schema Editor.
   - **Telemetry & Dynamics:** Multi-channel Oscilloscope, Live Gauges, Value Cards, Rolling Strip Charts.
   - **HIL & Fault Injection:** Dual-port Bridge Monitor, BER Bit-Flip Controls, Jitter Sliders, Pin Controls (RTS/DTR).
   - **Vault Analysis & Diff:** Recorded Timeline Scrubber, Dual Session Comparator, Event Annotations.
3. **Persistence:**
   - User layouts automatically serialize to `%APPDATA%/BaudForge/layout.json` upon exit.
   - Users can save named layouts (`Export Layout...` / `Import Layout...`) per project or hardware setup.

---

## 3. Microcontroller and New User Onboarding Workflow

The application must provide zero-friction hardware setup for new users:

1. **Step 1: Zero-State Connection Dialog / Hub:**
   - When launched without a configuration file, the application displays a modern, focused Welcome Panel.
   - **COM Port Detection:** Scans all Windows COM ports using Windows SetupAPI/DeviceManager metadata. Displays the USB chip name (e.g. *STMicroelectronics Virtual COM Port (COM4)*, *Silicon Labs CP210x (COM7)*, *FTDI USB Serial (COM3)*).
   - **Baud Rate:** Preset buttons (115200, 9600, 921600, 2000000) plus custom input.
   - **Framing Wizard:** Quick selection between:
     - Line-delimited (`\n` or `\r\n`)
     - Length-prefixed (header + length byte/short)
     - COBS (Consistent Overhead Byte Stuffing)
     - Raw streaming byte buffer
   - **Sniff / Auto-Detect Button:** Samples incoming bytes for 500 ms to suggest matching baud rate and framing delimiters automatically.
2. **Step 2: Guided Workbench Discovery:**
   - "Load Demo Simulation" button connects a simulated dual-port loopback IMU/telemetry generator in one click.
   - Guided cards explain when to use Dissector Lab, Telemetry Scope, or HIL Rig.
3. **Step 3: Export to Reproducible Workspace:**
   - Users who configure ports, dissectors, and layouts can click `Export as .bforge.toml` to create a version-controlled workspace file for their team.

---

## 4. Complete Workbench Panel Specifications

| Panel | Description | Key Capabilities |
| :--- | :--- | :--- |
| **1. Serial Monitor** | High-speed virtualized stream view | Auto-scroll lock, search/filter regex, timestamp delta, ASCII / Escaped preview, pause/resume without buffer loss. |
| **2. Hex Inspector** | Memory-mapped byte grid | 16-byte rows, address offset, hex column, ASCII column, hover highlights dissector field bounds. |
| **3. TX Console** | Bidirectional command transmitter | ASCII string / Hex byte input modes, line ending select (LF, CRLF, None), macro buttons, repeat loop with millisecond pacing. |
| **4. Protocol Dissector** | Real-time structured packet decoder | Tree view with nested fields, C struct header loader, Protobuf `.proto` loader, MAVLink `.xml` loader, bitfield extraction. |
| **5. Telemetry Scope** | High-performance graphical oscilloscope | Multi-channel waveforms via `egui_plot`, hardware trigger modes (rising edge, falling edge, threshold), delta-T / delta-V cursors, min/max/RMS stats. |
| **6. Dashboards** | Declarative real-time instruments | Radial dials, LED indicators, switches, numerical readouts bound directly to parsed protocol fields (e.g., `imu.pitch`). |
| **7. HIL Fault Rig** | Hardware-in-the-loop bridge & injection | Bidirectional bridge (Port A <-> Port B), real-time bit flipping (BER), packet drop ratio, latency jitter, byte truncation, CRC corruption, RTS/DTR pin controls. |
| **8. Vault Scrubber** | Recorded session playback & diff | Scrub recorded `.bflog` files along timeline, real-time or stepped replay, side-by-side session diff highlighting divergences. |
| **9. Config & Symbols** | Project configuration and ELF badges | Visual workspace editor, `.elf` firmware symbol resolver (converts raw addresses to C/C++ function symbols). |

---

## 5. Visual Engineering Design Language (`/emil-design-eng`)

- **Palette:** Dark technical aesthetic.
  - Background Canvas: `#0d0f12` (deep obsidian)
  - Surface Containers: `#14181d` (slate graphite)
  - Hairline Borders: `#222933` (crisp 1px borders, zero soft shadows)
  - Text: Primary `#f1f5f9`, Muted `#64748b`
  - Signals: RX `#10b981` (emerald green), TX `#06b6d4` (cyan), Fault `#f43f5e` (rose red), Trigger `#f59e0b` (amber)
- **Typography:** JetBrains Mono for addresses, hex dumps, and baud figures. Inter / Segoe UI for labels. Tabular numeric alignment throughout.
- **Physical Feedback:** 1px hairline active outlines, immediate 60 FPS slider feedback, calibrated signal indicators.

---

## 6. Implementation Stages & Subagent Plan

We will deploy specialized Gemini Flash subagents to construct the architecture cleanly:

1. **Phase 1: Foundation & App Shell (`crates/bforge-gui`)**
   - Setup `crates/bforge-gui` with `eframe`, `egui`, `egui_dock`, and `egui_plot`.
   - Implement `App` struct, main event loop, theme styling, and top/bottom status bars.
   - Implement `egui_dock::DockArea` with tab tree and layout persistence.
2. **Phase 2: Hardware Onboarding & Serial Monitor**
   - Subagent A: Welcome modal, COM port scanner (`serialport`), and Quick-Connect.
   - Subagent B: Virtualized Serial Monitor log, TX console, and Hex Inspector.
3. **Phase 3: Protocol Dissector Lab & Dynamic Dashboards**
   - Subagent C: Dissector packet tree viewer with field highlight synchronization to hex inspector.
   - Subagent D: Declarative instrument widgets (radial gauge, LED, strip chart).
4. **Phase 4: Telemetry Scope, HIL Fault Rig & Vault Scrubber**
   - Subagent E: Real-time `egui_plot` oscilloscope with triggers and cursors.
   - Subagent F: HIL bridge controls, fault injection sliders, RTS/DTR pin toggles, and `.bflog` vault scrubber/diff.
5. **Phase 5: Verification & Packaging**
   - Comprehensive testing on Windows desktop: resize, dock manipulation, multi-port streaming, demo workspace validation.
