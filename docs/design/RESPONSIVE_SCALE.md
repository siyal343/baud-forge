# BaudForge Workstation — Responsive Density & Scale Architecture

This document describes the responsive layout engine, dense typography scale, and screen adaptation mechanisms for the BaudForge desktop workstation.

## 1. Problem Definition

The initial desktop workstation shell used fixed element heights and hardcoded window dimensions:
- Initial window size: `1440 x 900` px. This overflowed 1080p laptop displays running at standard 125% or 150% Windows display scaling (logical viewports `1536 x 864` or `1280 x 720`).
- Global ribbon: `44px` height with six separate baud rate preset buttons and full-length text labels, requiring > 1400px horizontal space.
- Table columns: Fixed 530px allocation in the packet stream, compressing the decoded summary on lower resolutions.
- Dockview panels: Uniform 50/50 splits, reducing packet stream space.

## 2. Dynamic Monitor & Screen Adaptation

### 2.1 Native Window Initialization
In `crates/bforge-desktop/tauri.conf.json` and `main.rs`:
- Window starts maximized (`"maximized": true`) to fill the user's active monitor work area without overflowing taskbars.
- Default fallback window geometry: `1280 x 760` with minimum limits at `720 x 450`.
- Startup logic checks for stored geometry; if none exists, it calls `window.maximize()`.

### 2.2 Proportional Panel Ratios
In `ui/src/components/WorkstationDock.tsx`:
- Packet Stream (primary surface): 62% viewport width, 68% upper height.
- Protocol Dissector & Hex Inspector: 38% viewport width, 68% upper height.
- Telemetry Oscilloscope & Command Forge: 100% width, 32% lower height.
- Minimum bounds enforce panel legibility (`minWidth: 260px`, `minHeight: 120px`).

## 3. Dense Typography & Component Sizing

Following Wireshark and Saleae Logic CAD standards, component heights and font metrics were refactored:

| Element | Previous | Refactored | Benefit |
| :--- | :--- | :--- | :--- |
| **Root Font Baseline** | `16px` | `11px` | +31% data density across all panels |
| **Global Ribbon Height** | `44px` | `34px` | Frees 10px vertical display area |
| **Baud Rate Selector** | 6 buttons (300px) | Single Compact Select (85px) | Frees > 200px horizontal ribbon space |
| **Ribbon Action Buttons** | Long text strings | Concise badges with responsive hide | Prevents ribbon overflow on narrow displays |
| **Packet Stream Header** | `30px` | `24px` | Sleeker hierarchy |
| **Packet Stream Fixed Cols** | `530px` | `374px` | +156px for payload & summary text |
| **Packet Row Height** | `28px` (`py-1`) | `20px` (`py-0.5`) | +40% visible packet frames without scrolling |
| **Dissector Row Height** | `28px` (`py-1.5`) | `20px` (`py-0.5`) | Compact struct inspection |
| **Hex Inspector Table** | Wrap at <480px | `overflow-x-auto` | Preserves 16-byte hex alignment |
| **DVR Transport Bar** | `36px` | `28px` | Slim scrubber controls |
| **Status Footer** | `26px` | `20px` | Single-line modem telemetry strip |

## 4. Hardware Display Zoom & DPI Scaling Engine

The workstation includes an integrated Zoom / Display Density engine:
- Store: `useWorkstationStore.uiScale` (range `0.70` to `1.50`, persisted in `localStorage`).
- Auto-detection: Displays under 1440px default to `0.90` (compact mode).
- CSS Container Binding:
  ```tsx
  <div
    style={{
      zoom: scaleFactor,
      width: `${100 / scaleFactor}%`,
      height: `${100 / scaleFactor}%`,
    }}
  >
  ```
- Hotkeys:
  - `Ctrl +` / `Ctrl =`: Zoom In (+5%)
  - `Ctrl -`: Zoom Out (-5%)
  - `Ctrl 0`: Reset to 100%
- Toolbar Controls: Quick `[-] 100% [+]` buttons directly accessible on the ribbon.
