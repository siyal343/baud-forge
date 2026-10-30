# BaudForge 0.1.0

First release candidate. A serial monitor, a protocol dissector and a fault-injection
rig for one machine or two sockets, with a workbench that runs in a browser or in a
window.

Released 30 October 2026. Everything below was run and measured on this machine; the
numbers say what they measured and nothing more.

## What is in it

**Engine**

- One reader thread per port, fixed-size rings, a disk logger that never drops a byte.
- Transports: serial (USB identity or device path), TCP client, TCP server, UDP.
- Framing: delimiter, COBS, SLIP, Intel HEX, sync word plus length, idle gap.
- Checksums: CRC-8/ATM, CRC-16/CCITT-FALSE, CRC-32C, verified against published vectors.
- Vault: `.bflog`, 256-byte header, 32-byte records, a persisted sparse index, repair of
  a killed session.
- Hotplug: a port that disappears is reopened in the same session, with a cumulative
  attempt budget.
- Yield: the engine hands the port to a flash tool for a window and takes it back.
- Dissectors: a C header parser (packed structs, bitfields, enums, arrays, endianness)
  and three native packs (CCSDS TM/TC with PUS, CSP v1, Modbus RTU).
- Symbols: an address in a frame becomes a function and a source line.
- Send path with `crc8`, `crc16` and `crc32c` appended on the wire.
- Fault profiles: bit flips, dropped bytes, truncation, corrupted CRC, seeded so a run
  reproduces.
- Bridges: a passive tap or an inline forward between two ports, recording the forwarded
  copy as transmit.

**Workbench** (browser or desktop window)

- Ribbon with link, contract, mode, ports and counters.
- Port cards with state, chunks, bytes, overruns and stall time.
- Live stream with direction, hex, protocol and crash badges.
- Inspector with the decoded fields, and the bytes a field came from lit on hover.
- One telemetry plot, from the live stream or from a scrubbed window.
- Scrubber over a vault, with the plot following the window.
- Command forge and a fault injector beside it.
- Paired bus view for a bridge's two ports, merged by time.

**Command line**

`help`, `version`, `config check`, `ports list`, `record`, `replay`, `status`, `serve`,
`tail`, `assert`, `vault info`, `vault repair`, `yield`.

## Found and fixed during the release pass

Two bugs that only a real capture could show. Both are fixed here, with tests.

1. **`bforge assert` never finished on a real capture.** The reader walked forward
   from the sparse index for *every* record, so a window cost `count × stride`
   reads and a whole-vault decode was quadratic. On the 14.6 MB capture from the
   board, `assert` ran over ten minutes without finishing; after the fix it reads
   327 929 chunks, decodes 164 073 frames and answers in **10 s**.
2. **A session truncated an existing vault.** `serve --vault demo.bflog` opened the
   same path for writing and destroyed the capture that was already there. A
   session now refuses a non-empty vault and says so; an empty file is allowed.

## Measured on this machine

| Claim | Figure |
| --- | --- |
| Pipeline, four ports, 60 s | 288 MB, 0 gaps, 11.9 MiB peak |
| Vault read, 512 MiB file | 21.5 MiB peak (4.2 % of the file) |
| COBS framing | 2000 frames, 156 MB/s, 0 invalid |
| C header dissection | 180 422 frames/s |
| Symbol lookup | 1.2 µs per address |
| Hotplug, three unplugs | detected in 16.8 / 24.9 / 47.1 ms, reopened in 1 ms |
| Flash while recording | `arduino-cli upload` wrote 298 880 bytes during a yield |
| ESP32-C3 on COM8, 15 minutes of `mode imu` at `rate 200` | 327 929 chunks, 4 101 333 payload bytes, 164 073 frames, 0 overruns, 0 read errors |
| The same capture through `assert` | 3 of 3 checks in 10 s; every frame `C_STRUCT:ImuPacket`, `mode = RUN` |
| Fault injection on hardware | `bit_flip` at 1.0 reported `fault_bytes: 3` for a 3-byte command |
| Desktop window | title `BaudForge`, engine on a random loopback port, recorded 2308 records |
| Test suite | 234 tests, 20 s |

## How to run it

`docs/QUICKSTART.md`, three ways: two simulated devices, an ESP32-C3, or the desktop
window.

## Not in this release

These are deliberate, recorded in `DEFERRED.md` with the reason and the unblocking
condition:

- no installer or code signing (D-74, deferred to a later release by decision);
- no Lua fault scripts (D-67), no jitter or latency injection (D-66);
- plots are SVG, one series, not WebGL at 60 FPS (D-63);
- the inspector is a flat field list, not a tree (D-69);
- the command forge takes hex, not typed fields (D-64);
- the scrubber seeks by record, not wall-clock time (D-68);
- no live transmit rows: a bridge's writes appear in a scrubbed window (D-79);
- no protobuf, Kaitai, defmt or MAVLink (D-35, D-56);
- Windows is the only desktop platform that was built and run (D-77).

## A note about the demo capture

The 15-minute capture from the board was destroyed by the second bug above, before it
was fixed, and the board is no longer attached to this machine for a re-run. The
figures were measured on that capture before it was lost; the numbers are real, the
file is not.

## Upgrading

Nothing to upgrade from. The vault format is version 1; if it changes, the header says
so and `bforge vault info` reports it.
