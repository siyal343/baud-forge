# Console TX and Port Control Implementation Report

## Summary
This document records the implementation of the Console TX send bar and port yielding controls in BaudForge.

## Implemented Changes

### 1. Store Methods (`ui/src/lib/store.ts`)
- Added `sendTx(portId: string, text: string, mode: 'crlf' | 'lf' | 'cr' | 'none' | 'hex'): Promise<boolean>`:
  - Formats payloads based on selected line ending mode (`CRLF`, `LF`, `CR`, `None`, `HEX`).
  - Encodes text with `TextEncoder` and parses space/comma/continuous hex strings into byte sequences.
  - Sends a JSON POST request to `/api/send` containing `{ port, bytes, hex }`.
  - Records transmission into `sentHistory` and updates transmission status notification.
- Updated `yieldPort(port: string | PortView, durationSec: number = 30): Promise<boolean>`:
  - Dispatches POST request to `/api/yield` with payload `{ port: portId, duration_sec: durationSec, seconds: durationSec }`.
  - Sets temporary notification in `yieldNote`.
  - Returns `true` on success and `false` on HTTP or network error.

### 2. Backend Support (`crates/bforge-core/src/serve.rs`)
- Added optional `bytes: Option<Vec<u8>>` field to `SendRequest` to directly handle raw byte arrays.
- Added `#[serde(alias = "duration_sec")]` to `YieldBody` to accept both `duration_sec` and `seconds`.

### 3. Pinned Console TX Bar (`ui/src/components/panels/ConsolePanel.tsx`)
- Added `.console-tx-bar` pinned to the bottom of the console layout:
  - Port selector `<select>` when multiple ports are available; defaults to the first open port or `obc`/`serial0`.
  - Single-port indicator badge when one port exists.
  - Input field with placeholder `Type command to transmit... (Enter to send, ↑↓ history)`.
  - Full command history navigation (`ArrowUp` to traverse older commands, `ArrowDown` to return to draft).
  - Mode selector dropdown (`CRLF (\r\n)`, `LF (\n)`, `CR (\r)`, `None`, `HEX`).
  - Transmission trigger button wired to `handleSend()`.

### 4. Hardware Bay Yield Control (`ui/src/components/panels/HardwareBayPanel.tsx`)
- Added `<button class="pin yield">yield 30s</button>` next to `boot seq` button on each port card.
- Wired `onClick` to `store.yieldPort(port.id, 30)`.

### 5. Styling (`ui/src/index.css`)
- Added compact Carbon/Phosphor styling for `.console-tx-bar`, `.tx-input`, `.tx-mode-select`, `.tx-port-select`, `.tx-port-badge`, and `.tx-send-btn`.
- Added hover style for `.pin.yield`.

## Verification
- `cargo test -p bforge-core --test serve`: Passed (15 passed, 0 failed).
- `npm --prefix ui run build`: Passed (clean TypeScript compilation and Vite production bundle).
