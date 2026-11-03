# Panel Zero-State & Template Loaders

This document specifies the zero-state guidance and template loaders for BaudForge workbench panels.

## 1. Dashboard Panel (`DashboardPanel.tsx`)

- **Trigger:** Rendered when no XML dashboard is active or the XML source is empty (`activeXml().trim() === ''`).
- **Template Gallery Card:**
  - Header: Title "Declarative XML Dashboards", subtitle, and category pill.
  - Template 1: **Motor & ESC Diagnostics**
    - Description: RPM dial gauge, motor temperature gauge, DC bus voltage, and live phase current chart.
    - Action: `<button class="btn-template">Load Motor Diagnostics</button>` fetches `/dashboards/motor-diagnostics.xml` with fallback to inline definition.
  - Template 2: **Battery BMS & Cell Monitor**
    - Description: Pack state-of-charge gauge, 8-cell voltage grid, cell delta bar, and thermal sensors.
    - Action: `<button class="btn-template">Load Battery BMS</button>` fetches `/dashboards/battery-bms.xml` with fallback to inline definition.
  - Custom File Upload: `<input type="file" accept=".xml">` to load local `.xml` specifications directly into the reactive parser.
  - Toolbar selector allows switching between template gallery, pre-built presets, and custom XML editing.

## 2. Telemetry Panel (`TelemetryPanel.tsx`)

- **Trigger:** Rendered when no traces are plotted (`traces().length === 0`).
- **Oscilloscope Zero-State Card:**
  - Visual: Dual-trace phosphor oscilloscope graphic with reticle grid lines.
  - Title: "Real-Time Telemetry & Oscilloscope"
  - Description: "Extract numeric channels from decoded packets into live time-synchronized waveform plots."
  - Action: `<button class="btn-action">Plot All Discovered Channels</button>`
    - Scans available numeric channels from `store.plotKeys()` and decoded `store.rawRows()`.
    - Automatically adds all detected numeric channels (e.g. RPM, temperature, voltage) to the plotted traces list.

## 3. Session Diff Panel (`SessionDiffPanel.tsx`)

- **Trigger:** Rendered when no regression diff comparison report is loaded (`!store.diffReport()`).
- **Regression Audit Zero-State Card:**
  - Title: "Semantic Session Regression Diff"
  - Description: "Compare two .bflog recordings to identify field-by-field divergence, dropped packets, and timing drift."
  - Dual File Picker Slots:
    - Slot A: Golden Baseline `.bflog` selector.
    - Slot B: Candidate / Regression `.bflog` selector.
  - Action: `<button class="btn-action">Load Demo Regression</button>`
    - Injects demo baseline and candidate session paths.
    - Pre-populates sample regression report with field divergence, packet indices, and microsecond delta times.

## 4. Stream Panel (`StreamPanel.tsx`)

- **Trigger:** Rendered when live frames exist but no dissector fields are populated (`isRawStream`).
- **Subtle Top Hint Banner:**
  - Notice text: "Raw stream active. Attach a C Header (.h), MAVLink XML, or Kaitai Struct to dissect fields into columns."
  - Action: "Attach Dissector" button triggers workspace configuration modal.
  - Dismisses automatically once dissector decodes fields into stream rows.
