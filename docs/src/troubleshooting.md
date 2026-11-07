# Troubleshooting

Start every investigation in the [Activity Log](activity-log.html) — one timeline of what the engine did and what you pressed. The entries below name the exact log text you will see.

## The port will not open

**Log:** `port_state | esp: reconnecting` → `esp: closed`, read errors climbing.

- **Another process owns the port** — only one program can hold a COM port. Close the Arduino IDE's serial monitor, the other BaudForge engine, a stuck `esptool`… (a second engine silently fills the stream with simulated data instead of erroring — check the ribbon for `SIMULATED`).
- **The USB stack is wedged** — Windows can report the device as present (PnP status `OK`) while every open fails with *"A device attached to the system is not functioning"*. Software cannot clear this; **unplug and re-plug the board**. If it recurs, try a different cable (charge-only cables enumerate but fail exactly like this) or a hub port.
- **Wrong port id** — the workspace's `device_path` must match, or use `match_vid_pid = "303a:1001"` and let BaudForge find it.

## The stream shows data but the ribbon says SIMULATED

You are looking at the demo generator, not the wire. It appears when the UI has no engine: start `bforge serve` (or the desktop app), then reload. While a session runs, simulated rows never mix into real frames — the demo data seeds only when no engine is reachable.

## TX fails: `port "X" is not in this session`

The panel's DESTINATION badge names a port this engine does not have. Ports are workspace ids (`esp`, `obc`), not device paths — check the ribbon selector and the [Activity Log](activity-log.html) `tx_failed` entry for the exact port name.

## Frames decode wrong

1. Check the framing in the workspace: `cobs` vs `delimiter` mismatch produces garbage frames that fail decode (`ERR: …` rows).
2. C-struct dissectors require `struct __attribute__((packed))`; `#pragma pack` is not honoured, so a padded layout fails with a precise length error (`field crc needs 28 bytes but the frame has 23`).
3. Use [Schema Dialects](schema-dialects.html) → DECODE WIRE HEX to test a schema against a captured frame before applying it live.

## X/YMODEM fails instantly

`failed:cancelled by device (CAN)` means the device answered the handshake with CAN — it does not speak XMODEM. That is a real protocol exchange, not a hang. Check the device's bootloader mode ([Pin Sequencer](pin-sequencer.html) presets help get it there).

## ELF upload rejected

The engine reports the architecture mismatch (e.g. an AVR32 image on an ARM/RISC-V rig) or a missing symbol table. Build with `-g`; load the image built **for that exact target**.

## Diff says `storage: io: <path>: …`

The panel shows the engine's real error: the path names the file it could not find or open. Vault paths are relative to the engine process's working directory (usually the repo root). A capture sealed moments ago is retry-opened automatically; if a file is genuinely missing, the path in the error is the answer.

## Yielding the port

**YIELD** (ribbon) releases the port for a window (default 30 s) so `esptool`/`arduino-cli` can use it exclusively — the reader does not touch the port during the window, and takes it back afterwards with normal reconnect patience. The ribbon shows a countdown.

## The workbench froze or renders slowly

That was fixed — but if you ever see it again, check the device's frame rate: hundreds of frames per second at max baud are expected to be smooth; if not, note the rate and open an issue with the `.activity.jsonl`.

## Still stuck?

Attach three things to a bug report: the **`.activity.jsonl`** next to the vault, the exported **JSONL** of the stream around the failure ([Exports](exports.html)), and the workspace `.bforge.toml`.
