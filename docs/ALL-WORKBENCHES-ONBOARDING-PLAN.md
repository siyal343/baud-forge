# Complete Workbench Onboarding Architecture & Specification

This specification defines the comprehensive, multi-workbench onboarding and user experience system for BaudForge.

---

## 1. Executive Summary

BaudForge provides six distinct engineering workbenches:
1. **Serial & Microcontroller Bring-Up:** Auto-discovery, bidirectional console, pin sequences, flasher yield.
2. **Protocol Dissector Lab:** C headers, MAVLink, Kaitai Struct, canonical 16-byte hex inspector, CQL queries.
3. **Telemetry & Live Oscilloscope:** Multi-channel real-time waveform plotting with timebase controls.
4. **Declarative XML Dashboards:** Custom instrument panels (gauges, strip charts, LEDs, switches, sliders).
5. **HIL Bridge & Fault Injection Lab:** Bi-directional forwarding bridges, bit flips, CRC corruption, jitter, drop rates.
6. **Session Diff & Regression Analysis:** Semantic comparison of binary `.bflog` vaults, timing drift, field divergence.

The onboarding system must guide users into **all six workbenches**, providing zero-friction entry points, 1-click interactive demonstration labs, in-panel empty states with template loaders, and in-app guided workflows.

---

## 2. Onboarding Experience Architecture

```
                               ┌────────────────────────────────────────────────────────┐
                               │             DESKTOP LAUNCHER & HUB                     │
                               │              (ui/public/desktop.html)                  │
                               └──────────────────────────┬─────────────────────────────┘
                                                          │
          ┌───────────────────────┬───────────────────────┼───────────────────────┬───────────────────────┐
          │                       │                       │                       │                       │
          ▼                       ▼                       ▼                       ▼                       ▼
    [1. SERIAL QUICK]      [2. PROTOCOL LAB]      [3. TELEMETRY SCOPE]    [4. XML DASHBOARD]       [5. HIL FAULT RIG]
    COM Auto-Discovery     C Header / MAVLink     Live Oscilloscope       Motor / Battery BMS      Dual-Port Bridge
    115200 Baud            IMU Packet Stream      Waveform Plots          Gauges & Strip Charts    Fault Injection
    Interactive Terminal   16-byte Hex Dump       Numeric Extraction      Safe Pratt Expressions   Bit-Flips & Drops
          │                       │                       │                       │                       │
          └───────────────────────┴───────────────────────┼───────────────────────┴───────────────────────┘
                                                          │
                                                          ▼
                               ┌────────────────────────────────────────────────────────┐
                               │             UNIFIED WORKBENCH APPLICATION              │
                               │                        (ui/src/)                       │
                               ├────────────────────────────────────────────────────────┤
                               │ • Topbar Hub: 6 Preset Layouts + Active Hardware Badge │
                               │ • Guided Empty States: 1-click templates for all panels│
                               │ • "New Workspace Wizard": Visual setup without TOML    │
                               │ • Help & Cheatsheet Modal (Ctrl+H): Interactive Guide   │
                               └────────────────────────────────────────────────────────┘
```

---

## 3. Workbenches & Onboarding Paths

### Workbench 1: Serial & Microcontroller Bring-Up
- **Entry Point:** "Serial Device Quick Connect" card in launcher.
- **Actions:** Pick COM port, baud rate, and line framing (`\n`). Click Connect.
- **In-App Features:** Interactive Console TX bar with history (`CRLF`, `LF`, `HEX`), `yield 30s` button for flashers (`esptool.py`, `cargo flash`), DTR reset pulse, bootloader sequence.

