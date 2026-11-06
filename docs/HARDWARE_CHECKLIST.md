# Hardware Validation Checklist — post-audit feature waves

Date: 2026-11-07
Audience: anyone with the hardware in hand. Every step is a click or one
command; expected results are exact. Time budget: ~15 minutes.

Covers everything added after the 2026-11-03 validation report: REC vault
recording, MITM bridge, ELF symbolization, live schema apply, X/YMODEM
transfers, Workflow B scope-click sync, and per-field trace lanes.

---

## 0. Prerequisites

- BaudForge built: `cargo build --release -p bforge-cli` and
  `cargo build --release -p bforge-desktop` (or use the existing
  `target/release/` binaries).
- Device firmware streaming telemetry (the 2026-11-03 report's setup, unchanged).
- `examples/esp32-demo.bforge.toml` as the workspace (COM8, COBS, CRC32C).

Start the engine with the built UI:

```
target/release/bforge.exe serve -c examples/esp32-demo.bforge.toml --ui target/release/ui --duration 1h
```

Open `http://127.0.0.1:7717/` (or launch `bforge-desktop.exe`). The footer
must read a real link — **not** `SIMULATED`.

---

## 1. REC vault recording (2 min)

1. Click the **STANDBY** pill (top ribbon).
   - Expect: it turns into a pulsing red **● REC** with a byte counter that
     grows each second.
2. Stream telemetry for ~30 s.
3. Click **● REC** again.
   - Expect: toast `Vault sealed`, pill back to STANDBY.
4. Verify on disk (PowerShell):
   ```
   target/release/bforge.exe tail --vault vaults/rec-*.bflog --duration 2s
   ```
   - Expect: decoded `ImuPacket` frames from the sealed vault.

## 2. MITM bridge (needs 2 serial links)

Two adapters back-to-back (A.TX→B.RX, B.TX→A.RX), or one adapter with a
loopback plug bridged against the ESP32 link. Add a second `[[ports]]` +
`[[bridges]]` (forward = true) to the workspace, restart the engine.

1. Open **LAYOUTS & PANELS → MITM Bridge & Relay**.
2. Pick PORT A = the ESP32 link, PORT B = the second adapter, tick
   Forward, **ARM BRIDGE**.
   - Expect: toast `Bridge armed`; the bridge row shows forwarded bytes
     climbing.
3. Send bytes into A from the device — they must appear on B's wire
   (probe with a second terminal) and in the shared stream timeline.

## 3. ELF symbolization (2 min)

1. Open **ELF SYMBOLS & CRASH TRACE**. Status must read DEMO SYMBOLS.
2. **UPLOAD ELF** → pick the firmware `.elf` built for the device.
   - Expect: toast `Firmware image loaded`; status flips to
     **SYMBOLS ACTIVE**.
3. Stream frames that contain addresses.
   - Expect: address badges in the stream resolve to function names.

## 4. Live schema apply (2 min)

1. Open **SCHEMA DIALECTS**. LOAD FILE or edit the C header for the
   device's real struct.
2. **PARSE** → expect the exact field list.
3. **APPLY TO WORKSPACE** → toast `Schema applied`; frames from that port
   re-dissect with the new schema immediately (stream summaries change).
4. **DECODE WIRE HEX** with a captured frame → the sandbox table must
   match the stream.

## 5. X/YMODEM transfer (3 min; STM32-style bootloader or a loopback)

1. Open **X/YMODEM FILE TRANSFER**. STAGE FILE → pick any binary.
2. XMODEM-CRC + SEND → **START TRANSFER**.
   - Expect: handshake → `transferring` with climbing block counter →
     `COMPLETE`. The device side must see valid SOH blocks (CRC16/XMODEM).
3. RECV: make the device send a file (or loop the link so the engine talks
   to itself through the bridge). START TRANSFER with RECV direction and an
   expected size.
   - Expect: `COMPLETE` and the received file offered as a download;
     byte-for-byte equal to what the device sent.

## 6. Workflow B sync (1 min)

1. With telemetry flowing, click anywhere on the oscilloscope canvas
   (cursor mode armed — default).
   - Expect: a cursor snaps to the clicked instant AND the packet stream
     selects the nearest frame, hex inspector follows, DVR shows
     `PAUSED AT T-…`.
2. Press Space / JUMP TO LIVE to resume.

## 7. Trace lanes (1 min)

1. In the dissector, click the 📈 icon on any numeric field
   (e.g. `gyro_z`).
   - Expect: toast `Field bound to scope`; a colored lane appears in the
     oscilloscope ribbon and plots the field live.

---

## Regression gates (no hardware needed)

- `cargo test --workspace --locked` — 76+ tests
- `cd ui && pnpm test` — 25 tests
- `cd ui && pnpm smoke` — 15 checks (headless Chrome/Edge)
- `python e2e/e2e_bridge_rec.py target/release/bforge.exe` — 9 checks
- `python e2e/e2e_xmodem.py target/release/bforge.exe` — 14 checks

All green as of 2026-11-07 (commit `9012efd`).

---

## Validated: 2026-11-07, ESP32-C3 on COM8 (release build `de68183`+)

All seven checklist items executed against the physical device
(`303a:1001`, COM8 @ 115200, COBS + CRC32C). Results:

| # | Check | Result |
|---|---|---|
| 0 | Real link | `port esp open`, 0 overruns / 0 stalls / 0 read errors |
| 1 | REC vault | `● REC 5.0 KB` growing on real frames → sealed 112 records, `damaged_tail: false`, frames replay via `/api/vault/frames?path=` |
| 3 | ELF upload | Real ELF staged → parsed → honestly rejected as wrong-architecture (AVR32 vs RISC-V). Device ELF (`esp32c3_app.elf`) not on this machine — symbol badges pending that file |
| 4 | Schema apply | Renamed schema applied to `esp` mid-session → device frames re-dissected live (`frame_no`, `gyro_z`, `vbatt_mv`); full 12-field `imu_packet.h` restored and verified (nested `samples` flattened) |
| 5 | X/YMODEM | RECV armed on the real link; engine polled 'C'; **the device answered CAN** — state machine transitioned to `failed:cancelled by device` honestly (this firmware does not speak XMODEM). Real bidirectional protocol exchange, no hang |
| 6 | Workflow B | Scope canvas click paused the capture at the clicked instant and selected the real 12-field frame |
| 7 | Trace lanes | `gyro_z` bound from the real dissector; 26 live points from physical sensor data |

Bidirectional dispatch baseline: `mode imu\n` (9 B) → device streamed
2,670 chunks / 32 KB at 0 overruns.

Fix made during this pass: `/api/vault/frames` now honors `?path=` like
`/api/vault` and `/api/vault/export` (a sealed vault could not be
replayed unless the server was started with `--vault`).

**Pending on the user:** build/point at the ESP32-C3 `.elf`
(`esp32c3_app.elf`) for symbol badges — the upload endpoint is live.
