# In-UI Dynamic Framing and Workspace Export Implementation

## Overview
This document records the design and implementation of in-UI dynamic framing configuration and workspace export persistence for BaudForge.

## Implemented Components

### 1. Dynamic Framing Configuration (`ui/src/components/panels/HardwareBayPanel.tsx`)
- Made the **Baud / Frame** metric card interactive on each port card.
- Added a `Framing ▾` toggle button and an interactive badge displaying current framing mode.
- Integrated a popover panel with 5 standard framing modes:
  - `delimiter` (Line Delimited `\n`)
  - `cobs` (Consistent Overhead Byte Stuffing)
  - `slip` (SLIP RFC 1055)
  - `header-length` (Length-prefixed sync word)
  - `intel-hex` (Intel HEX records)
- Implemented `store.setPortFraming(portId, framing)`:
  - Updates local snapshot state immediately through `feed.updatePortFraming(portId, framing)` so the UI reflects the change with zero delay.
  - Sends a `POST` request to `/api/ports/{portId}/framing` to synchronize the backend session.

### 2. Workspace Export Persistence (`ui/src/lib/workspace.ts` & `ui/src/App.tsx`)
- Added `synthesizeWorkspaceToml(ports, bridges)` in `ui/src/lib/workspace.ts` to construct a valid `.bforge.toml` workspace specification from active ports and bridges.
- Added `exportWorkspace(ports, bridges)`:
  - Queries `POST /api/workspace/export` for server-side serialized configuration.
  - Falls back to client-side synthesized TOML if the server endpoint is not available.
  - Handles Tauri desktop shell integration via `save_workspace` invoke command if running in desktop mode.
  - Triggers a browser download of `baudforge-workspace.bforge.toml`.
- Added the **Save Workspace** toolbar button in `App.tsx`:
  - Placed beside Preset selector in the topbar header:
    `<button class="tb-btn" title="Save current session as .bforge.toml (Ctrl+S)">💾 Save Workspace</button>`
  - Bound `Ctrl+S` and `Cmd+S` across both the centralized command registry (`workspace.save`) and window-level keydown event listeners.
  - Added Command Palette action for `Save Workspace Configuration (.bforge.toml)`.

### 3. Active Hardware Indicator (`ui/src/App.tsx`)
- Added active hardware badge in the topbar breadcrumb cluster:
  - Formats active port as `[<device/id> @ <baud> 8N1 · <framing>]`.
  - Displays a live green status LED when the port state is `open`.

### 4. Backend Framing API Route (`crates/bforge-core/src/serve.rs`)
- Added `POST /api/ports/{port_id}/framing` route in `bforge-core::serve`.
- Synchronizes updated framing mode to server snapshot memory and returns `{ "ok": true, "port": "...", "framing": "..." }`.

## Verification
- `npm --prefix ui run build` executed and passed in 2.08s with 0 errors.
- `cargo test -p bforge-core` executed and passed all 119 tests with 0 failures.