### Workbench 2: Protocol Dissector Lab
- **Entry Point:** "Protocol Dissector Lab" tile in launcher.
- **1-Click Lab:** Launches loopback IMU packet simulator with [`crates/bforge-dissect/tests/fixtures/imu_packet.h`](file:///f:/Datapack/Personal/Programa/baud-forge/crates/bforge-dissect/tests/fixtures/imu_packet.h).
- **In-App Guidance:** Stream panel empty state offers "Attach C Header (.h)", "Load MAVLink XML", or "Load Kaitai Struct". Hex Inspector highlights field byte ranges with color bands.

### Workbench 3: Telemetry & Live Oscilloscope
- **Entry Point:** "Telemetry & Oscilloscope" tile in launcher.
- **1-Click Lab:** Opens multi-channel real-time waveform scope with live simulated telemetry (`v_batt_mv`, `gyro_z`, `samples`).
- **In-App Guidance:** Telemetry panel empty state displays "Plot Signals" guide with a 1-click button to automatically plot all discovered numeric fields.

### Workbench 4: Declarative XML Dashboards
- **Entry Point:** "Interactive Dashboards" tile in launcher.
- **1-Click Lab:** Loads either [`dashboards/motor-diagnostics.xml`](file:///f:/Datapack/Personal/Programa/baud-forge/dashboards/motor-diagnostics.xml) or [`dashboards/battery-bms.xml`](file:///f:/Datapack/Personal/Programa/baud-forge/dashboards/battery-bms.xml).
- **In-App Guidance:** When no dashboard is active, the Dashboard panel renders a visual template gallery card showing previews and 1-click "Load Template" actions.

### Workbench 5: HIL Bridge & Fault Injection Lab
- **Entry Point:** "HIL Bridge & Fault Rig" tile in launcher.
- **1-Click Lab:** Launches dual-port loopback bridge (`obc` <-> `eps`) with live packet forwarding.
- **In-App Guidance:** Hardware bay highlights bridge traffic counters and provides fault injection presets (Drop 5% packets, Corrupt CRC, 50ms Jitter).

### Workbench 6: Session Diff & Regression Analysis
- **Entry Point:** "Session Diff & Golden Run" tile in launcher.
- **In-App Guidance:** When Session Diff panel is opened, it displays a dual-vault picker with a 1-click "Load Sample Regression" button to immediately show semantic field differences and timing drift.

---

## 4. Implementation Deliverables

1. **Desktop Launcher (`ui/public/desktop.html`):**
   - Transform launcher into a unified **Workbench Hub & Template Gallery**.
   - Tabbed / categorized layout:
     - **Quick Connect:** Serial Device Auto-Discovery
     - **Guided Labs & Templates:** 1-click launchers for all 6 workbenches
     - **Custom Setup:** "New Workspace Wizard" (modal to configure ports, framing, dissectors visually)
     - **Open Existing:** TOML Workspace, `.bflog` Vault, Recent Sessions
2. **In-App Empty States (`ui/src/components/panels/`):**
   - **`DashboardPanel.tsx`:** Template selector cards (*Motor Diagnostics*, *Battery BMS*, *Custom XML*).
   - **`TelemetryPanel.tsx`:** "Quick Plot Discovered Channels" button and signal picker.
   - **`SessionDiffPanel.tsx`:** "Load Sample Regression" button and drag-and-drop vault slots.
   - **`StreamPanel.tsx`:** Dissector attachment banner when viewing raw byte streams.
3. **Workspace Wizard & Templates (`ui/src/lib/templates.ts`, `ui/src/components/NewWorkspaceModal.tsx`):**
   - Visual dialog to construct new workspaces with multiple ports (Serial/TCP/UDP), framing, dissectors, and bridges without hand-writing TOML.
4. **Help & Cheatsheet Guide (`ui/src/components/HelpModal.tsx`):**
   - Quick reference modal (`Ctrl+H` or `?`) covering dock navigation, keyboard shortcuts, CQL syntax, and dissector support.
5. **Topbar Hub (`ui/src/App.tsx`):**
   - Enhanced preset switcher with icons and labels for all 6 workbenches.
   - "New Workspace" (`Ctrl+N`) and "Save Workspace" (`Ctrl+S`) actions.
