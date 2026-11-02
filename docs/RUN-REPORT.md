# BaudForge Build and Run Verification Report

This report documents the build verification and execution status of the BaudForge workbench.

## 1. Build Verification

- **Frontend (`ui`):**
  - Command: `npm --prefix ui run build`
  - Result: 47 modules transformed cleanly in 2.36 s.
  - Distribution directory: [`ui/dist/`](file:///f:/Datapack/Personal/Programa/baud-forge/ui/dist/)
  - Static bundle: `dist/assets/index-DINcYzYr.js` (207.32 kB), `dist/assets/index-DOqhmvWt.css` (40.05 kB), `dist/desktop.html` (21.54 kB).
  - Synced bundle: [`target/debug/ui/`](file:///f:/Datapack/Personal/Programa/baud-forge/target/debug/ui/).

- **Backend Workspace (`crates/*`):**
  - Command: `cargo build --workspace`
  - Result: All 9 workspace members compiled with zero errors in 3 m 37 s.
  - Binaries generated:
    - [`target/debug/bforge.exe`](file:///f:/Datapack/Personal/Programa/baud-forge/target/debug/bforge.exe) (CLI and headless HTTP engine)
    - [`target/debug/bforge-gui.exe`](file:///f:/Datapack/Personal/Programa/baud-forge/target/debug/bforge-gui.exe) (Tauri v2 native desktop window)
    - [`target/debug/examples/s8_device_sim.exe`](file:///f:/Datapack/Personal/Programa/baud-forge/target/debug/examples/s8_device_sim.exe) (Loopback device simulator)

---

## 2. Active Run Execution

The application is running with the loopback demonstration workspace: [`examples/loopback-demo.bforge.toml`](file:///f:/Datapack/Personal/Programa/baud-forge/examples/loopback-demo.bforge.toml).

### Active Process Table

| Component | Executable | PID | Port / Address | Status |
| :--- | :--- | :--- | :--- | :--- |
| **BaudForge Desktop GUI** | `bforge-gui.exe` | `10288` | Local HTTP: `http://127.0.0.1:61730` | **Running** (Active Window + WebView2) |
| **Simulated Device 1 (`obc`)** | `s8_device_sim.exe` | `2540` | `127.0.0.1:9100` (50 Hz) | **Streaming** (COBS IMU packets) |
| **Simulated Device 2 (`eps`)** | `s8_device_sim.exe` | `11048` | `127.0.0.1:9101` (50 Hz) | **Streaming** (COBS IMU packets) |

---

## 3. Telemetry Pipeline Health

Verified via `GET http://127.0.0.1:61730/api/snapshot`:
- **Session Mode:** `record`
- **Session Vault:** Auto-created temporary session log
- **Frames Ingested:** >520 chunks, >13 kB decoded payload
- **Port `obc` State:** `open` (zero drops)
- **Port `eps` State:** `open` (zero drops)
- **HIL Bridge `link`:** Forwarding live packets between `obc` and `eps` (>6.5 kB forwarded)

---

## 4. UI Capabilities Available in Active Run

1. **Workbench Window:**
   - Active native window displayed on desktop.
   - Also viewable in any external browser at: `http://127.0.0.1:61730/`.
2. **Docking Engine:**
   - Drag panel tabs into 5 drop zones (`center`, `left`, `right`, `top`, `bottom`).
   - Drag splitters to resize panels.
   - Switch presets via the top-right preset menu:
     - *Bring-up*
     - *Protocol Debug*
     - *Telemetry & Oscilloscope*
     - *Minimal Stream*
3. **Appearance & Settings:**
   - Press `Ctrl+,` or click the gear icon to open settings.
   - Switch themes: `carbon-dark`, `paper-light`, `high-contrast`.
   - Switch row densities: `compact` (22 px), `default` (26 px), `spacious` (32 px).
   - Configure visible stream columns and reorder them.
4. **Declarative Dashboards:**
   - Select the **Dashboards** panel tab to view live rendered XML gauges and charts.
   - XML definitions located in [`dashboards/motor-diagnostics.xml`](file:///f:/Datapack/Personal/Programa/baud-forge/dashboards/motor-diagnostics.xml) and [`dashboards/battery-bms.xml`](file:///f:/Datapack/Personal/Programa/baud-forge/dashboards/battery-bms.xml).
5. **Popout Windows:**
   - Open dedicated subviews in external browser windows:
     - Stream popout: `http://127.0.0.1:61730/?popout=stream`
     - Telemetry popout: `http://127.0.0.1:61730/?popout=telemetry`
     - Dashboard popout: `http://127.0.0.1:61730/?popout=dashboards`

---

## 5. Teardown Procedure

To cleanly stop the active session and background processes:

```powershell
Stop-Process -Id 10288, 2540, 11048 -Force
```
